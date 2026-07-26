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
 * withOverriddenModel(raw, profileName, model) — splices a DB-sourced model override
 *   (io/orchestratorSettings.ts's active_llm_model) onto one named profile, same idea
 * withOverriddenSupportsVision(raw, flags) — splices a DB-sourced vision-capability flag
 *   (io/orchestratorSettings.ts's llm_vision_capable_profiles) onto every named profile present in
 *   flags, not just the active one — a chat can pick any configured profile via its own connection
 *   override (server/httpServer.ts's sessionParams.profile), so the flag has to travel with every
 *   profile, the same way withOverriddenApiKeys already does for every profile's own apiKey
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
  /** Whether this connection's model can accept image attachments. Never set directly in
   *  BIGBRAIN_LLM_PROFILES — there's no reliable way to auto-detect vision capability across
   *  arbitrary OpenAI-compatible endpoints, so this is always false until
   *  withOverriddenSupportsVision splices in the admin-set, DB-backed flag
   *  (io/orchestratorSettings.ts's llm_vision_capable_profiles) at boot. */
  supportsVision: boolean;
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

/**
 * Pure: re-serializes `raw`'s parsed JSON with `model` replaced on the one named `profileName`,
 * when `model` is set — the Settings tab's model picker (GET/POST /v1/admin/settings) overriding
 * which model within the active connection is used, the same shape as withOverriddenApiKeys but
 * for a single profile/field instead of many. An unset model, an unknown profileName, or a
 * malformed profile entry all leave `raw` untouched.
 */
export function withOverriddenModel(raw: string, profileName: string, model: string | undefined): string {
  if (!model) return raw;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const profile = parsed[profileName];
  if (typeof profile !== 'object' || profile === null) return raw;
  parsed[profileName] = { ...(profile as Record<string, unknown>), model };
  return JSON.stringify(parsed);
}

/**
 * Pure: re-serializes `raw`'s parsed JSON with `supportsVision` set to true on every profile name
 * present (and true) in `flags`, false on every other known profile — unlike withOverriddenModel,
 * this applies to every profile in `flags`, not just one, since a chat can select any configured
 * profile via its own connection override (server/httpServer.ts's sessionParams.profile), not just
 * the household-wide active one; the vision flag has to travel with whichever profile a turn
 * actually ends up using. A profile name in `flags` that isn't in `raw` is silently ignored (a
 * stale Settings-tab entry for a since-removed profile), same "don't fail the whole boot over a
 * stale reference" shape as withOverriddenApiKeys.
 */
export function withOverriddenSupportsVision(raw: string, flags: Record<string, boolean>): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const [name, profile] of Object.entries(parsed)) {
    if (typeof profile !== 'object' || profile === null) continue;
    parsed[name] = { ...(profile as Record<string, unknown>), supportsVision: flags[name] === true };
  }
  return JSON.stringify(parsed);
}
