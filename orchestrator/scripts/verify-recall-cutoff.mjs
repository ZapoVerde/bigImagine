// Proves io/chatMemory/recallCutoff.ts — the CNZ rag/cutoff.js pool-statistics stage ported onto
// BigImagine's chunk lanes (docs/plans/completed/rag-dynamic-cutoff-plan.md, Stages 1-5 of the CNZ
// retrieval port). Pure arithmetic: no IO, no settings access. poolSize sizes the SQL LIMIT the
// IO wrapper issues; applyCutoff decides how many of the already-fetched, best-first rows are
// worth injecting; decayFactor (Stage 3) is Canonize's temporal-decay multiplier the chunk query
// divides each raw distance by, before the pool is formed; blendKeyword (Stage 4) is Canonize's
// anchored keyword blend re-ranking the fetched window before the cutoff measures it;
// mergeLanes/dualBonus (Stage 5) are Canonize's content+header RRF fusion — best-of distance
// with the 1.08× dual-confirmation bonus for chunks that matched both lanes. The read-path
// wiring (settings → pool → slice → telemetry) is proven by verify-recall-for-prompt.mjs; this
// file pins the math itself.
//
// Canonize's own formulas with the plan's two documented adaptations: distances are raw L2
// distance (lower = better), so the stricter modes SUBTRACT σ from the mean (Canonize adds it in
// similarity space) and rows are kept while distance < threshold; and the σ floor is relative
// (0.01 × mean) because raw distance has no fixed scale to borrow an absolute floor from. The
// keyword blend (Stage 4) happens in the bounded similarity space s = 1/(1+d) — see the Stage 4
// addendum — because a literal distance-space subtraction collapses when the best match is a
// near-duplicate.

import { poolSize, applyCutoff, decayFactor, DECAY_FACTOR_FLOOR, DECAY_COEFFICIENT, PAIRS_PER_CHUNK, blendKeyword, KEYWORD_BLEND_ALPHA, dualBonus, mergeLanes, DUAL_CONFIRM_BONUS } from '../dist/io/chatMemory/recallCutoff.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- poolSize: the SQL LIMIT, Canonize's own N_C = max(round(P × M), 6) unchanged ---
{
  assert(poolSize(8, 2) === 16, 'poolSize(8, 2) = round(16) = 16 (the default Max × default P)');
  assert(poolSize(8, 5) === 40, 'poolSize(8, 5) = round(40) = 40');
  assert(poolSize(8, 1.5) === 12, 'poolSize(8, 1.5) = round(12) = 12 (P is a float, not an integer)');
  assert(poolSize(8, 0.5) === 6, 'a tiny P × M floors to the minimum pool (6)');
  assert(poolSize(2, 1) === 6, 'even the smallest Max/P combination floors to 6');
  assert(poolSize(12, 5) === 60, 'the formula itself is uncapped (the read path caps the pool at 40)');
}

// --- applyCutoff on a thematic pool: strictness ordering mean > mean+1sd > mean+2sd ---
// A clean retrieval where the best matches cluster near the query and the tail falls away
// (distances ascending, best-first — the order the SQL query returns). Mean keeps the strong
// cluster (clamped to Max), +1sd demands a clearly-matched tail, +2sd floors to Min.
{
  const thematic = [0.15, 0.18, 0.22, 0.25, 0.30, 0.35, 0.38, 0.42, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];
  const mean = applyCutoff(thematic, { min: 2, max: 8, cutoffMode: 'mean' });
  const sd1 = applyCutoff(thematic, { min: 2, max: 8, cutoffMode: 'mean+1sd' });
  const sd2 = applyCutoff(thematic, { min: 2, max: 8, cutoffMode: 'mean+2sd' });
  assert(mean.keepCount === 8, `mean mode keeps the strong cluster, clamped to Max (got ${mean.keepCount})`);
  assert(sd1.keepCount === 4, `mean+1sd keeps only the clearly-matched tail (got ${sd1.keepCount})`);
  assert(sd2.keepCount === 2, `mean+2sd is strictest, flooring to Min (got ${sd2.keepCount})`);
  assert(
    mean.keepCount > sd1.keepCount && sd1.keepCount > sd2.keepCount,
    'strictness ordering in distance space: mean > mean+1sd > mean+2sd',
  );
  assert(
    Math.abs(sd1.stats.mean - 0.453125) < 1e-9 &&
      Math.abs(sd1.stats.threshold - (sd1.stats.mean - sd1.stats.stdDev)) < 1e-9,
    'stats report the pool mean and the distance-space threshold (mean − σ for mean+1sd)',
  );
  assert(
    sd1.stats.poolSize === 16 && sd1.stats.cutoffMode === 'mean+1sd' && sd1.stats.bypassed === false,
    'stats carry poolSize / cutoffMode / bypassed=false for the caller\'s telemetry',
  );
}

// --- Flat noise: a pool with no signal must collapse to Min, in every mode ---
{
  const flat = Array(16).fill(0.5);
  for (const cutoffMode of ['mean', 'mean+1sd', 'mean+2sd']) {
    const r = applyCutoff(flat, { min: 3, max: 8, cutoffMode });
    assert(
      r.keepCount === 3,
      `a perfectly flat pool (no signal) collapses to the Min floor (3) in ${cutoffMode} mode`,
    );
  }
}

// --- Cold-pool bypass: at/below Min there is nothing to measure — keep everything ---
{
  const r = applyCutoff([0.1, 0.2], { min: 2, max: 8, cutoffMode: 'mean+2sd' });
  assert(r.keepCount === 2 && r.stats.bypassed === true, 'a pool at the Min floor keeps everything (bypass)');
  assert(
    r.stats.mean === 0 && r.stats.stdDev === 0 && r.stats.threshold === 0,
    'a bypass reports zeroed statistics, marked non-meaningful',
  );
}

// --- Zero-length input: no pool at all — keep 0, never throw ---
{
  const r = applyCutoff([], { min: 2, max: 8, cutoffMode: 'mean' });
  assert(r.keepCount === 0 && r.stats.bypassed === true, 'an empty pool keeps 0 without throwing');
}

// --- Min never exceeds what the pool holds ---
{
  const r = applyCutoff([0.1, 0.2, 0.3], { min: 5, max: 8, cutoffMode: 'mean' });
  assert(r.keepCount === 3, 'a Min above the pool size never exceeds the pool\'s own row count');
}

// --- Stage 3: temporal-decay factor (Canonize's Step 2 formula, age in chunk units × 2 pairs) ---
function closeTo(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}

{
  // Canonize: factor = max(0.70, 1 − 0.025·ln(agePairs + 1)); agePairs = 2·ageChunks.
  // ageChunks 0 (newest chunk) → ln(1) = 0 → factor 1 (no decay).
  assert(decayFactor(0) === 1, 'the newest chunk (age 0) gets factor 1 — no decay');
  // ageChunks 1 → agePairs 3 → 1 − 0.025·ln(3) = 1 − 0.027465...
  assert(closeTo(decayFactor(1), 1 - 0.025 * Math.log(3)), 'age 1 chunk decays by Canonize\'s ln(3) term (0.97253)');
  // ageChunks 50 → agePairs 101 → 1 − 0.025·ln(101) = 1 − 0.11538...
  assert(closeTo(decayFactor(50), 1 - 0.025 * Math.log(101)), 'age 50 chunk decays by Canonize\'s ln(101) term (0.88462)');
  // The 0.70 floor: ancient chunks stop decaying, never buried entirely.
  assert(decayFactor(1e9) === 0.7, 'ancient chunks floor at 0.70 (never buried entirely)');
  // Monotonic non-increasing — older never decays LESS than newer.
  assert(
    decayFactor(5) <= decayFactor(2) && decayFactor(2) <= decayFactor(0),
    'the factor is monotone non-increasing with age',
  );
  // The constants are Canonize's own, exported so the SQL mirror can be checked against them.
  assert(DECAY_FACTOR_FLOOR === 0.7 && DECAY_COEFFICIENT === 0.025 && PAIRS_PER_CHUNK === 2, 'Stage 3 constants are Canonize\'s own (0.70 / 0.025 / 2)');
}

// --- Stage 4: anchored keyword blend (Canonize's Step 3, adapted to distance space via the
// bounded similarity transform s = 1/(1+d) — see the plan's Stage 4 addendum) ---
{
  // No keyword matches anywhere → the blend is inert: every distance unchanged, scale 0.
  const out = blendKeyword([
    { distance: 0.5, kwScore: 0 },
    { distance: 0.9, kwScore: 0 },
  ]);
  assert(out.scale === 0, 'no keyword matches → scale 0, the blend is inert');
  assert(out.rows[0].distance === 0.5 && out.rows[1].distance === 0.9, 'no keyword matches → every distance unchanged');
  assert(out.rows[0].kwContribution === 0 && out.rows[1].kwContribution === 0, 'no keyword matches → zero keyword contribution');
  assert(KEYWORD_BLEND_ALPHA === 0.7, 'KEYWORD_BLEND_ALPHA is Canonize\'s own default (0.7)');
}
{
  // An empty window blends to nothing without dividing by zero.
  const out = blendKeyword([]);
  assert(out.rows.length === 0 && out.scale === 0, 'an empty window blends to nothing (scale 0)');
}
{
  // The cap: the top keyword match contributes exactly (1−α) × the strongest vector similarity.
  // distances [0.25, 0.5], kw [10, 0] → s = [0.8, 0.667]; maxS = 0.8; scale = 0.3 × 0.8 = 0.24.
  const out = blendKeyword([
    { distance: 0.25, kwScore: 10 },
    { distance: 0.5, kwScore: 0 },
  ]);
  assert(closeTo(out.scale, (1 - 0.7) * (1 / 1.25)), 'the top keyword match contributes exactly (1−α) × max vector similarity (kw≤ = 0.24)');
  assert(closeTo(out.rows[0].kwContribution, 0.24), 'the top keyword row carries the full contribution');
  assert(closeTo(out.rows[1].kwContribution, 0), 'a non-matching row gets no keyword contribution');
  // Top vector AND top keyword → blended similarity 1.04 → distance clamps at 0 (perfect match).
  assert(out.rows[0].distance === 0, 'top vector + top keyword clamps the blended distance to 0 (perfect match)');
  assert(out.rows[1].distance === 0.5, 'a non-matching row keeps its exact decayed distance');
}
{
  // Keyword promotion: a mediocre vector match with a strong keyword hit outranks closer vector
  // matches with no keyword hit. distances [0.5, 0.6, 0.9], kw [0, 0, 20]:
  // s = [0.667, 0.625, 0.526]; maxS = 0.667; scale = 0.2; row 3: s' = 0.726 → d' = 0.377.
  const out = blendKeyword([
    { distance: 0.5, kwScore: 0 },
    { distance: 0.6, kwScore: 0 },
    { distance: 0.9, kwScore: 20 },
  ]);
  const d = out.rows.map((r) => r.distance);
  assert(d[2] < d[0] && d[2] < d[1], 'a strong keyword match promotes a mediocre vector match above closer non-matches');
  assert(closeTo(d[2], 1 / (1 / (1 + 0.9) + 0.3 * (1 / 1.5)) - 1), 'the promoted row\'s distance is the exact blend inverse');
  assert(d[0] === 0.5 && d[1] === 0.6, 'rows without a keyword match keep their decayed distance');
}
{
  // Proportional: contributions scale with kwScore (half the max → half the contribution).
  const out = blendKeyword([
    { distance: 0.5, kwScore: 10 },
    { distance: 0.5, kwScore: 5 },
  ]);
  assert(closeTo(out.rows[1].kwContribution, out.rows[0].kwContribution / 2), 'keyword contribution is proportional to kwScore (t_i/t_max)');
  assert(out.rows[0].distance < out.rows[1].distance, 'equal vector matches re-rank by keyword strength (stronger keyword → closer)');
}
{
  // α semantics: α=1 → the lane is completely inert; α=0 → full strength (scale = maxS).
  const inert = blendKeyword([{ distance: 0.5, kwScore: 10 }], 1);
  assert(inert.scale === 0 && inert.rows[0].distance === 0.5, 'alpha 1 → the keyword lane contributes nothing');
  const full = blendKeyword([{ distance: 0.5, kwScore: 10 }], 0);
  assert(closeTo(full.scale, 1 / 1.5), 'alpha 0 → the keyword lane contributes at full strength (scale = max similarity)');
}

// --- Stage 5: dualBonus — the exact distance-space inverse of Canonize's capped ×1.08 ---
{
  assert(DUAL_CONFIRM_BONUS === 1.08, 'Stage 5 constant is Canonize\'s own DUAL_BONUS (1.08)');
  assert(dualBonus(0) === 0, 'a perfect dual match stays perfect (s=1 → ×1.08 caps at 1 → d\'=0)');
  assert(dualBonus(0.08) === 0, 'the similarity cap at 1 is a distance floor: d=0.08 → s=1/1.08 → ×1.08 = 1 → d\'=0');
  // d=0.5: s = 1/1.5 = 0.6667; ×1.08 = 0.72; d' = 1/0.72 − 1 = 0.3889.
  assert(closeTo(dualBonus(0.5), 1 / ((1 / (1 + 0.5)) * 1.08) - 1), 'the dual bonus is the exact inverse of s × 1.08 (d=0.5 → 0.3889)');
  const a = dualBonus(0.3);
  const b = dualBonus(0.6);
  assert(a < 0.3 && b < 0.6 && a < b, 'the bonus strictly improves every matched chunk and is monotone in distance');
  assert(dualBonus(0.5) < 0.5 && dualBonus(0.5) > 0, 'a mid-distance dual match is promoted but not clamped');
}

// --- Stage 5: mergeLanes — best-of across the two vector lanes + dual bonus for both-matched ---
{
  // Inert header lane: passthrough — every distance unchanged, no dual counts.
  const passthrough = mergeLanes(
    [
      { ordinal: 1, distance: 0.2 },
      { ordinal: 2, distance: 0.5 },
    ],
    [],
  );
  assert(passthrough.dualCount === 0 && passthrough.rows.length === 2, 'an empty header lane passes the content window through untouched');
  assert(passthrough.rows[0].distance === 0.2 && passthrough.rows[1].distance === 0.5, 'passthrough rows keep their exact content distances');

  // Best-of: the closer lane wins; both-matched chunks get the dual bonus on the best distance.
  const fused = mergeLanes(
    [
      { ordinal: 1, distance: 0.5, kwScore: 3 }, // header is closer → fused = dualBonus(0.3)
      { ordinal: 2, distance: 0.2, kwScore: 0 }, // content is closer → fused = dualBonus(0.2)
      { ordinal: 3, distance: 0.7, kwScore: 0 }, // content-only → unchanged
    ],
    [
      { ordinal: 1, distance: 0.3 },
      { ordinal: 2, distance: 0.6 },
      { ordinal: 4, distance: 0.4, kwScore: 9 }, // header-only → joins the window
    ],
  );
  assert(fused.dualCount === 2, 'dualCount counts exactly the chunks that matched both lanes (2)');
  assert(closeTo(fused.rows[0].distance, dualBonus(0.3)), 'best-of picks the closer header distance and applies the dual bonus');
  assert(closeTo(fused.rows[1].distance, dualBonus(0.2)), 'best-of picks the closer content distance and applies the dual bonus');
  assert(fused.rows[2].distance === 0.7, 'a content-only chunk keeps its exact distance — the header lane is additive');
  const headerOnly = fused.rows.find((r) => r.ordinal === 4);
  assert(headerOnly !== undefined && closeTo(headerOnly.distance, 0.4), 'a header-only chunk joins the merged window with its header distance');
  assert(headerOnly !== undefined && headerOnly.kwScore === 9, 'a header-only chunk carries its keyword score (lane-independent in SQL)');
  assert(fused.rows[0].kwScore === 3, 'a both-matched chunk keeps its content keyword score');
}

if (process.exitCode) process.exit(process.exitCode);