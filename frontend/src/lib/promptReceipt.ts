/**
 * @file frontend/src/lib/promptReceipt.ts
 * @stamp 2026-08-14
 * @architectural-role Pure Function (bi_principles.md §8) — the per-call cost receipt arithmetic,
 * shared by every surface that shows what a turn cost
 * @description
 * The receipt's $ figure — raw counts × raw per-million rates, USD
 * (docs/plans/completed/prompt-inspector-usage-cost.md). Extracted from PromptInspectorPanel's
 * private helper so the Prompt Inspector and the chat drawer's Timing section render the same
 * arithmetic from one definition, never two (docs/plans/turn-timeline-graph-plan.md — the
 * receipt math lives in exactly one place, same as the row definitions in turnTimelineReport.ts).
 * The tokens are exactly what the server relayed, the rates exactly what the admin typed, and
 * the derived figure can never drift from either. Returns undefined when any tier the
 * calculation needs is unconfigured — the caller then omits the $ figure entirely rather than
 * computing a partially-wrong total.
 *
 * @api-declaration
 * computeReceiptCost(usage, price) — number | undefined, USD
 * formatUsd(cost) — the shared $ string: sub-cent figures keep 4 decimals, else 2
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import type { PromptPreviewGroup } from '../api/types';

/** The $ figure — undefined when any tier the arithmetic needs is unconfigured (a partial price
 *  omits the $ rather than pricing a tier at another tier's rate — silently pricing cache-hit
 *  tokens at the miss rate would understate savings, not just omit them). */
export function computeReceiptCost(
  usage: NonNullable<PromptPreviewGroup['usage']>,
  price: NonNullable<PromptPreviewGroup['price']>,
): number | undefined {
  const needsCacheRate = usage.cacheReadTokens !== undefined;
  if (
    price.inputPerMillion === undefined ||
    price.outputPerMillion === undefined ||
    (needsCacheRate && price.cacheHitPerMillion === undefined)
  ) {
    return undefined;
  }
  const perMillion = 1_000_000;
  const cacheHit = usage.cacheReadTokens ?? 0;
  const cacheMiss = usage.promptTokens - cacheHit;
  return (
    (cacheMiss * price.inputPerMillion + cacheHit * (price.cacheHitPerMillion ?? 0)) / perMillion +
    (usage.completionTokens * price.outputPerMillion) / perMillion
  );
}

/** Sub-cent figures are the norm for a single turn — show enough decimals to stay meaningful
 *  without trailing zeros past four places. */
export function formatUsd(cost: number): string {
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}
