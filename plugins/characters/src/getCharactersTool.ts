/**
 * @file plugins/characters/src/getCharactersTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — lists characters (summaries only)
 * @description
 * The read-back half of the data-only character slice (canonize-plan.md §8): returns character
 * ids and names so scenes can reference them (add_character_to_scene) and canon facts can link to
 * them (propose_canon_fact's linked_character_ids) without a separate Roster surface. Summary-only,
 * same shape as get_notes — persona/scenario/etc are the static creation fields and aren't needed
 * to pick an id.
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
      const rows = await ctx.db.query<CharacterRow>(
        'select character_id, name from characters where user_id = $1 order by name',
        [ctx.userId],
      );
      return rows.map((r) => ({ characterId: r.character_id, name: r.name }));
    },
  };
}
