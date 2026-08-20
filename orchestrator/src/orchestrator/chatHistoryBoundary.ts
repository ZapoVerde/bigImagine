/**
 * @file orchestrator/src/orchestrator/chatHistoryBoundary.ts
 * @stamp 2026-08-20
 * @architectural-role IO Wrapper — settled chat-history boundary queries
 * @description
 * Reads the newest closed synchronization anchor and compares message positions using the
 * canonical `(created_at, message_id)` order. Mutation callers use this instead of deriving a
 * boundary from the configured live window.
 *
 * @api-declaration
 * getClosedSyncPoints(session, chatId) — closed sync points, newest first
 * getSettledBoundary(session, chatId) — newest closed anchor, or null
 * isMessageSettled(session, chatId, messageId) — whether the message is at/before that anchor
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres reads)
 *     state_ownership: []
 *     external_io:     [Postgres via DbSession]
 */

import type { DbSession } from '../io/postgres.js';

export interface ClosedSyncPoint {
  syncId: string;
  lastMessageId: string;
  ordinal: number;
  createdAt: string;
}

export async function getClosedSyncPoints(session: DbSession, chatId: string): Promise<ClosedSyncPoint[]> {
  const rows = await session.query<{
    sync_id: string;
    last_message_id: string;
    ordinal: number;
    created_at: string;
  }>(
    `select sync_id, last_message_id, ordinal, created_at
     from chat_sync_points
     where chat_id = $1 and closed_at is not null
     order by ordinal desc`,
    [chatId],
  );
  return rows.map((row) => ({
    syncId: row.sync_id,
    lastMessageId: row.last_message_id,
    ordinal: row.ordinal,
    createdAt: row.created_at,
  }));
}

export async function getSettledBoundary(session: DbSession, chatId: string): Promise<{ lastMessageId: string | null }> {
  const [point] = await session.query<{ last_message_id: string }>(
    `select last_message_id
     from chat_sync_points
     where chat_id = $1 and closed_at is not null
     order by ordinal desc
     limit 1`,
    [chatId],
  );
  return { lastMessageId: point?.last_message_id ?? null };
}

export async function isMessageSettled(session: DbSession, chatId: string, messageId: string): Promise<boolean> {
  const [row] = await session.query<{ settled: boolean }>(
    `select (target.created_at, target.message_id) <= (anchor.created_at, anchor.message_id) as settled
     from chat_messages target
     join chat_sync_points point on point.chat_id = target.chat_id
       and point.closed_at is not null
       and point.ordinal = (
         select max(ordinal) from chat_sync_points where chat_id = $1 and closed_at is not null
       )
     join chat_messages anchor on anchor.message_id = point.last_message_id
     where target.chat_id = $1 and target.message_id = $2`,
    [chatId, messageId],
  );
  return row?.settled === true;
}
