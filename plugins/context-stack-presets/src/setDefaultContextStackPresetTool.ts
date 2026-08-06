/**
 * @file plugins/context-stack-presets/src/setDefaultContextStackPresetTool.ts
 * @stamp 2026-08-06
 * @architectural-role IO Wrapper — sets or clears the caller's default prompt-stack preset
 * @description
 * Writes users.default_context_stack_preset_id (db/migrations/0061_default_context_stack_preset.sql)
 * — the preset frontend/src/views/CharactersView.tsx's startRp() auto-applies to every new RP chat
 * right after apply_character_to_chat. An omitted/empty presetId clears it back to "no default"
 * (startRp then falls back to today's behavior — no prompt stack applied at creation) — the same
 * "absent means clear" shape context_stack_slots' own label field uses (migration 0060,
 * PromptStacksView.tsx's `label: e.target.value || undefined`), chosen over a nullable JSON-schema
 * type since no tool definition in this codebase uses one.
 *
 * Explicitly re-checks visibility (own row or is_builtin) before writing, the same "own or builtin"
 * shape context_stack_presets' select_own_or_builtin RLS policy already enforces on read — users
 * has no RLS of its own (0002's own comment), so this filter is the only thing standing between a
 * caller and setting their default to a preset_id that isn't actually theirs to see.
 *
 * @api-declaration
 * createSetDefaultContextStackPresetTool() — returns the set_default_context_stack_preset RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

function isSetDefaultArgs(value: unknown): value is { presetId?: string } {
  if (typeof value !== 'object' || value === null) return false;
  const presetId = (value as Record<string, unknown>).presetId;
  return presetId === undefined || typeof presetId === 'string';
}

export function createSetDefaultContextStackPresetTool(): RegisteredTool {
  return {
    definition: {
      name: 'set_default_context_stack_preset',
      description:
        "Set which prompt-stack preset is this user's default, auto-applied to every new RP chat right after the character is applied. Omit presetId (or pass an empty string) to clear the default.",
      parameters: {
        type: 'object',
        properties: {
          presetId: {
            type: 'string',
            description: 'The preset to make default. Omit to clear the default.',
          },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isSetDefaultArgs(args)) {
        throw new Error('set_default_context_stack_preset requires an optional presetId: string');
      }
      const presetId = args.presetId ? args.presetId : null;

      if (presetId !== null) {
        const visible = await ctx.db.query<{ preset_id: string }>(
          'select preset_id from context_stack_presets where preset_id = $1 and (user_id = $2 or is_builtin)',
          [presetId, ctx.userId],
        );
        if (visible.length === 0) return { set: false, reason: 'preset not found' };
      }

      await ctx.db.query('update users set default_context_stack_preset_id = $2 where user_id = $1', [ctx.userId, presetId]);
      return { set: true, presetId };
    },
  };
}
