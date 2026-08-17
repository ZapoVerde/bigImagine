/**
 * @file orchestrator/src/orchestrator/deepseekPricingSyncLoop.ts
 * @stamp 2026-08-17
 * @architectural-role Orchestrator — the daily DeepSeek pricing sync poll loop
 * @description
 * The background half of docs/plans/deepseek-pricing-sync.md: every 24h, fetch DeepSeek's official
 * pricing page and write the parsed off-peak + peak rates onto native DeepSeek connections
 * (io/deepseekPricingSync.ts). Same composition-root tier as startChatMemorySyncLoop/startCleanupLoop
 * — started once from index.ts, setInterval(...).unref(), one immediate tick at boot so a fresh
 * deploy picks up current rates within seconds rather than waiting a day.
 *
 * No in-flight guard needed (chatMemorySync.ts's inFlightSyncs and cleanupLoop.ts's inFlightRepairs
 * exist because those ticks can run for minutes of LLM round-trips while the next 30s tick overlaps
 * them): a pricing pass is one static-page fetch plus a handful of fast DB updates, far shorter than
 * the 24h interval, and overlapping passes would be idempotent overwrites anyway. A failed pass logs
 * and simply retries on the next tick — prices stay whatever the last successful sync wrote.
 *
 * @api-declaration
 * startDeepSeekPricingSyncLoop(deps) — begins polling every 24h (with an immediate first tick)
 * runDeepSeekPricingSyncTick(deps) — one sync pass, exported so verify scripts can drive it directly
 *
 * @contract
 *   assertions:
 *     purity:          impure (outbound fetch, Postgres writes; owns the setInterval timer)
 *     state_ownership: [the setInterval timer this starts]
 *     external_io:     [DeepSeek's pricing page, Postgres via io/deepseekPricingSync.ts]
 */

import { log } from '../io/logger.js';
import { syncDeepSeekPricing, type DeepSeekPricingSyncDeps } from '../io/deepseekPricingSync.js';

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function runDeepSeekPricingSyncTick(deps: DeepSeekPricingSyncDeps): Promise<void> {
  const result = await syncDeepSeekPricing(deps);
  log.info('deepseek pricing sync tick complete', result);
}

export function startDeepSeekPricingSyncLoop(deps: DeepSeekPricingSyncDeps): void {
  const tick = () => {
    runDeepSeekPricingSyncTick(deps).catch((err) => log.error('deepseek pricing sync tick failed', err));
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS).unref();
}