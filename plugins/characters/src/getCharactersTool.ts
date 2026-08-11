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
 * add_character_to_scene and undo the sync tick's exclusion. Transient rows surface only when
 * their anchor is provably on the calling chat's active swipe path; with no chat context
 * (ctx.chatId unset) only user-authored/permanent rows surface — the conservative reading. This
 * also shapes the Characters Roster (frontend/src/views/CharactersView.tsx lists via this tool),
 * so auto-registered transient NPCs appear once they promote to permanent canon, not before.
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
      // segway.md §2.6 eligibility, copied from getScenesTool.ts: transient rows count only when
      // their anchor is on the calling chat's active swipe path ($2; null chat -> none).
      const rows = await ctx.db.query<CharacterRow>(
        `select character_id, name from characters
         where user_id = $1 and (
           status = 'permanent' or status is null or
           (status = 'transient' and anchor_swipe_id in (
             select active_swipe_id from chat_messages where chat_id = $2 and active_swipe_id is not null
           ))
         )
         order by name`,
        [ctx.userId, ctx.chatId ?? null],
      );
      return rows.map((r) => ({ characterId: r.character_id, name: r.name }));
    },
  };
}
