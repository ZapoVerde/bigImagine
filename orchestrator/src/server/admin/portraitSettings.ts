/**
 * @file orchestrator/src/server/admin/portraitSettings.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (settings-store IO) — the same
 * dual-role split the original adminServer.ts portrait blocks used; moved here verbatim as part of
 * the adminServer domain split
 * @description
 * Portrait Studio's admin prompt configuration: the standalone portrait subject describer, plus
 * the consolidated "background" prompt trio (slot bootstrap, mutation/chromosome, reflection/wiki-
 * writing). Each field saves independently with the same "default + bespoke" override shape
 * (bi_principles.md §17 — '' = built-in default). Portrait-generation orchestration itself
 * deliberately stays in its own portraits/orchestrator modules; this file only reads/writes their
 * prompt settings.
 *
 * @api-declaration
 * getPortraitSubjectDescriberSettings(store) — { describerPrompt, describerPromptIsDefault }
 * parseSetPortraitSubjectDescriberSettingsBody(raw) — validates { describer_prompt? } (required,
 *   string); undefined on any malformed shape
 * setPortraitSubjectDescriberSettings(store, patch) — upserts portrait_subject_describer_prompt
 * getPortraitBackgroundPromptsSettings(store) — { slotBootstrapPrompt (+IsDefault),
 *   mutationPrompt (+IsDefault), reflectionPrompt (+IsDefault) }, each defaulting when unset
 * parseSetPortraitBackgroundPromptsSettingsBody(raw) — validates { slot_bootstrap_prompt?,
 *   mutation_prompt?, reflection_prompt? }, at least one present; undefined on any malformed shape
 * setPortraitBackgroundPromptsSettings(store, patch) — upserts whichever fields the patch names
 *
 * @contract
 *   assertions:
 *     purity:          parseSetPortraitSubjectDescriberSettingsBody/
 *                      parseSetPortraitBackgroundPromptsSettingsBody are pure; the rest are impure
 *                      (Postgres IO via the injected settings store)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected OrchestratorSettingsStore)]
 */

import type { OrchestratorSettingsStore } from '../../io/orchestratorSettings.js';
import { DEFAULT_PORTRAIT_SUBJECT_DESCRIBER_PROMPT } from '../../orchestrator/describeStudioSubject.js';
import { DEFAULT_PORTRAIT_SLOT_BOOTSTRAP_PROMPT } from '../../orchestrator/describeStudioSlots.js';
import { DEFAULT_MUTATION_SYSTEM_PROMPT } from '../../portraits/evoprompt.js';
import { DEFAULT_REFLECTION_SYSTEM_PROMPT } from '../../orchestrator/portraitFeedback.js';

// portrait-studio-standalone-subjects-plan.md Part B — the Settings tab's Portrait Subject
// describer settings, a sibling of the Character-describer trio above minus the history-pairs
// knob (this describer has no transcript to bound). Same admin gate + live no-restart shape.
export interface PortraitSubjectDescriberSettings {
  describerPrompt: string;
  describerPromptIsDefault: boolean;
}

export async function getPortraitSubjectDescriberSettings(store: OrchestratorSettingsStore): Promise<PortraitSubjectDescriberSettings> {
  const describerPrompt = await store.get('portrait_subject_describer_prompt');
  return {
    describerPrompt: describerPrompt?.trim() ? describerPrompt : DEFAULT_PORTRAIT_SUBJECT_DESCRIBER_PROMPT,
    describerPromptIsDefault: !describerPrompt?.trim(),
  };
}

export function parseSetPortraitSubjectDescriberSettingsBody(
  raw: unknown,
): { describer_prompt?: string } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { describer_prompt } = raw as Record<string, unknown>;
  if (describer_prompt === undefined) return undefined;
  if (typeof describer_prompt !== 'string') return undefined;
  return { describer_prompt };
}

export async function setPortraitSubjectDescriberSettings(
  store: OrchestratorSettingsStore,
  patch: { describer_prompt?: string },
): Promise<void> {
  if (patch.describer_prompt !== undefined) await store.set('portrait_subject_describer_prompt', patch.describer_prompt);
}

// Portrait Studio's other three "background" LLM prompts (the subject describer above being the
// first) — slot bootstrap (fires once per entity, at creation), the mutation/chromosome call (one
// per generation round), and the reflection/wiki-writing call (one per feedback submission).
// Consolidated into one GET/SET pair (unlike the standalone subject-describer one above) since
// they're always edited together from the same sidebar panel and each is a single string field
// with the same default+override shape — three near-identical route pairs would just be
// boilerplate. Each field saves independently: a patch that omits a field leaves that prompt's
// stored override untouched.
export interface PortraitBackgroundPromptsSettings {
  slotBootstrapPrompt: string;
  slotBootstrapPromptIsDefault: boolean;
  mutationPrompt: string;
  mutationPromptIsDefault: boolean;
  reflectionPrompt: string;
  reflectionPromptIsDefault: boolean;
}

export async function getPortraitBackgroundPromptsSettings(store: OrchestratorSettingsStore): Promise<PortraitBackgroundPromptsSettings> {
  const [slotBootstrapPrompt, mutationPrompt, reflectionPrompt] = await Promise.all([
    store.get('portrait_slot_bootstrap_prompt'),
    store.get('visual_mutation_system_prompt_override'),
    store.get('visual_reflection_system_prompt_override'),
  ]);
  return {
    slotBootstrapPrompt: slotBootstrapPrompt?.trim() ? slotBootstrapPrompt : DEFAULT_PORTRAIT_SLOT_BOOTSTRAP_PROMPT,
    slotBootstrapPromptIsDefault: !slotBootstrapPrompt?.trim(),
    mutationPrompt: mutationPrompt?.trim() ? mutationPrompt : DEFAULT_MUTATION_SYSTEM_PROMPT,
    mutationPromptIsDefault: !mutationPrompt?.trim(),
    reflectionPrompt: reflectionPrompt?.trim() ? reflectionPrompt : DEFAULT_REFLECTION_SYSTEM_PROMPT,
    reflectionPromptIsDefault: !reflectionPrompt?.trim(),
  };
}

export function parseSetPortraitBackgroundPromptsSettingsBody(
  raw: unknown,
): { slot_bootstrap_prompt?: string; mutation_prompt?: string; reflection_prompt?: string } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { slot_bootstrap_prompt, mutation_prompt, reflection_prompt } = raw as Record<string, unknown>;
  if (slot_bootstrap_prompt !== undefined && typeof slot_bootstrap_prompt !== 'string') return undefined;
  if (mutation_prompt !== undefined && typeof mutation_prompt !== 'string') return undefined;
  if (reflection_prompt !== undefined && typeof reflection_prompt !== 'string') return undefined;
  if (slot_bootstrap_prompt === undefined && mutation_prompt === undefined && reflection_prompt === undefined) return undefined;
  return {
    ...(slot_bootstrap_prompt !== undefined ? { slot_bootstrap_prompt } : {}),
    ...(mutation_prompt !== undefined ? { mutation_prompt } : {}),
    ...(reflection_prompt !== undefined ? { reflection_prompt } : {}),
  };
}

export async function setPortraitBackgroundPromptsSettings(
  store: OrchestratorSettingsStore,
  patch: { slot_bootstrap_prompt?: string; mutation_prompt?: string; reflection_prompt?: string },
): Promise<void> {
  if (patch.slot_bootstrap_prompt !== undefined) await store.set('portrait_slot_bootstrap_prompt', patch.slot_bootstrap_prompt);
  if (patch.mutation_prompt !== undefined) await store.set('visual_mutation_system_prompt_override', patch.mutation_prompt);
  if (patch.reflection_prompt !== undefined) await store.set('visual_reflection_system_prompt_override', patch.reflection_prompt);
}