/**
 * @file plugins/context-stack-presets/src/deleteContextStackPresetTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — deletes a prompt-stack preset and its slots
 * @description
 * A real delete, no soft-delete/archive concept — same as notes/lists/chat_sessions/
 * prompt_presets. context_stack_slots' `on delete cascade` on its preset_id FK means the slot
 * rows never need their own delete statement here. A builtin preset is unreachable here for the
 * same reason update_context_stack_preset can't touch one: delete_own's RLS policy only matches
 * user_id = the caller, so deleting a builtin's preset_id just returns zero rows.
 *
 * @api-declaration
 * createDeleteContextStackPresetTool() — returns the delete_context_stack_preset RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

function isDeleteArgs(value: unknown): value is { presetId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).presetId === 'string'
  );
}

export function createDeleteContextStackPresetTool(): RegisteredTool {
  return {
    definition: {
      name: 'delete_context_stack_preset',
      description: 'Delete a prompt-stack preset (and its slots) by id.',
      parameters: {
        type: 'object',
        properties: {
          presetId: { type: 'string', description: 'The preset to delete.' },
        },
        required: ['presetId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isDeleteArgs(args)) {
        throw new Error('delete_context_stack_preset requires a presetId: string argument');
      }
      const rows = await ctx.db.query<{ preset_id: string }>(
        'delete from context_stack_presets where preset_id = $1 and user_id = $2 returning preset_id',
        [args.presetId, ctx.userId],
      );
      return { deleted: rows.length > 0 };
    },
  };
}
