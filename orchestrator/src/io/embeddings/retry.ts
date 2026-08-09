/**
 * @file orchestrator/src/io/embeddings/retry.ts
 * @stamp 2026-08-09
 * @architectural-role IO Wrapper — retry+backoff around any EmbeddingProvider, the vector-LLM
 * twin of io/llm/llmGate.ts's retry loop
 * @description
 * Every chat-LLM call is wrapped by createGatedLlmProvider (io/llm/llmGate.ts), which retries a
 * retryable failure (io/llm/llmRetryClassify.ts) with bounded exponential backoff
 * (io/llm/llmBackoff.ts), bounded by the llm_gate_max_retries/llm_gate_retry_base_ms/
 * llm_gate_retry_max_ms settings. The embeddings provider had no such layer — voyage.ts only
 * had io/httpRetry.ts's fetchWithRetry (a single immediate transport retry, no backoff, no
 * HTTP-status handling) — so a vector call that hit the exact stale-socket class httpRetry.ts
 * documents, or a transient 429/5xx from the vendor, failed the whole recall. Confirmed live
 * 2026-08-09: the CNZ-style silent canon recall (io/chatMemory/recallForPrompt.ts) failed its
 * embed call twice in a row with `TypeError: fetch failed` then succeeded on the next call —
 * exactly the failure mode this wrapper makes invisible, and the reason approved canon facts
 * were never being injected into turns.
 *
 * This module is that missing layer: wraps an EmbeddingProvider and returns another with the
 * identical shape, retrying base.embed() on a retryable error (the same isRetryableLlmError
 * classifier the LLM gate uses — a thrown transport error, or an HTTP 429/5xx parsed from the
 * adapter's message) with the same bounded backoff, read from the same llm_gate_* settings so a
 * single knob governs every provider's retry policy. Non-retryable failures (a real 4xx
 * response — bad key, bad model, over-quota account state) pass straight through: retrying
 * those just burns the same refusal repeatedly. Each retried attempt is logged as a warning so
 * a persistently-failing provider stays audible without breaking the fail-open contract of
 * whichever caller is using embeddings (recallForPrompt.ts catches and continues empty).
 *
 * Deliberately no concurrency lanes and no llm_calls metering here: llmGate's lanes exist
 * because an interactive turn must never queue behind a background burst, and llm_calls rows
 * attribute per-turn LLM spend to a household user. Embeddings are batch, sub-second work run
 * inside the caller's own lane (a turn's recall runs inside the interactive request, a sync
 * tick inside its own background flow), and no cost-tracking row exists for them today — adding
 * either would be a new metering feature, not a retry fix. This wrapper only makes an existing
 * call more likely to succeed.
 *
 * @api-declaration
 * createRetryingEmbeddingProvider(base: EmbeddingProvider, settings: OrchestratorSettingsStore)
 *   -> EmbeddingProvider — same name/dimension, embed() retried per the llm_gate_* settings
 *
 * @contract
 *   assertions:
 *     purity:          impure (delegates to the wrapped provider, reads settings, sleeps)
 *     state_ownership: []
 *     external_io:     [whatever `base` does, orchestrator settings store]
 */

import type { OrchestratorSettingsStore } from '../orchestratorSettings.js';
import { log } from '../logger.js';
import { isRetryableLlmError } from '../llm/llmRetryClassify.js';
import { computeBackoffMs } from '../llm/llmBackoff.js';
import type { EmbeddingProvider } from './types.js';

/** Mirrors llmGate.ts's defaults — kept in sync by construction: this module reads the same
 *  llm_gate_* settings keys, so an unset/corrupt value should fall back to exactly what
 *  createGatedLlmProvider would use, not a second divergent constant. */
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRetryingEmbeddingProvider(
  base: EmbeddingProvider,
  settings: OrchestratorSettingsStore,
): EmbeddingProvider {
  return {
    name: base.name,
    dimension: base.dimension,
    async embed(texts: string[]): Promise<number[][]> {
      const maxRetriesRaw = await settings.get('llm_gate_max_retries');
      const retryBaseRaw = await settings.get('llm_gate_retry_base_ms');
      const retryMaxRaw = await settings.get('llm_gate_retry_max_ms');
      const parsedMax = maxRetriesRaw ? Number(maxRetriesRaw) : NaN;
      const parsedBase = retryBaseRaw ? Number(retryBaseRaw) : NaN;
      const parsedMaxMs = retryMaxRaw ? Number(retryMaxRaw) : NaN;
      // Corrupt (non-numeric) settings fall back to the defaults rather than yielding NaN — a
      // `llm_gate_max_retries: 'abc'` must not log "attempt 1/NaN" and silently disable retry.
      const maxRetries = Number.isFinite(parsedMax) && parsedMax >= 0 ? parsedMax : DEFAULT_MAX_RETRIES;
      const retryBaseMs = Number.isFinite(parsedBase) && parsedBase > 0 ? parsedBase : DEFAULT_RETRY_BASE_MS;
      const retryMaxMs = Number.isFinite(parsedMaxMs) && parsedMaxMs > 0 ? parsedMaxMs : DEFAULT_RETRY_MAX_MS;

      for (let attempt = 0; ; attempt++) {
        try {
          return await base.embed(texts);
        } catch (err) {
          const willRetry = isRetryableLlmError(err) && attempt < maxRetries;
          log.warn(
            `embeddings.embed failed (attempt ${attempt + 1}/${maxRetries + 1})${willRetry ? ', retrying' : ', giving up'}`,
            err,
          );
          if (!willRetry) throw err;
          await sleep(computeBackoffMs(attempt, retryBaseMs, retryMaxMs));
        }
      }
    },
  };
}
