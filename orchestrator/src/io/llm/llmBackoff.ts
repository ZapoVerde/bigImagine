/**
 * @file orchestrator/src/io/llm/llmBackoff.ts
 * @stamp 2026-08-06
 * @architectural-role Pure Function — exponential backoff-with-jitter math
 * @description
 * docs/plans/completed/llm-gate-plan.md §4.2: bounded exponential backoff between retry attempts, base ×2 per
 * attempt, capped, ±20% jitter so a burst of queued calls retrying after a provider-wide blip
 * doesn't retry in lockstep. Split out from llmGate.ts (which owns the impure sleep/retry loop)
 * purely so the arithmetic is independently testable.
 *
 * @api-declaration
 * computeBackoffMs(attempt, baseMs, maxMs) -> number — attempt is 0-indexed (0 = delay before the
 *   first retry)
 *
 * @contract
 *   assertions:
 *     purity:          impure (Math.random() jitter — no IO, but not deterministic)
 *     state_ownership: []
 *     external_io:     []
 */

export function computeBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const raw = Math.min(baseMs * 2 ** attempt, maxMs);
  const jitter = raw * 0.2;
  return Math.round(raw - jitter + Math.random() * jitter * 2);
}
