/**
 * @file orchestrator/src/orchestrator/eagerChunkSync.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — the eager chat-memory chunk step (docs/plans/eager-chunk-sync-plan.md)
 * @description
 * The sync tick (chatMemorySync.ts) batches a due chat's chunking into the same transaction as its
 * digest/bridge/curator consolidation — a chat that's gone quiet can arrive at a tick with a large
 * backlog of chunk work bunched into one pass. This module peels the chunk-create part
 * (chunkChatTranscript.ts + classifyChatChunk.ts + embedding) off that batch and runs it the
 * moment enough new messages exist to form a whole chunk — right after a turn persists — so that
 * by the time the tick runs, the chunk rows mostly already exist and the tick's own job shrinks
 * to consolidation (digest/bridge/curators).
 *
 * Sibling to chatMemorySync.ts, not folded into it (bi_principles.md §10 — the same split
 * recallPlotLane.ts/recallFactLane.ts already follow): it reuses the tick's own building blocks
 * (chunkChatTranscript, summarizeChatChunk, findTurnBoundaries) and the same sync-point lifecycle
 * contract, only earlier. Each pass is a cost/latency-smoothing no-op in the common case (most
 * turns add one user + one assistant message, half of one chunk) and fails open — a broken eager
 * pass just leaves chunking to the tick's existing top-up, exactly as if it had never run.
 *
 * Eligibility is counted in turn-pairs through findTurnBoundaries (never raw message counts), with
 * the seeded greeting folded into turn 1 — so the eager boundary can never drift ahead of or
 * behind the tick's own turn-aligned archive boundary, and the plan's "visibility unchanged"
 * claim holds: eager chunking never reaches into the live window, and the tick's consolidated
 * sync point is what recall/digest still gate on.
 *
 * The sync-point lifecycle: an eager pass chunks against the chat's OPEN sync point (`closed_at`
 * null), opening one if none exists (next ordinal, left open); the sync tick that eventually
 * consolidates the block reuses that point, stamps its own archiveEnd as last_message_id, and
 * closes it. At most one open point can exist per chat by construction: only this module opens
 * points, only the tick closes them, and both take the same per-chat pg_advisory_xact_lock first.
 *
 * @api-declaration
 * maybeEagerChunk(deps, userId, chatId) — never throws; internally catches and logs (bi_principles.md
 *   §11). Fire-and-forget from the turn path (handleChatCompletions.ts); nothing it does can fail
 *   or delay the turn.
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, LLM IO via the gated provider, embeddings IO)
 *     state_ownership: []
 *     external_io:     [Postgres, the LLM via the gated provider it builds (same construction
 *                       resolveSyncSettings uses), the embeddings provider]
 */

import { log } from '../io/logger.js';
import { runWithCallContext, withCallLabel } from '../io/llm/callContext.js';
import { createLlmProviderForProfile } from '../io/llm/index.js';
import { createGatedLlmProvider } from '../io/llm/llmGate.js';
import type { LlmProvider } from '../io/llm/types.js';
import { toPgVectorLiteral } from '../util/pgvector.js';
import { chunkChatTranscript, DEFAULT_CHUNK_PAIRS, type ChatTranscriptMessage } from '../io/chatMemory/chunkChatTranscript.js';
import { summarizeChatChunk } from '../io/chatMemory/classifyChatChunk.js';
import { findTurnBoundaries, DEFAULT_LIVE_WINDOW_PAIRS, type ChatMemorySyncDeps } from './chatMemorySync.js';

/** Mirrors ChatMemorySyncDeps in full — chunk summarization is a mandatory, gated LLM call
 *  (`chat_chunks.summary` is `not null`), so this path can never skip or stub the provider. */
export type EagerChunkDeps = ChatMemorySyncDeps;

export type EagerChunkResult = { status: 'noop' | 'ok'; chunksAdded: number };

function toPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Same live settings reads + gated-provider construction resolveSyncSettings (chatMemorySync.ts)
 *  does for the tick: chat_memory_profile names the chunk-summary connection (falling back to the
 *  household's active connection when unset or unknown), chat_memory_chunk_summary_prompt can
 *  override the built-in summarize prompt, chat_memory_live_window_pairs sets the live window, and
 *  chat_memory_chunk_pairs sets the chunk size in turn-pairs (docs/plans/completed/chunk-size-resize-plan.md
 *  — fallback DEFAULT_CHUNK_PAIRS = today's 4-message chunk, so a changed size is a no-op until a
 *  value is saved). */
async function resolveEagerLlm(deps: EagerChunkDeps, userId: string, chatId: string): Promise<{
  llm: LlmProvider;
  chunkSummaryPrompt: string | undefined;
  liveWindowPairs: number;
  pairsPerChunk: number;
}> {
  const [chatProfile, livePairsRaw, chunkPairsRaw, chunkSummaryPrompt] = await Promise.all([
    deps.db.withUserScope(userId, async (session) => {
      const rows = await session.query<{ profile: string | null }>(
        `select params->>'profile' as profile from chat_sessions where chat_id = $1`,
        [chatId],
      );
      return rows[0]?.profile ?? undefined;
    }),
    deps.settings.get('chat_memory_live_window_pairs'),
    deps.settings.get('chat_memory_chunk_pairs'),
    deps.settings.get('chat_memory_chunk_summary_prompt'),
  ]);

  let llm = deps.llm;
  if (!chatProfile) {
    const active = await deps.llmConnections.resolveActive();
    if (!active) throw new Error(`chat ${chatId} has no selected connection and no active connection exists`);
    llm = createGatedLlmProvider(createLlmProviderForProfile(active), deps.db, deps.settings, active);
  }
  if (chatProfile) {
    const profile = await deps.llmConnections.resolveByName(chatProfile);
    if (profile) {
      llm = createGatedLlmProvider(createLlmProviderForProfile(profile), deps.db, deps.settings, profile);
    } else {
      throw new Error(`chat ${chatId} names unknown connection "${chatProfile}"; eager sync refused to use another connection`);
    }
  }

  return {
    llm,
    chunkSummaryPrompt: chunkSummaryPrompt || undefined,
    liveWindowPairs: toPositiveInt(livePairsRaw, DEFAULT_LIVE_WINDOW_PAIRS),
    pairsPerChunk: toPositiveInt(chunkPairsRaw, DEFAULT_CHUNK_PAIRS),
  };
}

/**
 * The eager chunk step: if at least one whole chunk (pairsPerChunk turn-pairs — the live
 * chat_memory_chunk_pairs setting, default 2) has rolled off this chat's live window since the
 * last chunking, chunk + summarize + embed it against the chat's open sync point (opening one if
 * none exists) and commit. Two phases — a cheap unlocked pre-check first, so the common no-op
 * turn never takes the per-chat advisory lock or loads the transcript; the locked phase re-derives
 * everything under the lock as the authoritative check, guarding the race where a concurrent eager
 * call or sync tick for the same chat changed the counts in between.
 *
 * Never throws: every failure is caught, logged, and turned into a no-op — the sync tick's
 * existing chunking path picks the backlog up the next time the chat is due.
 */
export async function maybeEagerChunk(deps: EagerChunkDeps, userId: string, chatId: string): Promise<EagerChunkResult> {
  try {
    const { llm, chunkSummaryPrompt, liveWindowPairs, pairsPerChunk } = await resolveEagerLlm(deps, userId, chatId);

    // Phase 1 — unlocked, cheap pre-check. floor(messageCount / 2) is the turn-count estimate:
    // exact in every today-case (each turn is one user + one assistant message; a seeded
    // greeting's +1 message rounds down with the pair it rides in), and any under/over-estimate
    // by a fraction of a pair is re-derived authoritatively under the lock anyway.
    const counts = await deps.db.withUserScope(userId, async (session) => {
      const [msgRow] = await session.query<{ n: string }>('select count(*)::text as n from chat_messages where chat_id = $1', [chatId]);
      const [chunkRow] = await session.query<{ n: string }>('select count(*)::text as n from chat_chunks where chat_id = $1', [chatId]);
      return { messageCount: Number(msgRow?.n ?? '0'), chunkCount: Number(chunkRow?.n ?? '0') };
    });
    const turnCountEstimate = Math.floor(counts.messageCount / 2);
    const eligiblePairsEstimate = Math.max(
      0,
      turnCountEstimate - liveWindowPairs - counts.chunkCount * pairsPerChunk,
    );
    if (Math.floor(eligiblePairsEstimate / pairsPerChunk) === 0) {
      return { status: 'noop', chunksAdded: 0 };
    }

    // Phase 2 — locked authoritative pass, under the same per-chat advisory lock and
    // runWithCallContext gate the tick uses (bi_principles.md §14: chunk summarization is a real
    // LLM call, so it must never slip in through an ungated path).
    return await runWithCallContext({ taskId: chatId, kind: 'system', userId }, () =>
      deps.db.withUserScope(userId, async (session): Promise<EagerChunkResult> => {
        await session.query('select pg_advisory_xact_lock(hashtext($1))', [chatId]);

        const messages = await session.query<{ message_id: string; role: 'user' | 'assistant'; content: string }>(
          'select message_id, role, content from chat_messages where chat_id = $1 order by created_at, message_id',
          [chatId],
        );
        // findTurnBoundaries folds a seeded greeting into turn 1 (no boundary of its own), so the
        // greeting is never its own turn, pair, chunk, or live-window slot.
        const turnCount = findTurnBoundaries(messages).length;

        // count(*) doubles as the ordinal base (startOrdinal) and, multiplied by pairsPerChunk,
        // as alreadyChunkedPairs — one query, two roles, not interchangeable numbers.
        const [chunkCountRow] = await session.query<{ n: string }>('select count(*)::text as n from chat_chunks where chat_id = $1', [chatId]);
        const startOrdinal = Number(chunkCountRow?.n ?? '0');

        const eligiblePairs = Math.max(
          0,
          turnCount - liveWindowPairs - startOrdinal * pairsPerChunk,
        );
        const chunksToCreate = Math.floor(eligiblePairs / pairsPerChunk);
        if (chunksToCreate === 0) return { status: 'noop', chunksAdded: 0 };

        // The span to chunk is the rolled-off-but-unchunked one: after the already-chunked
        // messages, never into the live window (chunksToCreate * messagesPerChunk <= eligible
        // messages by construction). Slicing from message 0 instead would re-chunk content the
        // existing chunks already cover.
        const messagesPerChunk = pairsPerChunk * 2;
        const coveredMessages = startOrdinal * messagesPerChunk;
        const toChunk: ChatTranscriptMessage[] = messages
          .slice(coveredMessages, coveredMessages + chunksToCreate * messagesPerChunk)
          .map((m) => ({ messageId: m.message_id, role: m.role, content: m.content }));
        const chunks = chunkChatTranscript(toChunk, startOrdinal, messagesPerChunk);

        // The mandatory summarize + embed pair, byte-for-byte the tick's own summarize_embed step
        // (content lane + the 0094 summary lane).
        const summaries = await withCallLabel('sync:chunk-summary', () =>
          Promise.all(chunks.map((c) => summarizeChatChunk(llm, c.content, chunkSummaryPrompt))),
        );
        const vectors = await deps.embeddings.embed(chunks.map((c) => c.content));
        const summaryVectors = await deps.embeddings.embed(summaries);
        const lastChunkedMessageId = chunks[chunks.length - 1]!.lastMessageId;

        // Reuse the chat's open sync point if one exists; otherwise open one (next ordinal, left
        // open for the tick to consolidate and close). At most one open point can exist — see the
        // module header.
        const [openPoint] = await session.query<{ sync_id: string }>(
          'select sync_id from chat_sync_points where chat_id = $1 and closed_at is null order by ordinal desc limit 1',
          [chatId],
        );
        let syncId: string;
        if (openPoint) {
          syncId = openPoint.sync_id;
        } else {
          const [maxRow] = await session.query<{ m: string | null }>(
            'select max(ordinal)::text as m from chat_sync_points where chat_id = $1',
            [chatId],
          );
          const nextOrdinal = (maxRow?.m != null ? Number(maxRow.m) : -1) + 1;
          const [inserted] = await session.query<{ sync_id: string }>(
            `insert into chat_sync_points (chat_id, user_id, ordinal, last_message_id) values ($1, $2, $3, $4)
             returning sync_id`,
            [chatId, userId, nextOrdinal, lastChunkedMessageId],
          );
          syncId = inserted!.sync_id;
        }

        // Lead-in chain (docs/plans/chunk-lead-in-context-plan.md), same rule as the tick's
        // insert_chunks step: the batch's first chunk links to the chat's current max-ordinal
        // row (null when the chat has no chunks yet — it becomes the chain head), each
        // subsequent chunk links to the previously inserted row. This loop is inside the
        // per-chat advisory lock taken at the top of Phase 2, so the read-then-insert is
        // race-free; parent_chunk_id is never inferred from ordinal.
        const [prevChunk] = await session.query<{ chunk_id: string }>(
          'select chunk_id from chat_chunks where chat_id = $1 order by ordinal desc limit 1',
          [chatId],
        );
        let parentChunkId: string | null = prevChunk?.chunk_id ?? null;
        for (const [i, chunk] of chunks.entries()) {
          const [inserted]: { chunk_id: string }[] = await session.query<{ chunk_id: string }>(
            `insert into chat_chunks (chat_id, sync_id, user_id, ordinal, content, summary, vector_embed, summary_vector_embed, parent_chunk_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             returning chunk_id`,
            [chatId, syncId, userId, chunk.ordinal, chunk.content, summaries[i], toPgVectorLiteral(vectors[i]!), toPgVectorLiteral(summaryVectors[i]!), parentChunkId],
          );
          parentChunkId = inserted!.chunk_id;
        }

        // Advance the open point's anchor to the new span end — only ever runs when >= 1 chunk was
        // produced this call (guaranteed above), so unique (chat_id, last_message_id) is safe.
        await session.query('update chat_sync_points set last_message_id = $2 where sync_id = $1', [syncId, lastChunkedMessageId]);

        log.info('eager chunk: chunked rolled-off turn pairs', { chatId, chunksAdded: chunks.length, syncId });
        return { status: 'ok', chunksAdded: chunks.length };
      }),
    );
  } catch (err) {
    // bi_principles.md §11: log, never swallow silently — a stuck or broken eager pass is visible
    // in the server log without ever breaking a turn.
    log.error('eager chunk: pass failed — leaving chunking to the sync tick', { chatId, err });
    return { status: 'noop', chunksAdded: 0 };
  }
}
