/**
 * @file orchestrator/src/io/lorebook/fetchLorebookTimedEffectState.ts
 * @stamp 2026-08-11
 * @architectural-role IO Wrapper — timed-effect state read for the §5 gate
 * @description
 * Reads `lorebook_activation_log` (§3e) for the candidate set — the single source of truth for
 * "was this entry active as of message N". Sticky/cooldown are resolved from these rows by the
 * pure gate (docs/lorebook-plan.md §4), not from a separate mutable counter table, so the
 * audit trail and the timed-effect state can never drift apart.
 *
 * One row per entry (the most recent activation): both sticky ("still-active-until") and
 * cooldown ("blocked-until") are "since the last activation" windows, so the most recent
 * activation is all the gate needs. `turns_since_activation` counts completed assistant
 * messages strictly after the activation's own message — each assistant generation is one turn
 * in BigImagine, so the in-flight turn being resolved is not yet counted and the gate compares
 * against it directly (sticky N ⇒ still active while turns_since < N).
 *
 * @api-declaration
 * fetchLorebookTimedEffectState(session, userId, chatId, entryIds) ->
 *   Promise<LorebookTimedEffectState[]> — most recent activation per entry, [] when an entry
 *   has never activated or entryIds is empty. Fail-open: a DB error logs and returns [].
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { DbSession } from '../postgres.js';
import { log } from '../logger.js';

/** Per-entry most recent activation. `turns_since_activation` is the number of completed
 *  assistant turns after the activation's message (0 = activated last turn). */
export interface LorebookTimedEffectState {
  entry_id: string;
  message_id: string;
  activated_at: string;
  turns_since_activation: number;
}

export async function fetchLorebookTimedEffectState(
  session: DbSession,
  userId: string,
  chatId: string,
  entryIds: string[],
): Promise<LorebookTimedEffectState[]> {
  const ids = [...new Set(entryIds)];
  if (ids.length === 0) return [];
  try {
    const rows = await session.query<LorebookTimedEffectState>(
      `select distinct on (lal.entry_id)
         lal.entry_id,
         lal.message_id,
         lal.activated_at,
         (select count(*) from chat_messages m
          where m.chat_id = lal.chat_id and m.role = 'assistant'
            and (m.created_at, m.message_id) > (cm.created_at, cm.message_id)) as turns_since_activation
       from lorebook_activation_log lal
       join chat_messages cm on cm.message_id = lal.message_id
       where lal.user_id = $1 and lal.chat_id = $2 and lal.entry_id = any($3)
       order by lal.entry_id, (lal.activated_at, lal.message_id) desc`,
      [userId, chatId, ids],
    );
    return rows.map((r) => ({ ...r, turns_since_activation: Number(r.turns_since_activation) }));
  } catch (err) {
    // Fail-open: the gate must still run (with no timed-effect state) if the log read fails.
    log.warn('fetchLorebookTimedEffectState: log read failed, returning no state', { userId, chatId, err });
    return [];
  }
}
