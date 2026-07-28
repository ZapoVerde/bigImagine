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
 * getCallContext() — the current {taskId, kind}, or undefined outside any runWithCallContext
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
}

const store = new AsyncLocalStorage<LlmCallContext>();

export function runWithCallContext<T>(ctx: LlmCallContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function getCallContext(): LlmCallContext | undefined {
  return store.getStore();
}
