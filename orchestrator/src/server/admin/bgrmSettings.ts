/** Character-image BGRM enablement settings. */

import type { OrchestratorSettingsStore, SettingName } from '../../io/orchestratorSettings.js';

export interface BgrmSettings {
  portraitStudioEnabled: boolean;
  characterAutofireEnabled: boolean;
}

export interface BgrmSettingsPatch {
  portraitStudioEnabled?: boolean;
  characterAutofireEnabled?: boolean;
}

function parseBoolean(value: string | undefined): boolean {
  return value === 'true';
}

export async function getBgrmSettings(store: OrchestratorSettingsStore): Promise<BgrmSettings> {
  const [portrait, character] = await Promise.all([
    store.get('portrait_bgrm_enabled'),
    store.get('character_visual_bgrm_enabled'),
  ]);
  return {
    portraitStudioEnabled: parseBoolean(portrait),
    characterAutofireEnabled: parseBoolean(character),
  };
}

export function parseSetBgrmSettingsBody(raw: unknown): BgrmSettingsPatch | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  const allowed = new Set(['portraitStudioEnabled', 'characterAutofireEnabled']);
  if (Object.keys(body).some((key) => !allowed.has(key))) return undefined;
  if (!Object.keys(body).length) return undefined;
  if (body.portraitStudioEnabled !== undefined && typeof body.portraitStudioEnabled !== 'boolean') return undefined;
  if (body.characterAutofireEnabled !== undefined && typeof body.characterAutofireEnabled !== 'boolean') return undefined;
  return {
    portraitStudioEnabled: body.portraitStudioEnabled as boolean | undefined,
    characterAutofireEnabled: body.characterAutofireEnabled as boolean | undefined,
  };
}

export async function setBgrmSettings(store: OrchestratorSettingsStore, patch: BgrmSettingsPatch): Promise<void> {
  const writes: Array<[SettingName, string]> = [];
  if (patch.portraitStudioEnabled !== undefined) writes.push(['portrait_bgrm_enabled', String(patch.portraitStudioEnabled)]);
  if (patch.characterAutofireEnabled !== undefined) writes.push(['character_visual_bgrm_enabled', String(patch.characterAutofireEnabled)]);
  for (const [key, value] of writes) await store.set(key, value);
}
