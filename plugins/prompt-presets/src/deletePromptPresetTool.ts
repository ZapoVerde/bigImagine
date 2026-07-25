/**
 * @file plugins/prompt-presets/src/deletePromptPresetTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — deletes an instruction set
 * @description
 * A real delete, no soft-delete/archive concept — same as notes/lists/chat_sessions. Deleting a
 * preset never affects any chat that already copied its content into params.system.
 *
 * @api-declaration
 * createDeletePromptPresetTool() — returns the delete_prompt_preset RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

function isDeletePresetArgs(value: unknown): value is { preset_id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).preset_id === 'string'
  );
}

export function createDeletePromptPresetTool(): RegisteredTool {
  return {
    definition: {
      name: 'delete_prompt_preset',
      description: 'Delete an instruction set by id.',
      parameters: {
        type: 'object',
        properties: {
          preset_id: { type: 'string', description: 'The instruction set to delete.' },
        },
        required: ['preset_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isDeletePresetArgs(args)) {
        throw new Error('delete_prompt_preset requires a preset_id: string argument');
      }
      const rows = await ctx.db.query<{ preset_id: string }>(
        'delete from prompt_presets where preset_id = $1 and user_id = $2 returning preset_id',
        [args.preset_id, ctx.userId],
      );
      return { deleted: rows.length > 0 };
    },
  };
}
