/**
 * @file plugins/characters/src/removeCharacterFromChatTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — unlinks a character from a chat's RP cast
 * @description
 * rp-cast-delete-plan.md — the "remove from cast" affordance. Deletes the `character_chat_links`
 * row for (character, chat) so the character no longer appears in this chat's cast
 * (get_characters' chat-scoped eligibility filter, segway.md §2.6). It deliberately does NOT
 * delete the `characters` row itself: migration 0096's `cleanup_orphaned_character()` trigger
 * (after delete on character_chat_links) reaps the row whenever that was its last link — the
 * cascade is "the link row, with the characters row going away via the existing trigger only when
 * it loses its last link" (plan's Cascade decision). A character linked to another chat survives,
 * persona and avatar intact.
 *
 * Also clears the character's `scene_presence` rows for THIS chat's scenes (scoped by
 * s.chat_id, never globally — the character may still be present in a different chat's scene with
 * its own link) so a chat that never gets another Present: scrape doesn't carry a permanently-
 * orphaned junction row. This is hygiene rather than a correctness fix: get_scenes' own eligibility
 * filter already re-checks character_chat_links live on every read, so the presence dot stops
 * lighting the instant the link is gone. Both deletes run in the same transaction because
 * postgres.ts's withUserScope wraps the whole tool invocation in one BEGIN/COMMIT — matching how
 * every other multi-statement tool here (e.g. deleteCharacterTool.ts's two deletes) already relies
 * on the same implicit wrap.
 *
 * Scoping discipline matches deleteCharacterTool.ts: both deletes are guarded by the calling
 * user, so a stale/foreign characterId or chatId can never touch another user's data — a link (or a
 * user-scoped link) that doesn't exist returns removed:false, reason:'not-found' as an idempotent
 * no-op rather than an error.
 *
 * @api-declaration
 * createRemoveCharacterFromChatTool() — returns the remove_character_from_chat RegisteredTool
 *
 * POST /v1/tools/remove_character_from_chat?chat_id=<chatId>
 *   { characterId: string }
 *   -> { removed: boolean; reason?: 'not-found' }
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { log } from '@bigbrain/orchestrator/logger';

function isRemoveCharacterFromChatArgs(value: unknown): value is { characterId: string } {
  const v = value as Record<string, unknown>;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof v.characterId === 'string' &&
    v.characterId.length > 0
  );
}

export function createRemoveCharacterFromChatTool(): RegisteredTool {
  return {
    definition: {
      name: 'remove_character_from_chat',
      description:
        "Remove a character from a chat's cast (unlink it from the chat). Leaves the character's persona and avatar intact; the characters row is only cleaned up by its own orphan trigger if this was its last chat.",
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: "The character's id to remove from the chat's cast." },
        },
        required: ['characterId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isRemoveCharacterFromChatArgs(args)) {
        throw new Error('remove_character_from_chat requires a characterId: string');
      }
      // The target chat comes from the caller's chat scope (ctx.chatId — the frontend always
      // appends ?chat_id= via callTool, the same way get_characters/get_scenes are scoped). A
      // call with no chat context is a foreign-chat hazard the tool refuses: every delete below
      // also re-guards on user_id via the characters join, so nothing can ever assert against a
      // chat that isn't the caller's or reach beyond this user's data.
      const chatId = ctx.chatId;
      if (!chatId) return { removed: false, reason: 'not-found' };

      // 1) Unlink the character from the chat. The EXISTS guard scopes the delete to the calling
      // user's own character (RLS on character_chat_links derives from characters.user_id), so a
      // stale/foreign / other-user characterId is a safe scoped no-op that matches nothing.
      const linkRows = await ctx.db.query<{ character_id: string }>(
        `delete from character_chat_links
         where character_id = $1 and chat_id = $2
           and exists (select 1 from characters
                       where character_id = character_chat_links.character_id and user_id = $3)
         returning character_id`,
        [args.characterId, chatId, ctx.userId],
      );
      if (linkRows.length === 0) {
        return { removed: false, reason: 'not-found' };
      }

      // 2) Hygiene: drop this character's presence rows for THIS chat's scenes only (scoped by
      // scenes.chat_id and scenes.user_id). A character present in a different chat's scene keeps
      // its own link and its own presence rows there — we never touch them.
      await ctx.db.query(
        `delete from scene_presence sp
         using scenes s
         where sp.character_id = $1 and sp.scene_id = s.scene_id
           and s.user_id = $2 and s.chat_id = $3`,
        [args.characterId, ctx.userId, chatId],
      );

      // Log at the IO seam (bi_principles.md §11): a silent presence-vs-removed inconsistency
      // would otherwise be invisible. Whether the orphan trigger reaps the row is derivable from
      // the link delete, but we surface it so the diagnosis is in the log.
      const survivors = await ctx.db.query<{ count: string }>(
        'select count(*)::text as count from character_chat_links where character_id = $1',
        [args.characterId],
      );
      log.debug(
        `remove_character_from_chat: unlinked character ${args.characterId} from chat ${chatId}; ` +
          `${survivors[0]?.count ?? 0} link(s) remain — orphan-trigger reap applies iff this was the character's last link`,
      );

      return { removed: true };
    },
  };
}
