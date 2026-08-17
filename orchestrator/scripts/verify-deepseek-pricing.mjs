// Proves docs/plans/deepseek-pricing-sync.md end to end against compiled dist output (no network):
//
//  1. parseDeepSeekPricingHtml turns the official pricing table's shape (MODEL header, one
//     rowspan'd pricing-label row per token type carrying OFF-PEAK + prices, the PEAK row right
//     after it) into per-model off-peak + peak rates — and drops a model the instant any of its six
//     rates is missing or unparseable ("omit rather than guess": a broken page never half-syncs).
//  2. isPeakUtcHour classifies by UTC wall-clock only (DeepSeek's 01:00-04:00 + 06:00-10:00 UTC
//     window), so e.g. 09:00 local in Perth (UTC+8) = 01:00 UTC = peak.
//  3. pickPriceTier/computeCallCostUsd bill a call at the tier matching its UTC hour ONLY when
//     the connection actually has a peak tier configured (i.e. a synced DeepSeek connection) —
//     every other connection always bills at the base rate, UTC hour irrelevant, so a non-DeepSeek
//     provider never goes blank for ~7 UTC hours a day.
//  4. syncDeepSeekPricing (fetchHtml injected) writes off-peak + peak rates onto every native
//     DeepSeek connection (base_url host api.deepseek.com AND model on the page), overwriting
//     manual prices, stamps price_synced_at, and leaves host-mismatched / model-less / broken-URL
//     connections untouched; a failed fetch aborts the pass.
//
//  5. The HTTP route (POST /v1/admin/connections/pricing-sync) is covered in verify-server.mjs,
//     which injects the same fetchHtml seam through HttpServerDeps.

import { parseDeepSeekPricingHtml, isPeakUtcHour } from '../dist/io/llm/deepseekPricing.js';
import { pickPriceTier, computeCallCostUsd } from '../dist/io/llm/callCost.js';
import { syncDeepSeekPricing } from '../dist/io/deepseekPricingSync.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function utcHour(hour) {
  return new Date(Date.UTC(2026, 7, 17, hour, 0, 0));
}

// The page's real table shape (re-verified live 2026-08-17 against a fresh fetch): MODEL header
// then, per token type, a rowspan'd label row [label, 'OFF-PEAK', ...prices] immediately followed
// by [ 'PEAK', ...prices ] — PLUS a rowspan="6" "PRICING(1)" cell that wraps the whole block and
// lands as an extra leading cell on only the very first pricing row (whichever token type comes
// first), same shape as the unrelated "FEATURES" rowspan block earlier in the real table. This
// caught a real parser bug: assuming the label sat at cells[0] made the parser miss the label on
// that first row entirely, which (since every model needs all three labels) silently zeroed out
// every model against the live page.
// deepseek-v4-lite exercises the omit-rather-than-guess path: one of its peak prices is garbage.
const FIXTURE = `
<table>
  <tbody>
    <tr>
      <td colspan="2">MODEL</td>
      <td>deepseek-v4-flash</td>
      <td>deepseek-v4-pro</td>
      <td>deepseek-v4-lite</td>
    </tr>
    <tr>
      <td rowspan="6">PRICING(1)</td>
      <td rowspan="2">1M INPUT TOKENS (CACHE MISS)</td>
      <td>OFF-PEAK</td>
      <td>$0.14</td>
      <td>$2.00</td>
      <td>$0.05</td>
    </tr>
    <tr><td>PEAK</td><td>$0.28</td><td>$4.00</td><td>n/a</td></tr>
    <tr>
      <td rowspan="2">1M OUTPUT TOKENS</td>
      <td>OFF-PEAK</td>
      <td>$0.28</td>
      <td>$8.00</td>
      <td>$0.15</td>
    </tr>
    <tr><td>PEAK</td><td>$0.56</td><td>$16.00</td><td>$0.30</td></tr>
    <tr>
      <td rowspan="2">1M INPUT TOKENS (CACHE HIT)</td>
      <td>OFF-PEAK</td>
      <td>$0.014</td>
      <td>$0.20</td>
      <td>$0.005</td>
    </tr>
    <tr><td>PEAK</td><td>$0.028</td><td>$0.40</td><td>$0.01</td></tr>
  </tbody>
</table>
`;

// --- parser ---
{
  const parsed = parseDeepSeekPricingHtml(FIXTURE);
  assert(parsed.length === 2, `two of three fixture models survive parsing (got ${parsed.length})`);
  const flash = parsed.find((p) => p.model === 'deepseek-v4-flash');
  assert(
    flash &&
      flash.offPeak.inputPerMillion === 0.14 &&
      flash.offPeak.outputPerMillion === 0.28 &&
      flash.offPeak.cacheHitPerMillion === 0.014 &&
      flash.peak.inputPerMillion === 0.28 &&
      flash.peak.outputPerMillion === 0.56 &&
      flash.peak.cacheHitPerMillion === 0.028,
    'deepseek-v4-flash parses all six rates (off-peak and peak) from the OFF-PEAK + PEAK rows',
  );
  const pro = parsed.find((p) => p.model === 'deepseek-v4-pro');
  assert(
    pro && pro.peak.outputPerMillion === 16 && pro.offPeak.inputPerMillion === 2,
    'deepseek-v4-pro parses too — the rowspan label covers both its pricing rows',
  );
  assert(
    parsed.find((p) => p.model === 'deepseek-v4-lite') === undefined,
    'a model with an unparseable peak price is dropped entirely — never half-synced',
  );
  assert(
    parseDeepSeekPricingHtml('<html><body>no tables here</body></html>').length === 0,
    'a page with no pricing table yields [] — the sync then touches nothing',
  );
}

// --- isPeakUtcHour (UTC wall-clock only) ---
{
  assert(!isPeakUtcHour(utcHour(0)), '00:00 UTC is off-peak');
  assert(isPeakUtcHour(utcHour(1)), '01:00 UTC is peak (Perth 09:00 = 01:00 UTC)');
  assert(isPeakUtcHour(utcHour(3)), '03:59 UTC is peak');
  assert(!isPeakUtcHour(utcHour(4)), '04:00 UTC is off-peak again');
  assert(isPeakUtcHour(utcHour(6)), '06:00 UTC is peak');
  assert(isPeakUtcHour(utcHour(9)), '09:59 UTC is peak');
  assert(!isPeakUtcHour(utcHour(10)), '10:00 UTC is off-peak');
  assert(!isPeakUtcHour(utcHour(23)), '23:00 UTC is off-peak');
}

// --- pickPriceTier / computeCallCostUsd ---
{
  const price = {
    priceInputPerMillion: 1,
    priceOutputPerMillion: 2,
    priceCacheHitPerMillion: 0.5,
    pricePeakInputPerMillion: 3,
    pricePeakOutputPerMillion: 4,
    pricePeakCacheHitPerMillion: 1.5,
  };
  const offPeak = pickPriceTier(price, utcHour(5));
  assert(
    offPeak.priceInputPerMillion === 1 && offPeak.priceOutputPerMillion === 2 && offPeak.pricePeakInputPerMillion === undefined,
    'off-peak UTC hours pick the base tier fields',
  );
  const peak = pickPriceTier(price, utcHour(7));
  assert(
    peak.priceInputPerMillion === 3 && peak.priceCacheHitPerMillion === 1.5 && peak.priceOutputPerMillion === 4,
    'peak UTC hours pick the peak tier fields',
  );

  const usage = { promptTokens: 1_000_000, completionTokens: 0 };
  assert(
    Math.abs(computeCallCostUsd(usage, price, utcHour(5)) - 1) < 1e-12,
    'off-peak call prices the prompt at the base input rate',
  );
  assert(
    Math.abs(computeCallCostUsd(usage, price, utcHour(7)) - 3) < 1e-12,
    'peak call prices the prompt at the peak input rate',
  );

  const usageCache = { promptTokens: 1_000_000, cacheReadTokens: 400_000, completionTokens: 100_000 };
  assert(
    Math.abs(computeCallCostUsd(usageCache, price, utcHour(5)) - 1) < 1e-12,
    'cached tokens are priced at the base cache-hit tier off-peak (0.6 + 0.2 + 0.2)',
  );
  assert(
    Math.abs(computeCallCostUsd(usageCache, price, utcHour(7)) - 2.8) < 1e-12,
    'the same call in peak hours uses the peak tiers (1.8 + 0.6 + 0.4)',
  );

  assert(
    computeCallCostUsd(usage, { priceInputPerMillion: 1, priceOutputPerMillion: 2 }, utcHour(7)) === 1,
    'a peak-hour call against a connection with no peak tier configured (e.g. non-DeepSeek) bills at the base rate — peak tiering never applies outside a synced DeepSeek connection',
  );
}

// --- syncDeepSeekPricing ---
function createFakeConnectionsStore(rows) {
  const rowsById = new Map(rows.map((r) => [r.id, { ...r }]));
  const updates = [];
  return {
    rows: rowsById,
    updates,
    async list() {
      return Array.from(rowsById.values());
    },
    async update(id, patch) {
      const row = rowsById.get(id);
      if (!row) return undefined;
      Object.assign(row, patch);
      updates.push({ id, patch });
      return row;
    },
  };
}

{
  const store = createFakeConnectionsStore([
    { id: 'a', name: 'DeepSeek Direct', kind: 'openai-compatible', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'x' },
    { id: 'b', name: 'OpenRouter', kind: 'openai-compatible', model: 'deepseek-v4-flash', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'x' },
    { id: 'c', name: 'DeepSeek old model', kind: 'openai-compatible', model: 'deepseek-v3', baseUrl: 'https://api.deepseek.com', apiKey: 'x' },
    { id: 'd', name: 'Broken URL', kind: 'openai-compatible', model: 'deepseek-v4-flash', baseUrl: 'not a url', apiKey: 'x' },
  ]);

  const result = await syncDeepSeekPricing({
    llmConnections: store,
    fetchHtml: async () => FIXTURE,
  });
  assert(
    result.checked === 4 && result.updated === 1,
    `the sync scans every connection but updates only the one native DeepSeek match (checked ${result.checked}, updated ${result.updated})`,
  );

  const updatedRow = store.rows.get('a');
  assert(
    updatedRow.priceInputPerMillion === 0.14 &&
      updatedRow.priceOutputPerMillion === 0.28 &&
      updatedRow.priceCacheHitPerMillion === 0.014 &&
      updatedRow.pricePeakInputPerMillion === 0.28 &&
      updatedRow.pricePeakOutputPerMillion === 0.56 &&
      updatedRow.pricePeakCacheHitPerMillion === 0.028,
    'a matched connection gets all six rates written (off-peak overwritten by the official page, peak filled in)',
  );
  assert(
    typeof updatedRow.priceSyncedAt === 'string' && !Number.isNaN(Date.parse(updatedRow.priceSyncedAt)),
    'a matched connection has its price_synced_at stamped to now',
  );

  assert(
    store.rows.get('b').priceInputPerMillion === undefined && store.rows.get('c').priceInputPerMillion === undefined,
    'host-mismatched and model-not-on-page connections are left untouched — the sync never guesses across providers',
  );
  assert(
    store.rows.get('d').priceInputPerMillion === undefined,
    'a connection with an unparseable base URL is skipped, not crashed on',
  );
  assert(
    store.updates.length === 1,
    'exactly one update() call reaches the store',
  );
}

// A failed fetch aborts the whole pass — the caller (loop/route) surfaces it; no partial writes.
{
  const store = createFakeConnectionsStore([
    { id: 'a', name: 'DeepSeek Direct', kind: 'openai-compatible', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', apiKey: 'x' },
  ]);
  let threw = false;
  try {
    await syncDeepSeekPricing({
      llmConnections: store,
      fetchHtml: async () => {
        throw new Error('fetch failed');
      },
    });
  } catch (err) {
    threw = err.message === 'fetch failed';
  }
  assert(threw, 'a failed fetch rejects the sync — prices stay whatever the last successful pass wrote');
  assert(store.updates.length === 0, 'no update() calls after a failed fetch');
}

if (process.exitCode) {
  console.error('\nDeepSeek pricing verification FAILED');
  process.exit(1);
}
console.log('\nDeepSeek pricing verification passed');