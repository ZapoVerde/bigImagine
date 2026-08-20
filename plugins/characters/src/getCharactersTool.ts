/**
 * @file plugins/characters/src/getCharactersTool.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — lists characters (summaries only)
 * @description
 * The read-back half of the data-only character slice (canonize-plan.md §8): returns character
 * ids, names, and creation timestamps so scenes can reference them (add_character_to_scene) and
 * canon facts can link to
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
 * An optional `castOnly` arg (rp-cast-library-repair.md Part A) drops the status-null
 * unconditional-eligibility carve-out for one caller — the RP sidebar's Cast section — so it
 * returns only this chat's linked auto-registered characters, never the user's card library.
 * It is a purely internal frontend↔handler contract: deliberately NOT added to
 * definition.parameters (which only governs the LLM's own tool-calling manifest), so the model
 * never sees or uses it.
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
  created_at: Date;
}

export function createGetCharactersTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_characters',
      description: "List the user's characters (id, name, and creation time). Use the returned character ids to reference characters in scenes or canon facts.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      // castOnly (rp-cast-library-repair.md Part A): the RP sidebar's Cast section passes it so
      // its chat-scoped listing shows only this chat's actual cast, not the whole card library.
      // Anything other than a literal true is treated as false — a missing/malformed body never
      // throws and never changes today's behavior.
      const castOnly = (args as { castOnly?: boolean } | null | undefined)?.castOnly === true;
      // segway.md §2.6 eligibility: user-authored rows (status null) always count; auto-registered
      // rows count only when linked to the calling chat and not demoted ($2; null chat -> none).
      // castOnly drops the status-null carve-out — per db/migrations/0096, a user-authored card
      // never has a character_chat_links row, so the link check alone excludes the card library.
      const rows = await ctx.db.query<CharacterRow>(
        castOnly
          ? `select character_id, name, created_at from characters
             where user_id = $1 and (
               status is not null and status <> 'inactive' and exists (
                 select 1 from character_chat_links where character_id = characters.character_id and chat_id = $2
               )
             )
             order by name`
          : `select character_id, name, created_at from characters
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
      return rows.map((r) => ({ characterId: r.character_id, name: r.name, createdAt: r.created_at.toISOString() }));
    },
  };
}
