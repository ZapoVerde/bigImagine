/**
 * @file plugins/context-stack-presets/src/applyPromptStackToChatTool.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — assembles a preset's slots (plus the chat's linked character,
 *   if any) into a chat's system prompt
 * @description
 * The RP settings panel's "Apply" action (frontend/src/views/ChatView.tsx's ChatSettings): reads
 * the target chat's linked character_id (db/migrations/0049_chat_kind.sql, stamped by
 * applyCharacterToChatTool.ts) and the requested preset's ordered slots, maps the character's card
 * fields onto assemblePromptStack.ts's PromptStackFields (system/description/scenario/mes_example —
 * the four fields a character card actually has; the rest of MarkerKey has no source yet and is
 * left undefined, which the assembler already treats as "skip this slot"), then calls that pure
 * function and folds its LlmMessage[] into a single string joined with blank lines. Known v1
 * simplification: a custom slot's non-system role collapses into the system text along with
 * everything else rather than becoming its own seeded message — acceptable because system-prompt
 * text is the only thing this chat shape (ChatView, not scenes) has to write into.
 *
 * Read-merge-writes chat_sessions.params.system and prompt_stack_preset_id, the same
 * read-then-`update ... set params = $n::jsonb` shape applyCharacterToChatTool.ts uses — plugins
 * own their own SQL, never orchestrator's internal IO modules. Also seeds the character's first
 * greeting under the identical zero-messages guard that tool uses, so calling this on a chat that
 * already has messages (re-applying a different stack later) never re-seeds.
 *
 * @api-declaration
 * createApplyPromptStackToChatTool() — returns the apply_prompt_stack_to_chat RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { assemblePromptStack, type PromptStackFields, type PromptStackSlot } from './assemblePromptStack.js';
import type { SlotRow } from './slotRows.js';

interface CharacterFieldsRow {
  system_prompt: string;
  persona: string;
  scenario: string;
  example_dialogue: string;
  greetings: string[];
}

function isApplyPromptStackToChatArgs(value: unknown): value is { chatId: string; presetId: string } {
  const v = value as Record<string, unknown>;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof v.chatId === 'string' &&
    v.chatId.length > 0 &&
    typeof v.presetId === 'string' &&
    v.presetId.length > 0
  );
}

export function createApplyPromptStackToChatTool(): RegisteredTool {
  return {
    definition: {
      name: 'apply_prompt_stack_to_chat',
      description:
        "Apply a prompt-stack preset to a chat: assembles the preset's ordered slots (plus the chat's linked character, if any) into the chat's system prompt, and seeds the character's first greeting if the chat has no messages yet.",
      parameters: {
        type: 'object',
        properties: {
          chatId: { type: 'string' },
          presetId: { type: 'string' },
        },
        required: ['chatId', 'presetId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isApplyPromptStackToChatArgs(args)) {
        throw new Error('apply_prompt_stack_to_chat requires chatId: string and presetId: string');
      }

      const chatRows = await ctx.db.query<{ params: Record<string, unknown> | null; character_id: string | null }>(
        'select params, character_id from chat_sessions where chat_id = $1 and user_id = $2',
        [args.chatId, ctx.userId],
      );
      const chat = chatRows[0];
      if (!chat) return { applied: false, reason: 'chat not found' };

      const slotRows = await ctx.db.query<SlotRow>(
        `select slot_type, marker_key, enabled, custom_role, custom_content
         from context_stack_slots where preset_id = $1 order by position`,
        [args.presetId],
      );
      if (slotRows.length === 0) return { applied: false, reason: 'preset not found or has no slots' };
      // Mapped straight from SlotRow rather than via slotRowToWire: that helper's SlotInput type
      // makes `enabled` optional (a create/update call may omit it, defaulting true at the insert
      // boundary), but a row read back from the DB always has it set, and assemblePromptStack's
      // PromptStackSlot requires it non-optional.
      const slots: PromptStackSlot[] = slotRows.map((row) => ({
        slotType: row.slot_type as 'marker' | 'custom',
        markerKey: row.marker_key ?? undefined,
        enabled: row.enabled,
        customRole: (row.custom_role as 'system' | 'user' | 'assistant' | null) ?? undefined,
        customContent: row.custom_content ?? undefined,
      }));

      let character: CharacterFieldsRow | undefined;
      if (chat.character_id) {
        const characterRows = await ctx.db.query<CharacterFieldsRow>(
          'select system_prompt, persona, scenario, example_dialogue, greetings from characters where character_id = $1 and user_id = $2',
          [chat.character_id, ctx.userId],
        );
        character = characterRows[0];
      }

      const fields: PromptStackFields = character
        ? {
            system: character.system_prompt || undefined,
            description: character.persona || undefined,
            scenario: character.scenario || undefined,
            mes_example: character.example_dialogue || undefined,
          }
        : {};

      const messages = assemblePromptStack(fields, slots);
      const systemText = messages.map((m) => m.content).join('\n\n');

      const nextParams = { ...(chat.params ?? {}), system: systemText };
      await ctx.db.query(
        'update chat_sessions set params = $2::jsonb, prompt_stack_preset_id = $3, updated_at = now() where chat_id = $1',
        [args.chatId, JSON.stringify(nextParams), args.presetId],
      );

      let greetingInserted = false;
      if (character && character.greetings.length > 0) {
        const [{ count }] = await ctx.db.query<{ count: string }>(
          'select count(*)::text as count from chat_messages where chat_id = $1',
          [args.chatId],
        );
        if (count === '0') {
          await ctx.db.query(
            'insert into chat_messages (chat_id, user_id, role, content, created_at) values ($1, $2, $3, $4, clock_timestamp())',
            [args.chatId, ctx.userId, 'assistant', character.greetings[0]],
          );
          greetingInserted = true;
        }
      }

      return { applied: true, systemText, greetingInserted };
    },
  };
}
