/**
 * @file orchestrator/src/orchestrator/chatChunkResize.ts
 * @stamp 2026-08-13
 * @architectural-role Orchestrator — the admin-triggered backfill that re-chunks every chat's
 *   archived history at the live chat_memory_chunk_pairs size (docs/plans/chunk-size-resize-plan.md)
 * @description
 * The chunk size is a live, household-wide setting (migration 0099); changing it only affects
 * NEW chunks the sync tick / eager path write. This module is the one-time backfill that brings
 * EXISTING archives in line: for every non-archived chat, delete all chat_chunks rows (they're
 * derived data — bi_principles.md §1) and regenerate the currently-eligible span at the live
 * size, from ordinal 0, with the live chat_memory_live_window_pairs recomputing the span exactly
 * as a sync tick would. Summaries + both embeddings (content and the 0094 summary lane) are
 * regenerated per chunk, so the pass is LLM-bound and runs as a fire-and-forget background job
 * with progress surfaced in chat_chunk_resize_status (one singleton row, claimed atomically —
 * a second trigger while one pass is running gets 409).
 *
 * Reuses the chat's most-recent chat_sync_points row (`order by ordinal desc limit 1`) rather
 * than minting a new one, so the backfill adds no zero-entries noise rows to the Review Panel.
 * Its anchor is only ever ADVANCED (never retreated) to the new span end: an advance targets a
 * strictly newer message than every existing anchor (anchors increase with ordinal), so it can
 * never trip the unique (chat_id, last_message_id) constraint, and it is REQUIRED when the new
 * span outruns an open point — otherwise the tick's top-up would re-chunk the same span under
 * fresh ordinals, duplicating content the (chat_id, ordinal) constraint cannot see. When the new
 * span ends before the current anchor (the live window grew since the last sync), the anchor is
 * left untouched — exactly what the sync tick itself would do, so no new gap semantics.
 *
 * Never-synced chats (no chat_sync_points row) are skipped untouched: they have nothing to
 * delete, and the tick will chunk them at the live size when they come due. Chats whose eligible
 * span is under one chunk have all their chunks deleted (their span is now live) and count as
 * done. A per-chat failure rolls back that chat's transaction (its existing chunks survive) and
 * is logged, not fatal — bi_principles.md §11.
 *
 * @api-declaration
 * claimChatChunkResize(db) -> Promise<boolean> — atomically claims the singleton row for a new
 *   pass ('idle'/'done'/'error', or a stale 'running' older than 2h); false = a live pass is
 *   already running
 * runChatChunkResize(deps) -> Promise<void> — the background pass; never throws (records
 *   'error' + message in the status row on failure)
 * getChatChunkResizeStatus(db) -> Promise<ChunkResizeStatusRow> — the singleton row for polling
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, LLM IO via the gated provider, embeddings IO)
 *     state_ownership: []
 *     external_io:     [Postgres, the LLM via the gated provider it builds (same construction
 *                       resolveSyncSettings uses), the embeddings provider]
 */

import { log } from '../io/logger.js';
import { runWithCallContext } from '../io/llm/callContext.js';
import { createLlmProviderForProfile } from '../io/llm/index.js';
import { createGatedLlmProvider } from '../io/llm/llmGate.js';
import type { LlmProvider } from '../io/llm/types.js';
import type { PostgresClient } from '../io/postgres.js';
import { toPgVectorLiteral } from '../util/pgvector.js';
import { chunkChatTranscript, DEFAULT_CHUNK_PAIRS, type ChatTranscriptMessage } from '../io/chatMemory/chunkChatTranscript.js';
import { summarizeChatChunk } from '../io/chatMemory/classifyChatChunk.js';
import { findTurnBoundaries, DEFAULT_LIVE_WINDOW_PAIRS, type ChatMemorySyncDeps } from './chatMemorySync.js';

/** Mirrors ChatMemorySyncDeps in full — chunk summarization is a mandatory LLM call and chunk
 *  embeddings are mandatory columns, so this path can never skip or stub either provider. */
export type ChatChunkResizeDeps = ChatMemorySyncDeps;

export interface ChunkResizeStatusRow {
  status: 'idle' | 'running' | 'done' | 'error';
  chatsTotal: number;
  chatsDone: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/** The flagged judgment call from the plan (not a hard requirement): a crashed pass leaves the
 *  singleton row stuck at 'running' forever, wedging the trigger. A pass running past this
 *  ceiling is treated as stale and may be reclaimed by a new trigger. Deliberately generous —
 *  a large household can take hours of LLM round-trips. */
const STALE_RUNNING_CEILING = '2 hours';

/** 2h ceiling / atomic claim, same guarded-update shape as a compare-and-swap: the WHERE
 *  re-evaluates on the row's committed state (READ COMMITTED), so two concurrent triggers can
 *  never both claim — the loser's update matches zero rows. */
export async function claimChatChunkResize(db: PostgresClient): Promise<boolean> {
  return db.withSystemScope(async (session) => {
    const claimed = await session.query<{ id: number }>(
      `update chat_chunk_resize_status
       set status = 'running', chats_total = 0, chats_done = 0,
           started_at = now(), finished_at = null, error = null
       where id = 1
         and (status <> 'running' or started_at is null or started_at < now() - interval '${STALE_RUNNING_CEILING}')
       returning id`,
    );
    return claimed.length > 0;
  });
}

function toPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Same live settings reads + gated-provider construction resolveSyncSettings (chatMemorySync.ts)
 *  does for the tick — the pass regenerates summaries, so it must honor the household's
 *  chunk-summary connection, prompt, live window, and chunk size exactly as the tick would. */
async function resolveResizeSettings(deps: ChatChunkResizeDeps): Promise<{
  llm: LlmProvider;
  chunkSummaryPrompt: string | undefined;
  pairsPerChunk: number;
  liveWindowPairs: number;
}> {
  const [profileName, livePairsRaw, chunkPairsRaw, chunkSummaryPrompt] = await Promise.all([
    deps.settings.get('chat_memory_profile'),
    deps.settings.get('chat_memory_live_window_pairs'),
    deps.settings.get('chat_memory_chunk_pairs'),
    deps.settings.get('chat_memory_chunk_summary_prompt'),
  ]);

  let llm = deps.llm;
  if (profileName) {
    const profile = await deps.llmConnections.resolveByName(profileName);
    if (profile) {
      llm = createGatedLlmProvider(createLlmProviderForProfile(profile), deps.db, deps.settings);
    } else {
      log.error(`chat chunk resize: chat_memory_profile names unknown connection "${profileName}" — falling back to the active connection`);
    }
  }

  return {
    llm,
    chunkSummaryPrompt: chunkSummaryPrompt || undefined,
    pairsPerChunk: toPositiveInt(chunkPairsRaw, DEFAULT_CHUNK_PAIRS),
    liveWindowPairs: toPositiveInt(livePairsRaw, DEFAULT_LIVE_WINDOW_PAIRS),
  };
}

interface ResizeSettings {
  llm: LlmProvider;
  chunkSummaryPrompt: string | undefined;
  pairsPerChunk: number;
  liveWindowPairs: number;
}

/** One chat's pass, under the SAME per-chat advisory lock the tick and the eager path use
 *  (shared hashtext($1) lock — bi_principles.md's serialization seam), and the same
 *  runWithCallContext gate (§14: summarization is a real LLM call). Everything here is one
 *  transaction: a mid-pass failure rolls back, and the chat keeps its existing chunks. */
async function resizeOneChat(deps: ChatChunkResizeDeps, s: ResizeSettings, userId: string, chatId: string): Promise<void> {
  await runWithCallContext({ taskId: chatId, kind: 'system', userId }, () =>
    deps.db.withUserScope(userId, async (session) => {
      await session.query('select pg_advisory_xact_lock(hashtext($1))', [chatId]);

      const messages = await session.query<{ message_id: string; role: 'user' | 'assistant'; content: string }>(
        'select message_id, role, content from chat_messages where chat_id = $1 order by created_at, message_id',
        [chatId],
      );
      const boundaries = findTurnBoundaries(messages);

      // The same eligibility math the tick uses (live window + chunk-size rounding): the span to
      // regenerate is everything that has rolled off the live window, grouped at the live size.
      const eligibleTurns = boundaries.length - s.liveWindowPairs;
      if (eligibleTurns < s.pairsPerChunk) {
        // Nothing is currently eligible — the span is live — so any old chunks (a now-larger live
        // window rolled them back into view) are deleted. Still counts as done.
        await session.query('delete from chat_chunks where chat_id = $1', [chatId]);
        return;
      }
      const turnsToArchive = eligibleTurns - (eligibleTurns % s.pairsPerChunk);
      const archiveEndIdx = turnsToArchive < boundaries.length ? boundaries[turnsToArchive]! : messages.length;
      const chunkInput: ChatTranscriptMessage[] = messages.slice(0, archiveEndIdx).map((m) => ({
        messageId: m.message_id,
        role: m.role,
        content: m.content,
      }));
      const chunks = chunkChatTranscript(chunkInput, 0, s.pairsPerChunk * 2);

      const [syncPoint] = await session.query<{ sync_id: string; last_message_id: string }>(
        'select sync_id, last_message_id from chat_sync_points where chat_id = $1 order by ordinal desc limit 1',
        [chatId],
      );
      if (!syncPoint) {
        // Never-synced chat (no sync point, therefore no chunks — chat_chunks.sync_id is not
        // null): nothing to delete, and the tick will chunk it at the live size when due.
        log.debug('chat chunk resize: chat has no sync point, leaving it to the sync tick', { chatId });
        return;
      }
      if (chunks.length === 0) {
        await session.query('delete from chat_chunks where chat_id = $1', [chatId]);
        return;
      }

      // Regenerate the summaries + both embeddings (content lane and the 0094 summary lane),
      // byte-for-byte the tick's own summarize_embed step, then swap the archive atomically.
      const summaries = await Promise.all(chunks.map((c) => summarizeChatChunk(s.llm, c.content, s.chunkSummaryPrompt)));
      const vectors = await deps.embeddings.embed(chunks.map((c) => c.content));
      const summaryVectors = await deps.embeddings.embed(summaries);

      await session.query('delete from chat_chunks where chat_id = $1', [chatId]);
      // Lead-in chain (docs/plans/chunk-lead-in-context-plan.md): this is a full wipe-and-
      // regenerate from ordinal 0, so the first new chunk is the chain head (null parent) and
      // each subsequent chunk links to the previous row of this pass via `returning chunk_id`.
      let parentChunkId: string | null = null;
      for (const [i, chunk] of chunks.entries()) {
        const [inserted]: { chunk_id: string }[] = await session.query<{ chunk_id: string }>(
          `insert into chat_chunks (chat_id, sync_id, user_id, ordinal, content, summary, vector_embed, summary_vector_embed, parent_chunk_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           returning chunk_id`,
          [chatId, syncPoint.sync_id, userId, chunk.ordinal, chunk.content, summaries[i], toPgVectorLiteral(vectors[i]!), toPgVectorLiteral(summaryVectors[i]!), parentChunkId],
        );
        parentChunkId = inserted!.chunk_id;
      }

      // Advance-only anchor update — see the module header for why it never retreats.
      const newAnchor = chunks[chunks.length - 1]!.lastMessageId;
      const currentAnchorIdx = messages.findIndex((m) => m.message_id === syncPoint.last_message_id);
      const newAnchorIdx = messages.findIndex((m) => m.message_id === newAnchor);
      if (newAnchorIdx > currentAnchorIdx) {
        await session.query('update chat_sync_points set last_message_id = $2 where sync_id = $1', [syncPoint.sync_id, newAnchor]);
      }
    }),
  );
}

/** The background pass. Never throws: a failure anywhere records 'error' + the message in the
 *  status row (bi_principles.md §11 — a broken pass is visible, not silent); a per-chat failure
 *  is logged and counted as done, since that chat's rollback left it untouched. */
export async function runChatChunkResize(deps: ChatChunkResizeDeps): Promise<void> {
  try {
    const s = await resolveResizeSettings(deps);

    // Enumerate every non-archived chat with its owner, then run each chat under its own RLS
    // scope (chat_chunks/user data is user-scoped; the enumeration itself is system-scoped).
    const chats = await deps.db.withSystemScope(async (session) =>
      session.query<{ chat_id: string; user_id: string }>(
        'select chat_id, user_id from chat_sessions where archived_at is null order by chat_id',
      ),
    );
    await deps.db.withSystemScope((session) =>
      session.query('update chat_chunk_resize_status set chats_total = $1 where id = 1', [chats.length]),
    );

    for (const chat of chats) {
      try {
        await resizeOneChat(deps, s, chat.user_id, chat.chat_id);
      } catch (err) {
        // Rolled back — the chat keeps its existing chunks; the failure is visible in the log.
        log.error('chat chunk resize: chat failed, keeping its existing chunks', { chatId: chat.chat_id, err });
      }
      await deps.db.withSystemScope((session) =>
        session.query('update chat_chunk_resize_status set chats_done = chats_done + 1 where id = 1'),
      );
    }

    await deps.db.withSystemScope((session) =>
      session.query("update chat_chunk_resize_status set status = 'done', finished_at = now() where id = 1"),
    );
    log.info('chat chunk resize: pass finished', { chatsTotal: chats.length });
  } catch (err) {
    log.error('chat chunk resize: pass failed', { err });
    await deps.db
      .withSystemScope((session) =>
        session.query(
          `update chat_chunk_resize_status set status = 'error', finished_at = now(), error = $1 where id = 1`,
          [err instanceof Error ? err.message : String(err)],
        ),
      )
      .catch((recordErr) => log.error('chat chunk resize: failed to record error status', { err: recordErr }));
  }
}

export async function getChatChunkResizeStatus(db: PostgresClient): Promise<ChunkResizeStatusRow> {
  return db.withSystemScope(async (session) => {
    const [row] = await session.query<{
      status: string;
      chats_total: number;
      chats_done: number;
      started_at: Date | null;
      finished_at: Date | null;
      error: string | null;
    }>(
      'select status, chats_total, chats_done, started_at, finished_at, error from chat_chunk_resize_status where id = 1',
    );
    if (!row) return { status: 'idle', chatsTotal: 0, chatsDone: 0, startedAt: null, finishedAt: null, error: null };
    return {
      status: row.status as ChunkResizeStatusRow['status'],
      chatsTotal: row.chats_total,
      chatsDone: row.chats_done,
      startedAt: row.started_at ? row.started_at.toISOString() : null,
      finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
      error: row.error,
    };
  });
}
