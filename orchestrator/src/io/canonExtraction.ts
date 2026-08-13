/**
 * @file orchestrator/src/io/canonExtraction.ts
 * @stamp 2026-08-04
 * @architectural-role Pure Function module — the default canon-extraction prompt constant
 * @description
 * The built-in default for the `canon_extraction_prompt` orchestrator setting
 * (docs/canonize-plan.md §6, bi_principles.md §17): the instruction text the background
 * extraction pass will send to the LLM when it proposes canon facts after a turn. Lives in
 * orchestrator core rather than plugins/canonize because server/adminServer.ts (core) must be
 * able to import it for the Settings tab's "default + bespoke" display — a plugin can depend on
 * @bigbrain/orchestrator, never the reverse (orchestrator/src/orchestrator/pluginLoader.ts's
 * own one-way-dependency doc).
 *
 * The actual extraction pass that *uses* this prompt is Director Pass work
 * (canonize-plan.md §2 Non-Goals) — not yet wired. When it lands, it reads the setting live via
 * io/orchestratorSettings.ts, same shape as chatMemorySync.ts's resolveSyncSettings; an empty
 * override means "use this default" (bi_principles.md §17).
 *
 * The default encodes the category routing and the Connections/Relationship/Goals guidance from
 * canonize-plan.md §3.3, written out as the actual instruction text an LLM extraction call
 * receives.
 *
 * @api-declaration
 * DEFAULT_CANON_EXTRACTION_PROMPT — the built-in system prompt for the canon-extraction pass
 *
 * @contract
 *   assertions:
 *     purity:          pure (constant only)
 *     state_ownership: []
 *     external_io:     []
 */

export const DEFAULT_CANON_EXTRACTION_PROMPT =
  'You are the canon extraction pass for an interactive fiction scene. Read the recent turn and decide ' +
  'whether anything said, discovered, or changed is worth remembering as an established world fact. Only ' +
  'propose facts that are genuinely new or have changed — do not restate what is already canonical, and do ' +
  'not infer a character\'s static identity (appearance, core personality) from a single turn; that belongs ' +
  'to a human editing the Roster, never to extraction.\n\n' +
  'For each fact you propose, pick exactly one category:\n' +
  '- "person" — a connection between characters, a relationship-with-user shift, or an evolving goal. Prefer ' +
  '"person" facts about the connections between present characters over bare personality notes.\n' +
  '- "place" — a fact about a location.\n' +
  '- "thing" — a fact about an object or artifact.\n' +
  '- "concept" — a fact about the world\'s rules, politics, or abstractions.\n' +
  '- "plot" — a fact that advances a continuing storyline thread. Reuse an existing arc_tag to continue a ' +
  'thread; only use a new arc_tag for genuinely new stakes. A plot thread must have exactly one current ' +
  'state, so prefer superseding an existing thread over adding a near-duplicate fragment.\n\n' +
  'Write each summary as a concise, standalone statement of what is true. Always answer by calling ' +
  'propose_canon_fact for each fact (category, summary, detail, scene_id, linked_character_ids, ' +
  'linked_location_id, arc_tag where required).';