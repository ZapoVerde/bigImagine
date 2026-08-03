/**
 * @file orchestrator/src/orchestrator/turnStatus.ts
 * @stamp 2026-08-03
 * @architectural-role Stateful Owner — the ambient "what is this turn doing right now" status
 * @description
 * runTurn (loop.ts) can take several tool rounds before it has a reply, and the chat endpoint is
 * a single blocking POST (docs/bootstrap.md's non-streaming design) — the client has nothing to
 * read mid-turn. This is a side channel, not a response body: loop.ts writes the current tool's
 * label (describeToolCall.ts) here, keyed by taskId (a chat_id for the persisted-session path),
 * and httpServer.ts's GET /v1/chat/status route lets the frontend poll it independently while the
 * real POST is still in flight. In-memory only, single-orchestrator-process scoped, same as
 * io/llm/callContext.ts's AsyncLocalStorage neighbor — a lost status on restart is fine, it's a
 * "still thinking" hint, not the canonical record (bb_principles.md §1).
 *
 * @api-declaration
 * setTurnStatus(taskId, label) — overwrites the current label for that task
 * clearTurnStatus(taskId) — removes it; loop.ts calls this once the turn ends, any outcome
 * getTurnStatus(taskId) — the current label, or undefined if none/already cleared
 *
 * @contract
 *   assertions:
 *     purity:          impure (owns the map)
 *     state_ownership: [the taskId -> label map]
 *     external_io:     []
 */

const status = new Map<string, string>();

export function setTurnStatus(taskId: string, label: string): void {
  status.set(taskId, label);
}

export function clearTurnStatus(taskId: string): void {
  status.delete(taskId);
}

export function getTurnStatus(taskId: string): string | undefined {
  return status.get(taskId);
}
