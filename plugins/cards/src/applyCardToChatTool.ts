/**
 * @file plugins/cards/src/applyCardToChatTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — applies Card source material to a chat
 * @description Reads the canonical Card, stamps chat_sessions.card_id, and preserves the existing
 * zero-message greeting/swipe behavior without creating runtime Characters or memberships.
 * @api-declaration createApplyCardToChatTool() — returns apply_card_to_chat
 * @contract writes cards/chat_sessions/chat_messages/swipes only; never characters or links.
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface CardRow {
  name: string;
  persona: string;
  scenario: string;
  system_prompt: string;
  example_dialogue: string;
  greetings: string[];
}

function isArgs(value: unknown): value is { cardId: string; chatId: string } {
  const v = value as Record<string, unknown>;
  return typeof value === 'object' && value !== null && typeof v.cardId === 'string' && v.cardId.length > 0
    && typeof v.chatId === 'string' && v.chatId.length > 0;
}

function composeSystemText(card: CardRow): string {
  return [
    ['System Prompt', card.system_prompt],
    ['Persona', card.persona],
    ['Scenario', card.scenario],
    ['Example Dialogue', card.example_dialogue],
  ].filter(([, content]) => content.trim().length > 0)
    .map(([label, content]) => `## ${label}\n${content.trim()}`)
    .join('\n\n');
}

export function createApplyCardToChatTool(): RegisteredTool {
  return {
    definition: {
      name: 'apply_card_to_chat',
      description: 'Apply a Card to a chat and seed its opening greeting without creating a runtime Character.',
      parameters: {
        type: 'object',
        properties: { cardId: { type: 'string' }, chatId: { type: 'string' } },
        required: ['cardId', 'chatId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isArgs(args)) throw new Error('apply_card_to_chat requires cardId: string and chatId: string');
      const [card] = await ctx.db.query<CardRow>(
        'select name, persona, scenario, system_prompt, example_dialogue, greetings from cards where card_id = $1 and user_id = $2',
        [args.cardId, ctx.userId],
      );
      if (!card) return { applied: false, reason: 'card not found' };
      const [chat] = await ctx.db.query<{ params: Record<string, unknown> | null }>(
        'select params from chat_sessions where chat_id = $1 and user_id = $2', [args.chatId, ctx.userId]);
      if (!chat) return { applied: false, reason: 'chat not found' };

      const systemText = composeSystemText(card);
      await ctx.db.query(
        'update chat_sessions set params = $2::jsonb, card_id = $3, updated_at = now() where chat_id = $1 and user_id = $4',
        [args.chatId, JSON.stringify({ ...(chat.params ?? {}), system: systemText }), args.cardId, ctx.userId],
      );
      const [{ count }] = await ctx.db.query<{ count: string }>(
        'select count(*)::text as count from chat_messages where chat_id = $1 and user_id = $2', [args.chatId, ctx.userId]);
      let greetingInserted = false;
      if (count === '0' && card.greetings.length > 0) {
        const [{ message_id: messageId }] = await ctx.db.query<{ message_id: string }>(
          'insert into chat_messages (chat_id, user_id, role, content, created_at) values ($1, $2, $3, $4, clock_timestamp()) returning message_id',
          [args.chatId, ctx.userId, 'assistant', card.greetings[0]],
        );
        greetingInserted = true;
        if (card.greetings.length > 1) {
          let activeSwipeId: string | undefined;
          for (const greeting of card.greetings) {
            const [{ swipe_id: swipeId }] = await ctx.db.query<{ swipe_id: string }>(
              'insert into chat_message_swipes (message_id, content, created_at) values ($1, $2, clock_timestamp()) returning swipe_id',
              [messageId, greeting],
            );
            activeSwipeId ??= swipeId;
          }
          await ctx.db.query('update chat_messages set active_swipe_id = $1 where message_id = $2', [activeSwipeId, messageId]);
        }
      }
      return { applied: true, systemText, greetingInserted };
    },
  };
}
