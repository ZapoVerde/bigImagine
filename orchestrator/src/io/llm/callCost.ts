/**
 * @file orchestrator/src/io/llm/callCost.ts
 * @stamp 2026-08-17
 * @architectural-role Pure Function — cost derivation kept out of llmGate.ts because the gate is
 * an IO Wrapper (bi_principles.md §8: "contain zero reasoning or derivation logic") and USD cost
 * arithmetic is derivation. Its own file, not a helper inside the gate, so the arithmetic is
 * unit-testable without any Postgres/LLM scaffolding (the same split the frontend's
 * computeReceiptCost keeps client-side for the Prompt Inspector receipt).
 * @description
 * Turns one call's token counts and the resolved connection's price tiers into a USD cost. The
 * "omit rather than guess" rule from docs/plans/completed/prompt-inspector-usage-cost.md: it only
 * returns a number when every tier the calculation actually needs is present — input and output
 * always; the cache-hit tier only when cacheReadTokens is a positive number (a zero or absent
 * cache count prices the full prompt at the input rate, no cache tier needed). Any missing
 * needed tier yields undefined — the caller stores null and the Stats page excludes the row from
 * sums/averages rather than showing a fabricated $0.00.
 *
 * DeepSeek bills two rates per token type — off-peak (base) and peak, by the call's UTC wall-clock
 * hour (docs/plans/deepseek-pricing-sync.md). The price object carries both tiers; pickPriceTier
 * selects the effective one at instant `now` (defaults to `new Date()` = "the moment the call
 * resolved", so llmGate.ts needs no change). Peak tiering only ever applies to a connection that
 * actually has peak fields configured — i.e. one the DeepSeek sync has written — so every other
 * provider always prices at the base tier, UTC hour irrelevant. Within a connection that does
 * have a peak tier, a needed base/peak field left unset is a missing needed tier -> undefined,
 * never a silent bill at the wrong rate (that would misstate cost, same spirit as never pricing
 * cache-hit at the miss rate).
 *
 * Arithmetic is the same shape as the inspector's receipt: cache-hit tokens are billed at the
 * cache rate, the remainder of promptTokens at the input rate, completionTokens at the output
 * rate, all per-1M-token prices divided by 1_000_000.
 *
 * @api-declaration
 * computeCallCostUsd(usage, price, now = new Date()) — number | undefined, per the rules above.
 * pickPriceTier(price, now = new Date()) — the effective tier set for the call's UTC hour.
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO, no state, no exceptions for well-typed inputs)
 *     state_ownership: []
 *     external_io:     []
 */

import { isPeakUtcHour } from './deepseekPricing.js';

export interface CallCostUsage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's cache — undefined and 0 both mean "no cache hit
   *  to price"; only a positive number engages the cache-hit tier requirement. */
  cacheReadTokens?: number;
}

export interface CallCostPrice {
  /** Off-peak/base tier — USD per 1M tokens (the 0089 columns). */
  priceInputPerMillion?: number;
  priceOutputPerMillion?: number;
  priceCacheHitPerMillion?: number;
  /** Peak tier — USD per 1M tokens (migration 0109's price_peak_* columns). DeepSeek bills a
   *  second, higher rate during peak UTC hours (docs/plans/deepseek-pricing-sync.md); undefined
   *  means "not configured", the same omit-rather-than-guess contract as the base tier. */
  pricePeakInputPerMillion?: number;
  pricePeakOutputPerMillion?: number;
  pricePeakCacheHitPerMillion?: number;
}

const PER_MILLION = 1_000_000;

/** The effective tier set for a call at instant `now`. Peak tiering is a DeepSeek-specific concept
 *  (docs/plans/deepseek-pricing-sync.md) — only connections the sync has actually written carry
 *  any pricePeak* field, so "has a peak tier configured" doubles as "is a synced DeepSeek
 *  connection". Every other provider (OpenRouter, Anthropic, ...) never has these fields set and
 *  always prices at the base tier, regardless of UTC hour — those providers' own pricing engines
 *  already cover time-of-day variation where it applies, and welding DeepSeek's peak/off-peak
 *  split onto their cost path would blank out their cost for ~7 UTC hours a day instead. A
 *  peak-hour call against a connection WITH a peak tier configured uses it; base fields left
 *  undefined within that tier still omit-rather-than-guess as before (computeCallCostUsd). Pure;
 *  `now` is injectable for deterministic verify scripts (dateContext.ts's seam). */
export function pickPriceTier(price: CallCostPrice, now: Date = new Date()): CallCostPrice {
  const hasPeakTier =
    price.pricePeakInputPerMillion !== undefined ||
    price.pricePeakOutputPerMillion !== undefined ||
    price.pricePeakCacheHitPerMillion !== undefined;
  return hasPeakTier && isPeakUtcHour(now)
    ? {
        priceInputPerMillion: price.pricePeakInputPerMillion,
        priceOutputPerMillion: price.pricePeakOutputPerMillion,
        priceCacheHitPerMillion: price.pricePeakCacheHitPerMillion,
      }
    : {
        priceInputPerMillion: price.priceInputPerMillion,
        priceOutputPerMillion: price.priceOutputPerMillion,
        priceCacheHitPerMillion: price.priceCacheHitPerMillion,
      };
}

export function computeCallCostUsd(
  usage: CallCostUsage,
  price: CallCostPrice,
  now: Date = new Date(),
): number | undefined {
  const effective = pickPriceTier(price, now);
  const needsCacheRate = typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens > 0;
  if (
    effective.priceInputPerMillion === undefined ||
    effective.priceOutputPerMillion === undefined ||
    (needsCacheRate && effective.priceCacheHitPerMillion === undefined)
  ) {
    return undefined;
  }
  const cacheHit = usage.cacheReadTokens ?? 0;
  const cacheMiss = usage.promptTokens - cacheHit;
  return (
    (cacheMiss * effective.priceInputPerMillion + cacheHit * (effective.priceCacheHitPerMillion ?? 0)) / PER_MILLION +
    (usage.completionTokens * effective.priceOutputPerMillion) / PER_MILLION
  );
}
