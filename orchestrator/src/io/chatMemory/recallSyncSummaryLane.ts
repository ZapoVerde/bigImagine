/**
 * @file orchestrator/src/io/chatMemory/recallSyncSummaryLane.ts
 * @stamp 2026-08-18
 * @architectural-role IO Wrapper — the unconditional sync-window summaries lane, the
 * fourth member of buildAutoRecallParts's parallel fetch
 * @description
 * Closes the eager-chunk / bridge-tick gap (docs/plans/completed/sync-summaries-plan.md): a chunk
 * archived by the eager path (eagerChunkSync.ts) sits under the chat's OPEN sync point
 * (`closed_at is null`) until the bridge tick (chatMemorySync.ts) closes it — archived, but
 * folded into neither the bridge digest nor guaranteed inclusion in RAG's scored top-k. This
 * lane lists exactly those chunks: no vector query, no cutoff, no recency decay — just every
 * chunk under the chat's currently-open sync point, in ordinal order, as a bare summary.
 *
 * The open-sync-point boundary is the exact query eagerChunkSync.ts and chatMemorySync.ts's
 * `runOneChatSync` already model ("at most one open sync point per chat" is a construction
 * invariant there — both queries run under the chat's advisory lock, and the
 * (chat_id, ordinal) unique constraint backs the invariant), so no new bookkeeping exists:
 * the same `select ... where chat_id = $1 and closed_at is null order by ordinal desc limit 1`
 * that decides "which point does this chunk belong to" decides "which chunks are waiting for
 * the bridge". recallForPrompt.ts starts this lane immediately (it needs no embedding) and
 * merges its rows with the RAG-scored chunk lane in post-processing.
 *
 * @api-declaration
 * recallSyncSummaryLane(session, userId, chatId) -> Promise<{ rows: SyncSummaryRow[] }> —
 *   fetch the chat's open sync point (if any) and its chunks' summaries. Empty rows when the
 *   chat has no open sync point, or none of its chunks are archived yet. `content` is '' on
 *   every row this lane returns — recallForPrompt.ts's inflate step fills it for a chunk RAG
 *   also selected (never duplicated across the two sections).
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the caller's session)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { DbSession } from '../postgres.js';
import { log } from '../logger.js';

/** One chunk waiting for the bridge tick, rendered as a bare summary. `content` is '' unless
 *  recallForPrompt.ts's inflate step promoted this row to full text in place (RAG's own
 *  scoring also selected it — see docs/plans/completed/sync-summaries-plan.md Step 2). */
export interface SyncSummaryRow {
  chunk_id: string;
  ordinal: number;
  summary: string;
  content: string; // '' unless inflated by recallForPrompt.ts's merge step
}

/** Fetch the chat's open sync point and list every chunk under it, in ordinal order.
 *  `session` is the caller's already-user-scoped DbSession (RLS applies user_id; chatId
 *  narrows to "this conversation"). No open sync point => no rows — the chat has nothing in
 *  the eager-chunk/bridge gap, so there is nothing for this lane to say. Fail-open by
 *  contract, same as recallPlotLane: a DB error here degrades to empty rows, never takes the
 *  chunk/fact lanes down with it (sync summaries are the gap-filler — RAG still covers the
 *  same content), and never rejects unhandled if the caller's embed fails before this lane is
 *  awaited. */
export async function recallSyncSummaryLane(
  session: DbSession,
  userId: string,
  chatId: string,
): Promise<{ rows: SyncSummaryRow[] }> {
  try {
    const [openPoint] = await session.query<{ sync_id: string }>(
      `select sync_id from chat_sync_points where chat_id = $1 and closed_at is null order by ordinal desc limit 1`,
      [chatId],
    );
    if (!openPoint) return { rows: [] };
    const rows = await session.query<SyncSummaryRow>(
      `select chunk_id, ordinal, summary, '' as content from chat_chunks
       where chat_id = $1 and user_id = $2 and sync_id = $3 order by ordinal`,
      [chatId, userId, openPoint.sync_id],
    );
    return { rows };
  } catch (err) {
    log.warn('recallSyncSummaryLane: retrieval failed, continuing without sync summaries', { userId, chatId, err });
    return { rows: [] };
  }
}
