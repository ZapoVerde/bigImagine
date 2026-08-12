/**
 * @file orchestrator/src/io/chatMemory/recallCutoff.ts
 * @stamp 2026-08-15
 * @architectural-role Pure Function — CNZ-style distribution-aware retrieval cutoff, ported to raw distance
 * @description
 * The ported pool-statistics/threshold stage of SillyTavern-Canonize's rag/cutoff.js
 * (docs/plans/rag-dynamic-cutoff-plan.md, Stage 1 of the CNZ retrieval port): given the pool of
 * candidate distances the caller already fetched, decide how many of them are actually worth
 * injecting — the "is anything here worth recalling?" mechanism the fixed-LIMIT read path never
 * had. Pure Function per bi_principles.md §8: no IO, no settings access — recallForPrompt.ts
 * reads the settings and passes plain numbers in, this module only does arithmetic on them.
 *
 * Two deliberate adaptations from Canonize's literal formulas, both documented in the plan's
 * Background section and worth restating here because they shape every number this module
 * produces:
 *
 *  1. The input is pgvector's raw L2 distance (`vector_embed <-> $query`), not a bounded cosine
 *     similarity. Lower is better, so the threshold direction is INVERTED from Canonize's
 *     similarity-space formulas: the stricter modes SUBTRACT standard deviations from the mean
 *     rather than add them, and rows are kept when distance < threshold.
 *  2. Canonize's absolute σ floor (0.01) is calibrated to its [0,1]-ish similarity range; raw L2
 *     distance has no fixed scale, so the floor is relative to the pool's own mean
 *     (0.01 × mean) instead of a borrowed absolute constant.
 *
 * The cold-pool bypass (pool length <= min) is folded into applyCutoff as one early check rather
 * than kept as Canonize's separate pre-pipeline branch: computing a mean/σ on a handful of points
 * and then flooring back up to min anyway produces an identical result through more code.
 *
 * @api-declaration
 * poolSize(max, poolMultiple) -> number — the SQL LIMIT for the candidate pool, Canonize's own
 *   N_C = max(round(P × M), 6) unchanged. Called BEFORE the query runs.
 * applyCutoff(distances, { min, max, cutoffMode }) -> { keepCount, stats } — how many of the
 *   already-fetched, best-first pool rows to keep, plus the statistics for the caller's
 *   telemetry line. distances must be ascending (closest/best first) — the order the SQL query
 *   already returns; keepCount counts leading rows under the threshold, floored to min, clamped
 *   to max, and never exceeding what the pool actually holds.
 *
 * @contract
 *   assertions:
 *     purity:          pure — no IO, no settings access, no external reads/writes
 *     state_ownership: []
 *     external_io:     []
 */

export type CutoffMode = 'mean' | 'mean+1sd' | 'mean+2sd';

/** Canonize's own N_C pool-sizing formula (RAG_strategy_v4.md §3 Step 4), unchanged: the pool
 *  is P × Max candidates (rounded), floored at 6 so even a tiny Max/P combination gives the
 *  statistics a minimally-shaped pool. Called by the IO wrapper before it issues the SQL, to
 *  size the LIMIT — the pool must exist before its distribution can be measured. */
export function poolSize(max: number, poolMultiple: number): number {
  return Math.max(Math.round(poolMultiple * max), 6);
}

export interface CutoffStats {
  /** The pool actually measured — equals distances.length (the caller's fetched row count). */
  poolSize: number;
  mean: number;
  stdDev: number;
  threshold: number;
  cutoffMode: CutoffMode;
  /** true for the cold-pool bypass (distances.length <= min): mean/stdDev/threshold are 0 and
   *  must not be read as meaningful by the caller's telemetry beyond logging `bypassed`. */
  bypassed: boolean;
}

export interface CutoffResult {
  keepCount: number;
  stats: CutoffStats;
}

/** Decide how many of the pool's leading rows are worth keeping. `distances` is the pool's
 *  distance values in the order the SQL query already returned them — ascending, closest/best
 *  first. Cold-pool bypass: when the pool is at or below the Min floor, keep everything and skip
 *  statistics entirely (an empty archive is covered by the same check, since 0 <= min).
 *
 *  Otherwise the threshold is resolved in distance space, where lower is better, so the stricter
 *  modes pull the threshold DOWN from the mean (Canonize's similarity-space formulas push it up):
 *    mean     -> threshold = mean,             keep distance < threshold
 *    mean+1sd -> threshold = mean − stdDev,    keep distance < threshold
 *    mean+2sd -> threshold = mean − 2×stdDev,  keep distance < threshold
 *  stdDev is floored at 0.01 × mean (the relative floor — see the file preamble) so a perfectly
 *  flat pool can't make mean+1sd/mean+2sd degenerate into mean mode's behavior.
 *
 *  The result is floored to `min` (never above what the pool holds — the bypass already returned
 *  everything when the pool was <= min) and clamped to `max` (always satisfiable when
 *  poolMultiple >= 1, since poolSize >= max by construction). */
export function applyCutoff(
  distances: number[],
  opts: { min: number; max: number; cutoffMode: CutoffMode },
): CutoffResult {
  const { min, max, cutoffMode } = opts;
  const pool = distances.length;
  if (pool <= min) {
    return {
      keepCount: pool,
      stats: { poolSize: pool, mean: 0, stdDev: 0, threshold: 0, cutoffMode, bypassed: true },
    };
  }
  const mean = distances.reduce((a, b) => a + b, 0) / pool;
  const variance = distances.reduce((a, b) => a + (b - mean) ** 2, 0) / pool;
  const stdDev = Math.max(Math.sqrt(variance), 0.01 * mean);
  const threshold = cutoffMode === 'mean' ? mean : cutoffMode === 'mean+1sd' ? mean - stdDev : mean - 2 * stdDev;

  let keepCount = 0;
  for (const distance of distances) {
    if (distance < threshold) keepCount += 1;
    else break; // the pool is sorted best-first — nothing past the first miss is under threshold
  }
  if (keepCount < min) keepCount = min;
  if (keepCount > max) keepCount = max;
  return { keepCount, stats: { poolSize: pool, mean, stdDev, threshold, cutoffMode, bypassed: false } };
}
