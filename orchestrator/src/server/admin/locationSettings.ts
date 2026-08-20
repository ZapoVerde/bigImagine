/**
 * @file orchestrator/src/server/admin/locationSettings.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (settings-store IO) — the same
 * dual-role split the original adminServer.ts location blocks used; moved here verbatim as part of
 * the adminServer domain split
 * @description
 * The location subsystem's admin configuration: the Location Tracker's split/injection keys, the
 * room describer's prompt/history-pairs knobs, and — as the legacy image-settings surface — the
 * Master Image Prompt Template (image_prompt_template) that synthesizeImagePrompt.ts expands
 * against a location's visual_description/environment. Domain ownership follows the location
 * subsystem rather than historical UI placement: the image-settings endpoint historically exposed
 * the describer_* keys and still accepts them for back-compat, so its get/parse/set trio lives
 * here unchanged. General image-connection administration is deliberately elsewhere
 * (admin/imageConnections.ts).
 *
 * @api-declaration
 * getImageSettings(store) — { template, templateIsDefault, describerPrompt, describerPromptIsDefault,
 *   describerHistoryPairs } for the image subsystem's settings (endpoint.md §2.2 + describer.md;
 *   bi_principles.md §17 — '' = built-in default for the two prompts, '' = built-in 1 for the pairs)
 * parseSetImageSettingsBody(raw) — validates { template?, describer_prompt?, describer_history_pairs? },
 *   at least one present; undefined on any malformed shape
 * setImageSettings(store, patch) — upserts whichever fields the patch names
 * getLocationSettings(store) — { splitEnabled, injectionEnabled, injectionPrompt,
 *   injectionPromptIsDefault, describerPrompt, describerPromptIsDefault, describerHistoryPairs }
 * parseSetLocationSettingsBody(raw) — validates { split_enabled?, injection_enabled?,
 *   injection_prompt?, describer_prompt?, describer_history_pairs? }, at least one present;
 *   undefined on any malformed shape
 * setLocationSettings(store, patch) — upserts whichever fields the patch names
 *
 * @contract
 *   assertions:
 *     purity:          parseSetImageSettingsBody/parseSetLocationSettingsBody are pure; the rest
 *                      are impure (Postgres IO via the injected settings store)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected OrchestratorSettingsStore)]
 */

import type { OrchestratorSettingsStore, SettingName } from '../../io/orchestratorSettings.js';
import { DEFAULT_LOCATION_DESCRIBER_PROMPT } from '../../orchestrator/describeLocation.js';
import { DEFAULT_LOCATION_BLOCK_TEMPLATE } from '../../util/renderLocationBlock.js';

// --- Image settings (endpoint.md §2.2, bi_principles.md §17) ---
// The three orchestrator-settings keys this subsystem adds: image_prompt_template, the Master
// Image Prompt Template synthesizeImagePrompt.ts expands against a location's visual_description/
// environment; location_describer_prompt, the room-description LLM prompt describeLocation.ts
// expands (migration 0078, describer.md — empty = built-in default); and
// location_describer_history_pairs, how many trailing turn-pairs the describer reads as context
// (integer-as-text, default 1). All three are live-read on every call (no restart).

export interface ImageSettings {
  template: string;
  templateIsDefault: boolean;
  describerPrompt: string;
  describerPromptIsDefault: boolean;
  describerHistoryPairs: string;
}

export async function getImageSettings(store: OrchestratorSettingsStore): Promise<ImageSettings> {
  const [template, describerPrompt, describerHistoryPairs] = await Promise.all([
    store.get('image_prompt_template'),
    store.get('location_describer_prompt'),
    store.get('location_describer_history_pairs'),
  ]);
  return {
    template: template ?? '',
    templateIsDefault: !template,
    describerPrompt: describerPrompt ?? '',
    describerPromptIsDefault: !describerPrompt,
    describerHistoryPairs: describerHistoryPairs ?? '',
  };
}

export function parseSetImageSettingsBody(raw: unknown): { template?: string; describer_prompt?: string; describer_history_pairs?: string } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { template, describer_prompt, describer_history_pairs } = raw as Record<string, unknown>;
  if (template === undefined && describer_prompt === undefined && describer_history_pairs === undefined) return undefined;
  if (template !== undefined && typeof template !== 'string') return undefined;
  if (describer_prompt !== undefined && typeof describer_prompt !== 'string') return undefined;
  if (describer_history_pairs !== undefined && typeof describer_history_pairs !== 'string') return undefined;
  return { template, describer_prompt, describer_history_pairs };
}

export async function setImageSettings(
  store: OrchestratorSettingsStore,
  patch: { template?: string; describer_prompt?: string; describer_history_pairs?: string },
): Promise<void> {
  const writes: Array<[SettingName, string]> = [];
  if (patch.template !== undefined) writes.push(['image_prompt_template', patch.template]);
  if (patch.describer_prompt !== undefined) writes.push(['location_describer_prompt', patch.describer_prompt]);
  if (patch.describer_history_pairs !== undefined) writes.push(['location_describer_history_pairs', patch.describer_history_pairs]);
  for (const [key, value] of writes) await store.set(key, value);
}

// --- Location Tracker settings (docs/plans/vistalyze_integration/location.md §6.3) ---
// The Locations page's unified settings surface: the tracker's three keys plus the room
// describer's two (moved entirely from the Backgrounds page — the image-settings endpoint above
// keeps accepting the describer_* patch keys for back-compat, but the page no longer sends them).

export interface LocationSettings {
  splitEnabled: boolean;
  injectionEnabled: boolean;
  injectionPrompt: string;
  injectionPromptIsDefault: boolean;
  describerPrompt: string;
  describerPromptIsDefault: boolean;
  describerHistoryPairs: string;
}

export async function getLocationSettings(store: OrchestratorSettingsStore): Promise<LocationSettings> {
  const [splitEnabled, injectionEnabled, injectionPrompt, describerPrompt, describerHistoryPairs] = await Promise.all([
    store.get('location_split_enabled'),
    store.get('location_injection_enabled'),
    store.get('location_injection_prompt'),
    store.get('location_describer_prompt'),
    store.get('location_describer_history_pairs'),
  ]);
  return {
    splitEnabled: splitEnabled !== 'false',
    injectionEnabled: injectionEnabled !== 'false',
    injectionPrompt: injectionPrompt?.trim() ? injectionPrompt : DEFAULT_LOCATION_BLOCK_TEMPLATE,
    injectionPromptIsDefault: !injectionPrompt?.trim(),
    describerPrompt: describerPrompt?.trim() ? describerPrompt : DEFAULT_LOCATION_DESCRIBER_PROMPT,
    describerPromptIsDefault: !describerPrompt?.trim(),
    describerHistoryPairs: describerHistoryPairs ?? '',
  };
}

export function parseSetLocationSettingsBody(
  raw: unknown,
):
  | {
      split_enabled?: string;
      injection_enabled?: string;
      injection_prompt?: string;
      describer_prompt?: string;
      describer_history_pairs?: string;
    }
  | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { split_enabled, injection_enabled, injection_prompt, describer_prompt, describer_history_pairs } = raw as Record<string, unknown>;
  if (
    split_enabled === undefined &&
    injection_enabled === undefined &&
    injection_prompt === undefined &&
    describer_prompt === undefined &&
    describer_history_pairs === undefined
  ) {
    return undefined;
  }
  if (split_enabled !== undefined && typeof split_enabled !== 'boolean') return undefined;
  if (injection_enabled !== undefined && typeof injection_enabled !== 'boolean') return undefined;
  if (injection_prompt !== undefined && typeof injection_prompt !== 'string') return undefined;
  if (describer_prompt !== undefined && typeof describer_prompt !== 'string') return undefined;
  if (describer_history_pairs !== undefined && typeof describer_history_pairs !== 'string') return undefined;
  return {
    split_enabled: split_enabled === undefined ? undefined : split_enabled ? 'true' : 'false',
    injection_enabled: injection_enabled === undefined ? undefined : injection_enabled ? 'true' : 'false',
    injection_prompt,
    describer_prompt,
    describer_history_pairs,
  };
}

export async function setLocationSettings(
  store: OrchestratorSettingsStore,
  patch: {
    split_enabled?: string;
    injection_enabled?: string;
    injection_prompt?: string;
    describer_prompt?: string;
    describer_history_pairs?: string;
  },
): Promise<void> {
  const writes: Array<[SettingName, string]> = [];
  if (patch.split_enabled !== undefined) writes.push(['location_split_enabled', patch.split_enabled]);
  if (patch.injection_enabled !== undefined) writes.push(['location_injection_enabled', patch.injection_enabled]);
  if (patch.injection_prompt !== undefined) writes.push(['location_injection_prompt', patch.injection_prompt]);
  if (patch.describer_prompt !== undefined) writes.push(['location_describer_prompt', patch.describer_prompt]);
  if (patch.describer_history_pairs !== undefined) writes.push(['location_describer_history_pairs', patch.describer_history_pairs]);
  for (const [key, value] of writes) await store.set(key, value);
}