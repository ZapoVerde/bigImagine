/**
 * @file orchestrator/src/io/llm/callContext.ts
 * @stamp 2026-07-28
 * @architectural-role Stateful Owner — the ambient "which task is this LLM call for" context
 * @description
 * bb_principles.md §14 requires every LLM call to carry a task id, but the model gets called from
 * deep inside plugin-owned helpers (plugins/lists/src/classifySection.ts,
 * plugins/document-ingestion/src/classifyNote.ts, etc.) that only ever receive a bare
 * LlmProvider — threading a taskId parameter through every one of those signatures, and every
 * tool handler that calls them, would touch a dozen files for no reasoning gain (bb_principles.md
 * §2 — none of those files decide what the id *means*, they'd just be relaying it). This reuses
 * the exact AsyncLocalStorage pattern io/logger.ts's runWithRequestId already established for the
 * same shape of problem (request-scoped metadata that needs to reach arbitrarily nested async
 * work without a parameter threaded through everything in between): orchestrator/loop.ts's
 * runTurnInner sets the context once, for the whole turn, and every complete() call made during
 * that turn — the turn's own reasoning calls and any tool-triggered classification/extraction
 * call nested inside it — automatically inherits the same taskId/kind, because they all share the
 * one gated LlmProvider instance closed over since plugin registration (index.ts wraps deps.llm
 * with llmGate.ts's createGatedLlmProvider exactly once, at boot).
 *
 * A call made with no context set (getCallContext() returns undefined) is a bug, not a
 * degraded-but-tolerable state — llmGate.ts throws rather than logging an unattributed call, per
 * this same principle's "a call with nothing attached to it is a call nothing can be budgeted
 * against" reasoning.
 *
 * @api-declaration
 * runWithCallContext(ctx, fn) — every LLM call made during fn (including nested async work it
 *   kicks off) is tagged with ctx
 * withCallLabel(label, fn) — narrows the currently active context to { ...active, callLabel:
 *   label } for the duration of fn (docs/plans/llm-call-label-breakdown-plan.md): the Stats
 *   page's one-level-deeper breakdown of 'system'-kind calls (cleanup repairs, chat-memory sync
 *   steps, background title/location work). Reads the active context and throws if none is set
 *   (unreachable in practice — every call site is already nested inside an outer
 *   runWithCallContext); AsyncLocalStorage nests cleanly, so a call made inside fn is tagged
 *   with the label while anything outside fn keeps seeing the outer, unlabeled context. Additive
 *   to runWithCallContext, not a replacement — call sites that don't care about a finer label
 *   keep working unchanged.
 * getCallContext() — the current {taskId, kind, callLabel?, roundId?}, or undefined outside any
 *   runWithCallContext
 * withRoundId(roundId, fn) — narrows the currently active context to { ...active, roundId:
 *   roundId } for the duration of fn (docs/plans/portrait-studio-telemetry-plan.md): the
 *   Portrait Studio correlation id llmGate.ts logs onto llm_calls.round_id for a round's
 *   mutation/wiki-pull/reflection calls. Mirror of withCallLabel — same nesting semantics,
 *   same throw-if-no-context bug guard, additive rather than a replacement.
 *
 * @contract
 *   assertions:
 *     purity:          impure (owns AsyncLocalStorage)
 *     state_ownership: [the AsyncLocalStorage instance]
 *     external_io:     []
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type LlmCallKind = 'chat' | 'agent_routine' | 'system';

export interface LlmCallContext {
  /** What this call is on behalf of: a chat_id (kind 'chat'), a scheduled_jobs.job_id (kind
   *  'agent_routine'), or a short caller-chosen label for a standalone system call with no
   *  session of its own (kind 'system', e.g. "generateChatTitle"). */
  taskId: string;
  kind: LlmCallKind;
  /** Whose data this call runs under — llmGate.ts logs it onto llm_calls.user_id even though
   *  that table is itself RLS-exempt (bb_principles.md §4 still applies to attribution, just not
   *  to query-time enforcement here). */
  userId: string;
  /** Optional finer-grained breakdown of the call's purpose, one level deeper than `kind` —
   *  llmGate.ts logs it onto llm_calls.call_label. Set via withCallLabel() from inside an
   *  already-active runWithCallContext; null/absent on the outer context means "no finer label",
   *  which the Stats page's 'call-type' grouping falls back to `kind` for. The closed label
*   vocabulary lives in docs/plans/llm-call-label-breakdown-plan.md (cleanup:*, bg:*, sync:*). */
  callLabel?: string;
  /** Optional Portrait Studio round id (docs/plans/portrait-studio-telemetry-plan.md) —
   *  llmGate.ts logs it onto llm_calls.round_id so the round's mutation/wiki-pull/reflection
   *  calls correlate to their visual_rounds row while llm_calls stays the sole LLM accounting
   *  ledger. Set via withRoundId() from inside an already-active runWithCallContext; absent on
   *  any non-portrait call. */
  roundId?: string | null;
}

const store = new AsyncLocalStorage<LlmCallContext>();

export function runWithCallContext<T>(ctx: LlmCallContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function getCallContext(): LlmCallContext | undefined {
  return store.getStore();
}

/** Re-runs fn under a nested context identical to the currently active one except for
 *  callLabel. The label describes what the call is *for* (the same purpose a call made inside
 *  fn is billed against), so it rides the same gate every other attribution field already rides
 *  through — no second logging path (bb_principles.md §14). Throws if called outside any
 *  runWithCallContext, the same "a call with nothing attached to it" bug llmGate.ts guards
 *  against — unreachable in practice, every call site is already nested inside an outer context. */
export function withCallLabel<T>(label: string, fn: () => T): T {
  const active = getCallContext();
  if (!active) {
    throw new Error(
      'withCallLabel: no call context set — every LLM call must run inside runWithCallContext (bb_principles.md §14)',
    );
  }
  return store.run({ ...active, callLabel: label }, fn);
}

/** Re-runs fn under a nested context identical to the currently active one except for roundId
 *  (docs/plans/portrait-studio-telemetry-plan.md). Same ambient mechanism as withCallLabel — a
 *  call made inside fn logs llm_calls.round_id; anything outside fn keeps the outer, unattributed
 *  context. Null clears the attribution (a portrait LLM call made outside any round, e.g. a
 *  feedback episode whose generation predates this plan). Throws if called outside any
 *  runWithCallContext, the same "a call with nothing attached to it" bug llmGate.ts guards
 *  against — unreachable in practice, every call site is already nested inside an outer context. */
export function withRoundId<T>(roundId: string | null, fn: () => T): T {
  const active = getCallContext();
  if (!active) {
    throw new Error(
      'withRoundId: no call context set — every LLM call must run inside runWithCallContext (bb_principles.md §14)',
    );
  }
  return store.run({ ...active, roundId }, fn);
}
