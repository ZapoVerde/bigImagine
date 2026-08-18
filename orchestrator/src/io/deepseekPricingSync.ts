/**
 * @file orchestrator/src/io/deepseekPricingSync.ts
 * @stamp 2026-08-17
 * @architectural-role IO Wrapper — fetch DeepSeek's official pricing page and write the parsed
 * rates onto native DeepSeek connections
 * @description
 * The sync side of docs/plans/deepseek-pricing-sync.md, shared by the daily loop
 * (orchestrator/src/orchestrator/deepseekPricingSyncLoop.ts) and the manual admin route
 * (POST /v1/admin/connections/pricing-sync, wired inside handleAdminConnections.ts):
 *
 * fetch the static pricing page (io/httpRetry.ts's fetchWithRetry — a fixed first-party docs URL,
 * so no fetchUntrusted/SSRF treatment), parse it with io/llm/deepseekPricing.ts's pure parser, and
 * for every connection whose kind is 'deepseek' (or whose base_url host is api.deepseek.com — the
 * pre-0117 freeform spelling of the same thing) AND whose model id is on the page, update all six
 * price fields (off-peak/base + peak) plus price_synced_at. A matched connection's manual prices
 * are overwritten by the official rates — that is the point of the feature. Anything else (kind
 * mismatch, host mismatch, model not on the page, unparseable base URL) is left untouched.
 *
 * One failed fetch aborts the whole pass and the caller (loop/route) surfaces the error — a
 * deployment's prices are simply whatever the last successful sync wrote; rows are per-update
 * transactions, so a mid-pass failure leaves prior updates committed, never a half-written row.
 *
 * The fetchHtml dep exists purely so verify scripts can inject a fixture — the destination is
 * DeepSeek's own domain and can't be pointed at a sandbox.
 *
 * @api-declaration
 * DEEPSEEK_PRICING_URL — https://api-docs.deepseek.com/quick_start/pricing/
 * syncDeepSeekPricing(deps) — { checked, updated }; throws (logged by callers) on fetch/parse failure
 *
 * @contract
 *   assertions:
 *     purity:          impure (outbound HTTP fetch, Postgres writes via llmConnections)
 *     state_ownership: []
 *     external_io:     [DeepSeek's pricing page, Postgres (via deps.llmConnections)]
 */

import { log } from './logger.js';
import { fetchWithRetry } from './httpRetry.js';
import { matchDeepSeekPricing, parseDeepSeekPricingHtml, type DeepSeekPricing } from './llm/deepseekPricing.js';
import type { LlmConnectionRow, LlmConnectionStore } from './llmConnections.js';

export const DEEPSEEK_PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing/';

async function defaultFetchHtml(url: string): Promise<string> {
  const res = await fetchWithRetry(
    url,
    { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(30_000) },
    2,
  );
  if (!res.ok) {
    throw new Error(`DeepSeek pricing page returned HTTP ${res.status}`);
  }
  return res.text();
}

export interface DeepSeekPricingSyncDeps {
  llmConnections: Pick<LlmConnectionStore, 'list' | 'update'>;
  /** Injectable for verify scripts — the real sync hits DeepSeek's own domain. */
  fetchHtml?: (url: string) => Promise<string>;
}

function pricingForConnection(
  connection: LlmConnectionRow,
  byModel: Map<string, DeepSeekPricing>,
): DeepSeekPricing | undefined {
  // A kind-marked native DeepSeek connection matches by kind alone — no URL parsing, and robust to
  // a nonstandard baseUrl. Freeform rows (kind === 'openai-compatible') keep the legacy host check
  // (io/llm/deepseekPricing.ts's matchDeepSeekPricing) so an api.deepseek.com connection created
  // before the 0117 kinds still syncs.
  if (connection.kind === 'deepseek') {
    return byModel.get(connection.model);
  }
  const match = matchDeepSeekPricing(connection.baseUrl, connection.model, byModel);
  if (match.status === 'unparseable-url') {
    log.warn(`deepseek pricing sync: skipping "${connection.name}" — unparseable base URL "${connection.baseUrl}"`);
    return undefined;
  }
  return match.status === 'matched' ? match.pricing : undefined;
}

export async function syncDeepSeekPricing(deps: DeepSeekPricingSyncDeps): Promise<{ checked: number; updated: number }> {
  const fetchHtml = deps.fetchHtml ?? defaultFetchHtml;
  const html = await fetchHtml(DEEPSEEK_PRICING_URL);
  const pricing = parseDeepSeekPricingHtml(html);
  const byModel = new Map(pricing.map((p) => [p.model, p]));
  const connections = await deps.llmConnections.list();

  let updated = 0;
  for (const connection of connections) {
    const parsed = pricingForConnection(connection, byModel);
    if (!parsed) continue;
    await deps.llmConnections.update(connection.id, {
      priceInputPerMillion: parsed.offPeak.inputPerMillion,
      priceOutputPerMillion: parsed.offPeak.outputPerMillion,
      priceCacheHitPerMillion: parsed.offPeak.cacheHitPerMillion,
      pricePeakInputPerMillion: parsed.peak.inputPerMillion,
      pricePeakOutputPerMillion: parsed.peak.outputPerMillion,
      pricePeakCacheHitPerMillion: parsed.peak.cacheHitPerMillion,
      priceSyncedAt: new Date().toISOString(),
    });
    updated++;
  }

  log.info('deepseek pricing sync complete', {
    checked: connections.length,
    updated,
    models: pricing.map((p) => p.model),
  });
  return { checked: connections.length, updated };
}