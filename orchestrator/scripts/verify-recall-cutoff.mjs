// Proves io/chatMemory/recallCutoff.ts — the CNZ rag/cutoff.js pool-statistics stage ported onto
// BigImagine's single content-vector lane (docs/plans/rag-dynamic-cutoff-plan.md, Stages 1-3 of
// the CNZ retrieval port). Pure arithmetic: no IO, no settings access. poolSize sizes the SQL
// LIMIT the IO wrapper issues; applyCutoff decides how many of the already-fetched, best-first
// rows are worth injecting; decayFactor (Stage 3) is Canonize's temporal-decay multiplier the
// chunk query divides each raw distance by, before the pool is formed. The read-path wiring
// (settings → pool → slice → telemetry) is proven by verify-recall-for-prompt.mjs; this file
// pins the math itself.
//
// Canonize's own formulas with the plan's two documented adaptations: distances are raw L2
// distance (lower = better), so the stricter modes SUBTRACT σ from the mean (Canonize adds it in
// similarity space) and rows are kept while distance < threshold; and the σ floor is relative
// (0.01 × mean) because raw distance has no fixed scale to borrow an absolute floor from.

import { poolSize, applyCutoff, decayFactor, DECAY_FACTOR_FLOOR, DECAY_COEFFICIENT, PAIRS_PER_CHUNK } from '../dist/io/chatMemory/recallCutoff.js';

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

console.log('\nrecall-cutoff verification passed');
if (process.exitCode) process.exit(process.exitCode);
