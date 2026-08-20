/**
 * @file orchestrator/src/server/admin/characterSettings.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (settings-store IO) — the same
 * dual-role split the original adminServer.ts character block used; moved here verbatim as part of
 * the adminServer domain split
 * @description
 * The Characters page's describer settings, mirroring the location-settings trio: the
 * character-describer LLM pass's prompt and history-pairs knobs. Configuration only — the
 * describeCharacter.ts pass that consumes the prompt stays in its own orchestrator module.
 *
 * @api-declaration
 * getCharacterSettings(store) — { describerPrompt, describerPromptIsDefault, describerHistoryPairs }
 * parseSetCharacterSettingsBody(raw) — validates { describer_prompt?, describer_history_pairs? },
 *   at least one present; undefined on any malformed shape
 * setCharacterSettings(store, patch) — upserts whichever fields the patch names
 *
 * @contract
 *   assertions:
 *     purity:          parseSetCharacterSettingsBody is pure; the rest are impure (Postgres IO via
 *                      the injected settings store)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected OrchestratorSettingsStore)]
 */

import type { OrchestratorSettingsStore, SettingName } from '../../io/orchestratorSettings.js';
import { DEFAULT_CHARACTER_DESCRIBER_PROMPT } from '../../orchestrator/describeCharacter.js';

// rp-cast-infrastructure-plan.md A4 — the Characters page's describer settings, mirroring the
// location-settings trio above (not the image-settings pair, whose describer_* keys are
// back-compat only): the character-describer LLM pass's prompt/history-pairs knobs.

export interface CharacterSettings {
  describerPrompt: string;
  describerPromptIsDefault: boolean;
  describerHistoryPairs: string;
}

export async function getCharacterSettings(store: OrchestratorSettingsStore): Promise<CharacterSettings> {
  const [describerPrompt, describerHistoryPairs] = await Promise.all([
    store.get('character_describer_prompt'),
    store.get('character_describer_history_pairs'),
  ]);
  return {
    describerPrompt: describerPrompt?.trim() ? describerPrompt : DEFAULT_CHARACTER_DESCRIBER_PROMPT,
    describerPromptIsDefault: !describerPrompt?.trim(),
    describerHistoryPairs: describerHistoryPairs ?? '',
  };
}

export function parseSetCharacterSettingsBody(
  raw: unknown,
):
  | {
      describer_prompt?: string;
      describer_history_pairs?: string;
    }
  | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { describer_prompt, describer_history_pairs } = raw as Record<string, unknown>;
  if (describer_prompt === undefined && describer_history_pairs === undefined) return undefined;
  if (describer_prompt !== undefined && typeof describer_prompt !== 'string') return undefined;
  if (describer_history_pairs !== undefined && typeof describer_history_pairs !== 'string') return undefined;
  return {
    describer_prompt,
    describer_history_pairs,
  };
}

export async function setCharacterSettings(
  store: OrchestratorSettingsStore,
  patch: {
    describer_prompt?: string;
    describer_history_pairs?: string;
  },
): Promise<void> {
  const writes: Array<[SettingName, string]> = [];
  if (patch.describer_prompt !== undefined) writes.push(['character_describer_prompt', patch.describer_prompt]);
  if (patch.describer_history_pairs !== undefined) writes.push(['character_describer_history_pairs', patch.describer_history_pairs]);
  for (const [key, value] of writes) await store.set(key, value);
}