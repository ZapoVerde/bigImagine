/**
 * @file orchestrator/src/io/chatMemory/recallCutoff.ts
 * @stamp 2026-08-17
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
 * Since 2026-08-17 (Stage 3 of the same plan) the module also owns Canonize's temporal-decay
 * factor (their RAG_strategy_v4.md §3 Step 2, "chat channel only") as a pure export,
 * `decayFactor(ageChunks)`. The factor itself is Canonize's formula unchanged; the DISTANCE-SPACE
 * adaptation is the caller's: recallForPrompt.ts divides each chunk's raw distance by the factor
 * in SQL (older chunks get a larger distance — worse), mirroring Canonize's `s_vec = s_vec ×
 * factor` in a space where lower is better. The plan's Background flagged this distance-space
 * form as deliberately unresolved at Stage 1; Stage 3 resolves it as d' = d / factor because it
 * is scale-free (no absolute constants — consistent with the module's relative-σ-floor
 * convention) and a strict inversion of Canonize's multiplicative semantics.
 *
 * @api-declaration
 * poolSize(max, poolMultiple) -> number — the SQL LIMIT for the candidate pool, Canonize's own
 *   N_C = max(round(P × M), 6) unchanged. Called BEFORE the query runs.
 * applyCutoff(distances, { min, max, cutoffMode }) -> { keepCount, stats } — how many of the
 *   already-fetched, best-first pool rows to keep, plus the statistics for the caller's
 *   telemetry line. distances must be ascending (closest/best first) — the order the SQL query
 *   already returns; keepCount counts leading rows under the threshold, floored to min, clamped
 *   to max, and never exceeding what the pool actually holds.
 * decayFactor(ageChunks) -> number — Canonize's temporal-decay factor (Step 2): how much a chunk
 *   `ageChunks` chunks behind the conversation's newest archived chunk survives to the cutoff.
 *   age 0 (the newest chunk) returns 1 (no decay); the factor falls off as 1 − 0.025·ln(2·age+1)
 *   and floors at 0.70 so ancient-but-relevant chunks are never buried entirely.
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

/** Canonize's temporal-decay factor (RAG_strategy_v4.md §3 Step 2, chat channel only), their
 *  formula unchanged. `ageChunks` is how many chunks behind the conversation's newest archived
 *  chunk the row is; each chunk covers PAIRS_PER_CHUNK turn-pairs, so the age enters Canonize's
 *  ln(age + 1) in pair units (2·ageChunks + 1) — the faithful unit mapping, not an extra
 *  tuning knob. age 0 → factor 1 (no decay); the floor (0.70) stops ancient-but-relevant chunks
 *  from being buried entirely. The caller divides the row's raw distance by this factor
 *  (distance space: lower is better), so the factor must be reproduced verbatim in the chunk
 *  query's SQL — verify-recall-for-prompt.mjs asserts the SQL shape to catch drift. */
export function decayFactor(ageChunks: number): number {
  return Math.max(DECAY_FACTOR_FLOOR, 1 - DECAY_COEFFICIENT * Math.log(PAIRS_PER_CHUNK * ageChunks + 1));
}

/** Stage 3 constants, Canonize's own values (RAG_strategy_v4.md §3 Step 2) — kept plain
 *  constants, not settings, exactly as the plan's Stage 3 bullet specifies the formula. The
 *  SQL mirror in recallForPrompt.ts's chunk query must stay in sync with these. */
export const DECAY_FACTOR_FLOOR = 0.7;
export const DECAY_COEFFICIENT = 0.025;
/** Turn-pairs per chunk — chunkChatTranscript's MESSAGES_PER_CHUNK (4 messages = 2 pairs),
 *  the age-unit mapping between chunk ordinals and Canonize's pair-counted age. */
export const PAIRS_PER_CHUNK = 2;

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
