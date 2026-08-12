/**
 * @file orchestrator/src/io/llm/llmRetryClassify.ts
 * @stamp 2026-08-06
 * @architectural-role Pure Function — retryable-vs-not decision for a failed LLM call
 * @description
 * llmGate.ts (docs/plans/completed/llm-gate-plan.md §4.2) needs to decide, for a thrown error from
 * base.complete(), whether retrying the exact same call could plausibly succeed. Split out as its
 * own pure module (docs/conventions.md's four-kinds-of-code split) so the decision is
 * independently testable without a fake LlmProvider or Postgres.
 *
 * Both adapters (openaiCompatible.ts, anthropic.ts) throw a plain Error with the vendor's HTTP
 * status embedded in the message text (e.g. "OpenAI-compatible API error 429: ...",
 * "Anthropic API error 503: ..." — there's no structured error type today, so this parses the
 * status out of the message rather than inventing a new error class threaded through both
 * adapters for one caller's benefit.
 *
 * A thrown error with no parseable status at all (a bare `fetch failed`, `ECONNRESET`, a DNS
 * blip) means the request never reached the provider — io/httpRetry.ts's own doc comment already
 * establishes that retrying this class of failure is safe, since nothing downstream has run yet.
 * Two response-shaped failures are explicitly excluded even though they carry no HTTP status:
 * openaiCompatible.ts's "malformed arguments" (a real response came back, just not a usable one —
 * retrying the identical prompt is unlikely to fix a model's own bad tool-call JSON) and "returned
 * no choices" (same reasoning — a real, empty response, not a transport failure). The embeddings
 * adapter's "returned a N-dim embedding" (io/embeddings/voyage.ts — a real response whose vector
 * length mismatches the requested output_dimension, a permanent config error) is the same shape
 * and excluded the same way, so its digit isn't accidentally parsed as a retryable status.
 *
 * @api-declaration
 * isRetryableLlmError(err) -> boolean
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

const NON_RETRYABLE_RESPONSE_SHAPES = [/malformed arguments/i, /returned no choices/i, /returned a \d+-dim embedding/i];

export function isRetryableLlmError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);

  // A Stop (orchestrator/turnAbort.ts) aborts the provider fetch, which throws a DOMException
  // named 'AbortError' — that is the user explicitly cancelling this call, never something
  // retrying it could fix. Must be checked before the no-status fallthrough below, which would
  // otherwise classify it retryable (bare transport throw) and re-fire the very call the user
  // just stopped.
  if (err instanceof Error && err.name === 'AbortError') return false;

  if (NON_RETRYABLE_RESPONSE_SHAPES.some((re) => re.test(message))) return false;

  const statusMatch = message.match(/\b(\d{3})\b/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    if (status >= 400 && status <= 499) return false;
  }

  // No parseable HTTP status — a transport-level throw (network/DNS/stale-socket), the same class
  // io/httpRetry.ts already retries one layer down. Safe to retry here too.
  return true;
}
