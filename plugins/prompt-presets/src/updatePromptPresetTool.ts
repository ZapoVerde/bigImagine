/**
 * @file plugins/prompt-presets/src/updatePromptPresetTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — renames/edits an instruction set
 * @description
 * Only the fields actually supplied are changed — same "build the SET clause from present keys"
 * approach as updateNoteTool.ts/chatSessions.ts's updateChat. Always bumps updated_at.
 *
 * @api-declaration
 * createUpdatePromptPresetTool() — returns the update_prompt_preset RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface PresetRow {
  preset_id: string;
  name: string;
  content: string;
  updated_at: string;
}

function isUpdatePresetArgs(value: unknown): value is { preset_id: string; name?: string; content?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).preset_id === 'string'
  );
}

export function createUpdatePromptPresetTool(): RegisteredTool {
  return {
    definition: {
      name: 'update_prompt_preset',
      description: "Rename and/or edit an instruction set's content. Only the fields provided are changed.",
      parameters: {
        type: 'object',
        properties: {
          preset_id: { type: 'string', description: 'The instruction set to edit.' },
          name: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['preset_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isUpdatePresetArgs(args)) {
        throw new Error('update_prompt_preset requires a preset_id: string argument');
      }
      const sets: string[] = ['updated_at = now()'];
      const params: unknown[] = [args.preset_id, ctx.userId];
      if (args.name !== undefined) {
        params.push(args.name);
        sets.push(`name = $${params.length}`);
      }
      if (args.content !== undefined) {
        params.push(args.content);
        sets.push(`content = $${params.length}`);
      }
      const [row] = await ctx.db.query<PresetRow>(
        `update prompt_presets set ${sets.join(', ')} where preset_id = $1 and user_id = $2
         returning preset_id, name, content, updated_at`,
        params,
      );
      if (!row) return { found: false, presetId: args.preset_id };
      return { found: true, presetId: row.preset_id, name: row.name, content: row.content, updatedAt: row.updated_at };
    },
  };
}
