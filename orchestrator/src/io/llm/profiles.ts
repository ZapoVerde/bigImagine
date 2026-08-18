/**
 * @file orchestrator/src/io/llm/profiles.ts
 * @stamp 2026-08-18
 * @architectural-role Pure Function — LLM connection shape + one-time env-seed parsing
 * @description
 * LlmProfile is the shape io/llm/index.ts's createLlmProviderForProfile consumes — today built
 * from a decrypted io/llmConnections.ts row (the DB-backed, admin-managed connection registry),
 * not read live from BIGBRAIN_LLM_PROFILES on every boot the way it used to be. parseLlmProfiles
 * still exists for exactly one caller: index.ts's first-boot seed, which parses the env var once to
 * populate llm_connections when that table is empty, so an existing deployment's connections/keys
 * carry over without a manual DB write on cutover. Every later boot never calls this again.
 *
 * `kind` names the connection's provider, not just its wire adapter: `deepseek` and `openrouter`
 * are provider kinds that still speak the OpenAI-compatible shape (db/migrations/0117), so their
 * `baseUrl` may be omitted and defaults to the canonical endpoint. The seed can therefore emit
 * provider-kind profiles; io/llmConnections.ts resolves their key from provider_credentials at call
 * time. Everything downstream (io/llm/index.ts's dispatch) treats the two exactly like
 * `openai-compatible`, which is why this file's validation mirrors that defaulting rather than
 * inventing a parallel rule.
 *
 * The withOverriddenApiKeys/withOverriddenModel/withOverriddenSupportsVision splice functions this
 * file used to export are gone — they existed to patch a field onto an *env-defined* profile before
 * parseLlmProfiles ever saw it; now that connections are real DB rows, admin edits go straight to
 * io/llmConnections.ts's update(), no re-serialize-then-reparse step needed.
 *
 * @api-declaration
 * LlmProfile — kind/model/apiKey/baseUrl/supportsVision/provider + per-connection pricing
 *   (priceInputPerMillion/priceOutputPerMillion/priceCacheHitPerMillion base tier plus the
 *   pricePeak*Million peak tier), io/llmConnections.ts's
 *   resolveByName/resolveActive build this shape from a decrypted connection row
 * parseLlmProfiles(raw: string) — throws with a specific, actionable message on any malformed
 *   profile rather than silently dropping or guessing at it; index.ts's first-boot seed only
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import type { LlmConnectionKind } from '../llmConnections.js';

export interface LlmProfile {
  kind: LlmConnectionKind;
  model: string;
  apiKey: string;
  /** Required when kind is 'openai-compatible' (there's no sane default across vendors);
   *  optional for 'anthropic' (defaults to the real Anthropic API) and for the provider kinds
   *  'deepseek'/'openrouter', which default to their canonical endpoints. */
  baseUrl?: string;
  /** Whether this connection's model can accept image attachments. Never auto-detected — set
   *  explicitly per connection (io/llmConnections.ts), since there's no reliable way to detect
   *  vision capability across arbitrary OpenAI-compatible endpoints. */
  supportsVision: boolean;
  /** OpenRouter's own per-request `provider` object (io/llm/openaiCompatible.ts's complete()) —
   *  pin routing to a primary (+ optional fallback) provider and/or a quantization filter, instead
   *  of OpenRouter's default full-set routing. Undefined means "no override", the pre-existing
   *  behavior; every other adapter (Anthropic, non-OpenRouter openai-compatible) simply never
   *  receives it. order holds at most a primary then a fallback provider tag — not an arbitrary
   *  ranking — matching the "a provider and a fallback" scope this was built for. */
  provider?: {
    order?: string[];
    allowFallbacks: boolean;
    quantizations?: string[];
  };
  /** USD per 1M tokens for the Prompt Inspector's cost receipt (docs/plans/
   *  prompt-inspector-usage-cost.md) — relayed from the llm_connections row by
   *  io/llmConnections.ts's toProfile, so every caller that already resolves a profile has
   *  pricing without a second DB round-trip. Undefined means "not configured", not zero — the
   *  receipt then shows token counts only, never a fabricated $0.00. Only ever set on the
   *  DB-backed path; the env-var seed (parseLlmProfiles) carries no prices. */
  priceInputPerMillion?: number;
  priceOutputPerMillion?: number;
  priceCacheHitPerMillion?: number;
  /** Peak tier (migration 0109's price_peak_* columns) — USD per 1M tokens for DeepSeek's peak
   *  UTC hours (docs/plans/deepseek-pricing-sync.md), relayed from the llm_connections row by
   *  io/llmConnections.ts's toProfile like the base tier. Undefined means "not configured" — the
   *  receipt then picks the effective tier by the call's UTC hour (io/llm/callCost.ts's
   *  pickPriceTier) and omits the $ when the needed tier is missing. */
  pricePeakInputPerMillion?: number;
  pricePeakOutputPerMillion?: number;
  pricePeakCacheHitPerMillion?: number;
}

/** The canonical endpoint for each provider kind, defaulted when a profile omits baseUrl (only the
 *  freeform 'openai-compatible' kind demands one — see validateProfile). Kept as a module-level map
 *  so io/llmConnections.ts's store and this parser agree on one source of truth. */
export const CANONICAL_PROVIDER_BASE_URL: Record<'deepseek' | 'openrouter', string> = {
  deepseek: 'https://api.deepseek.com',
  openrouter: 'https://openrouter.ai/api/v1',
};

function validateProfile(name: string, value: unknown): LlmProfile {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`BIGBRAIN_LLM_PROFILES["${name}"] must be an object`);
  }
  const v = value as Record<string, unknown>;

  const kind = v.kind as LlmConnectionKind;
  if (
    kind !== 'anthropic' &&
    kind !== 'openai-compatible' &&
    kind !== 'deepseek' &&
    kind !== 'openrouter'
  ) {
    throw new Error(`BIGBRAIN_LLM_PROFILES["${name}"].kind must be one of "anthropic", "openai-compatible", "deepseek", "openrouter", got ${JSON.stringify(v.kind)}`);
  }
  if (typeof v.model !== 'string' || !v.model) {
    throw new Error(`BIGBRAIN_LLM_PROFILES["${name}"].model must be a non-empty string`);
  }
  if (typeof v.apiKey !== 'string' || !v.apiKey) {
    throw new Error(`BIGBRAIN_LLM_PROFILES["${name}"].apiKey must be a non-empty string`);
  }
  if (kind === 'openai-compatible' && (typeof v.baseUrl !== 'string' || !v.baseUrl)) {
    throw new Error(`BIGBRAIN_LLM_PROFILES["${name}"].baseUrl is required when kind is "openai-compatible"`);
  }

  const baseUrl =
    kind === 'deepseek' || kind === 'openrouter'
      ? typeof v.baseUrl === 'string' && v.baseUrl
        ? v.baseUrl
        : CANONICAL_PROVIDER_BASE_URL[kind]
      : typeof v.baseUrl === 'string'
        ? v.baseUrl
        : undefined;

  return {
    kind,
    model: v.model,
    apiKey: v.apiKey,
    baseUrl,
    supportsVision: v.supportsVision === true,
  };
}

export function parseLlmProfiles(raw: string): Record<string, LlmProfile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`BIGBRAIN_LLM_PROFILES is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('BIGBRAIN_LLM_PROFILES must be a JSON object: {"profileName": {"kind": ..., "model": ..., "apiKey": ...}}');
  }

  const profiles: Record<string, LlmProfile> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    profiles[name] = validateProfile(name, value);
  }
  return profiles;
}
