/**
 * @file orchestrator/src/io/chatMemory/recallChunkLane.ts
 * @stamp 2026-08-17
 * @architectural-role IO Wrapper — the chat_chunks half of buildAutoRecallParts's CNZ-style
 * silent auto-recall (recallForPrompt.ts), split out per bi_principles.md §10's 300-line budget
 * once Stages 3-5 of docs/plans/rag-dynamic-cutoff-plan.md grew this lane substantially.
 * @description
 * Everything specific to the archived full-turn "chat lane": the content-vector query (Stage 1,
 * migration 0077/0091, temporal decay Stage 3), the header/summary-vector query (Stage 5,
 * migration 0094), the two windows' fusion + dual-confirmation bonus (recallCutoff.mergeLanes),
 * the keyword/FTS blend (Stage 4, migration 0093, recallCutoff.blendKeyword), and the dynamic
 * cutoff (Stage 1, recallCutoff.applyCutoff) that decides how many of the resulting best-first
 * rows are worth injecting. recallForPrompt.ts resolves the live settings (Min/Max/Pool
 * Multiple/Cutoff Mode) into plain numbers and calls recallChunkLane once per turn; this module
 * owns none of that settings-reading, only the two-lane fetch → fuse → blend → cutoff pipeline.
 *
 * Pipeline order, matching Canonize's own (RAG_strategy_v4.md §3): fetch a KEYWORD_WINDOW_SIZE
 * window per lane ordered by decayed distance (the SQL divides by recallCutoff.decayFactor) →
 * fuse the two lanes with best-of scoring + the 1.08× dual-confirmation bonus (mergeLanes) →
 * blend in the keyword score (blendKeyword) → re-sort by blended distance → cut the fused/
 * blended window DOWN to the Stage-1 pool size (poolSize(max, poolMultiple), capped at
 * MAX_POOL_SIZE) → only THEN measure the pool's mean/σ and decide how many leading rows clear
 * the threshold (applyCutoff). That last cut matters and is easy to lose in a refactor: the
 * window is deliberately fetched larger than the pool (KEYWORD_WINDOW_SIZE 100 vs. a pool that's
 * usually 12-24) so the keyword/header lanes have candidates beyond the vector top-N_C to
 * promote from, but applyCutoff's mean/σ statistics are calibrated to the pool's shape — feeding
 * the full uncut window into applyCutoff would dilute the mean with matches the fetch only kept
 * around for the blend to consider, not for the cutoff to measure, and change the cutoff's
 * behavior from what Stage 1 was designed and tested against.
 *
 * @api-declaration
 * recallChunkLane(session, userId, chatId, vector, query, opts) ->
 *   Promise<{ chunks: ChunkRow[] }> — the full two-lane fetch/fuse/blend/cutoff pipeline for one
 *   turn. Logs one telemetry line per call (bi_principles.md §11: the seam where "nothing here
 *   was worth recalling" becomes visible instead of silently injecting mediocre matches).
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the caller's session, logs)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { DbSession } from '../postgres.js';
import { toPgVectorLiteral } from '../../util/pgvector.js';
import { applyCutoff, blendKeyword, mergeLanes, poolSize, type CutoffMode } from './recallCutoff.js';
import { log } from '../logger.js';

/** Stage 4: the per-lane fetch window — deliberately larger than the Stage-1 pool (MAX_POOL_SIZE
 *  below) so the keyword/header lanes have room to promote matches from beyond the vector
 *  top-N_C before the window is cut down to the pool applyCutoff measures (see the file
 *  preamble's pipeline order). */
const KEYWORD_WINDOW_SIZE = 100;

/** Sanity cap on the Stage-1 pool (poolSize(max, poolMultiple)) — a corrupt Pool Multiple must
 *  not turn into an unbounded fetch or an unbounded statistics sample. Same value and reasoning
 *  as recallFactLane's own cap; kept as its own local constant rather than a shared import,
 *  since the two lanes' fetch shapes (window-then-cut vs. a flat pool) differ enough that
 *  sharing one integer across a file boundary isn't worth the coupling. */
const MAX_POOL_SIZE = 40;

export interface ChunkRow {
  ordinal: number;
  summary: string;
  content: string;
  /** Decayed L2 distance to the query vector, after fusion + keyword blend — see the file
   *  preamble's pipeline order. */
  distance: number;
  /** Full-text rank for this row (Stage 4) — ts_rank over chat_chunks.content_tsv (migration
   *  0093), 0 when the row has no keyword match. */
  kw_score: number;
}

export interface ChunkLaneOptions {
  min: number;
  max: number;
  poolMultiple: number;
  cutoffMode: CutoffMode;
}

/** Fetch, fuse, blend, and cut this chat's archived chunks down to what's worth injecting.
 *  `vector`/`query` are the caller's already-embedded recall query (raw vector + its source
 *  text, the latter only used to build the keyword tsquery). See the file preamble for the full
 *  pipeline order. */
export async function recallChunkLane(
  session: DbSession,
  userId: string,
  chatId: string,
  vector: number[],
  query: string,
  opts: ChunkLaneOptions,
): Promise<{ chunks: ChunkRow[] }> {
  const { min, max, poolMultiple, cutoffMode } = opts;
  const pool = Math.min(poolSize(max, poolMultiple), MAX_POOL_SIZE);
  const keywordWindow = Math.max(pool, KEYWORD_WINDOW_SIZE);

  const [chunkRows, headerRows] = await Promise.all([
    // Stages 3-5: each row's distance is the raw `vector_embed <-> $query` divided by
    // Canonize's temporal-decay factor (recallCutoff.ts `decayFactor`) — a chunk `ageChunks`
    // chunks behind the newest archived chunk gets distance × 1/factor, so older-but-relevant
    // chunks rank (and are measured by the cutoff) as if farther away. The expression mirrors
    // decayFactor() verbatim — keep in sync (verify-recall-for-prompt.mjs asserts the SQL
    // shape). `now` is the newest chunk ordinal for this chat (scalar subquery, index-assisted
    // by chat_chunks_by_chat), so the freshest chunk has age 0 → factor 1 → no decay. Stage 4
    // adds the keyword lane: every row is scored with ts_rank over the content_tsv generated
    // column (migration 0093) for the OR of the query text's lexemes (ts_rank over a NULL
    // tsquery is NULL, coalesced to 0 when the query has none — the lane is inert, not an
    // error, for the empty-lexeme case), and the fetch is the KEYWORD_WINDOW window rather than
    // the pool alone, so blendKeyword has room to promote lexical matches before the window is
    // cut to the pool the cutoff measures.
    session.query<ChunkRow>(
      `select ordinal, summary, content,
              (vector_embed <-> $3)
                / greatest(0.70, 1.0 - 0.025 * ln(2 * greatest(0, (select max(ordinal) from chat_chunks where user_id = $1 and chat_id = $2) - ordinal) + 1))
                as distance,
              coalesce(ts_rank(content_tsv, (select string_agg(lexeme, ' | ')::tsquery from unnest(to_tsvector('english', $4)))), 0)
                as kw_score
       from chat_chunks
       where user_id = $1 and chat_id = $2
       order by distance
       limit ${keywordWindow}`,
      [userId, chatId, toPgVectorLiteral(vector), query],
    ),
    // Stage 5: the header lane — same shape against chat_chunks.summary_vector_embed
    // (migration 0094), skipping rows that predate it (NULL = never embedded; the content lane
    // still covers them). Same decayed distance + same lane-independent keyword score (kw_score
    // comes from content_tsv, not the lane's vector), so mergeLanes can fuse the two windows
    // with best-of scoring + the 1.08× dual-confirmation bonus. A chunk the content lane missed
    // can enter the merged window here — the header lane is additive.
    session.query<ChunkRow>(
      `select ordinal, summary, content,
              (summary_vector_embed <-> $3)
                / greatest(0.70, 1.0 - 0.025 * ln(2 * greatest(0, (select max(ordinal) from chat_chunks where user_id = $1 and chat_id = $2) - ordinal) + 1))
                as distance,
              coalesce(ts_rank(content_tsv, (select string_agg(lexeme, ' | ')::tsquery from unnest(to_tsvector('english', $4)))), 0)
                as kw_score
       from chat_chunks
       where user_id = $1 and chat_id = $2 and summary_vector_embed is not null
       order by distance
       limit ${keywordWindow}`,
      [userId, chatId, toPgVectorLiteral(vector), query],
    ),
  ]);

  // Stage 5: fuse the two vector lanes (recallCutoff.ts mergeLanes — Canonize's RRF fusion,
  // Step 1) BEFORE the keyword blend, matching their pipeline order. Each chunk's distance
  // becomes the best-of (min) of its content and header decayed distances, with the 1.08×
  // dual-confirmation bonus when the chunk matched both lanes; header-only chunks join the
  // merged window, so the header lane can only add recall, never suppress it.
  const { rows: fusedRows, dualCount } = mergeLanes(
    chunkRows.map((r) => ({ ordinal: r.ordinal, distance: r.distance, kwScore: r.kw_score })),
    headerRows.map((r) => ({ ordinal: r.ordinal, distance: r.distance, kwScore: r.kw_score })),
  );
  const chunkByOrdinal = new Map([...chunkRows, ...headerRows].map((r) => [r.ordinal, r] as const));
  // Stage 4: the chunk lane's keyword blend (recallCutoff.ts blendKeyword) — each row's ts_rank
  // kw_score re-ranks the fused window by blended distance. The blend is additive: a row with no
  // keyword match keeps its fused distance, so the keyword lane can only promote, never bury.
  const { rows: blendedRows, scale: kwScale } = blendKeyword(
    fusedRows.map((r) => ({ distance: r.distance, kwScore: r.kwScore ?? 0 })),
  );
  // Re-sort by blended distance, THEN cut the window down to the Stage-1 pool size before
  // applyCutoff measures it — see the file preamble. Skipping this cut would feed the wider
  // fetch window (kept around for the keyword/header lanes' promotion headroom) into the
  // cutoff's statistics instead of the pool they're calibrated to.
  const orderedChunks = fusedRows
    .map((r, i) => ({ row: chunkByOrdinal.get(r.ordinal)!, distance: blendedRows[i].distance }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, pool);
  const { keepCount, stats } = applyCutoff(orderedChunks.map((x) => x.distance), { min, max, cutoffMode });
  const chunks = orderedChunks.slice(0, keepCount).map((x) => x.row);
  log.info('recallChunkLane: cutoff applied', {
    userId,
    chatId,
    min,
    max,
    keepCount,
    temporalDecay: true, // Stage 3: distances measured are decayed (recallCutoff.decayFactor)
    keywordLane: true, // Stage 4: distances measured are keyword-blended (recallCutoff.blendKeyword)
    kwScale, // the max keyword contribution (Canonize's telemetry `kw≤`; 0 = lane inert)
    headerLane: true, // Stage 5: distances measured are fused across content+header (mergeLanes)
    dualCount, // how many chunks matched both lanes and received the 1.08× dual bonus
    ...stats,
  });
  return { chunks };
}
