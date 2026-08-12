# In-Stream Cleanup — Per-Region Live Repair + Three-Pill Status

*Status: implemented — commits `95714a0` ("in-stream cleanup: live header/body/footer repair
during streaming") and `deb88a5` ("in-stream cleanup validation fixes") shipped this.*

## Goal

Move the cleanup subloop's header, body (slop), and footer checks from a single post-hoc pass
(the 5s poll tick, `cleanupLoop.ts`) into the live turn itself, each region triggered at the
earliest moment it can honestly be judged — header as soon as its two lines have landed, body
per completed paragraph (TRG's own regex-per-paragraph model), footer once the last token lands
— with the raw stream never delayed for any of it (`rp-streaming-plan.md`'s "I like it raw" stays
true: cleanup only ever *follows up* on text already shown, via a patch, never withholds it). The
single `CleanupStatusPill` is replaced with three independent pills (header / body / footer),
each grey when nothing was called, red while a repair is in flight or stuck, green once a repair
has been applied. This is the follow-on plan `rp-streaming-plan.md`'s Non-Goals deferred, now that
the shared streaming core (`runStreamingRpTurn`) it depends on is built and proven.

## Scope

RP lane only, same as `rp-streaming-plan.md` — cleanup has always been RP-only
(`cleanupLoop.ts`'s own roster query: `kind = 'rp'`). Applies to both entry points that already
share `runStreamingRpTurn` (send and swipe) — cleanup gets this for free from the same
send-equals-swipe core, the same way streaming itself did.

## Background

- `cleanupLoop.ts` today runs one atomic pipeline per due message: `planCleanup` produces a
  `CleanupPlan` covering header status, footer status, and slop steps together; every step is
  dispatched serially; the outcome is recorded as **one** `cleanup_jobs` row per (message, swipe)
  with a single `status`/`changed`. The pill (`CleanupStatusPill.tsx`) polls
  `GET /v1/cleanup/status` every 5s and shows that one composite state.
- `cleanupHeuristics.ts` is already a pure, stateless decision engine — `inspectHeader`,
  `inspectFooter`, and the paragraph utilities (`extractParagraph`/`collectUniqueParagraphs`,
  direct TRG ports) all operate on whatever string they're handed. Nothing about them assumes
  the string is a *complete* reply — that assumption lives entirely in *when* `cleanupLoop.ts`
  chooses to call them (today: only once, after the full message is persisted).
- `runStreamingRpTurn` (`streamingTurn.ts`) already relays every delta to the caller's `onDelta`
  as it arrives, with nothing buffered except the existing turn-1 special case
  (`firstLlmTurn` in `handleChatCompletions.ts`, which fully buffers and repairs the header
  synchronously before ever streaming anything — `ensureFirstTurnHeader.ts`). That precedent —
  repair before persistence, no original swipe kept — already exists for exactly one case; this
  plan is substantially that precedent generalized to header/body/footer, for every turn, live.
- `handleChatCompletions.ts` / `handleChats.ts` already have a place to hang new SSE frame types:
  `rp-streaming-plan.md` established the additive-frame pattern (`bigimagine_error`) for exactly
  this reason — a frame type any client that's never heard of it can safely ignore.

## Non-Goals (deferred, not forgotten)

- **Retiring `cleanupLoop.ts`'s poll tick.** Stays on, unconditionally, as the fail-open safety
  net for: a connection whose adapter has no `completeStream` (falls back to one whole-reply
  delta — nothing streams live, so nothing can be caught live either); an orchestrator crash mid
  turn; and the one slop-action kind this plan can't run live (`'llm'`, whole-message rewrite —
  see Logic). Its existing `(message_id, swipe_id, region)` dedup (widened by this plan, see
  Contracts) already makes re-checking an already-covered region free.
- **Changing the "original is always kept as a swipe" guarantee.** The persisted result of a
  live-cleaned turn is written exactly the way `cleanupLoop.ts` writes it today: the raw reply as
  swipe #0, the cleaned composite as a later swipe, in one atomic writeback — see Logic. Live
  cleanup changes *when* repairs are decided and previewed, not the durable record's shape.
- **Turn 1 of a new chat.** Already fully buffered and header-repaired synchronously
  (`ensureFirstTurnHeader.ts`, `firstLlmTurn`) before anything streams. This plan's early-header
  and live-body triggers are not engaged for turn 1 — there is no live stream to react to yet.
  Footer-at-end and the end-of-stream body pass still apply, since turn 1's buffered send still
  goes through the shared persistence handoff (see Logic) before it's sent.
- **The Cleanup page's setup surface or its slop-rule table.** Unchanged — same regexes, same
  prompts, same admin-gated settings.
- **A visual redesign of the pill beyond the three-way split.** Same shape/placement, same
  click-to-run-now interaction, just three instances instead of one.

## Files

- `db/migrations/0090_cleanup_per_region_jobs.sql` — created — widens `cleanup_jobs` with a
  `region` column (`'header' | 'body' | 'footer'`) and replaces the unique index with
  `(message_id, swipe_id, region)`, so one message/swipe now carries up to three job rows instead
  of one. See Contracts.
- `orchestrator/src/orchestrator/cleanupHeuristics.ts` — modified — gains one new pure export,
  `nextCompletedParagraph(buffer, fromOffset)`, the newline-boundary scan the live body trigger
  needs (returns the next newline-bounded paragraph starting at or after `fromOffset`, or `null`
  if none has closed yet) — a small sibling to the existing `extractParagraph`, same TRG lineage.
  Nothing else here changes; `inspectHeader`/`inspectFooter`/`evaluateSlopRules` already work
  against a partial buffer as-is.
- `orchestrator/src/orchestrator/cleanupLiveStatus.ts` — created — the in-memory, per-chat,
  per-region "what's happening right now" map, modeled directly on `turnStatus.ts`: an ambient
  hint for the pill while a turn is actively streaming, not the canonical record (a lost entry on
  restart is fine — the settled job rows are the real source of truth once the turn ends).
- `orchestrator/src/orchestrator/cleanupLoop.ts` — modified — `processDueMessage`'s single
  writeback + single `recordJob` call becomes: one atomic writeback of the composed final text
  (unchanged), followed by up to three `recordJob` calls, one per region actually evaluated. The
  writeback + per-region job-recording step is extracted into a new exported function,
  `finalizeCleanupResult(...)` (see Contracts), so the live path (below) calls the exact same
  code the poll tick does — one persistence implementation, not two. `CleanupMessageState`,
  `CleanupStatus`, and `getCleanupStatus` are reshaped to report three regions instead of one
  (see Contracts). Two helpers the live path needs become exported here: `dispatchStep` (was
  module-private; unchanged behavior) and a new `loadRecentHistory(db, userId, chatId)` — the
  last `HISTORY_READ_LIMIT` messages before the current turn, no messageId boundary (the live
  turn's assistant message doesn't exist yet). The module-level in-flight guard gains two
  exported helpers `claimCleanupInFlight` / `releaseCleanupInFlight` that accept a `'*'` swipe
  (wildcard) key, and `processDueMessage`'s guard check honors the wildcard — the live path
  holds `(chatId, messageId, *)` from stream start through `finalizeCleanupResult` so the 5s
  tick can never launch a duplicate repair pass on a message the live path is still finishing
  (see Logic → Persistence handoff). `findDueMessages`'s dedup becomes all-three-regions: a
  message is due until its active swipe has one `cleanup_jobs` row for each of `header`/`body`/
  `footer` — so a live-handled message that crashed between `recordJob` calls stays visible to
  the fail-open tick.
- `orchestrator/src/orchestrator/liveCleanup.ts` — created — the incremental engine:
  `checkHeaderEarly`, `checkBodyParagraph` (called each time a new paragraph boundary closes),
  and `finishStream` (footer inspection + the one `'llm'`-action slop pass, both of which need
  the complete text). Each function inspects via `cleanupHeuristics.ts`, dispatches a repair via
  `cleanupLoop.ts`'s existing `dispatchStep` (exported, unchanged), updates
  `cleanupLiveStatus.ts`, and reports a patch (if the region changed) or a status transition via a
  caller-supplied event callback. Accumulates the three regions' outcomes so `finishStream` can
  hand them straight to `finalizeCleanupResult`.
- `orchestrator/src/orchestrator/streamingTurn.ts` — modified — `runStreamingRpTurn` drives
  `liveCleanup.ts` alongside its existing raw-delta relay: every delta is still forwarded to the
  caller's `onDelta` completely unchanged and undelayed (cleanup never gates what's shown), and
  is *also* appended to an internal composed buffer that `liveCleanup.ts` inspects (the buffer is
  byte-identical to what the caller's `onDelta` accumulation has produced so far — raw deltas
  plus every patch already emitted — so patch offsets are always valid in both coordinate
  spaces). Gains new required deps (`settings`, the same `OrchestratorSettingsStore`
  `cleanupLoop.ts` reads config from; a `chats` handle for history, matching `CleanupLoopDeps`),
  a new optional `onCleanupEvent` callback, and a `skipLiveTriggers` flag (see Contracts). The
  per-delta live hooks reset their buffer and region state on every blank-reply retry attempt,
  mirroring `relayedText`'s reset, so offsets never diverge from what the client accumulated.
  `runStreamingRpTurn` does **not** run `finishStream` or persistence itself: it returns the
  composed buffer + live region outcomes alongside the existing `{content, usage}`, and the
  caller drives `appendMessages`/`recordSwipe` → `finishStream` → `finalizeCleanupResult` — the
  raw reply must be durable before any further LLM-calling cleanup work is attempted, so a
  finishStream failure never costs the turn its already-streamed reply. Turn 1's
  `ensureFirstTurnHeader` must run between the stream and the persist call, which only the caller
  can sequence.
- `orchestrator/src/server/handleChatCompletions.ts` — modified — passes `onCleanupEvent` through
  to `runStreamingRpTurn`, translating each event into a `bigimagine_cleanup` (status) or
  `bigimagine_patch` (content) SSE frame, interleaved with the existing delta frames. After the
  stream resolves, drives the persistence handoff itself (the stream core deliberately does not,
  see streamingTurn below): for `firstLlmTurn`, `ensureFirstTurnHeader` runs first and its
  output is the base text for `finishStream` and the `expectedContent` for `finalizeCleanupResult`
  (the header region outcome is attributed from `ensureFirstTurnHeader`'s result — deployed if it
  repaired, not-called otherwise); for every other turn the raw streamed text is persisted via the
  existing `appendMessages` call and `finalizeCleanupResult` writes the composed text as the next
  swipe, exactly the way the poll tick does. Either way the message never waits for the next poll
  tick.
- `orchestrator/src/server/turnExecution.ts` — modified — `regenerateSwipe` (the actual
  `runStreamingRpTurn` call site for the swipe route) passes `onCleanupEvent` through to
  `runStreamingRpTurn` and, once the stream resolves and `recordSwipe` has persisted the raw
  text, calls `liveCleanup.finishStream` + `finalizeCleanupResult` with the turn's accumulated
  region outcomes — the send/swipe equivalence `rp-streaming-plan.md` established carries
  through to cleanup.
- `orchestrator/src/server/handleChats.ts` — modified — the swipe route forwards the same
  `onCleanupEvent` callback into `regenerateSwipe` (alongside the existing `onDelta`) and
  translates the events into `bigimagine_cleanup` / `bigimagine_patch` SSE frames, mirroring
  `handleChatCompletions.ts` exactly.
- `orchestrator/src/server/handleCleanup.ts` — modified — `handleCleanupStatus`'s response now
  carries three region entries (reshaped `getCleanupStatus`); routing/auth unchanged.
- `frontend/src/api/types.ts` — modified — `CleanupStatus`/`CleanupMessageState` reshaped to
  per-region; two new SSE frame types (`CleanupStatusFrame`, `CleanupPatchFrame`).
- `frontend/src/api/client.ts` — modified — `consumeSseCompletionStream` (and therefore
  `chatCompletion`/`swipeMessage`) parse the two new frame types and forward them through new
  optional `onCleanupStatus`/`onCleanupPatch` callback params, alongside the existing
  `onDelta`/`onTerminalFrame`.
- `frontend/src/components/cleanup/CleanupStatusPill.tsx` — modified — becomes a component that
  renders three small pills (`h` / `b` / `f`) from a per-region status object instead of one pill
  from a single state; same polling fallback (`getCleanupStatus`) for the settled state, plus a
  live override while a stream with cleanup events is active. `CleanupStatusPill.css` updated for
  the three-up layout.
- `frontend/src/views/ChatView.tsx` — modified — wires `onCleanupStatus`/`onCleanupPatch` from
  `send()`/`swipe()` into the three-pill component's live state and into the in-progress
  assistant placeholder's content (a patch splices into the accumulated string by offset, the same
  span-based approach `cleanupHeuristics.ts` already uses server-side).
- `orchestrator/scripts/verify-cleanup-heuristics.mjs` — modified — assertions for
  `nextCompletedParagraph`.
- `orchestrator/scripts/verify-cleanup-loop.mjs` — modified — `finalizeCleanupResult` records
  three job rows (not always all three "changed" — most turns need none of them); `getCleanupStatus`
  returns three regions.
- `orchestrator/scripts/verify-live-cleanup.mjs` — created — drives `liveCleanup.ts` directly
  (stub LLM + fake pool + a scripted delta sequence), asserting trigger timing and event ordering
  per region. See Tests.
- `orchestrator/scripts/verify-server.mjs` — modified — end-to-end: a streaming RP turn whose raw
  reply has a malformed header produces a `bigimagine_cleanup` "in-flux" frame early (before the
  stream ends) followed by a `bigimagine_patch` frame for the header region, and the persisted
  message + `cleanup_jobs` rows reflect the repair. See Tests.
- `orchestrator/package.json` — modified — adds `verify-live-cleanup.mjs` to the `verify` chain.

## Logic

**Header — early.** `runStreamingRpTurn`'s internal buffer is checked after every delta while no
header verdict has been reached yet: once the buffer contains two newline characters (both
candidate header lines are fully formed, whatever their content), or 400 characters have arrived
with *zero* newlines (nothing header-shaped can be mid-formation — judge on what's there rather
than wait forever), `cleanupHeuristics.inspectHeader` runs against that prefix. The one guarded
case: at 400 characters with *exactly one* newline, the check fires only when `inspectHeader`
reports `'missing'` (no header-in-progress evidence); a `'malformed'` verdict means a genuine
header may still be streaming (an open `Present:` line, a bracket-opened first line) — patching
over it would leave the rest of that header to append *after* the repair, garbling the composed
text, so in that case the engine waits for the second newline (or the stream's end) instead. `'ok'` → the region
stays `not-called`, done for the turn (header appears exactly once, at position 0). Otherwise →
`in-flux`, and a repair `complete()` call fires immediately, concurrently with the main stream
still generating (a second, independent LLM call under the same `runWithCallContext` /
`registerTurnAbort` signal as the turn itself — no new concurrency machinery, just a second
in-flight promise, the same way `dispatchStep` already fires one call per step today). Because the
header repair fires before the rest of the reply exists, its `{{message}}` is whatever prefix
triggered the check (typically just the malformed attempt) — the prompt leans on `{{history, N}}`
for the roster/scene-state context it needs, not on a reply that doesn't exist yet. This is the
one deliberate accuracy trade-off in exchange for early feedback; see Edge Cases. Once the repair
resolves: non-empty output → `deployed`, and a `bigimagine_patch` frame is sent with the span of
raw header text originally relayed to the client, so the visible text corrects itself in place
(TRG's flash-then-patch, not a delay). Empty/errored output → `flagged`; the raw header stays
displayed as-is (fail-open, same as today).

**Body — live, per paragraph, regex-powered like TRG.** Each time a new delta closes a paragraph
(`nextCompletedParagraph` finds a fresh newline-bounded span), the engine runs the enabled
`'remove'` and `'replace-paragraph'` slop rules against exactly that paragraph.
`'remove'` matches are deterministic and apply immediately — patched in with no LLM round trip.
`'replace-paragraph'` matches fire one `dispatchStep` call for that paragraph (unchanged
mechanism from `cleanupLoop.ts`, just triggered per-paragraph instead of over the whole message at
once) — `in-flux` while it's out, `deployed` + a patch frame once it returns non-empty,
`flagged` if it comes back empty. `'llm'` (whole-message) rules are the one action this can't run
live — they need the complete final text — so they're deferred to `finishStream`. The body pill
tracks the union: `in-flux` if any paragraph repair is currently out, `deployed` if at least one
paragraph was ever patched this turn (and nothing is still out), `flagged` if any paragraph repair
failed and nothing later fixed the same span, `not-called` if the whole reply produced no matches
at all.

The reply's final paragraph has no trailing newline, so no live trigger ever sees it close.
`finishStream` therefore re-runs the body pass (`remove` + `replace-paragraph`) against the
complete final text — catching that tail paragraph, and for turn 1 (where live body triggers are
skipped) the whole body. The body region outcome is the union of the live and tail results.

Patch spans are always expressed in **current-composed coordinates**: the server's composed
buffer is byte-identical to what the client has accumulated, and a `replace-paragraph` repair
re-locates its paragraph in that buffer (re-running `collectUniqueParagraphs` with the rule's
pattern and matching the stored paragraph's start/text) when its LLM call resolves — earlier
`remove`/header patches may have shifted offsets since dispatch, so the span is computed at
emission time, never captured at dispatch time. Both sides splice the same span at the same
moment, in the same order, keeping the invariant intact.

**Footer — once the last token lands.** `finishStream` (called when the stream itself ends, before
persistence) runs `inspectFooter` and the deferred `'llm'`-action slop check against the complete
final text (already carrying every live header/body patch). Same `dispatchStep` mechanism, same
three-way outcome. A footer repair's output is spliced into the final text server-side before
persistence — there is no "already streamed, needs patching" concern here the way there is for
header/body, since the client only sees the fully-composed text via the normal delta stream that's
already in flight; if the footer's repair changes trailing text the client already received as raw
deltas, that still needs one `bigimagine_patch` frame, sent just before the turn's normal `stop`
chunk.

**Persistence handoff — one shared implementation.** Whichever path caught a region — live, or the
poll tick catching whatever the live path couldn't (no `completeStream`, a crash, an `'llm'`-action
rule if `finishStream` itself never ran) — writes back through the same `finalizeCleanupResult`:
one atomic writeback of the composed final text (original stays swipe #0, composed text becomes
the next swipe, exactly `recordSwipeIfContent`'s existing contract), then one `recordJob` call per
region that was evaluated (three, ordinarily), each carrying that region's own
`status`/`changed`/`notes`. A message the live path fully handled is therefore indistinguishable,
in `cleanup_jobs`, from one the poll tick caught — the tick's widened dedup (a message is due
until its active swipe has one row per region) simply finds nothing left to do.

Because the live path's `finishStream` and the tick both fire against the same freshly-persisted
message, the live path holds the loop's in-flight guard for `(chatId, messageId, *)` from stream
start through `finalizeCleanupResult` (wildcard swipe — the messageId is pre-generated before
streaming starts; the swipeId isn't known until `ensureActiveSwipe`/`recordSwipe` runs).
`processDueMessage`'s guard check honors the wildcard key, so the 5s tick skips the message for
the whole live span instead of launching a full duplicate repair pass in the window between
`appendMessages` and `finalizeCleanupResult` (the message is persisted with no job rows yet) —
the 2026-08-08 runaway class, pre-empted rather than papered over by `recordSwipeIfContent`'s
content guard.

**Live status vs. settled status.** While a turn is streaming, the three pills read
`cleanupLiveStatus.ts` (pushed live via the new SSE frames — no polling needed for an active
turn). For any client that polls mid-turn (the Cleanup page, a pill that joined after the first
frames), `getCleanupStatus` overlays the live map's per-chat regions on top of the settled rows,
so a polling read never shows stale `not-called` while a repair is actually in flight. Once
`finalizeCleanupResult` writes the settled job rows, the live path clears `cleanupLiveStatus.ts`'s
entry for that chat and the existing 5s poll becomes authoritative again — the same
ambient-hint-then-canonical-record handoff `turnStatus.ts` already models for the "thinking"
indicator.

## Contracts

- `cleanup_jobs` (migration 0090):
  ```sql
  alter table cleanup_jobs add column region text not null default 'header'
    check (region in ('header', 'body', 'footer'));
  drop index cleanup_jobs_msg_swipe;
  create unique index cleanup_jobs_msg_swipe_region on cleanup_jobs (message_id, swipe_id, region);
  ```
  (The `default 'header'` only satisfies the `not null` constraint for any pre-migration rows —
  every row written from this plan onward always sets `region` explicitly. Migrations are
  append-only per existing convention; old rows are not backfilled to a "correct" region.)
- `CleanupRegionState` (`orchestrator/src/orchestrator/cleanupLoop.ts`):
  ```
  type CleanupRegionState = 'not-called' | 'in-flux' | 'deployed' | 'flagged';
  ```
- `CleanupStatus` (replaces today's single-`latest` shape):
  ```
  interface CleanupStatus {
    enabled: boolean;
    pending: number;
    latest: {
      messageId: string;
      regions: {
        header: { state: CleanupRegionState };
        body:   { state: CleanupRegionState };
        footer: { state: CleanupRegionState };
      };
    } | null;
  }
  ```
  The per-region states live under `latest` because they describe the newest eligible message —
  the pill's `onSettled` one-shot keys on `messageId`, which a top-level `regions` would lose.
  The states are never `null` (a missing row maps to `not-called` or `in-flux`); `latest: null`
  still means "no eligible message yet", mirroring today's shape. (Implementation refinement of
  the initial contract sketch, applied 2026-08-12.)
- `finalizeCleanupResult` (`orchestrator/src/orchestrator/cleanupLoop.ts`, exported):
  ```
  function finalizeCleanupResult(
    deps: CleanupLoopDeps,
    userId: string, chatId: string, messageId: string,
    originalContent: string, composedContent: string,
    regionOutcomes: Array<{ region: 'header'|'body'|'footer'; status: 'done'|'flagged'|'error'; changed: boolean; notes: string }>,
  ): Promise<void>
  ```
- `runStreamingRpTurn`'s new `onCleanupEvent` (`orchestrator/src/orchestrator/streamingTurn.ts`):
  ```
  onCleanupEvent?: (event:
    | { kind: 'status'; region: 'header'|'body'|'footer'; state: CleanupRegionState }
    | { kind: 'patch'; region: 'header'|'body'|'footer'; start: number; end: number; replacement: string }
  ) => void
  ```
  `start`/`end` are character offsets into the accumulated text as the caller has assembled it via
  `onDelta` so far — the same coordinate space `cleanupHeuristics.ts`'s spans already use.
- **New SSE frame types**, additive alongside the existing `bigimagine_error` terminal frame,
  interleaved with normal content-delta frames (not just before `[DONE]`):
  ```
  data: {"bigimagine_cleanup": true, "region": "header"|"body"|"footer", "state": "not-called"|"in-flux"|"deployed"|"flagged"}

  data: {"bigimagine_patch": true, "region": "header"|"body"|"footer", "start": number, "end": number, "replacement": string}
  ```
  Any consumer that doesn't recognize these fields ignores them, same contract
  `bigimagine_error` established — never a normal content chunk, never `[DONE]`.
- `nextCompletedParagraph` (`orchestrator/src/orchestrator/cleanupHeuristics.ts`):
  ```
  function nextCompletedParagraph(buffer: string, fromOffset: number): Paragraph | null
  ```
- Exports from `cleanupLoop.ts` (all were module-private before this plan): `dispatchStep`
  (unchanged behavior — live repair dispatch is the exact same function the poll tick uses), and
  `loadRecentHistory(db, userId, chatId)` (last `HISTORY_READ_LIMIT` messages before the current
  turn, no messageId boundary — the live repair prompts' `{{history, N}}`).
- In-flight guard helpers (`cleanupLoop.ts`):
  ```
  claimCleanupInFlight(chatId: string, messageId: string, swipeId: string | '*'): boolean
  releaseCleanupInFlight(chatId: string, messageId: string, swipeId: string | '*'): void
  ```
  `processDueMessage` checks both its exact `(chatId, messageId, swipeId)` key and the wildcard
  `(chatId, messageId, '*')`; the live path holds the wildcard across the whole live span.
- Settled job-row → region-state mapping (`getCleanupStatus`, replacing the old
  `thinking`/`unchanged`/`modified` composite): `done` + `changed` → `deployed`;
  `done` + `!changed` → `not-called`; `flagged`/`error` → `flagged`; no row → `not-called`,
  except no row while the `(chat, message, swipe)` triple is in the in-flight guard → `in-flux`
  (preserves the old red "thinking" meaning for the polling-only path).
- `recordJob` / `recordJobForActiveSwipe` insert a `region` value and conflict on
  `(message_id, swipe_id, region)` — the migration 0090 unique index is the concurrency guard.
- `runStreamingRpTurn`'s result gains the live-cleanup handoff (streamingTurn.ts):
  ```
  { content: string; usage?: LlmUsage; cleanup?: { composed: string; liveOutcomes: RegionOutcome[] } }
  ```
  where `RegionOutcome = { region: 'header'|'body'|'footer'; state: CleanupRegionState }`.
  The caller runs `liveCleanup.finishStream(baseText)` (baseText = `ensureFirstTurnHeader`'s
  output for turn 1, else `composed`) and then `finalizeCleanupResult`.

## Edge Cases

- **Header repair fires before the reply exists.** Its `{{message}}` is necessarily partial (see
  Logic) — accepted trade-off for early feedback per the explicit design direction; the repair
  leans on `{{history, N}}`, which is unaffected.
- **Two (occasionally three) LLM calls in flight for one turn** — the main generation plus a
  concurrent header repair, plus possibly a paragraph repair. Uses the gate's existing
  `llm_gate_max_concurrent` lane admission unchanged; this plan doesn't raise any cap, it just
  spends more of the existing one per turn than before.
- **Abort mid-turn.** Any in-flight header/body/footer repair call shares the same
  `AbortController`/signal `registerTurnAbort` already provides for the turn — one Stop cancels
  everything, exactly like `dispatchStep`'s existing abort handling in the poll-tick path.
- **A paragraph edited by a later `'remove'` rule after an earlier live patch already applied.**
  `evaluateSlopRules`'s ordering (set, then position) is preserved per-paragraph the same way it
  is today for the whole message — rules are applied in order against that paragraph's live text,
  not against a stale snapshot.
- **`'llm'`-action slop rules never run live** — they rewrite the whole message and are terminal;
  deferred to `finishStream`, same as they'd be missed entirely by a naive live-only design.
- **A connection with no `completeStream`.** Nothing streams live, so nothing can be checked live
  either — `runStreamingRpTurn`'s existing single-whole-reply-delta fallback simply never invokes
  `liveCleanup.ts`'s per-delta hooks; the poll tick catches the whole message afterward, unchanged
  from today's behavior for this case.
- **Turn 1.** Not engaged for header/body live triggers (see Non-Goals); footer-at-end and the
  deferred `'llm'`-action pass still run once the buffered send resolves, through the same
  `finishStream`/`finalizeCleanupResult` handoff every other turn uses.
- **A region settles between an SSE poll and the live-status clear.** `getCleanupStatus`'s existing
  best-effort semantics (`CleanupStatusPill.tsx`'s comment: "a failed poll keeps the last-known
  state") already tolerate a brief window where live and settled status disagree; no new handling
  needed.
- **Blank-reply retry mid-stream.** The live buffer and per-region state reset on every retry
  attempt, mirroring `relayedText`'s reset — so patch offsets never diverge from what the client
  accumulated (attempt-1 whitespace is not part of the buffer the repair spans are computed
  against), and a whitespace-only first attempt can't fire a spurious header repair. Rare
  cosmetic case otherwise unchanged from `rp-streaming-plan.md`.
- **The 400-char cap vs. a still-forming genuine header.** With exactly one newline at the cap,
  the check fires only on `'missing'` — a `'malformed'` prefix (open `Present:` line,
  bracket-opened first line) waits for the second newline, so a long-but-real header is never
  patched over (see Logic → Header).
- **The final paragraph never closes live.** `finishStream`'s end-of-stream body pass catches the
  tail paragraph (and turn 1's whole body); without it a dirty tail would be permanently missed,
  because the tick's all-three-regions dedup would treat the body region as covered.
- **The tick vs. the live path on the same message.** The live path's wildcard in-flight guard
  (see Logic → Persistence handoff) keeps the 5s tick from launching a duplicate repair pass in
  the appendMessages→finalizeCleanupResult window; `recordSwipeIfContent`'s content guard and the
  `(message_id, swipe_id, region)` ON CONFLICT remain the writeback-level backstops.
- **Turn 1 attribution.** `ensureFirstTurnHeader` output is the base for `finishStream` and the
  `expectedContent` for `finalizeCleanupResult`; the header region outcome is recorded as
  deployed/not-called from `ensureFirstTurnHeader`'s own result, and live header/body triggers
  are skipped (`skipLiveTriggers`), so the composed swipe always carries the same header as
  swipe #0.

## Tests

- **`cleanupHeuristics.mjs`**: `nextCompletedParagraph` returns the correct paragraph at a
  newline boundary, `null` before one exists, and correctly advances `fromOffset` across
  multiple closed paragraphs in one buffer.
- **`verify-live-cleanup.mjs`** (new, stub LLM + fake pool + a scripted delta sequence): header
  check fires exactly once, at the two-newline boundary (or the 400-char cap) and not before;
  the cap with one newline fires only on `'missing'` (waits on `'malformed'`); a malformed
  header produces `in-flux` then `deployed` + a patch event with the header's own span; body
  `'remove'` matches patch with no LLM call; `'replace-paragraph'` matches dispatch a repair
  scoped to just that paragraph, and its patch span is re-located in the composed buffer when an
  earlier patch has shifted offsets; the final unterminated paragraph is only caught by
  `finishStream`'s tail body pass; an `'llm'`-action rule is never dispatched until
  `finishStream`; footer inspection only runs in `finishStream`; a blank-reply retry resets the
  buffer and never fires a spurious header repair; abort mid-repair cancels the in-flight call
  and reports no `deployed`/`flagged` transition for that region.
- **`verify-cleanup-loop.mjs`**: `finalizeCleanupResult` writes one composed-text swipe and up to
  three `cleanup_jobs` rows (one per region), each independently `done`/`flagged`/`error`;
  `getCleanupStatus` returns three regions, `null` when there's no eligible message.
- **`verify-server.mjs`** (real sockets): a streaming RP turn with a malformed raw header produces
  a `bigimagine_cleanup` "in-flux" frame for `region: "header"` before `[DONE]`, followed by a
  `bigimagine_patch` frame, and the persisted message + `cleanup_jobs` rows reflect the repair;
  the equivalent swipe-route case (send/swipe parity); a turn needing no repairs at all produces
  no patch frames and three `not-called`→`deployed`-never/`flagged`-never (i.e. stays
  `not-called`) region outcomes.

## Out of Scope

- Retiring `cleanupLoop.ts`'s poll tick — stays as the fail-open safety net (see Non-Goals).
- Changing the original-always-a-swipe guarantee.
- Any change to the Cleanup page's setup surface (header/footer prompts, slop-rule table).
- Streaming/live cleanup for `chat`-kind (non-RP) turns — cleanup has always been RP-only.
- A visual redesign of the pill beyond three instances instead of one.

## Principles / Conventions in Play

- `bi_principles.md` §1 (Relational Store is Canonical) — `cleanupLiveStatus.ts` is explicitly an
  ambient hint, not the record; the settled `cleanup_jobs` rows (written through the same
  `finalizeCleanupResult` either path uses) remain the only durable truth.
- §2 (LLM Reasons; Nothing Else Does) — patch frames carry LLM-produced or deterministic-regex
  text only; the frontend never decides what to patch, only where to splice what the server sent.
- §6 (Reasoning Layer is Replaceable) — a connection with no `completeStream` degrades to "nothing
  live, poll tick catches it later," not a broken turn.
- §8 (Four Kinds of Code) — `liveCleanup.ts` and `cleanupLiveStatus.ts` split the same way
  `turnStatus.ts`/`loop.ts` already do: a tiny Stateful Owner for the ambient map, an Orchestrator
  for the sequencing, pure decision logic staying in `cleanupHeuristics.ts`.
- §10 (Size Budget) — `cleanupLoop.ts` and `streamingTurn.ts` are already near or over budget;
  the incremental engine is its own new file rather than grown inside either.
- §11 (Observability) — every new fail-open path (header/paragraph repair failure, abort mid-live-
  repair) logs, matching `cleanupLoop.ts`'s existing convention.
- §14 (One Gate, One Task Id) — every new concurrent repair call goes through the same gated
  provider and `runWithCallContext`/`taskId` as the rest of cleanup already does; nothing bypasses
  it for speed.
- §19 (Mobile-First) — three small pills in the same header strip; verify they don't wrap/overflow
  on a narrow viewport where one pill fit comfortably before.
- `conventions.md` — every new/modified file keeps or declares an accurate `@architectural-role`.
