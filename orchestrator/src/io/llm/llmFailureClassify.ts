/**
 * @file orchestrator/src/io/llm/llmFailureClassify.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function — permanent-vs-transient decision for a failed memory-sync LLM call
 * @description
 * The rolling chat-memory sync loop (chatMemorySync.ts, bi_principles.md §11) must know whether a
 * thrown sync error is worth retrying on the next 30s poll tick. A permanent failure — a 400/401/
 * 403/404 HTTP status (a dead model id, a revoked key, a missing endpoint), or a real-but-unusable
 * response (malformed tool-call arguments, an empty choices array, a wrong-dimension embedding) —
 * will fail identically every 30s forever (observed ×1500 consecutive on a dead
 * "No endpoints found for <model>" 404). A transient failure — 429/5xx, or a bare transport throw —
 * may clear on its own and is retried normally. Split out as its own pure module (docs/conventions.md's
 * four-kinds-of-code split, same shape as llmRetryClassify.ts) so the decision is independently
 * testable without a fake LlmProvider or Postgres.
 *
 * The adapters throw a plain Error with the vendor's HTTP status embedded in the message text
 * ("OpenAI-compatible API error 404: ...", "Anthropic API error 404: ..."); there is no structured
 * error type today, so this parses the status out of the message exactly like llmRetryClassify.ts,
 * and reuses its NON_RETRYABLE_RESPONSE_SHAPES for the status-less response-shape failures.
 *
 * @api-declaration
 * classifyLlmFailure(err) -> 'permanent' | 'transient'
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import { NON_RETRYABLE_RESPONSE_SHAPES } from './llmRetryClassify.js';

/** The four client statuses that can never succeed until the configuration that produced them
 *  changes. Everything else retries: 429/5xx are capacity/availability, 4xx beyond these are
 *  uncommon (and mostly malformed-request, which the retry-anyway fallback tolerates once a tick). */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404]);

export function classifyLlmFailure(err: unknown): 'permanent' | 'transient' {
  const message = err instanceof Error ? err.message : String(err);

  // An explicit user cancel (orchestrator/turnAbort.ts) is neither — treat it as transient so a
  // later tick naturally retries, rather than stamping the status row with a "permanent" misread.
  if (err instanceof Error && err.name === 'AbortError') return 'transient';

  if (NON_RETRYABLE_RESPONSE_SHAPES.some((re) => re.test(message))) return 'permanent';

  const statusMatch = message.match(/\b(\d{3})\b/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (PERMANENT_STATUSES.has(status)) return 'permanent';
  }

  // Everything else — 429, 5xx, no parseable status (transport throw) — retries on the next tick.
  return 'transient';
}