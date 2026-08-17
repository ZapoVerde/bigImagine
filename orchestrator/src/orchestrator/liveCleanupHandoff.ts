/**
 * @file orchestrator/src/orchestrator/liveCleanupHandoff.ts
 * @stamp 2026-08-17
 * @architectural-role Orchestrator — the detached end-of-stream cleanup handoff
 * @description
 * The one place both server turn-producing paths (handleChatCompletions's send, turnExecution's
 * regenerateSwipe) run the live cleanup engine's end-of-stream pass (*)
 * — docs/plans/cleanup-pass-blocks-turn-slot-plan.md. Before this module, each call site awaited
 * finishStream + finalizeCleanupResult inline, which held the per-chat turn slot (and therefore
 * Send/Edit/Stop) open until a slow repair pass finished. This module runs that pass as a detached,
 * fire-and-forget background task: the raw reply is already durable (persisted by the caller before
 * the handoff is requested), so nothing the user is waiting on sits behind it, and the turn slot is
 * released right after the terminal SSE frames go out.
 *
 * runLiveCleanupHandoff sequences: finishStream (end-of-stream tail-body / footer / deferred
 * 'llm' repairs on the live composed buffer) then finalizeCleanupResult (the poll tick's own
 * writeback, so a message is indistinguishable in cleanup_jobs from one the tick caught), then
 * appendCleanupDuration (the background pass's wall-time appended to the turn's already-written
 * turn_metrics row). It deliberately passes NO onCleanupEvent to finishStream — by the time this
 * runs there is no SSE connection left to write patches to; the cleanupLiveStatus.ts region map is
 * still written by emitStatus unconditionally, so CleanupStatusPill's independent 5s poll keeps
 * showing in-flux → deployed/flagged through the whole backgrounded phase with zero frontend
 * involvement.
 *
 * Deliberately fail-open and never-rejecting: nothing is awaiting this function by the time it
 * runs, so an uncaught rejection here is a silent unhandled-rejection — the only diagnostic left is
 * this module's own logging (bi_principles.md §11). The caller keeps its releaseLiveCleanupGuard
 * closure and passes it in; this module invokes it exactly once in its finally so the dedup key and
 * the cleanup abort-registry entry drop exactly when the background pass is truly done.
 *
 * (!) in-stream-cleanup-plan.md's live engine — finishStream is its end-of-stream phase.
 *
 * @api-declaration
 * runLiveCleanupHandoff(deps, ctx, userId, chatId, messageId, reply, abortCtl, releaseGuard, opts)
 *   — detach and run finishStream + finalizeCleanupResult for a turn whose raw reply is already
 *   persisted. Resolves only once the pass (and the metrics append) is done; never rejects.
 *
 * @contract
 *   assertions:
 *     purity:          impure (drives LLM via finishStream's dispatchStep + Postgres writeback)
 *     state_ownership: [invokes the caller's releaseGuard exactly once]
 *     external_io:     [Postgres via finalizeCleanupResult/appendCleanupDuration; LLM via finishStream]
 */

import { log } from '../io/logger.js';
import { appendCleanupDuration } from '../io/turnMetrics.js';
import { isAbortError } from './turnAbort.js';
import { finishStream, type LiveCleanupContext } from './liveCleanup.js';
import { finalizeCleanupResult, type CleanupLoopDeps } from './cleanupLoop.js';

/** Run a turn's live-cleanup end-of-stream handoff detached, fail-open, with its own logging and
 *  its own turn-metrics append. The caller must have already persisted the raw `reply` and detached
 *  any client-close abort wiring, and must pass the same releaseLiveCleanupGuard closure it would
 *  otherwise have released inline — this function is what releases it, exactly once, after the
 *  background pass finishes. Calling with no `turnMetricId` simply skips the metrics append (the
 *  poll-tick dedup key and abort-registry entry still drop via releaseGuard). Never rejects. */
export async function runLiveCleanupHandoff(
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
  } = {},
): Promise<void> {
  const { reasoning, turnMetricId, skipLiveTriggers = false, headerDeployed = false } = opts;
  const cleanupStart = Date.now();
  try {
    // The composed buffer is authoritative for the durable text: the client has already seen every
    // live patch (relayed during streaming), so finishStream's further patches must land in the
    // composed text and the ledger, not be re-derived from the raw reply. No onCleanupEvent — there
    // is no SSE connection left to write to once the stream closed and the slot released.
    const fsResult = await finishStream(ctx, cleanupDeps, reply, {
      userId,
      chatId,
      signal: cleanupAbortController.signal,
      skipLiveTriggers,
      headerDeployed,
    });
    // Same finalizeCleanupResult the poll tick uses, so the message is indistinguishable in
    // cleanup_jobs from one the tick caught; recordSwipeIfContent's content-match guard still
    // protects it from clobbering a swipe a later turn already wrote (unchanged behavior).
    await finalizeCleanupResult(
      cleanupDeps,
      userId,
      chatId,
      messageId,
      reply,
      fsResult.composed,
      fsResult.outcomes,
      reasoning,
    );
  } catch (err) {
    if (isAbortError(err)) {
      // A Stop landed during the backgrounded pass — expected (the user hit Stop while the pass was
      // still repairing). Matches the pre-decoupling log line: the raw reply is already persisted
      // but no composed swipe / job rows, so the message stays due and the poll tick catches it.
      log.info(`live cleanup handoff aborted for user ${userId}`, { chatId });
    } else {
      // finishStream is fail-open internally; a non-abort throw here is unexpected but must never
      // propagate — nothing can surface it to a user (the response is long gone). Log it and let
      // the finally below still release the guard + append metrics.
      log.error(`live cleanup handoff failed for user ${userId}`, err);
    }
  } finally {
    // The background pass is done (success, abort, or failure) — the dedup key and the cleanup's
    // abort-registry entry must drop now so the 5s poll tick can claim the message, and a late
    // Stop (which aborts everywhere for this chat) no longer has this pass to cancel.
    releaseGuard();
    if (turnMetricId) {
      await appendCleanupDuration(cleanupDeps.db, userId, turnMetricId, Date.now() - cleanupStart);
    }
  }
}
