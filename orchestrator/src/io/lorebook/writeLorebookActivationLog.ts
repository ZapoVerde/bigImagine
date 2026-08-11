/**
 * @file orchestrator/src/io/lorebook/writeLorebookActivationLog.ts
 * @stamp 2026-08-11
 * @architectural-role IO Wrapper — activation-log append
 * @description
 * Appends one `lorebook_activation_log` row per activated entry after the assistant turn
 * completes (docs/lorebook-plan.md §3e/§4) — the "write after, not during" shape chatMemorySync
 * already uses. The log is the audit trail the sidebar's Live Activation Indicator reads and the
 * timed-effect state fetchLorebookTimedEffectState resolves, so a turn that never completes
 * (abort, retry exhaustion) simply never writes rows — consistent with "one row per entry per
 * assistant turn it was injected into".
 *
 * @api-declaration
 * writeLorebookActivationLog(session, userId, chatId, messageId, entryIds) ->
 *   Promise<number> — rows actually inserted (deduped entryIds; 0 for an empty set).
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { DbSession } from '../postgres.js';
import { log } from '../logger.js';

export async function writeLorebookActivationLog(
  session: DbSession,
  userId: string,
  chatId: string,
  messageId: string,
  entryIds: string[],
): Promise<number> {
  const ids = [...new Set(entryIds)];
  if (ids.length === 0) return 0;
  try {
    const rows = await session.query(
      `insert into lorebook_activation_log (chat_id, message_id, entry_id, user_id)
       select $1::uuid, $2::uuid, unnest($3::uuid[]), $4::uuid
       returning activation_id`,
      [chatId, messageId, ids, userId],
    );
    return rows.length;
  } catch (err) {
    // Fail-open: a log write must never fail the turn that already completed. Log and move on.
    log.warn('writeLorebookActivationLog: log write failed, activation untracked', { userId, chatId, messageId, err });
    return 0;
  }
}
