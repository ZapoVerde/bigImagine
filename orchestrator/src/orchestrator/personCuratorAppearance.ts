/**
 * @file orchestrator/src/orchestrator/personCuratorAppearance.ts
 * @stamp 2026-08-17
 * @architectural-role Pure Function — the shared Appearance section-rule text
 * @description
 * The single source of the Appearance section-rule wording for characters'
 * physical-description field (docs/plans/character-appearance-field-plan.md). Both
 * description passes — the mint-time one-shot (describeCharacter.ts) and the periodic RP sync
 * people curator (io/chatMemory/curatePeople.ts) — interpolate this same constant into their own
 * prompts, so the two built-in defaults can never drift apart: "physically inherent traits only",
 * set once at creation, reproduced verbatim afterward, exactly the line
 * SillyTavern-Canonize's own people-curator prompt draws.
 *
 * Deliberately NOT a third prompt surface: each pass keeps its own full-text Settings override
 * (bi_principles.md §17 — character_describer_prompt / chat_memory_people_curator_prompt are the
 * only override points an operator reasons about). An operator who overrides either prompt in full
 * no longer sees this constant's wording — same "an empty override means use the built-in
 * default" posture as every other §17 prompt; there is no sub-prompt composition here.
 *
 * @api-declaration
 * APPEARANCE_SECTION_RULE — the section rule, as prose a pass interpolates verbatim into its
 *   prompt (each pass wraps it in the marker/label framing its own OUTPUT FORMAT requires).
 *
 * @contract
 *   assertions:
 *     purity:          pure (a plain string constant; no IO, no imports)
 *     state_ownership: []
 *     external_io:     []
 */

/** The Appearance section rule both character-description passes interpolate. Prose form so it
 *  reads naturally embedded in each pass's own prompt ("## Appearance — set once at creation…"),
 *  not a bullet list a pass would have to re-format. */
export const APPEARANCE_SECTION_RULE = `## Appearance — set once at creation.
Physically inherent traits only: body type, height, build, bone structure, facial features, natural hair colour and texture, permanent features such as scars or birthmarks. Exclude clothing, accessories, current hairstyle, and injuries.
If a trait is not established in the transcript, invent something consistent with the character's tone and setting — commit to it, do not leave gaps.
Reproduce exactly in every UPDATE — do not alter, rephrase, or reorder.`;
