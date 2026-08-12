# RP Streaming — Real Token Streaming for the RP Lane

*Status: planned, not yet implemented.*

## Goal

Replace the RP lane's single blocking reply with real token-level streaming, delivered through
**one shared turn-execution core used by both a fresh send and a swipe/regenerate** — so streaming
exists in exactly one place, not two independently-evolving implementations. This is the
prerequisite groundwork for a later, separate plan (in-stream TRG-style cleanup); it is not that
plan. See Non-Goals.

## Scope

RP lane only (`session.kind === 'rp'`). This lane already runs with **zero tools**
(`httpServer.ts`'s `sessionKind === 'rp'` branch forces `sessionTools = createToolRegistry([])`, in
both `handleChatCompletions` and `regenerateSwipe`) — every RP completion is guaranteed to be a
single plain-text final reply, never a tool call. That means the streaming core this plan builds
never needs a multi-round tool loop at all; it is a strictly simpler shape than `loop.ts`'s
`runTurn`, not a streaming mode bolted onto it. The household/`chat`-kind lane (Open WebUI traffic,
tool-calling turns) is untouched by this plan and keeps using the existing non-streaming
`complete()` path exactly as today.

## Background

- The native frontend currently sends `stream: false` and awaits one JSON response
  (`frontend/src/api/client.ts`'s `chatCompletion`); a side-channel poll (`GET /v1/chat/status`,
  backed by `orchestrator/turnStatus.ts`) is the only mid-turn signal it has today.
- The OpenAI-compatible surface accepts `stream: true` for Open WebUI compatibility, but
  `httpServer.ts`'s own header comment is explicit that this isn't real streaming: `runTurn`
  resolves the full reply first, and the "stream" is one SSE chunk followed immediately by the
  terminator. Confirmed reading the actual branch (`handleChatCompletions`, the `if (body.stream)`
  block): all post-turn bookkeeping (`ensureFirstTurnHeader`, `chats.appendMessages`, lorebook
  activation log, location scrape, title generation, canvas update) already runs to completion
  *before* that branch even starts writing bytes.
- There are two separate call sites into `runTurn` today: `handleChatCompletions` (a fresh send)
  and `regenerateSwipe` (Rerun / swipe past the last stored variant). They already converge on the
  same `runTurn` call and the same RP tool-stripping rule; they diverge only in their persistence
  tail (`chats.appendMessages` vs `chats.recordSwipe`) and the `scrapeTurnPresence` mode
  (`'extend'` vs `'replace'`). A swipe is just an alternate way of getting the same LLM output — it
  should behave exactly the same as a send, including streaming, from the moment this is built, not
  as a follow-on conversion. That is why this plan's core deliverable is a **shared** streaming
  primitive both call sites use, not a streaming branch added twice.
- `createGatedLlmProvider` (`llmGate.ts`) wraps every `complete()` call with retry-on-failure,
  lane-concurrency admission, and usage logging — all designed around "the whole call either
  succeeds or is retried wholesale." That doesn't transfer directly to streaming: once any token has
  been relayed to the client, silently retrying the whole call would duplicate or garble what the
  user already sees. The gate needs a streaming-aware variant with narrower retry semantics (see
  Logic).
- `orchestrator/cleanupLoop.ts` (the async, TRG-lineage regex-triggered cleanup subloop) is
  RP-only, and untouched by this plan — see Non-Goals for why it stays exactly as-is.

## Non-Goals (deferred, not forgotten)

- **In-stream TRG-style cleanup** (live regex `remove` pass per delta, paragraph-boundary-triggered
  repair prefetch, early header repair, patch events applied to already-streamed text). This needs
  the SSE/turn-core contract this plan establishes to exist and be proven first. It is its own
  follow-on plan.
- **Streaming for `chat`-kind / tool-calling turns** (household assistant, Open WebUI). Real
  added complexity (text/tool-call interleaving mid-stream) with no cleanup dependency forcing it.
  Left for a separate plan if ever wanted.
- **Retiring `orchestrator/cleanupLoop.ts`'s poll tick.** Even with RP fully streaming on both
  entry points, the tick stays on, unconditionally, as the fail-open safety net for: (a) any
  connection whose adapter has no streaming implementation (falls back to a single buffered delta —
  see Logic — which still lands as a raw, un-cleaned message the same way every message does
  today), and (b) an orchestrator crash/restart mid-turn, which — unlike today's persist-then-clean
  order — could otherwise leave a message that nothing ever notices needs cleaning. Its
  `(message_id, swipe_id)` job-ledger dedup already makes checking an already-fine message free.
- **Any schema change.** No new columns, no change to the swipe/message persistence model.
- **Retiring `orchestrator/turnStatus.ts`.** Still the only mid-turn signal for non-RP/tool-calling
  turns; unchanged.

## Files

- `orchestrator/src/io/llm/types.ts` — modified — `LlmProvider` gains an optional
  `completeStream(messages, tools, onDelta, options)` method, same "undefined means no streaming
  capability, not broken" convention `listModels`/`listProviders` already use on this interface.
- `orchestrator/src/io/llm/anthropic.ts` — modified — implements `completeStream`: same request
  body as `complete()` plus `stream: true`, parses the SSE `content_block_delta` events whose
  `delta.type === 'text_delta'` into `onDelta` calls, accumulates the full text, and builds the
  final `LlmTurn` (including usage from the terminal `message_delta`/`message_stop` event) the same
  way `fromAnthropicResponse` does today. No tool-call streaming support — RP never calls with
  tools; a caller that passes a non-empty `tools` array to `completeStream` gets an explicit thrown
  error rather than silently misbehaving.
- `orchestrator/src/io/llm/openaiCompatible.ts` — modified — implements `completeStream`
  symmetrically: `stream: true` plus `stream_options: { include_usage: true }`, parses
  `choices[0].delta.content` per chunk into `onDelta`, reads usage off the final chunk. Same
  no-tool-streaming restriction as the Anthropic adapter.
- `orchestrator/src/io/llm/stub.ts` — modified — `createStubLlmProvider` gains a `completeStream`
  that replays each scripted turn's `message.content` as a handful of small chunks through
  `onDelta` (deterministic, no timers, no network) before resolving with the same scripted
  `LlmTurn` — lets the new verify scripts exercise the streaming path with no real provider.
- `orchestrator/src/io/llm/llmGate.ts` — modified — `createGatedLlmProvider`'s returned object
  gains `completeStream` (present only when `base.completeStream` exists, mirroring the existing
  `listModels: base.listModels` passthrough pattern), with the narrower retry rule described in
  Logic. Already over its principle §10 budget before this change; if the streaming-retry logic
  doesn't fit cleanly inline, extract it into a small sibling module rather than inlining further —
  left to the implementer's judgment on the exact internal boundary, not a hard file split
  requirement.
- `orchestrator/src/orchestrator/streamingTurn.ts` — created — `runStreamingRpTurn`, the shared
  core both `handleChatCompletions` and `regenerateSwipe` call for an RP + `stream: true` turn. No
  tool-round loop (RP has none); owns the blank-reply retry, the abort wiring, and turn-metrics
  recording for this path. See Contracts for its exact signature.
- `orchestrator/src/server/httpServer.ts` — modified —
  - `handleChatCompletions`: when `sessionKind === 'rp' && body.stream`, delegates to
    `runStreamingRpTurn` instead of `runTurn`, writes SSE headers immediately, relays each delta as
    a `buildChatCompletionChunk` chunk, and runs the existing post-turn bookkeeping (unchanged
    logic) once the stream's final delta has arrived, against the accumulated text — except the
    turn-1 `ensureFirstTurnHeader` case, which stays fully buffered (see Edge Cases). Every other
    combination (non-RP, or `stream: false`) keeps today's exact code path.
  - `regenerateSwipe`: gains the identical `stream` branch, gated the same way
    (`session.kind === 'rp' && stream`); persists via `chats.recordSwipe` after the stream ends,
    same as today's non-streaming call. Non-RP swipes (household chat regenerate) are unaffected —
    still buffered `runTurn`.
  - The swipe route handler (`POST /v1/chats/:id/messages/:messageId/swipe`) reads a new optional
    `stream` field off the request body (default `false`, matching how `body.stream` already
    defaults on the completions route) and, only for the `needs_regenerate` outcome, writes the SSE
    response the same way `handleChatCompletions` does. The `switched`/`no_earlier_swipe`/
    `no_further_swipe` outcomes are pure content swaps with no LLM call — unaffected, still plain
    JSON.
  - A small shared helper for writing the new abort/error terminal frame (see Contracts) so both
    routes emit it identically.
  - Both streaming branches wire `req.on('close', ...)` to the same `AbortController` the explicit
    Stop button uses (`registerTurnAbort`), so a dropped client connection cancels the in-flight LLM
    call instead of burning tokens on a stream nobody is reading (see Edge Cases).
- `frontend/src/api/client.ts` — modified — `chatCompletion` gains an optional `onDelta` callback
  parameter; when present, it sends `stream: true`, reads `res.body` as a `ReadableStream`, parses
  `data: ...` SSE lines, calls `onDelta` per content chunk, and still resolves with the same
  `ChatCompletionResponse` shape once `[DONE]` arrives — so the return contract is unchanged for any
  caller that doesn't pass the callback. `swipeMessage` gets the same optional `onDelta` addition.
- `frontend/src/api/types.ts` — modified — adds the abort/error terminal-frame type used by the new
  stream parser.
- `frontend/src/views/ChatView.tsx` — modified — `send()` passes an `onDelta` that appends into the
  in-progress assistant `DisplayMessage`'s `content` in local state as chunks arrive (a placeholder
  message is pushed the moment the stream starts, filled in live, then reconciled against the
  server's canonical row once the existing post-send `refreshActiveMessages` call runs — the same
  reconcile-after-optimistic-append shape the user-message send already uses). `swipe()` gets the
  equivalent live-fill only for its `willRegenerate` branch; `prev`/`next` cycling (no LLM call) is
  unaffected. The existing `GET /v1/chat/status` poll (`getChatTurnStatus`) is simply not started
  for a streaming RP turn — there's nothing for it to report that the live text isn't already
  showing.
- `orchestrator/scripts/verify-llm-adapters.mjs` — modified — new fixtures mocking a chunked SSE
  `fetch` response for both adapters' `completeStream`: deltas arrive in order, concatenate to the
  same text the equivalent canned `complete()` response would produce, and usage is parsed from the
  terminal event/chunk.
- `orchestrator/scripts/verify-streaming-turn.mjs` — created — drives `runStreamingRpTurn` against
  the stub provider's new `completeStream` and a fake pool. See Tests.
- `orchestrator/scripts/verify-server.mjs` — modified — end-to-end SSE assertions over a real
  socket for both routes. See Tests.

## Logic

**Adapters.** Both `completeStream` implementations open the same request as `complete()` with
streaming enabled, parse the vendor's SSE format for text-delta events, call `onDelta` with each
piece of text in arrival order, and resolve with the same `LlmTurn` shape `complete()` already
returns (full concatenated text, empty `toolCalls`, usage from whatever terminal field the vendor
reports it on). `onDelta` is called zero or more times before the promise resolves; it is never
called after resolution or rejection.

**Gate.** `createGatedLlmProvider`'s `completeStream` passthrough keeps the existing lane-admission
check (`withLaneSlot`) and the existing `agent_routine` preflight, but changes retry semantics from
"retry the whole call on a retryable failure" to "retry only if the failure happens before the
first `onDelta` call for this attempt." Once even one delta has been relayed to the caller (and
therefore already on its way to the user), a subsequent failure propagates as a genuine error
instead of silently starting a second, overlapping generation — the caller (`runStreamingRpTurn`)
is responsible for deciding what the client sees in that case (the abort/error terminal frame, not
a fabricated retry). Usage logging (`logCall`) fires once, when the stream resolves or fails, exactly
like today's single post-call log — no per-delta logging.

**`runStreamingRpTurn`.** Registers the turn's `AbortController` the same way `runTurn` does
(`registerTurnAbort`/`unregisterTurnAbort` in a `finally`), calls the gated provider's
`completeStream` with an empty tools array, relays every delta straight to the caller's own
`onDelta`, and applies the existing blank-reply retry rule (`MAX_EMPTY_REPLY_RETRIES`) to the final
accumulated text — a retry here is safe precisely because "blank" means nothing but whitespace was
ever relayed, so nothing meaningful reached the client from the failed attempt (see Edge Cases for
the one case this doesn't cleanly cover). Records `turn_metrics` the same way `runTurn` does today.
When the resolved connection's adapter has no `completeStream` at all, falls back to calling
`complete()` and invoking `onDelta` exactly once with the whole reply — the turn still "streams" in
the sense the caller's contract expects, just with one big delta instead of many; this is the
graceful-degradation path principle §6 requires for a per-connection capability gap.

**`handleChatCompletions` / `regenerateSwipe` streaming branch.** SSE headers are written as soon as
the branch is entered (before the LLM call, matching the existing non-RP `stream: true` header
write). Each `onDelta` call is immediately serialized as one `buildChatCompletionChunk` SSE frame
and flushed — this is unchanged framing, so any OpenAI-compatible client (Open WebUI, if it were
ever pointed at an RP chat) parses it exactly as it already does today's single-chunk response. Once
the stream resolves, the existing post-turn bookkeeping block runs completely unchanged, using the
accumulated final text as `reply` — same `ensureFirstTurnHeader`/`appendMessages`/lorebook/scrape/
title/canvas sequence, same decoupled `fireLocationImageGeneration` trigger on `res.finish`. The
final SSE frame (the existing `stop`-finish-reason chunk, followed by `[DONE]`) is written last, only
after persistence succeeds — so a client that sees `[DONE]` can trust the message is already saved,
same guarantee the non-streaming path gives via its single response.

## Contracts

- `LlmProvider.completeStream` (`orchestrator/src/io/llm/types.ts`):
  ```
  completeStream?(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    onDelta: (textDelta: string) => void,
    options?: LlmCompleteOptions,
  ): Promise<LlmTurn>;
  ```
  Throws if `tools.length > 0` — this capability is RP-only by contract, not a general
  tool-streaming implementation.
- `runStreamingRpTurn` (`orchestrator/src/orchestrator/streamingTurn.ts`):
  ```
  function runStreamingRpTurn(opts: {
    userId: string;
    taskId: string;              // chatId — same meaning as RunTurnOptions.taskId
    messages: LlmMessage[];
    systemPrompt: string;
    llm: LlmProvider;             // the gated provider
    model?: string;
    sampling?: { temperature?: number; topP?: number; maxTokens?: number };
    db: PostgresClient;
    onDelta: (textDelta: string) => void;
  }): Promise<{ content: string; usage?: LlmUsage }>
  ```
  Throws `AbortError`-shaped errors the same way `runTurn` does (`isAbortError` from
  `turnAbort.ts` recognizes them) — callers handle abort identically to today's `runTurn` catch
  block, just choosing the SSE terminal frame instead of a `499` status when headers are already
  sent.
- **SSE abort/error terminal frame** (new): sent as one additional `data: ...` line, before
  `[DONE]`, only when the turn is aborted or fails *after* streaming has already started (i.e.
  after `res.writeHead` has committed the `200` status, so an HTTP status code is no longer an
  option):
  ```
  data: {"bigimagine_error": true, "aborted": boolean, "message": string}

  data: [DONE]
  ```
  When nothing has been streamed yet at the point of failure/abort, the handler keeps today's
  behavior exactly: no headers sent yet, respond with `499`/`500` as a normal HTTP status, no SSE at
  all. A success completion is unaffected — it keeps emitting today's `stop`-finish-reason chunk,
  no `bigimagine_error` field, so an OpenAI-compatible client that has never heard of this field
  simply never sees it.
- Swipe route request body gains one new optional field: `{ direction: 'prev' | 'next'; stream?:
  boolean }`. Omitting it is identical to `false` — fully backward compatible with any existing
  caller.

## Edge Cases

- **Turn 1 of a new RP chat.** `ensureFirstTurnHeader` may rewrite `reply` (adding the two-line
  scene header) *after* `runTurn`/`runStreamingRpTurn` resolves but *before* persistence, only when
  `priorMessageCount <= 1`. Streaming that raw pre-repair text live would show the client something
  that doesn't match what actually gets saved. This one case is deliberately **not** streamed live:
  `handleChatCompletions` detects `firstLlmTurn` the same way it does today and, only for that case,
  buffers all deltas internally (no `onDelta` forwarded to the SSE response) and sends the
  header-repaired text as a single chunk once persistence completes — identical to today's
  non-streaming behavior, for this one first-turn-only case. Every subsequent turn in the same chat
  streams normally.
- **Blank/whitespace-only stream triggering a retry after some bytes were already relayed.** The
  blank check is on the *trimmed* final text, so a pathological stream that emits only whitespace
  before ending would trigger a retry even though something was flushed to the client. Accepted as
  an unhandled rare cosmetic case (a brief blank flush before the retry's real text arrives) — not
  worth special-casing given how unlikely a real model is to emit only whitespace.
- **A connection with no `completeStream` implementation.** Falls back to one whole-reply delta via
  `complete()` (see Logic) — the turn still completes and streams in the contract sense, just
  without live token-by-token display. The message is `chats.appendMessages`/`recordSwipe`'d exactly
  as any other reply; `cleanupLoop.ts`'s tick treats it no differently than any message today.
- **Client disconnects mid-stream (not an explicit Stop click).** `req.on('close', ...)` fires the
  same abort path as the Stop button so the upstream LLM call is actually cancelled, not left
  running to completion against a socket nobody is reading — new behavior this plan adds
  specifically for the streaming branch; the non-streaming path is unaffected (out of scope, no
  regression risk since it doesn't stream in the first place).
- **Abort or upstream error after streaming has begun.** Handled via the new terminal frame (see
  Contracts) rather than an HTTP status change, since headers are already committed. Before any
  bytes are sent, behavior is unchanged (`499`/`500` as today).
- **Concurrent send/swipe on the same chat.** No new race beyond what exists today — the frontend's
  existing `sending`/`swipingId` guards prevent a second fire client-side, and server-side nothing
  about streaming changes how `runTurn`'s single-flight-per-chat abort registration works.

## Tests

- **Adapters** (`verify-llm-adapters.mjs`): a mocked chunked SSE `fetch` response for both Anthropic
  and OpenAI-compatible `completeStream` produces deltas, in order, that concatenate to the same
  text a canned non-streaming response would produce for equivalent content; usage is parsed off the
  terminal event/chunk; a call with a non-empty `tools` array throws.
- **`runStreamingRpTurn`** (new `verify-streaming-turn.mjs`, stub provider + fake pool): deltas
  arrive via the callback in order and concatenate to the final `content`; an abort mid-stream
  propagates as an `isAbortError`-recognized throw with no `turn_metrics` "ok" outcome recorded;
  every attempt coming back blank retries up to `MAX_EMPTY_REPLY_RETRIES` then throws, matching
  `runTurn`'s existing blank-retry behavior; a stub provider configured with no `completeStream`
  falls back to exactly one `onDelta` call carrying the whole reply.
- **Gate** (extend `verify-llm-gate.mjs`): a `completeStream` failure before any delta is relayed
  retries per the existing backoff config; a failure injected *after* the first delta has fired
  propagates immediately with no retry attempt.
- **Server, end to end** (`verify-server.mjs`, real sockets): `POST /v1/chat/completions` with
  `chat_id` on an RP chat and `stream: true` produces multiple `data:` chunks before `[DONE]`, and
  the persisted message afterward matches the concatenated streamed text; the same for the swipe
  route's `needs_regenerate` case with `stream: true`; a `POST /v1/chat/abort` fired mid-stream
  produces the `bigimagine_error`/`aborted: true` terminal frame and leaves nothing persisted; a
  non-RP chat or `stream: false` request is byte-for-byte unaffected by this plan (regression
  guard).

## Out of Scope

- In-stream cleanup (TRG-style live patching) — separate follow-on plan, see Non-Goals.
- Streaming for `chat`-kind/tool-calling turns — see Non-Goals.
- Any `cleanupLoop.ts`/`cleanupHeuristics.ts` change — untouched.
- Any schema/migration change.
- Anthropic extended-thinking/reasoning content blocks — not used by either adapter today
  (`AnthropicContentBlock`'s type union has no `thinking` variant); not introduced by this plan.

## Principles / Conventions in Play

- `bi_principles.md` §2 (LLM Reasons; Nothing Else Does) — streamed deltas are relayed data, never
  interpreted by the frontend; this is also why the earlier TRG-comparison in this conversation
  rejected a client-side DOM-patch approach — reasoning about the text stays server-side end to end.
- §6 (Reasoning Layer is Replaceable) — `completeStream` is optional on `LlmProvider`; a connection
  without it degrades to one whole-reply delta rather than failing the turn.
- §7 (Interface Layer is Replaceable) — the SSE contract is additive to the existing
  OpenAI-compatible chunk shape; no breaking change to what Open WebUI already speaks.
- §8 (Four Kinds of Code) — `streamingTurn.ts` is an Orchestrator module (sequences gate/adapter/
  persistence calls, owns no state itself, performs no direct IO); the gate stays an IO Wrapper.
- §10 (Every File Has One Purpose and a Size Budget) — the new streaming core is its own file
  rather than grown inside `loop.ts`/`llmGate.ts`/`httpServer.ts`, all three already at or past
  their budget.
- §11 (Observability) — every fallback path introduced here (no-`completeStream` connection,
  blank-retry, mid-stream abort/error, dropped-client cancellation) logs, matching `loop.ts`'s and
  `cleanupLoop.ts`'s existing conventions.
- §19 (Mobile-First) — no layout change; the same message bubble fills incrementally, so nothing
  new to verify here beyond what already holds.
- `conventions.md` — every modified/created file keeps or declares an accurate
  `@architectural-role`; `streamingTurn.ts` is new and must declare Orchestrator from the start.
