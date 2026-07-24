/**
 * @file orchestrator/src/io/llm/profiles.ts
 * @stamp 2026-07-23
 * @architectural-role Pure Function — LLM connection profile parsing/validation
 * @description
 * The bigBrain equivalent of SillyTavern's connection-profile pattern: several named,
 * fully-specified connections defined once (BIGBRAIN_LLM_PROFILES, a JSON object keyed by
 * profile name), with one selected as active (BIGBRAIN_LLM_ACTIVE_PROFILE). Switching between,
 * say, DeepSeek's native endpoint and OpenRouter is changing which name is active — a config
 * change, not a rewrite (bb_principles.md §6) — rather than the single hardcoded provider/model
 * pair the original createLlmProvider design assumed.
 *
 * @api-declaration
 * LlmProfile, parseLlmProfiles(raw: string) — throws with a specific, actionable message on
 *   any malformed profile rather than silently dropping or guessing at it
 * withOverriddenApiKeys(raw, overrides) — splices a DB-sourced apiKey (io/providerCredentials.ts)
 *   into the otherwise-static profiles JSON before parseLlmProfiles ever sees it, so this module
 *   and createLlmProvider need no other changes to support that
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

/**
 * Pure: re-serializes `raw`'s parsed JSON with `apiKey` replaced on whichever named profiles
 * appear in both `raw` and `overrides` (an `undefined` override leaves that profile's existing
 * apiKey untouched, it does not delete the field). kind/baseUrl/model, and any profile not named
 * in overrides, pass through unchanged. Does not itself validate the result — the caller still
 * runs it through parseLlmProfiles/validateProfile same as any other BIGBRAIN_LLM_PROFILES value.
 */
export function withOverriddenApiKeys(raw: string, overrides: Partial<Record<string, string>>): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const [name, apiKey] of Object.entries(overrides)) {
    if (apiKey === undefined) continue;
    const profile = parsed[name];
    if (typeof profile !== 'object' || profile === null) continue;
    parsed[name] = { ...(profile as Record<string, unknown>), apiKey };
  }
  return JSON.stringify(parsed);
}
