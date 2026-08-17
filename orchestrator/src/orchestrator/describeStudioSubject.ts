/**
 * @file orchestrator/src/orchestrator/describeStudioSubject.ts
 * @stamp 2026-08-17
 * @architectural-role Orchestrator — the Portrait Studio subject describer
 *   (docs/plans/portrait-studio-standalone-subjects-plan.md Part B)
 * @description
 * The "type a name, get a described subject" path inside Portrait Studio: one synchronous LLM
 * call that turns a bare subject name (+ an optional short `seed` prompt) into a full physical-
 * appearance blurb. The blurb is never persisted on the entity itself (2026-08-17: visual_entities
 * dropped standing_instructions, migration 0114) — the caller (portraitRoutes.ts's create-entity
 * path) hands it straight to describeStudioSlots.ts as ephemeral bootstrap context, one LLM call
 * feeding the next, ordinary scratch data with no independent life afterward.
 *
 * Structurally the small sibling of describeCharacter.ts (orchestrator/describeCharacter.ts),
 * minus the transcript-context machinery — there is no chat to read here, nothing to fill-when-
 * empty, no skip rule, no fire-and-forget split — minus the two-marker persona/appearance
 * output: this pass produces exactly one blurb (the Appearance marker's value when the model
 * follows the output format, the full reply otherwise).
 *
 * The prompt is the same "default + bespoke" shape as every prompt key (bi_principles.md §17):
 * empty `portrait_subject_describer_prompt` → the built-in default here; a non-empty override is
 * used verbatim, `{{name}}` and `{{seed}}` interpolated. The built-in default interpolates the
 * shared APPEARANCE_SECTION_RULE (orchestrator/personCuratorAppearance.ts) exactly like
 * describeCharacter.ts and curatePeople.ts do, so a Studio-native subject's instructions read the
 * same shape as any other appearance blurb in the system and can never semantically drift from
 * what the character describer or people curator mean by "appearance."
 *
 * Fail-open (bi_principles.md §11): the call itself never throws — a settings read failure, an
 * LLM error, an empty reply, or a reply with no usable content all log a warning and resolve to
 * `''`, and the caller proceeds to bootstrap slots with no context either way (the operator can
 * hand-fill slots afterward). Creation never blocks on the describer failing.
 *
 * @api-declaration
 * DEFAULT_PORTRAIT_SUBJECT_DESCRIBER_PROMPT — the built-in prompt template (empty
 *   `portrait_subject_describer_prompt` = this; §17)
 * describeStudioSubject(settings, llm, userId, { name, seed }) -> Promise<string> —
 *   the synchronous call; resolves to the appearance blurb, or `''` on any failure (never throws)
 *
 * @contract
 *   assertions:
 *     purity:          impure (settings read, LLM call, prompt-trace write)
 *     state_ownership: []
 *     external_io:     [orchestrator_settings (read), the LLM via the injected provider, the
 *                       prompt trace (recordPromptTrace)]
 *     never:           throws. Every failure path logs and resolves to `''`.
 */

import { log } from '../io/logger.js';
import { runWithCallContext, withCallLabel } from '../io/llm/callContext.js';
import type { LlmProvider } from '../io/llm/types.js';
import { recordPromptTrace, type PromptTraceEntry } from '../io/promptTrace.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { APPEARANCE_SECTION_RULE } from './personCuratorAppearance.js';

export const DEFAULT_PORTRAIT_SUBJECT_DESCRIBER_PROMPT = `[SYSTEM: TASK — PORTRAIT SUBJECT VISUAL ARCHIVIST]
The training subject is: {{name}}

SEED:
{{seed}}

Write a short physical-appearance blurb for this subject — the standing instructions Portrait
Studio will refine into image-generation prompts. Draw on the seed when it gives you anything;
when the seed is empty, invent a full physical description from the name alone.

${APPEARANCE_SECTION_RULE}

### OUTPUT FORMAT:
Appearance: [Physical Appearance Blurb]`;

/** Describe the subject. Resolves to the appearance blurb, or `''` when the call fails, times
 *  out, or comes back empty — the caller (portraitRoutes.ts's create-entity path) inserts the
 *  entity either way (bi_principles.md §11, the plan's fail-open). `name` is guaranteed non-empty
 *  by parseCreateEntityBody's 400 before this is ever reached. */
export async function describeStudioSubject(
  settings: OrchestratorSettingsStore,
  llm: LlmProvider,
  userId: string,
  input: { name: string; seed?: string },
): Promise<string> {
  try {
    const override = await settings.get('portrait_subject_describer_prompt');
    const prompt = (override ?? '').trim() || DEFAULT_PORTRAIT_SUBJECT_DESCRIBER_PROMPT;
    const filled = prompt
      .replace(/\{\{\s*name\s*\}\}/g, input.name)
      .replace(/\{\{\s*seed\s*\}\}/g, (input.seed ?? '').trim());

    const entry: PromptTraceEntry = {
      kind: 'describer',
      title: 'Portrait Studio Subject Describer — appearance blurb',
      items: [{ role: 'user', content: filled, chars: filled.length, estimatedTokens: Math.ceil(filled.length / 4) }],
      capturedAt: Date.now(),
    };
    recordPromptTrace('portrait-subject-describer', entry);
    log.info('describeStudioSubject: describer fired', { name: input.name, promptChars: filled.length });

    const turn = await runWithCallContext({ taskId: 'portrait-subject-describer', kind: 'system', userId }, () =>
      withCallLabel('portrait:subject-describer', () => llm.complete([{ role: 'user', content: filled }], [])),
    );
    const reply = turn.message.content?.trim() ?? '';
    if (!reply) {
      log.warn('describeStudioSubject: describer replied empty, creating subject with blank instructions', { name: input.name });
      return '';
    }
    entry.reply = reply;

    // The tolerant label scan, same shape as describeCharacter.ts's extractMarker: prefer the
    // Appearance: marker's value, fall back to the whole reply when the model skipped the format.
    const match = reply.match(/Appearance:\s*([\s\S]*?)(?=\n\*?\*?(?:Name|Persona)\*?\*?:|$)/i);
    const marker = match?.[1]?.trim().replace(/^\*+|\*+$/g, '').trim();
    const blurb = marker || reply;
    log.info('describeStudioSubject: subject described', { name: input.name, blurbChars: blurb.length });
    return blurb;
  } catch (err) {
    // bi_principles.md §11: log the seam. A failed describe must never block or error the create.
    log.warn('describeStudioSubject: describer failed, creating subject with blank instructions', { name: input.name, err });
    return '';
  }
}