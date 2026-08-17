# Cleanup pass blocks turn slot — decouple the end-of-stream repair pass

*Status: **implemented**.* For Reasonix implementation per `docs/roles.md`.

## Context

`docs/plans/cleanup-pass-blocks-turn-slot-issue.md` is the investigation behind this plan (confirmed
accurate against current source — every file it cites is unchanged since it was written). The bug:
both turn-producing paths await the live cleanup pass's end-of-stream repairs (`finishStream` +
`finalizeCleanupResult`) *before* releasing the per-chat turn slot or closing the SSE stream. On a
slow provider (DeepSeek under load) this holds the turn slot, and therefore Send/Edit/Stop, for
however long the tail-body/footer/deferred-`'llm'` repair pass takes — sometimes minutes.

Per-delta live repairs (the early header check, per-paragraph body checks) already run concurrently
with the raw stream and never block anything — that part of the design already matches the goal.
Only the *end-of-stream* phase needs to move.

The fix turns out to be smaller than it first looked, for three reasons verified against the current
code:

1. **The frontend already has almost everything it needs.** `sending`/`submitEdit`/the Send↔Stop
   button swap all key off one flag that already flips false as soon as the awaited
   `chatCompletion()` call resolves — i.e. as soon as `[DONE]` arrives. Making `[DONE]` arrive
   sooner is most of the fix; no frontend gating logic changes.
2. **`CleanupStatusPill` already polls independently of the send lifecycle.** It reads
   `GET /v1/cleanup/status` on its own 5s interval, which is backed by `cleanupLoop.ts`'s settled
   `cleanup_jobs` rows overlaid with `cleanupLiveStatus.ts`'s in-memory region map — and that map is
   written unconditionally by `liveCleanup.ts`'s `emitStatus` (`updateCleanupLiveRegion`), regardless
   of whether an `onCleanupEvent` SSE callback is even wired up. So the pills will keep showing real
   `in-flux → deployed/flagged` progress through the whole backgrounded phase with **zero** frontend
   changes, exactly the way they already do for cleanup-enabled chats whose repairs are caught by the
   5s poll tick instead of the live path.
3. **Stop already reaches a backgrounded cleanup pass.** `registerTurnAbort`/`abortTurn`
   (`orchestrator/turnAbort.ts`) key on `taskId`, and both call sites already register the live turn's
   controller and the cleanup handoff's controller under the *same* `taskId` (`= chatId`). One Stop
   press already aborts everything registered for that chat — including a still-running cleanup left
   over from a previous turn, since a new turn on the same chat reuses the same `taskId`. This is
   exactly the "Stop kills all activity on this chat" behavior wanted, and it needs no design change,
   only for the background task to keep holding its controller open until it actually finishes.

Two things settled by direction from this investigation's discussion, folded into this plan:

- **No live patch delivery is needed for the backgrounded phase.** The tail-body/footer/`'llm'` pass
  already only ever produces patches *after the last token* — the footer check in particular never
  ran until the stream was already fully displayed. So there was never a "corrects itself while you
  watch it stream" moment to preserve for this phase; it's fine for these patches to land as a plain
  refetch once cleanup settles (`CleanupStatusPill`'s existing `onSettled` → `refreshActiveMessages`
  path), the same way it already works for any chat whose repairs are caught by the poll tick.
- **`turn_metrics` timing becomes an append, not a delayed write.** Rather than moving the row's
  `INSERT` to fire after cleanup finishes (which would mean turn stats lag by minutes and a crashed
  background task loses the row entirely), the base row is written exactly when it is today —
  immediately, at the end of the raw turn — and a small follow-up `UPDATE` appends
  `cleanup_duration_ms` once the backgrounded pass completes.

A related bug surfaced while verifying the investigation, fixed as a byproduct of this plan rather
than needing its own: today, a **non-abort** throw from `finishStream`/`finalizeCleanupResult` (or
`appendMessages`/`ensureFirstTurnHeader`) inside the awaited block has no enclosing `catch` — it
propagates out of `handleChatCompletions` entirely and is caught only by `httpServer.ts`'s generic
`handleRequest(...).catch(...)`, which sees `res.headersSent === true` (SSE already started) and does
nothing further: no terminal frame, no `res.end()`. The client's `chatCompletion()` never resolves,
`sending` never clears, and Stop can't help because nothing is still running to abort. This plan's
restructuring puts the whole cleanup handoff behind its own `try/catch/finally` that never rethrows,
which removes this hang as a side effect.

## Goal

Release the turn slot and send the SSE terminal frames as soon as the raw reply is persisted; run
the live cleanup engine's end-of-stream repairs (`finishStream` + `finalizeCleanupResult`) as a
detached background task that Stop can still cancel; record the background task's duration as a
follow-up append to the turn's already-written `turn_metrics` row.

## Files

- `orchestrator/src/orchestrator/liveCleanupHandoff.ts` — **new**. Exports
  `runLiveCleanupHandoff(...)`, the one function both call sites use to run `finishStream` +
  `finalizeCleanupResult` detached, fail-open, with its own logging and its own turn-metrics append.
  New file rather than growing `cleanupLoop.ts` (953 lines) or `turnExecution.ts` (412 lines) further.
- `orchestrator/src/server/handleChatCompletions.ts` — modified. The send-path cleanup handoff
  (currently awaited around lines 621–661) becomes a fire-and-forget call to
  `runLiveCleanupHandoff`; the turn-1 SSE chunk (line 768) drops the `cleanupComposed ??` fallback and
  always sends `reply`; the outer guard-release `finally` gets a `cleanupHandedOff` guard (see Edge
  Cases). No change to `beginInteractiveTurn`/`endInteractiveTurn` call sites — they already release
  the slot as soon as the function returns, which now happens right after the terminal frames are
  written instead of after cleanup finishes.
- `orchestrator/src/server/turnExecution.ts` — modified. `regenerateSwipe`'s cleanup handoff
  (currently awaited around lines 358–386) becomes the same fire-and-forget call; same
  `cleanupHandedOff` guard around its own `finally`. `regenerateSwipe` now returns as soon as
  `recordSwipe` + presence scrape + canvas update finish, without waiting on cleanup.
- `orchestrator/src/orchestrator/streamingTurn.ts` — modified. `runStreamingRpTurn`'s success-path
  `recordTurnMetrics` call captures the returned row id and threads it onto
  `RunStreamingRpTurnResult.turnMetricId`.
- `orchestrator/src/io/turnMetrics.ts` — modified. `recordTurnMetrics`'s `INSERT` gains a
  `returning turn_metric_id` and the function returns that id (existing callers may keep ignoring the
  return value — non-breaking). New export `appendCleanupDuration(db, userId, turnMetricId,
  cleanupDurationMs)`.
- `db/migrations/0115_turn_metrics_cleanup_duration.sql` — **new**. Adds a nullable
  `cleanup_duration_ms int` column to `turn_metrics`.

Not touched, deliberately:

- `orchestrator/src/orchestrator/liveCleanup.ts` — `finishStream` already treats `onCleanupEvent` as
  optional (`emitStatus`/`emitPatch` both null-guard it) and already writes
  `cleanupLiveStatus.ts`'s region map unconditionally. Calling it from the background task with no
  `onCleanupEvent` is already a supported path, not a new one.
- `orchestrator/src/server/handleChats.ts` — the swipe route's `try { ... } finally {
  endInteractiveTurn(chatId); }` already wraps exactly `await regenerateSwipe(...)` plus writing the
  response. Once `regenerateSwipe` returns sooner, this file's turn-slot release speeds up for free.
- `frontend/**` — no changes. See Context above for why.

## Logic

**`runLiveCleanupHandoff`** (new file) takes what both call sites already have in scope: the
`CleanupLoopDeps`, the turn's `LiveCleanupContext`, `userId`/`chatId`/`messageId`, the raw `reply`
text, the turn's `cleanupAbortController`, the existing `releaseLiveCleanupGuard` closure (unchanged
— still does `releaseCleanupInFlight` + `unregisterTurnAbort` + `clearCleanupLiveStatus`), and an
options bag (`reasoning?`, `turnMetricId?`, `skipLiveTriggers?`, `headerDeployed?`). It:

1. Records `cleanupStart = Date.now()`.
2. `try`: calls `finishStream(ctx, cleanupDeps, reply, { userId, chatId, signal:
   cleanupAbortController.signal, skipLiveTriggers, headerDeployed })` — no `onCleanupEvent`, since
   there is no SSE connection left to write to by the time this runs — then, if it resolved (didn't
   throw), `finalizeCleanupResult(cleanupDeps, userId, chatId, messageId, reply, composed, outcomes,
   reasoning)`.
3. `catch`: an abort error is logged at `info` (Stop landed during the backgrounded pass — expected,
   matches today's log line); anything else is logged at `error` and swallowed — this function must
   never throw, since nothing is left awaiting it.
4. `finally`: calls `releaseLiveCleanupGuard()`, then, if `turnMetricId` is present, calls
   `appendCleanupDuration(cleanupDeps.db, userId, turnMetricId, Date.now() - cleanupStart)` in its own
   `.catch(...)` (never throws further — same "never rethrows" contract `recordTurnMetrics` already
   documents).

**`handleChatCompletions.ts`** (send path): the existing `if (cleanupHandoff) { try { ... } catch
{...} }` block (today's lines ~621–643) is replaced with a single `void
runLiveCleanupHandoff(cleanupDeps, cleanupHandoff.ctx, userId, body.chat_id, assistantMessageId,
reply, cleanupAbortController, releaseLiveCleanupGuard, { reasoning: turnReasoning?.text,
turnMetricId: turnResult.turnMetricId, skipLiveTriggers: firstLlmTurn, headerDeployed:
firstTurnHeaderRepaired })`, guarded by setting `cleanupHandedOff = true` immediately before the
call (see Edge Cases). The `cleanupComposed`/`cleanupOutcomes` outer variables are deleted entirely —
nothing after this point ever produces or needs them. The turn-1 SSE chunk (line 768) becomes `content:
reply` unconditionally. Everything else in the `if (body.chat_id)` block — lorebook activation log,
`scrapeTurnPresence` (already reads raw `reply`, never depended on cleanup), the background title
generation, the canvas `focusedNoteId` update, `maybeEagerChunk` — is untouched; none of it ever
depended on cleanup's output. `turnResult.turnMetricId` is captured at the same point `cleanupHandoff`
and `turnReasoning` already are (where `runStreamingRpTurn`'s result is destructured).

**`turnExecution.ts`**'s `regenerateSwipe` gets the identical treatment: its existing `if
(cleanupHandoff) { try { ... } catch {...} }` block (today's lines ~364–382) becomes the same `void
runLiveCleanupHandoff(...)` call (no `skipLiveTriggers`/`headerDeployed` — a swipe is never turn 1),
with the same `cleanupHandedOff` guard around its own `finally`. `regenerateSwipe` returns `{ ok:
true, message: swipeResult, locationId, characterIds }` as soon as `recordSwipe` + the presence scrape
+ canvas update finish — unchanged shape, just returned sooner.

**`streamingTurn.ts`**: the success-path `recordTurnMetrics(...)` call (line ~174) captures its
returned id into `RunStreamingRpTurnResult.turnMetricId` (new optional field, mirroring how
`reasoning`/`cleanup` are already optional result fields). The error-path call (line ~184) does not
need to thread anything forward — a turn that errored never reaches a cleanup handoff.

**`turnMetrics.ts`**: `recordTurnMetrics`'s `INSERT` gains `returning turn_metric_id`, and the
function's return type becomes `Promise<string>` (the id). Existing callers in `streamingTurn.ts`'s
error branch and `loop.ts` that don't use the return value are unaffected — awaiting a
`Promise<string>` and discarding it compiles exactly as awaiting a `Promise<void>` did. New export:

```
appendCleanupDuration(db, userId, turnMetricId, cleanupDurationMs): Promise<void>
```

wraps a single `update turn_metrics set cleanup_duration_ms = $1 where turn_metric_id = $2` through
`db.withUserScope(userId, ...)` (same RLS pattern `recordTurnMetrics` already uses), and never
rethrows — a metrics-append failure must never be visible anywhere, since by the time it runs the
response is long gone.

## Contracts

```ts
// orchestrator/src/orchestrator/liveCleanupHandoff.ts
async function runLiveCleanupHandoff(
  cleanupDeps: CleanupLoopDeps,
  ctx: LiveCleanupContext,
  userId: string,
  chatId: string,
  messageId: string,
  reply: string,
  cleanupAbortController: AbortController,
  releaseGuard: () => void,
  opts: {
    reasoning?: string;
    turnMetricId?: string;
    skipLiveTriggers?: boolean;
    headerDeployed?: boolean;
  },
): Promise<void>   // never rejects
```

```ts
// orchestrator/src/io/turnMetrics.ts
async function recordTurnMetrics(db, fields): Promise<string>   // was Promise<void>; now returns turn_metric_id
async function appendCleanupDuration(
  db: PostgresClient,
  userId: string,
  turnMetricId: string,
  cleanupDurationMs: number,
): Promise<void>   // never rejects
```

```ts
// orchestrator/src/orchestrator/streamingTurn.ts
interface RunStreamingRpTurnResult {
  // ...existing fields unchanged...
  turnMetricId?: string; // present when the turn's own recordTurnMetrics insert succeeded
}
```

```sql
-- db/migrations/0115_turn_metrics_cleanup_duration.sql
alter table turn_metrics add column cleanup_duration_ms int;
```

## Edge Cases

- **The guard-release race (the one to get right).** `liveCleanupGuardHeld`/`releaseLiveCleanupGuard`
  is claimed *before* the turn even runs and must be released exactly once, whether or not a cleanup
  handoff actually happens. Today the enclosing `try/finally` releases it unconditionally on the way
  out. Once the handoff becomes fire-and-forget, that outer `finally` must **not** also release the
  guard once the background task owns it — if it did, the 5s poll tick's dedup key would free up
  before the background task has even started touching the message, and the poll tick could launch a
  duplicate repair pass concurrently with it. Fix: a local `let cleanupHandedOff = false;`, set `true`
  immediately before the `void runLiveCleanupHandoff(...)` call, and the outer `finally` becomes `if
  (!cleanupHandedOff) releaseLiveCleanupGuard();`. This also correctly covers: no live cleanup for
  this turn at all (`cleanupHandoff` undefined — guard was never claimed, release no-ops either way);
  and `ensureFirstTurnHeader`/`appendMessages` throwing before the handoff point is ever reached
  (`cleanupHandedOff` stays `false`, the outer `finally` releases it, matching today's behavior for
  that failure case).
- **Stop must still reach a backgrounded pass.** `cleanupAbortController` stays registered under
  `taskId = chatId` (via `registerTurnAbort`) until `runLiveCleanupHandoff`'s own `finally` calls
  `releaseGuard()`, which calls `unregisterTurnAbort`. Don't unregister it any earlier.
- **A new turn starting while the old cleanup is still backgrounded.** `claimCleanupInFlight`/
  `releaseCleanupInFlight`'s dedup key is `(chatId, messageId, '*')`, scoped to the specific
  `assistantMessageId`/`messageId` of the turn that claimed it — a new turn's own claim uses its own,
  different message id, so there's no collision. `beginInteractiveTurn` succeeds immediately once the
  slot is released (right after the terminal frames are written), which is the whole point.
- **A closed client tab must not cancel the backgrounded pass.** `req.off('close', onClientClose)`
  already fires before the terminal frames are written, in both call sites — keep that ordering
  exactly as-is (background the handoff *after* detaching, not before).
- **A non-abort throw inside `runLiveCleanupHandoff` must never propagate.** Nothing is awaiting this
  function by the time it runs; an uncaught rejection here is a silent unhandled-rejection, not a
  visible bug report. The `catch` must log and stop, never rethrow — this is what removes the hang bug
  described in Context.
- **Turn 1 always sends the raw (header-repaired) reply.** With `cleanupComposed`/`cleanupOutcomes`
  gone from `handleChatCompletions.ts`, the composed/cleaned version of a turn-1 reply only ever
  reaches the client via the existing `CleanupStatusPill` `onSettled` → `refreshActiveMessages` path,
  same as every other turn.
- **A turn with no live cleanup handoff never touches `cleanup_duration_ms`.** `appendCleanupDuration`
  is only called from inside `runLiveCleanupHandoff`, which is only ever invoked when `cleanupHandoff`
  is present. A chat that never opted into cleanup, or a turn where `runStreamingRpTurn` didn't
  produce a `cleanup` handoff, leaves the column `null` — no orphan writes.
- **`recordTurnMetrics`'s existing callers.** Grep for every call site before changing the return type
  — confirmed today: `streamingTurn.ts` (both branches) and `orchestrator/loop.ts` (the buffered
  `runTurn` path, both branches). None of them need the returned id except `streamingTurn.ts`'s
  success branch; the others simply keep awaiting and ignoring it.

## Tests

- A send/swipe on a cleanup-enabled chat resolves (`[DONE]` reaches the client / `regenerateSwipe`
  returns) as soon as the raw reply is persisted, not waiting on a slow `finishStream`/
  `finalizeCleanupResult` — assert against a fake pool with an artificially slow cleanup dispatch step.
- `beginInteractiveTurn` for the same chat succeeds (a second send/swipe is accepted, no 409) while a
  previous turn's cleanup handoff is still running in the background.
- `abortTurn(chatId)` issued while only a backgrounded cleanup handoff is in flight (no live turn
  running) still cancels it — the message stays "due" for the poll tick afterward, same as today's
  abort-during-cleanup outcome.
- A non-abort error thrown from `finishStream` or `finalizeCleanupResult` during the background phase
  is logged and does not produce an unhandled rejection or affect anything else — the already-sent
  response is unaffected either way.
- `finalizeCleanupResult`'s writeback still lands once the background task completes, and
  `recordSwipeIfContent`'s existing content-match guard still protects it from clobbering a swipe a
  later turn already wrote (unchanged behavior — cover with the existing test shape for that guard).
- `turn_metrics`: the base row is written immediately, unaffected by cleanup duration; once
  `runLiveCleanupHandoff` completes, `cleanup_duration_ms` is present on that same row (matched by
  `turn_metric_id`); a turn with no cleanup handoff never gets a `cleanup_duration_ms` write.
- Turn 1's SSE whole-reply chunk always carries the raw, header-repaired `reply` — never blocks on or
  waits for cleanup.
- Manual/UI check (no browser tool available in this environment — say so explicitly rather than
  claiming it's verified): on a cleanup-enabled chat with a deliberately slow cleanup connection,
  confirm (a) the entry box accepts typing and Send starts a new turn while the previous turn's pills
  still show `in-flux`, (b) editing/truncating the previous user message succeeds immediately once the
  raw reply is on screen, without waiting for the pills to settle, and (c) the pills still progress to
  `deployed`/`flagged` via their existing poll while the next turn is in flight.

## Out of Scope

- Per-delta live header/body repairs during the stream itself — already non-blocking, untouched by
  this plan.
- Restoring live SSE patch-frame delivery for the tail-body/footer/`'llm'` pass — deliberately not
  reproduced; these now always settle via `CleanupStatusPill`'s existing refetch path (see Context).
- Any change to `sending`/`resendMode`/`submitEdit`/the Send↔Stop button in `ChatView.tsx` — they
  already key off the right flag and need no changes once the backend responds sooner.
- `resumingTurn`/`reconcileTurnInFlight` (the lost-turn-recovery machinery) — unaffected.
- `interactiveTurnLock.ts`'s 10-minute stale-slot reclaim — unrelated safety net, untouched.
- Any change to Stop's abort-everything-under-this-chat-id semantics — already correct, see Context;
  this plan only makes sure the backgrounded task keeps its controller registered long enough for that
  to keep working.

## Principles / Conventions in Play

- `bi_principles.md` §14 (every LLM call carries a task id through one gate) — `cleanupAbortController`
  must stay registered under `taskId = chatId` for the backgrounded pass's whole lifetime; this is
  also what makes Stop's existing "abort everything for this chat" behavior keep working.
- `bi_principles.md` §11 (observability at the seams) — `runLiveCleanupHandoff`'s `catch` is the one
  place a backgrounded cleanup failure can still be diagnosed at all (nothing else is watching it by
  the time it runs); log both the abort and non-abort cases clearly, per the existing log-line style
  in `handleChatCompletions.ts`/`turnExecution.ts`.
- `bi_principles.md` §9 (self-describing modules) — the new `liveCleanupHandoff.ts` needs the standard
  preamble (role: Orchestrator — sequences `finishStream`/`finalizeCleanupResult`/
  `appendCleanupDuration`, all IO it doesn't own itself).
- `bi_principles.md` §10 (file size budget) — `cleanupLoop.ts`/`liveCleanup.ts`/
  `handleChatCompletions.ts` are already well past 300 lines; the new function goes in its own file
  rather than growing any of those further.
