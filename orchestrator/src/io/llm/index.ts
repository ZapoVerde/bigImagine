/**
 * @file orchestrator/src/io/llm/index.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — connection profile selection
 * @description
 * The only place BIGBRAIN_LLM_PROFILES / BIGBRAIN_LLM_ACTIVE_PROFILE are read. Fails closed on
 * missing/unrecognized config rather than defaulting, per bb_principles.md §6's "admitting
 * uncertainty rather than guessing" clause. The stub provider exists for local verification
 * (see scripts/verify-loop.mjs) and is intentionally not selectable through this factory — it's
 * constructed directly by tests, never by config, so a misconfigured deployment can't
 * accidentally boot against a provider that never talks to a real model.
 *
 * @api-declaration
 * createLlmProvider(env: NodeJS.ProcessEnv) — reads BIGBRAIN_LLM_PROFILES (JSON) and
 *   BIGBRAIN_LLM_ACTIVE_PROFILE (which key in it to use)
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads process env)
 *     state_ownership: []
 *     external_io:     []
 */

import { createAnthropicLlmProvider } from './anthropic.js';
import { createOpenAiCompatibleLlmProvider } from './openaiCompatible.js';
import { parseLlmProfiles } from './profiles.js';
import type { LlmProvider } from './types.js';

export type { LlmMessage, LlmProvider, LlmRole, LlmTurn, ToolCall, ToolDefinition } from './types.js';
export type { LlmProfile } from './profiles.js';

export function createLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const rawProfiles = env.BIGBRAIN_LLM_PROFILES;
  const activeName = env.BIGBRAIN_LLM_ACTIVE_PROFILE;

  if (!rawProfiles) {
    throw new Error('BIGBRAIN_LLM_PROFILES is required — define at least one named connection profile (see .env.example)');
  }
  if (!activeName) {
    throw new Error('BIGBRAIN_LLM_ACTIVE_PROFILE is required — name which profile in BIGBRAIN_LLM_PROFILES to use');
  }

  const profiles = parseLlmProfiles(rawProfiles);
  const profile = profiles[activeName];
  if (!profile) {
    const known = Object.keys(profiles).join(', ') || '(none defined)';
    throw new Error(`BIGBRAIN_LLM_ACTIVE_PROFILE is "${activeName}", which isn't in BIGBRAIN_LLM_PROFILES — known profiles: ${known}`);
  }

  if (profile.kind === 'anthropic') {
    return createAnthropicLlmProvider({ apiKey: profile.apiKey, model: profile.model, baseUrl: profile.baseUrl });
  }
  // profile.kind === 'openai-compatible'; profiles.ts already guarantees baseUrl is set for this kind.
  return createOpenAiCompatibleLlmProvider({ apiKey: profile.apiKey, model: profile.model, baseUrl: profile.baseUrl! });
}
