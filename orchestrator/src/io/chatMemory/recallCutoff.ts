/**
 * @file orchestrator/src/io/chatMemory/recallCutoff.ts
 * @stamp 2026-08-17
 * @architectural-role Pure Function — CNZ-style distribution-aware retrieval cutoff, ported to raw distance
 * @description
 * The ported pool-statistics/threshold stage of SillyTavern-Canonize's rag/cutoff.js
 * (docs/plans/completed/rag-dynamic-cutoff-plan.md, Stage 1 of the CNZ retrieval port): given the pool of
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
 * Since 2026-08-17 (Stage 4 of the same plan) the module also owns the anchored keyword blend
 * (their RAG_strategy_v4.md §3 Step 3) as a pure export, `blendKeyword(window, alpha)`. The
 * distance-space form is the item the Stage-1 Background explicitly left open ("flagged there,
 * not resolved here" — see the plan's Stage 4 addendum for the full reasoning): Canonize blends
 * in similarity space with an anchor of (1−α) × max(s_vec), and the literal distance mirror —
 * subtract (t_i/t_max) × (1−α) × min(d) — collapses whenever the best match is a near-duplicate
 * (min(d) ≈ 0 silences the keyword lane). So the blend happens in the bounded similarity space
 * s = 1/(1+d): strictly monotone, bounded (0,1], and the anchor max(s) = 1/(1+min(d)) is always
 * meaningful. Blended back with d' = max(0, 1/s' − 1); the pool statistics in applyCutoff still
 * run on distance, keeping the pipeline's distance-native convention consistently.
 *
 * Since 2026-08-17 (Stage 5 of the same plan) the module also owns the header/second vector
 * lane's fusion (their RAG_strategy_v4.md §3 Step 1) as pure exports, `dualBonus(distance)` and
 * `mergeLanes(content, header)`. Canonize's RRF fusion gives each item the best cosine seen
 * across its content and header lanes, × 1.08 (capped at 1) when the item matched BOTH lanes
 * (two independent representations agreeing strengthens the signal). In distance space (lower
 * is better) best-of is the min of the two lanes' decayed distances, and the bonus is the exact
 * inverse of Canonize's capped multiplier under the bounded similarity convention the Stage 4
 * blend established (s = 1/(1+d)): s' = min(1, 1.08·s), d' = max(0, 1/s' − 1) — the cap at 1
 * becomes a floor at distance 0, so a near-perfect dual match clamps to 0. One documented
 * order adaptation: Canonize boosts the fused score BEFORE decay, while this pipeline measures
 * decayed distance throughout (Stage 3's SQL); applying the bonus to the already-decayed
 * best-of distance is monotone and bounded (a slightly weaker bonus for older chunks), keeping
 * the pipeline's every-number-is-decimal-distance convention unbroken — see the plan's Stage 5
 * addendum.
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
 * blendKeyword(window, alpha?) -> { rows, scale } — Canonize's Step 3 anchored keyword blend in
 *   distance space (see the Stage-4 paragraph above): each row's kwScore re-ranks it within the
 *   window (index-aligned output rows carry the blended distance and the keyword contribution;
 *   `scale` is the max contribution, Canonize's telemetry `kw≤`, 0 when the lane is inert). The
 *   caller re-sorts by the blended distances (ascending) before applyCutoff, since the blend can
 *   re-rank.
 * dualBonus(distance) -> number — Canonize's 1.08× dual-confirmation bonus (Step 1) in distance
 *   space: the exact inverse of their capped similarity multiplier min(1, 1.08·s) under the
 *   s = 1/(1+d) convention, so a near-perfect dual match (d <= ~0.08) clamps to 0.
 * mergeLanes(content, header) -> { rows, dualCount } — Stage 5's fusion of the two vector
 *   lanes: each chunk's distance becomes the best-of (min) of its two decayed lane distances,
 *   with dualBonus applied when the chunk appeared in BOTH lanes' windows; header-only chunks
 *   (content lane missed them) join the merged window with their header distance and any
 *   keyword score the header query computed. The caller blends, re-sorts, and cuts off the
 *   merged rows exactly as it did the single-lane window.
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

/** Stage 4 constant, Canonize's own value (RAG_strategy_v4.md §3 Step 3): the keyword blend
 *  weight α — at 0.7 the keyword lane can contribute at most 30% of the strongest vector
 *  similarity in the window. Kept a plain constant, not a setting, exactly like the Stage 3
 *  decay constants — the plan's Stage-4 scope names no new setting; promoting α to a DB-backed
 *  RagView knob is the same mechanical follow-up Stage 3 documented. */
export const KEYWORD_BLEND_ALPHA = 0.7;

/** Stage 5 constant, Canonize's own value (RAG_strategy_v4.md §3 Step 1, DUAL_BONUS in their
 *  rag/rrf.js): the dual-confirmation bonus applied to a chunk's vector score when it matched
 *  BOTH the content and the header lane — two independent representations agreeing strengthens
 *  the relevance signal. Kept a plain constant, not a setting, same rationale as the Stage 3/4
 *  constants (the plan's Stage-5 scope names no new setting). */
export const DUAL_CONFIRM_BONUS = 1.08;

export interface KeywordBlendRow {
  /** Decayed L2 distance to the query vector (recallForPrompt.ts's chunk `distance` column). */
  distance: number;
  /** Full-text rank for the same row (recallForPrompt.ts's `kw_score` column — ts_rank over
   *  chat_chunks.content_tsv, migration 0093). 0/null when the row has no keyword match: the
   *  keyword lane is additive, so a row can only rank better, never worse. */
  kwScore: number | null | undefined;
}

export interface KeywordBlendResult {
  /** Index-aligned with the input window: each row's distance after the keyword blend, plus its
   *  keyword contribution. The caller re-sorts by `distance` (ascending) before applyCutoff. */
  rows: { distance: number; kwContribution: number }[];
  /** The max keyword contribution applied in this window (Canonize's telemetry `kw≤`): how much
   *  the strongest keyword match moved the top vector similarity. 0 when no row has a keyword
   *  match — the blend is inert and every distance is unchanged. */
  scale: number;
}

/** Canonize's anchored keyword blend (RAG_strategy_v4.md §3 Step 3) in distance space — the
 *  form the Stage-1 Background deliberately left open until a second lane existed (resolved in
 *  the plan's Stage 4 addendum). Canonize blends in similarity space (higher is better):
 *  s_i = s_vec_i + (t_i/t_max) × (1−α) × max(s_vec), anchored so the keyword lane contributes
 *  at most (1−α) × the strongest vector match. Raw L2 distance has no fixed scale, and the
 *  literal mirror (subtract (t_i/t_max) × (1−α) × min(d)) collapses when the best match is a
 *  near-duplicate, so the blend happens in the bounded similarity space s = 1/(1+d) — strictly
 *  monotone (ordering-preserving), bounded (0,1], and the anchor max(s) = 1/(1+min(d)) is always
 *  meaningful — then converts back with d' = max(0, 1/s' − 1): a row clamped at 0 is a perfect
 *  match (top vector AND top keyword). applyCutoff still measures distance, so the pipeline
 *  keeps its distance-native convention.
 *
 *  `window` is the caller's fetched candidate window (recallForPrompt.ts's KEYWORD_WINDOW_SIZE),
 *  any order — maxKw and max(s) are computed over it, the bounded analog of Canonize's
 *  whole-collection anchors (their query returns topK=100k; see the Stage 4 addendum's window
 *  note). No keyword match anywhere (maxKw = 0) or an empty window → scale 0, every distance
 *  unchanged. */
export function blendKeyword(
  window: KeywordBlendRow[],
  alpha: number = KEYWORD_BLEND_ALPHA,
): KeywordBlendResult {
  if (window.length === 0) return { rows: [], scale: 0 };
  const maxKw = window.reduce((m, w) => Math.max(m, w.kwScore ?? 0), 0);
  if (maxKw <= 0) {
    return { rows: window.map((w) => ({ distance: w.distance, kwContribution: 0 })), scale: 0 };
  }
  const maxS = window.reduce((m, w) => Math.max(m, 1 / (1 + w.distance)), 0);
  const scale = (1 - alpha) * maxS;
  return {
    rows: window.map((w) => {
      const contribution = ((w.kwScore ?? 0) / maxKw) * scale;
      // A row with no keyword match (contribution 0) keeps its distance EXACTLY — the keyword
      // lane is additive and must not perturb a non-matching row even by float rounding.
      if (contribution === 0) return { distance: w.distance, kwContribution: 0 };
      const blended = 1 / (1 + w.distance) + contribution;
      return { distance: Math.max(0, 1 / blended - 1), kwContribution: contribution };
    }),
    scale,
  };
}

export interface LaneRow {
  /** Chat-chunk ordinal (the chunk's identity across the two lane queries). */
  ordinal: number;
  /** Decayed L2 distance to the query vector from THIS lane (recallForPrompt.ts's `distance`
   *  column — content lane or summary_vector_embed lane). */
  distance: number;
  /** Full-text rank for the same chunk (ts_rank over chat_chunks.content_tsv, migration 0093).
   *  The keyword score is lane-independent — both lane queries compute it, so a header-only
   *  chunk can still carry its keyword score. 0/null = no keyword match (blend inert for it). */
  kwScore?: number | null;
}

export interface MergeLanesResult {
  /** The merged window: every content-lane row (distance = best-of the two lanes, with the
   *  dual-confirmation bonus applied when the chunk matched both), then any header-only rows.
   *  Callers blend (blendKeyword), re-sort by blended distance, and cut off (applyCutoff)
   *  exactly as they did a single-lane window. */
  rows: LaneRow[];
  /** How many chunks appeared in BOTH lanes' windows and received the dual bonus — telemetry
   *  (the plan's §11 "log where reasoning happens"). 0 when the header lane is inert. */
  dualCount: number;
}

/** Canonize's 1.08× dual-confirmation bonus (RAG_strategy_v4.md §3 Step 1, DUAL_BONUS in their
 *  rag/rrf.js) in distance space — the exact inverse of their capped similarity multiplier
 *  `min(1, s × 1.08)` under the bounded-similarity convention the Stage 4 blend established
 *  (s = 1/(1+d)): s' = min(1, 1.08·s), d' = max(0, 1/s' − 1). The similarity cap at 1 becomes
 *  a distance floor at 0 — any dual match at distance ≲ 0.08 clamps to 0 (perfect). Strictly
 *  monotone in `distance`, so it can re-rank but never invert the lane order. */
export function dualBonus(distance: number): number {
  const boosted = Math.min(1, (1 / (1 + distance)) * DUAL_CONFIRM_BONUS);
  return Math.max(0, 1 / boosted - 1);
}

/** Stage 5's fusion of the content and header vector lanes (Canonize's RRF fusion, Step 1).
 *  Each chunk's distance becomes the best-of (min) of its two decayed lane distances — the
 *  distance-space mirror of Canonize's "best cosine seen across lanes" — and chunks that
 *  appeared in BOTH lanes' windows get the dual-confirmation bonus (dualBonus), since two
 *  independent representations agreeing strengthens the signal. Rows the content lane missed
 *  but the header lane found join the merged window with their header distance (and keyword
 *  score), so the header lane can only ADD recall, never suppress it — same additive-lane
 *  discipline as the Stage 4 keyword lane.
 *
 *  Canonize's order is fusion → decay; this pipeline measures decayed distance throughout
 *  (Stage 3's SQL decays each lane), and best-of commutes with the decay (the factor depends
 *  only on the chunk's ordinal), so min(d_c, d_h) after per-lane decay equals the fused score
 *  after decay. The bonus does NOT commute exactly — applying it to the already-decayed
 *  best-of is a slightly weaker bonus for older chunks, monotone and bounded, keeping every
 *  number the cutoff measures in decayed distance space — see the plan's Stage 5 addendum. */
export function mergeLanes(content: LaneRow[], header: LaneRow[]): MergeLanesResult {
  if (header.length === 0) {
    return { rows: content, dualCount: 0 };
  }
  const headerByOrdinal = new Map<number, number>();
  const headerOrdinals = new Set<number>();
  for (const row of header) {
    headerByOrdinal.set(row.ordinal, row.distance);
    headerOrdinals.add(row.ordinal);
  }
  let dualCount = 0;
  const rows = content.map((row) => {
    const headerDistance = headerByOrdinal.get(row.ordinal);
    if (headerDistance === undefined) return row;
    dualCount += 1;
    return { ...row, distance: dualBonus(Math.min(row.distance, headerDistance)) };
  });
  const contentOrdinals = new Set(content.map((row) => row.ordinal));
  for (const row of header) {
    if (!contentOrdinals.has(row.ordinal)) rows.push({ ...row, kwScore: row.kwScore ?? 0 });
  }
  return { rows, dualCount };
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
