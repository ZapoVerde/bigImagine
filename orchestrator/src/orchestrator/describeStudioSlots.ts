/**
 * @file orchestrator/src/orchestrator/describeStudioSlots.ts
 * @stamp 2026-08-17
 * @architectural-role Orchestrator — the Portrait Studio slot bootstrapper
 * @description
 * The "give the mutation loop something to work with" step: one synchronous LLM call that turns
 * a bare entity (name + whatever free-text context the caller supplies — describeStudioSubject's
 * blurb, a create-time seed, or nothing) into a starting set of structured slot values for its own
 * layer only. Without this, every entity was created with `slots: {}` and stayed that way forever
 * — the mutation loop (evoprompt.ts) is explicitly told to "only use slot names that already exist
 * in that layer," so an entity with no slots to begin with never gets any, no matter how many
 * rounds run. compileTemplate (composer.ts) only ever reads from slots, so an unbootstrapped
 * entity composes to an almost-empty image prompt no matter how good the context text was.
 *
 * Structurally the sibling of describeStudioSubject.ts, one layer downstream: same "default +
 * bespoke" prompt shape (bi_principles.md §17), same fail-open contract (bi_principles.md §11 —
 * never throws, resolves to `{}` on any failure so creation is never blocked), same "type a name,
 * get it filled in" default-path gating (bi_principles.md §3 — an operator who hand-fills slots
 * gets exactly those, no bootstrapper call). Marker-text parsing, not forced tool-calling, per the
 * 2026-08-17 evoprompt.ts precedent (user direction: "structured requests like our character
 * description work better than json shapes").
 *
 * There is no fixed slot-name vocabulary anywhere in Portrait Studio — composer.ts resolves
 * `{{token}}` against whichever layer owns that name dynamically, and evoprompt.ts's mutation
 * prompt has never named specific slots either. This call is exactly where slot names for a layer
 * get invented for the first time; reconcile.ts's enforceSlotKeys then treats whatever this call
 * wrote as that entity's permanent key contract — a later mutation round can tweak these values
 * but never add keys this call didn't establish, and never drop them either.
 *
 * @api-declaration
 * DEFAULT_PORTRAIT_SLOT_BOOTSTRAP_PROMPT — the built-in prompt template (empty
 *   `portrait_slot_bootstrap_prompt` override = this; bi_principles.md §17)
 * describeStudioSlots(settings, llm, userId, { layerId, layerLabel, layerBoundary, name, context })
 *   -> Promise<Record<string, string>> — the synchronous call; resolves to the new slot map, or
 *   `{}` on any failure (never throws)
 *
 * @contract
 *   assertions:
 *     purity:          impure (settings read, LLM call, prompt-trace write)
 *     state_ownership: []
 *     external_io:     [orchestrator_settings (read), the LLM via the injected provider, the
 *                       prompt trace (recordPromptTrace)]
 *     never:           throws. Every failure path logs and resolves to `{}`.
 */

import { log } from '../io/logger.js';
import { runWithCallContext, withCallLabel } from '../io/llm/callContext.js';
import type { LlmProvider } from '../io/llm/types.js';
import { recordPromptTrace, type PromptTraceEntry } from '../io/promptTrace.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';

export const DEFAULT_PORTRAIT_SLOT_BOOTSTRAP_PROMPT = `[SYSTEM: TASK — PORTRAIT STUDIO SLOT ARCHIVIST]
Layer: {{layerLabel}} ({{layerId}})
Layer boundary: {{layerBoundary}}

Entity name: {{name}}

Context (may be empty):
{{context}}

Break this entity down into a small set of structured slot values for the "{{layerLabel}}" layer
only, strictly within its boundary above. These become the starting chromosome a later mutation
step will tweak round after round, so give it real, specific, image-prompt-usable content — not a
placeholder. Invent slot names freely (short, lowercase, underscore_separated — there is no fixed
vocabulary), choosing names that clearly describe what each holds. Use the context when it gives
you anything; when it's empty, infer sensible, specific values from the name alone.

Respond in plain text ONLY, exactly in this format (no JSON, no commentary, no markdown fences),
one "slotName: value" line per slot, and nothing else:

slotName: value
slotName: value
...`;

const SLOT_LINE = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/;

/** Bootstrap one layer's starting slots. Resolves to `{}` when the call fails, times out, or
 *  comes back with no parseable "slot: value" lines — the caller (portraitRoutes.ts's
 *  create-entity path) inserts the entity with empty slots either way (bi_principles.md §11, the
 *  same fail-open shape as describeStudioSubject). `name` is guaranteed non-empty by
 *  parseCreateEntityBody's 400 before this is ever reached. */
export async function describeStudioSlots(
  settings: OrchestratorSettingsStore,
  llm: LlmProvider,
  userId: string,
  input: { layerId: string; layerLabel: string; layerBoundary: string; name: string; context: string },
): Promise<Record<string, string>> {
  try {
    const override = await settings.get('portrait_slot_bootstrap_prompt');
    const prompt = (override ?? '').trim() || DEFAULT_PORTRAIT_SLOT_BOOTSTRAP_PROMPT;
    const filled = prompt
      .replace(/\{\{\s*layerLabel\s*\}\}/g, input.layerLabel)
      .replace(/\{\{\s*layerId\s*\}\}/g, input.layerId)
      .replace(/\{\{\s*layerBoundary\s*\}\}/g, input.layerBoundary)
      .replace(/\{\{\s*name\s*\}\}/g, input.name)
      .replace(/\{\{\s*context\s*\}\}/g, input.context.trim() || '(none)');

    const entry: PromptTraceEntry = {
      kind: 'describer',
      title: `Portrait Studio Slot Bootstrapper — ${input.layerLabel}`,
      items: [{ role: 'user', content: filled, chars: filled.length, estimatedTokens: Math.ceil(filled.length / 4) }],
      capturedAt: Date.now(),
    };
    recordPromptTrace('portrait-slot-bootstrap', entry);
    log.info('describeStudioSlots: bootstrapper fired', { layerId: input.layerId, name: input.name, promptChars: filled.length });

    const turn = await runWithCallContext({ taskId: 'portrait-slot-bootstrap', kind: 'system', userId }, () =>
      withCallLabel('portrait:slot-bootstrap', () => llm.complete([{ role: 'user', content: filled }], [])),
    );
    const reply = turn.message.content?.trim() ?? '';
    if (!reply) {
      log.warn('describeStudioSlots: bootstrapper replied empty, creating entity with no slots', { layerId: input.layerId, name: input.name });
      return {};
    }
    entry.reply = reply;

    const slots: Record<string, string> = {};
    for (const rawLine of reply.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = line.match(SLOT_LINE);
      if (!match) continue; // stray/malformed line — skip, same tolerance as evoprompt.ts's parseCandidateResponse
      const key = match[1]!.trim();
      const value = match[2]!.trim();
      if (!key || !value) continue;
      slots[key] = value;
    }
    log.info('describeStudioSlots: entity bootstrapped', { layerId: input.layerId, name: input.name, slotCount: Object.keys(slots).length });
    return slots;
  } catch (err) {
    log.warn('describeStudioSlots: bootstrapper failed, creating entity with no slots', { layerId: input.layerId, name: input.name, err });
    return {};
  }
}
