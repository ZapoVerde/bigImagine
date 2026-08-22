/**
 * @file plugins/characters/src/getCharactersTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — lists runtime Characters (cast only)
 * @description
 * Runtime-only listing: every returned row is a chat-scoped auto-registered
 * character linked via character_chat_links and not inactive. The legacy Card
 * library (status IS NULL) is no longer listed here — reusable Cards are
 * served by the canonical Cards plugin (cards). The former castOnly toggle is
 * retained as a harmless pass-through for callers that still send it.
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
    handler: async (_args, ctx) => {
      // Runtime-only: a character must be auto-registered (status not null, not inactive)
      // and linked to the calling chat via character_chat_links. The former Card library
      // (status IS NULL) and the castOnly toggle are now legacy — every call is cast-scoped.
      if (!ctx.chatId) return [];
      const rows = await ctx.db.query<CharacterRow>(
        `select character_id, name, created_at from characters
           where user_id = $1 and status is not null and status <> 'inactive' and exists (
             select 1 from character_chat_links where character_id = characters.character_id and chat_id = $2
           )
           order by name`,
        [ctx.userId, ctx.chatId],
      );
      return rows.map((r) => ({ characterId: r.character_id, name: r.name, createdAt: r.created_at.toISOString() }));
    },
  };
}
