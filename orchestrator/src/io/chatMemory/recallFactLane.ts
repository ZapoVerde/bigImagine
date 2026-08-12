/**
 * @file orchestrator/src/io/chatMemory/recallFactLane.ts
 * @stamp 2026-08-17
 * @architectural-role IO Wrapper — the canon_facts half of buildAutoRecallParts's CNZ-style
 * silent auto-recall (recallForPrompt.ts), split out per bi_principles.md §10's 300-line budget
 * alongside recallChunkLane.ts.
 * @description
 * The Stage 2 counterpart of recallChunkLane.ts (docs/plans/completed/rag-dynamic-cutoff-plan.md, Stage 2
 * addendum): fetches this chat's approved canon facts (deduped to most-recent-approved per
 * arc_tag/entity_key — the same CTE recallCanonFactsTool.ts runs, scoped to "now" rather than an
 * as_of point in time), sized by the shared Pool Multiple against the fact lane's own Max
 * (canon_recall_top_k), then applies recallCutoff.ts's dynamic cutoff — the same pure function
 * recallChunkLane.ts uses, unchanged; Stage 2 added no new pure math — with the fact lane's own
 * Min (canon_recall_min). No temporal decay, no keyword blend, no second vector lane: Canonize's
 * own decay/keyword/header mechanisms are chat-channel-only, so this lane stays a single flat
 * vector query with a dynamic cutoff on top of it.
 *
 * @api-declaration
 * recallFactLane(session, userId, chatId, vector, opts) -> Promise<{ facts: CanonFactRow[] }> —
 *   fetch the fact pool and cut it to the dynamic threshold. Logs one telemetry line per call
 *   (bi_principles.md §11).
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the caller's session, logs)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { DbSession } from '../postgres.js';
import { toPgVectorLiteral } from '../../util/pgvector.js';
import { applyCutoff, poolSize, type CutoffMode } from './recallCutoff.js';
import { log } from '../logger.js';

/** Sanity cap on the fact pool — same value and reasoning as recallChunkLane's own cap; kept as
 *  its own local constant rather than a shared import (see that file's own note on why). */
const MAX_POOL_SIZE = 40;

export interface CanonFactRow {
  fact_id: string;
  category: string;
  summary: string;
  detail: string;
  /** Raw L2 distance to the query vector (`vector_embed <-> $query`) — no temporal decay
   *  (Canonize's decay is chat-channel-only, so this lane keeps a plain distance). */
  distance: number;
}

export interface FactLaneOptions {
  min: number;
  max: number;
  poolMultiple: number;
  cutoffMode: CutoffMode;
}

/** Fetch this chat's approved, deduped canon facts and cut the pool down to what's worth
 *  injecting. `vector` is the caller's already-embedded recall query. */
export async function recallFactLane(
  session: DbSession,
  userId: string,
  chatId: string,
  vector: number[],
  opts: FactLaneOptions,
): Promise<{ facts: CanonFactRow[] }> {
  const { min, max, poolMultiple, cutoffMode } = opts;
  const pool = Math.min(poolSize(max, poolMultiple), MAX_POOL_SIZE);

  const facts = await session.query<CanonFactRow>(
    `with candidates as (
       select f.fact_id, f.category, f.summary, f.detail, f.arc_tag, f.entity_key, f.approved_at, f.vector_embed
       from canon_facts f
       where f.user_id = $1 and f.chat_id = $2 and f.status = 'approved'
     ),
     ranked as (
       select distinct on (coalesce(arc_tag, entity_key, fact_id::text)) fact_id, category, summary, detail, vector_embed
       from candidates
       order by coalesce(arc_tag, entity_key, fact_id::text), approved_at desc
     )
     select fact_id, category, summary, detail, vector_embed <-> $3 as distance
     from ranked
     order by vector_embed <-> $3
     limit $4`,
    [userId, chatId, toPgVectorLiteral(vector), pool],
  );

  const { keepCount, stats } = applyCutoff(facts.map((f) => f.distance), { min, max, cutoffMode });
  const keptFacts = facts.slice(0, keepCount);
  log.info('recallFactLane: cutoff applied', { userId, chatId, min, max, keepCount, ...stats });
  return { facts: keptFacts };
}
