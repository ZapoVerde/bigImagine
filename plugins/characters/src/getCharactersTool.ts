/**
 * @file plugins/characters/src/getCharactersTool.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — lists characters (summaries only)
 * @description
 * The read-back half of the data-only character slice (canonize-plan.md §8): returns character
 * ids and names so scenes can reference them (add_character_to_scene) and canon facts can link to
 * them (propose_canon_fact's linked_character_ids) without a separate Roster surface. Summary-only,
 * same shape as get_notes — persona/scenario/etc are the static creation fields and aren't needed
 * to pick an id.
 *
 * Applies docs/plans/vistalyze_integration/segway.md §2.6's eligibility filter — same clause as
 * get_scenes (plugins/scenes/src/getScenesTool.ts): an inactive character (a demoted alternate
 * timeline) must never be model-visible, or the model could hand its id straight back into
 * add_character_to_scene and undo the sync tick's exclusion. Auto-registered rows (status is not
 * null) surface only when linked to the calling chat via character_chat_links (db/migrations/0096)
 * — with no chat context (ctx.chatId unset) none of them surface. User-authored rows (status is
 * null) are always eligible. This also shapes the Characters Roster
 * (frontend/src/views/CharactersView.tsx lists via this tool) — with no chat context it now shows
 * only user-authored characters, never auto-registered NPCs, a deliberate behavior change (see
 * plan §6): background NPCs from one story shouldn't pollute a reusable character library.
 *
 * @api-declaration
 * createGetCharactersTool() — returns the get_characters RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface CharacterRow {
  character_id: string;
  name: string;
}

export function createGetCharactersTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_characters',
      description: "List the user's characters (id and name only). Use the returned character ids to reference characters in scenes or canon facts.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: async (_args, ctx) => {
      // segway.md §2.6 eligibility: user-authored rows (status null) always count; auto-registered
      // rows count only when linked to the calling chat and not demoted ($2; null chat -> none).
      const rows = await ctx.db.query<CharacterRow>(
        `select character_id, name from characters
         where user_id = $1 and (
           status is null or (
             status <> 'inactive' and exists (
               select 1 from character_chat_links where character_id = characters.character_id and chat_id = $2
             )
           )
         )
         order by name`,
        [ctx.userId, ctx.chatId ?? null],
      );
      return rows.map((r) => ({ characterId: r.character_id, name: r.name }));
    },
  };
}
