/**
 * @file orchestrator/src/io/llm/profiles.ts
 * @stamp 2026-08-06
 * @architectural-role Pure Function — LLM connection shape + one-time env-seed parsing
 * @description
 * LlmProfile is the shape io/llm/index.ts's createLlmProviderForProfile consumes — today built
 * from a decrypted io/llmConnections.ts row (the DB-backed, admin-managed connection registry),
 * not read live from BIGBRAIN_LLM_PROFILES on every boot the way it used to be. parseLlmProfiles
 * still exists for exactly one caller: index.ts's first-boot seed, which parses the env var once to
 * populate llm_connections when that table is empty, so an existing deployment's connections/keys
 * carry over without a manual DB write on cutover. Every later boot never calls this again.
 *
 * The withOverriddenApiKeys/withOverriddenModel/withOverriddenSupportsVision splice functions this
 * file used to export are gone — they existed to patch a field onto an *env-defined* profile before
 * parseLlmProfiles ever saw it; now that connections are real DB rows, admin edits go straight to
 * io/llmConnections.ts's update(), no re-serialize-then-reparse step needed.
 *
 * @api-declaration
 * LlmProfile — kind/model/apiKey/baseUrl/supportsVision/provider + per-connection pricing
 *   (priceInputPerMillion/priceOutputPerMillion/priceCacheHitPerMillion), io/llmConnections.ts's
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

export interface LlmProfile {
  kind: 'anthropic' | 'openai-compatible';
  model: string;
  apiKey: string;
  /** Required when kind is 'openai-compatible' (there's no sane default across vendors);
   *  optional override for 'anthropic', which already defaults to the real Anthropic API. */
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
}

function validateProfile(name: string, value: unknown): LlmProfile {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`BIGBRAIN_LLM_PROFILES["${name}"] must be an object`);
  }
  const v = value as Record<string, unknown>;

  if (v.kind !== 'anthropic' && v.kind !== 'openai-compatible') {
    throw new Error(`BIGBRAIN_LLM_PROFILES["${name}"].kind must be "anthropic" or "openai-compatible", got ${JSON.stringify(v.kind)}`);
  }
  if (typeof v.model !== 'string' || !v.model) {
    throw new Error(`BIGBRAIN_LLM_PROFILES["${name}"].model must be a non-empty string`);
  }
  if (typeof v.apiKey !== 'string' || !v.apiKey) {
    throw new Error(`BIGBRAIN_LLM_PROFILES["${name}"].apiKey must be a non-empty string`);
  }
  if (v.kind === 'openai-compatible' && (typeof v.baseUrl !== 'string' || !v.baseUrl)) {
    throw new Error(`BIGBRAIN_LLM_PROFILES["${name}"].baseUrl is required when kind is "openai-compatible"`);
  }

  return {
    kind: v.kind,
    model: v.model,
    apiKey: v.apiKey,
    baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : undefined,
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
