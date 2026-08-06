/**
 * @file plugins/characters/src/applyCharacterToChatTool.ts
 * @stamp 2026-08-06
 * @architectural-role IO Wrapper — loads a character into a chat's system prompt + opening greeting
 * @description
 * "Loading a card into the context stack", scoped to what's actually wired today: full
 * scenes/Director-Pass integration (docs/spec.md §7.4's marker vocabulary, §8) isn't built yet, so
 * this composes a plain labeled system-prompt string (System Prompt / Persona / Scenario / Example
 * Dialogue, skipping empty sections) and writes it into chat_sessions.params.system — the exact
 * mechanism the existing prompt-preset picker already uses to apply a saved instruction set to a
 * chat. params is a full-replace jsonb column (orchestrator/src/io/chatSessions.ts's updateChat), so
 * the existing row is read first and only its `system` key is overwritten, same read-merge-write
 * shape that store uses internally. Also stamps chat_sessions.character_id (0049_chat_kind.sql) so
 * a later apply_prompt_stack_to_chat call (plugins/context-stack-presets) can find which character
 * this chat is playing without the caller re-passing it.
 *
 * Only seeds the character's greetings as an assistant message when the target chat currently has
 * zero messages — this is meant to be called on a freshly-created chat (the frontend always opens a
 * brand new one for this action), never on an in-progress conversation, so there's no risk of
 * silently overwriting real history; the zero-message check is a safety backstop, not the only thing
 * enforcing that. chat_messages insertion mirrors chatSessions.ts's own appendMessages
 * (clock_timestamp() for ordering) rather than importing it — plugins own their own SQL and never
 * reach into orchestrator's internal IO modules, same as every other tool in this plugin.
 *
 * A card with more than one greeting (first_mes + alternate_greetings) loads every one of them in
 * as that opening message's swipe history (chat_message_swipes) rather than discarding all but the
 * first — chatSessions.ts's existing recordSwipe/cycleSwipe machinery, and ChatView.tsx's existing
 * prev/next swipe controls, then apply to the greeting for free with no new concept on either side.
 *
 * @api-declaration
 * createApplyCharacterToChatTool() — returns the apply_character_to_chat RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface CharacterRow {
  name: string;
  persona: string;
  scenario: string;
  system_prompt: string;
  example_dialogue: string;
  greetings: string[];
}

function isApplyCharacterToChatArgs(value: unknown): value is { characterId: string; chatId: string } {
  const v = value as Record<string, unknown>;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof v.characterId === 'string' &&
    v.characterId.length > 0 &&
    typeof v.chatId === 'string' &&
    v.chatId.length > 0
  );
}

function composeSystemText(row: CharacterRow): string {
  const sections: { label: string; content: string }[] = [
    { label: 'System Prompt', content: row.system_prompt },
    { label: 'Persona', content: row.persona },
    { label: 'Scenario', content: row.scenario },
    { label: 'Example Dialogue', content: row.example_dialogue },
  ];
  return sections
    .filter((s) => s.content.trim().length > 0)
    .map((s) => `## ${s.label}\n${s.content.trim()}`)
    .join('\n\n');
}

export function createApplyCharacterToChatTool(): RegisteredTool {
  return {
    definition: {
      name: 'apply_character_to_chat',
      description:
        "Load a character into a chat: composes its persona/scenario/system prompt/example dialogue into the chat's system prompt, and seeds its first greeting as the opening message if the chat has none yet.",
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string' },
          chatId: { type: 'string' },
        },
        required: ['characterId', 'chatId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isApplyCharacterToChatArgs(args)) {
        throw new Error('apply_character_to_chat requires characterId: string and chatId: string');
      }

      const characterRows = await ctx.db.query<CharacterRow>(
        'select name, persona, scenario, system_prompt, example_dialogue, greetings from characters where character_id = $1 and user_id = $2',
        [args.characterId, ctx.userId],
      );
      const character = characterRows[0];
      if (!character) return { applied: false, reason: 'character not found' };

      const chatRows = await ctx.db.query<{ params: Record<string, unknown> | null }>(
        'select params from chat_sessions where chat_id = $1 and user_id = $2',
        [args.chatId, ctx.userId],
      );
      const chat = chatRows[0];
      if (!chat) return { applied: false, reason: 'chat not found' };

      const systemText = composeSystemText(character);
      const nextParams = { ...(chat.params ?? {}), system: systemText };
      // Also stamps character_id (db/migrations/0049_chat_kind.sql) — every chat a character gets
      // applied to (this tool is the only writer of that column) remembers which one it's playing,
      // so apply_prompt_stack_to_chat can pull this character's fields later without the caller
      // re-passing characterId.
      await ctx.db.query(
        'update chat_sessions set params = $2::jsonb, character_id = $3, updated_at = now() where chat_id = $1',
        [args.chatId, JSON.stringify(nextParams), args.characterId],
      );

      const [{ count }] = await ctx.db.query<{ count: string }>(
        'select count(*)::text as count from chat_messages where chat_id = $1',
        [args.chatId],
      );
      let greetingInserted = false;
      if (count === '0' && character.greetings.length > 0) {
        const [{ message_id }] = await ctx.db.query<{ message_id: string }>(
          'insert into chat_messages (chat_id, user_id, role, content, created_at) values ($1, $2, $3, $4, clock_timestamp()) returning message_id',
          [args.chatId, ctx.userId, 'assistant', character.greetings[0]],
        );
        greetingInserted = true;

        // A card's alternate_greetings load in as this message's swipe history (chat_message_swipes,
        // db/migrations/0059_chat_message_swipes.sql) rather than a separate concept — the frontend's
        // existing swipe controls (ChatView.tsx) then just work on the opening message for free. Every
        // greeting is inserted, including the first (mirroring recordSwipe's own "original + regenerated"
        // shape), satisfying that table's "zero or two-plus rows" invariant when there's more than one.
        if (character.greetings.length > 1) {
          let activeSwipeId: string | undefined;
          for (const greeting of character.greetings) {
            const [{ swipe_id }] = await ctx.db.query<{ swipe_id: string }>(
              'insert into chat_message_swipes (message_id, content, created_at) values ($1, $2, clock_timestamp()) returning swipe_id',
              [message_id, greeting],
            );
            if (activeSwipeId === undefined) activeSwipeId = swipe_id;
          }
          await ctx.db.query('update chat_messages set active_swipe_id = $1 where message_id = $2', [activeSwipeId, message_id]);
        }
      }

      return { applied: true, systemText, greetingInserted };
    },
  };
}
