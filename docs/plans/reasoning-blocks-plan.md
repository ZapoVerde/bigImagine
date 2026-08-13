# Feature Plan: Reasoning ("Thinking") Blocks for RP Chat

## Goal

Give RP chat the same reasoning/chain-of-thought experience SillyTavern has: when a model emits a
`<think>...</think>`-wrapped span (or whatever tag pair is configured), it streams live into its
own collapsible block above the reply, is stored with the message, and is never resent to the
model on later turns. This was investigated directly against SillyTavern's own source
(`public/scripts/reasoning.js`, `ReasoningHandler`) rather than assumed — the design below mirrors
its actual behavior, adapted to BigImagine's server-authoritative architecture rather than ported
line for line.

## What SillyTavern Actually Does (reference, not a spec to copy code from)

- Reasoning is extracted from **two possible sources**: a provider's native structured field
  (`extractReasoningFromData` — OpenRouter's `reasoning`/`reasoning_content`, DeepSeek's
  `reasoning_content`, Claude's `thinking` content blocks, Gemini's `thought` parts), or **inline
  tag parsing** of the raw text stream when no structured field exists
  (`parseReasoningFromString`/`#autoParseReasoningFromMessage`, a configurable prefix/suffix pair
  per "reasoning template," default `<think>`/`</think>`).
- Either way, the result lands in the **same place**: `message.extra.reasoning` (plus
  `reasoning_duration`, `reasoning_type`), a field structurally separate from `message.mes` (the
  reply text) — never spliced back into the displayed/stored message string. Swipes carry their
  own reasoning (`swipe_info[i].extra.reasoning`).
- Rendered as a `<details class="mes_reasoning_details">` **sibling element above** `.mes_text`,
  with a `<summary>` showing "Thought for {duration}" plus edit/copy/delete actions, and a
  `.mes_reasoning` div holding the markdown-rendered reasoning text.
- Live streaming: every incoming token is re-classified — while inside an open tag, it's appended
  to the reasoning buffer and fades into `.mes_reasoning`; once the closing tag is seen, state
  flips to Done and the rest streams into `.mes_text` as normal. An `auto_expand` setting controls
  whether the block opens automatically.
- Reasoning is excluded from what gets resent to the model on later turns by default.

## Adapting This to BigImagine

The one structural difference that matters: `docs/plans/completed/rp-streaming-plan.md`'s own Principles
section already established that **text interpretation stays server-side** (bi_principles.md §2 —
"streamed deltas are relayed data, never interpreted by the frontend"), which is exactly why that
plan rejected a client-side DOM-patch approach for cleanup. ST has no choice but to parse in the
browser — it has no backend. BigImagine does, so the tag detection that ST does in
`reasoning.js` belongs in the orchestrator, not in `ChatView.tsx`. The frontend's job stays
"receive an already-classified delta, render it" — the same division of labor
`liveCleanup.ts`/`ChatView.tsx` already have for header/body/footer patches.

Everything else — separate storage field (not spliced into `content`), a `<details>` sibling above
the reply, live streaming into it, excluded from resent history — carries over directly.

## Scope: Inline Tag Parsing Only (v1)

No BigImagine LLM adapter currently exposes a provider's native structured reasoning field —
`rp-streaming-plan.md` explicitly scoped Anthropic extended-thinking content blocks out ("not used
by either adapter today... not introduced by this plan"), and the OpenAI-compatible adapter does
not read a `reasoning`/`reasoning_content` field off vendor chunks. Inline tag parsing is also the
higher-coverage path in practice: most OpenRouter/local reasoning models emit `<think>` tags
directly in the content stream regardless of whether a separate field also exists. This plan
covers inline tag parsing only; native structured-field normalization is future work (see Out of
Scope).

## Files

- `db/migrations/00XX_reasoning_blocks.sql` — created — adds a nullable `reasoning` text column to
  the assistant-message row and to `chat_message_swipes` (mirrors how content already varies
  per-swipe); no change to `content`'s own shape.
- `orchestrator/src/io/orchestratorSettings.ts` — modified — two new `SETTING_NAMES` entries,
  `reasoning_open_tag` / `reasoning_close_tag`, defaulting to `<think>` / `</think>`, following the
  exact pattern `cleanup_header_regex`/`cleanup_footer_regex` already use.
- `orchestrator/src/orchestrator/liveReasoning.ts` — created — the per-delta reasoning
  detector/splitter. Much simpler than `liveCleanup.ts`'s engine: a three-state machine
  (none/thinking/done), no LLM calls, no repairs — purely mechanical tag detection and text
  routing, in the same spirit as `cleanupHeuristics.ts`'s pure inspection functions.
- `orchestrator/src/orchestrator/streamingTurn.ts` — modified — wires the new detector into the
  existing per-delta loop (`runStreamingRpTurnInner`), alongside (not instead of) the live-cleanup
  hook; threads a new `onReasoningDelta` callback and returns the accumulated reasoning text +
  duration in `RunStreamingRpTurnResult`.
- `orchestrator/src/io/chatSessions.ts` — modified — `StoredChatMessage` gains an optional
  `reasoning` field; `appendMessages`, `recordSwipe`, and `recordSwipeIfContent` gain an optional
  `reasoning` parameter threaded alongside `content`; reads (`getChat`, swipe routes) return it.
- `orchestrator/src/server/handleChatCompletions.ts` — modified — the fresh-send streaming path:
  passes `onReasoningDelta` into `runStreamingRpTurn`, writes a new `bigimagine_reasoning` SSE
  frame per reasoning delta (same interleaving convention as the existing `bigimagine_cleanup`/
  `bigimagine_patch` frames), and passes the accumulated reasoning to `appendMessages`.
- `orchestrator/src/server/handleChats.ts` — modified — the swipe/regenerate streaming path: same
  `bigimagine_reasoning` frame emission, passes the accumulated reasoning to `recordSwipe`/
  `recordSwipeIfContent`.
- `orchestrator/src/server/turnExecution.ts` — modified — `regenerateSwipe`'s streaming branch
  threads the new callback and persists reasoning the same way `handleChats.ts` does.
- `frontend/src/api/types.ts` — modified — `StoredChatMessage`/`DisplayMessage` gain an optional
  `reasoning` field; a new type for the SSE frame (or reuse a simple `{ delta: string }` shape —
  see Contracts).
- `frontend/src/api/client.ts` — modified — `chatCompletion` and `consumeSseCompletionStream` gain
  an `onReasoningDelta` callback parameter, recognizing the new `bigimagine_reasoning` frame the
  same way `onCleanupPatch` already recognizes `bigimagine_patch`.
- `frontend/src/views/ChatView.tsx` — modified — a `<details>` block rendered as a sibling above
  `.markdown-content` (not inside the `ReactMarkdown` tree) for any message carrying `reasoning`;
  live per-message reasoning-buffer state while a send is in flight, filled by
  `onReasoningDelta`, mirroring how `onDelta` already fills the pending assistant bubble; a
  "Thought for {duration}" summary label once done.
- `frontend/src/views/ChatView.css` — modified — styling for the new block (collapsed/expanded
  chevron, muted/italic treatment distinct from the reply body, mobile-width layout per
  bi_principles.md §18).
- Settings UI (`frontend/src/views/CleanupView.tsx` or wherever the header/footer regex fields
  live) — modified — two new fields for the open/close tag pair, same editing pattern as the
  existing header/footer regex inputs.

## Logic

**Detection.** `liveReasoning.ts` exposes a small state machine driven by the same per-delta loop
`onLiveDelta` already runs on: `none` → `thinking` (the accumulated buffer's tail matches the
configured open tag) → `done` (the buffer, since the open tag, contains the configured close tag).
While `thinking`, every character arriving is reasoning text, not reply text — it must never reach
the ordinary content `onDelta`/SSE stream; only the reasoning callback sees it. The open and close
tag strings themselves are consumed, never relayed on either channel. Because RP turns are
single-shot (no tool rounds), a turn either produces zero or one reasoning span; a second `<think>`
opening after the first `</think>` closed is passed through as ordinary content, not treated as a
second reasoning span (matches the simple, non-multi-round case this plan covers — ST's own
handling of "continue" and manual re-opening is explicitly out of scope here, see Edge Cases).

Detection must work correctly whether it receives many small deltas (the normal streaming case) or
one delta containing the entire tagged span at once (the no-`completeStream` fallback, where
`complete()` degrades to a single whole-reply `onDelta` call) — the state machine is delta-size
agnostic, driven off the accumulated buffer's content, not off delta boundaries.

**Wiring.** `streamingTurn.ts`'s existing per-delta callback (`runStreamingRpTurnInner`, around
where `onLiveDelta` is invoked for cleanup) gains a sibling call into the reasoning detector,
independent of whether live cleanup is enabled for the chat — reasoning detection is not a
"cleanup" feature and must run unconditionally on every RP streaming turn (subject to the tag
actually appearing at all — a no-op otherwise, zero overhead for the overwhelming majority of
non-reasoning models). It is not gated by `skipLiveTriggers` the way header/body live triggers are
on turn 1 — there is no ordering dependency forcing it to wait.

**Timing.** The detector records the timestamp when the `thinking` state is entered and when
`done` is reached; the caller derives a duration in milliseconds from that pair, threaded through
to persistence and to the client for the "Thought for Xs" label.

**Wire frame.** A new SSE frame, interleaved with content chunks and the existing cleanup frames
exactly like `bigimagine_cleanup`/`bigimagine_patch` already are: `data:
{"bigimagine_reasoning": true, "delta": "..."}` per reasoning delta. A consumer that has never
heard of it (Open WebUI, any non-BigImagine client) ignores it, same guarantee the cleanup frames
already give.

**Persistence.** The accumulated reasoning text (trimmed) is passed alongside `content` to
whichever persistence call the turn was already making — `appendMessages` for a fresh send,
`recordSwipe`/`recordSwipeIfContent` for a swipe/regenerate. A turn with no reasoning span passes
`reasoning: undefined`/omits it, same optional-field convention `resolvedContent` and `swipes`
already use on `StoredChatMessage`.

**Never resent.** Because reasoning lives in its own column, not inline in `content`, the
prompt-stack's `recent_history` field — built from prior messages' `content` — never sees it. No
stripping step is needed; the separation is what makes exclusion free. This is the concrete payoff
of following ST's actual architecture (separate field) rather than an inline-`<details>`-in-
content alternative considered and rejected during planning.

**Rendering.** `ChatView.tsx` renders a `<details>` above `.markdown-content` whenever a message
has `reasoning` (persisted) or a live reasoning buffer (in-flight), collapsed by default once done,
matching the platform's existing `<details>/<summary>` "SillyTavern-style hidden text" convention
already documented at the `ReactMarkdown` call site — this is the same rendering idiom extended to
a first-class field instead of raw LLM-authored markdown. The reasoning text itself is still run
through the same markdown pipeline (`ReactMarkdown`, not raw HTML injection) inside that block.
While a send is in flight and the live buffer is in the `thinking` state, the block stays open;
once `done`, it collapses (mirrors ST's default off-after-done behavior — see Edge Cases for the
auto-expand question).

## Contracts

- **`StoredChatMessage.reasoning?: string`** (`orchestrator/src/io/chatSessions.ts`,
  `frontend/src/api/types.ts`) — present only when the turn produced a reasoning span; absent
  (never empty-string) otherwise, matching the `resolvedContent?`/`swipes?` convention already on
  this interface.
- **SSE frame**: `{"bigimagine_reasoning": true, "delta": string}` — one per reasoning delta,
  arriving interleaved with ordinary `choices[0].delta.content` chunks and the existing
  `bigimagine_cleanup`/`bigimagine_patch` frames, before the terminal `[DONE]`.
- **`appendMessages`/`recordSwipe`/`recordSwipeIfContent`** (`ChatSessionStore`) — each gains an
  optional `reasoning?: string` parameter alongside `content`, written to the new column on the
  same row/swipe the content lands in.
- **New DB columns**: nullable `text`, one on the assistant-message table, one on
  `chat_message_swipes` — never read by anything that builds `recent_history` or any other
  prompt-stack field.

## Edge Cases

- **No `completeStream` (fallback to `complete()`).** One whole-reply delta carries the entire
  tagged span (or none) — detection must handle this in one call, not just token-by-token (see
  Logic).
- **Stream aborted mid-`<think>`.** The turn's existing abort handling applies (nothing persisted,
  same as today); the reasoning buffer accumulated so far is simply discarded along with the
  content buffer — no special-casing needed.
- **Close tag never arrives (model cut off mid-thought).** Treat end-of-stream while still
  `thinking` as an implicit close: whatever was buffered becomes the persisted reasoning, with no
  reply content for that turn if the close tag genuinely never came — this is the same "blank
  reply" territory `streamingTurn.ts` already has a retry rule for, so confirm the interaction
  (does an all-reasoning, no-reply turn count as a blank reply and retry, or persist as reasoning
  with empty content?) before implementation — flagged for Reasonix to raise if the two rules
  conflict in practice.
- **Model doesn't use the configured tags at all.** The overwhelmingly common case — the detector
  never enters `thinking`, zero overhead, `reasoning` stays absent. No settings prompt or nag.
- **Tag configured but empty/misconfigured** (open or close tag blank). Detector treats this as
  "disabled" and never fires, matching `parseReasoningFromString`'s own "both prefix and suffix
  must be defined" guard.
- **A model emits literal `<think>` text as part of its actual in-character reply**, not as a
  reasoning marker (unlikely but possible with a creative-writing model). Not defensible without
  false positives either direction — accept this as a known tradeoff of tag-based detection,
  exactly as ST accepts it; the configurable tag pair lets a user pick something their specific
  model won't collide with.
- **Swipe/regenerate produces different reasoning (or none) than the swipe it replaces.** Each
  swipe's `reasoning` is independent, matching content's own per-swipe independence — cycling
  swipes shows that swipe's own reasoning (or none), not the previous swipe's.
- **Editing a message's content by hand (`editMessageContent`).** A user-typed edit has no
  reasoning behind it — clears `reasoning` for that row rather than leaving a stale block attached
  to text the user wrote themselves.
- **Auto-expand-while-thinking, then collapse-when-done vs. a user-configurable "always expand"
  setting** (ST has `power_user.reasoning.auto_expand`). Default to collapse-on-done per this
  plan's Logic section; whether to add a BigImagine equivalent toggle is a small enough addition
  that Reasonix can include it if trivial, or flag it back if it meaningfully grows scope.

## Tests

- `liveReasoning.ts`'s state machine: enters `thinking` on the open tag appearing (across delta
  boundaries, not just within one), enters `done` on the close tag, routes text to the correct
  channel in each state, is a no-op end to end when the tag never appears, handles the
  single-whole-reply-delta case identically to the token-by-token case.
- `streamingTurn.ts`: a scripted stub turn containing a `<think>...</think>` span produces the
  expected split between relayed content and relayed reasoning, in order; a turn with no tags is
  byte-identical to today's behavior (regression guard).
- Persistence: a fresh send and a swipe/regenerate both land `reasoning` on the correct row/swipe;
  a turn with no reasoning leaves the column null, not empty string.
- Server end-to-end (extending `verify-server.mjs`'s streaming assertions): `POST
  /v1/chat/completions` with `stream: true` against a stub turn containing tags produces
  `bigimagine_reasoning` frames before `[DONE]`, and the persisted message's `reasoning` matches
  the concatenated frames.
- Prompt-stack regression: a chat with reasoning-bearing history assembles `recent_history`
  byte-identical to the same history without reasoning — proves the exclusion is real, not
  accidental.

## Out of Scope

- Native structured provider reasoning fields (Anthropic extended-thinking content blocks,
  OpenRouter's separate `reasoning` JSON field, DeepSeek's `reasoning_content`) — v1 is inline tag
  parsing only, see Scope above.
- "Hidden reasoning model" affordances (ST's `isHiddenReasoningModel` — a lightbulb icon for
  known CoT-hiding models like o1/o3) — BigImagine has no per-connection model-capability registry
  to key this off today.
- Editing reasoning text by hand, or manually adding a reasoning block to a message that has none
  (ST's `mes_edit_add_reasoning` affordance) — display and live-capture only.
- Per-profile/per-connection tag configuration — one global tag pair, matching the existing
  header/footer regex config's scope (not per-connection).
- Any change to `chat`-kind (household) turns — reasoning blocks are RP-lane only, same boundary
  `completeStream` itself already draws.
- A settings toggle to resend some recent turns' reasoning to the model (ST's
  `reasoning.add_to_prompts`/`max_additions`) — explicitly decided against for this plan (never
  resent, no exceptions).

## Principles / Conventions in Play

- `bi_principles.md` §2 (The LLM Reasons; Nothing Else Does) — tag detection is mechanical string
  classification, not judgment, but it still stays server-side per the existing precedent
  `rp-streaming-plan.md` already set for exactly this reason (see "Adapting This to BigImagine").
- §6 (Reasoning Layer is Replaceable) — the tag pair is configuration, not a hardcoded assumption
  about one vendor's convention; a connection whose model never emits the tags degrades to no-op,
  not a failure.
- §8 (Four Kinds of Code) — `liveReasoning.ts` is a Pure-Function-flavored detector (no IO, no LLM
  calls) even though it lives in `orchestrator/` alongside the impure `liveCleanup.ts`; keep the
  state machine itself pure and let `streamingTurn.ts` (the Orchestrator) own wiring it to IO.
- §10 (Size Budget) — a dedicated file rather than growing `liveCleanup.ts` or `streamingTurn.ts`
  past their own budgets, same reasoning `liveCleanup.ts` itself documents for why it's not folded
  into `streamingTurn.ts`.
- §13 (Runtime Config in DB) / §17 (Surfaced Prompts) — the tag pair is DB-backed and editable from
  Settings, matching `cleanup_header_regex`/`cleanup_footer_regex`'s existing pattern exactly.
- Cache-prefix stability — excluding `reasoning` from `recent_history` by construction (separate
  column, never read by the assembler) keeps the assembled stack's cache-prefix byte-identical to
  today's for any chat that never had reasoning history, and deterministic either way.
- §18 (Mobile-First) — the reasoning block must collapse/expand cleanly and stay legible at phone
  width, same bar the existing message bubble and `<details>` spoiler convention already meet.
