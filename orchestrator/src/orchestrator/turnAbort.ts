/**
 * @file orchestrator/src/orchestrator/turnAbort.ts
 * @stamp 2026-08-14
 * @architectural-role Stateful Owner — the in-flight "who can be stopped right now" registry
 * @description
 * The server-side half of the Stop button: a chat is a single blocking POST (docs/bootstrap.md's
 * non-streaming design), so a client aborting its own fetch would only stop *waiting* — the
 * runTurn loop would keep generating, billed, and the reply would still be persisted. Stopping
 * generation requires the orchestrator to abort the upstream LLM call itself, and this module is
 * how it finds that call: a Map of taskId -> live AbortControllers for every LLM task currently
 * churning, in-memory only and single-process scoped, exactly like the turnStatus.ts neighbor.
 *
 * Keyed by taskId (a chat_id for live chat turns, a scheduled_jobs.job_id for agent routines —
 * the same key bb_principles.md §14's gate uses), so POST /v1/chat/abort can look up a chat's
 * in-flight work by the chat_id the client already knows. One taskId can hold MULTIPLE
 * controllers: the interactive turn and a cleanup-loop repair on the same chat are independent
 * llm.complete() calls, and the Stop button is meant to kill the whole chat's churning LLM work
 * at once (the turn the user is waiting on plus any cleanup repair compounding on that same
 * chat) — see cleanupLoop.ts's dispatchStep.
 *
 * @api-declaration
 * registerTurnAbort(taskId)          — register one in-flight task; returns its AbortController
 * unregisterTurnAbort(taskId, ctrl)  — drop that task's controller (callers do this in finally)
 * abortTurn(taskId)                  — abort every registered task for that key; false if none
 * isAbortError(err)                  — pure: is this the abort we raised (err.name === 'AbortError')
 *
 * @contract
 *   assertions:
 *     purity:          impure (owns the map); isAbortError is pure
 *     state_ownership: [the taskId -> AbortController set map]
 *     external_io:     []
 */

const tasks = new Map<string, Set<AbortController>>();

/** Register one in-flight LLM task under `taskId`. Returns the controller so the caller can pass
 *  its .signal into llm.complete() (threaded down to the provider fetch) and unregister it in a
 *  finally — the registry never aborts anything on its own, it only hands out the handles. */
export function registerTurnAbort(taskId: string): AbortController {
  const controller = new AbortController();
  let set = tasks.get(taskId);
  if (!set) {
    set = new Set();
    tasks.set(taskId, set);
  }
  set.add(controller);
  return controller;
}

/** Drop one task's controller — call in finally so a finished turn stops being abortable and the
 *  key disappears once nothing is in flight under it. */
export function unregisterTurnAbort(taskId: string, controller: AbortController): void {
  const set = tasks.get(taskId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) tasks.delete(taskId);
}

/** Abort every task currently registered under `taskId`. Returns false when nothing is in flight
 *  for that key (the turn already finished, never started, or is a stateless request with no
 *  chat_id) — the endpoint answers 404 then, and the client treats it as "nothing to stop". */
export function abortTurn(taskId: string): boolean {
  const set = tasks.get(taskId);
  if (!set || set.size === 0) return false;
  for (const controller of set) controller.abort();
  return true;
}

/** Pure predicate shared by the abort-detection sites (httpServer.ts's catch, httpRetry.ts's
 *  retry skip, llmRetryClassify.ts) — Node's fetch abort throws a DOMException named 'AbortError',
 *  and the retry layers must never treat it as a transient failure to retry. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
