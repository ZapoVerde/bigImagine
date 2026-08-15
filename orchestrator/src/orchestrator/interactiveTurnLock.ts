/**
 * @file orchestrator/src/orchestrator/interactiveTurnLock.ts
 * @stamp 2026-08-15
 * @architectural-role Stateful Owner — the per-chat "a real turn is running right now" gate
 * @description
 * The answer to "is a turn actually running for this chat, and may I start another one?" — a
 * Map<chat_id, startedAt> with begin/end/isActive, in-memory only and single-orchestrator-process
 * scoped, exactly like the turnStatus.ts and turnAbort.ts neighbors. Both turn-producing endpoints
 * gate on it (handleChatCompletions's whole body, handleChats's needs_regenerate swipe branch), so
 * two overlapping turns can never run on the same chat_id even if the client's local in-flight
 * state was lost (a backgrounded tab, a reload) and it sends again believing the first attempt
 * didn't go through — concurrent turns on one chat can genuinely corrupt the transcript, not just
 * the display.
 *
 * Deliberately NOT built on turnAbort.ts's registry: that key also holds the cleanup subloop's
 * second, independent controller while it repairs a prior turn, so "is this chat_id present" there
 * would false-positive on routine background cleanup and block a legitimate new send. The lock
 * spans the whole interactive turn — from just before any DB/LLM work through response writeback —
 * while the cleanup repair is a separate concern that shares the abort registry but never this
 * gate. A lost entry on restart is fine, same stance as turnStatus.ts: the client re-asks the
 * server on every mount/visibility change, so a fresh process just answers "not active" and lets
 * the next send proceed.
 *
 * @api-declaration
 * beginInteractiveTurn(chatId)  — claim the chat's turn slot; false = already active (and not
 *                                 stale), the caller must not proceed (answer 409)
 * endInteractiveTurn(chatId)    — release the slot; callers do this in a finally
 * isInteractiveTurnActive(chatId) — is a turn currently running (the status endpoint's `active`)
 *
 * @contract
 *   assertions:
 *     purity:          impure (owns the map)
 *     state_ownership: [the chatId -> startedAt map]
 *     external_io:     []
 */

const active = new Map<string, number>();

// A missed finally (a crash, an unhandled throw in an uncatchable seam) must never permanently
// wedge a chat — reclaim an entry older than this ceiling rather than trusting every caller's
// release to fire. Same self-healing-hint stance turnStatus.ts already documents; 10 minutes is
// far beyond any legitimate turn span, so a live turn can never be preempted by this.
const STALE_AFTER_MS = 10 * 60 * 1000;

/** Claim this chat's interactive-turn slot. Returns false when a (non-stale) turn is already
 *  running — the caller must answer 409 and not start any DB/LLM work. A stale entry is reclaimed
 *  rather than blocking. */
export function beginInteractiveTurn(chatId: string): boolean {
  const startedAt = active.get(chatId);
  if (startedAt !== undefined && Date.now() - startedAt < STALE_AFTER_MS) return false;
  active.set(chatId, Date.now());
  return true;
}

/** Release the slot — the caller's finally, covering every return/throw path of the turn. */
export function endInteractiveTurn(chatId: string): void {
  active.delete(chatId);
}

/** Is a turn actually running for this chat right now? Reclaims-and-answers-false on a stale
 *  entry so a wedged key can't report active forever. */
export function isInteractiveTurnActive(chatId: string): boolean {
  const startedAt = active.get(chatId);
  if (startedAt === undefined) return false;
  if (Date.now() - startedAt >= STALE_AFTER_MS) {
    active.delete(chatId);
    return false;
  }
  return true;
}
