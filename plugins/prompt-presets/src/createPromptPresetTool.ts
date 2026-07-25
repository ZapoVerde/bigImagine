/**
 * @file plugins/prompt-presets/src/createPromptPresetTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — creates a reusable named system-prompt snippet
 * @description
 * A preset is a name + a block of text, nothing more — picking one later only copies its content
 * into a chat's own params.system (chat_sessions); it is never a live reference back to this row.
 *
 * @api-declaration
 * createCreatePromptPresetTool() — returns the create_prompt_preset RegisteredTool
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
}

function isCreatePresetArgs(value: unknown): value is { name: string; content: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    (value as Record<string, unknown>).name !== '' &&
    typeof (value as Record<string, unknown>).content === 'string'
  );
}

export function createCreatePromptPresetTool(): RegisteredTool {
  return {
    definition: {
      name: 'create_prompt_preset',
      description: 'Save a reusable, named system-prompt snippet ("instruction set") for later reuse across chats.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A short name for this instruction set, e.g. "Terse Assistant".' },
          content: { type: 'string', description: 'The system-prompt text.' },
        },
        required: ['name', 'content'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isCreatePresetArgs(args)) {
        throw new Error('create_prompt_preset requires name: string and content: string arguments');
      }
      const [row] = await ctx.db.query<PresetRow>(
        'insert into prompt_presets (user_id, name, content) values ($1, $2, $3) returning preset_id, name, content',
        [ctx.userId, args.name, args.content],
      );
      return { presetId: row!.preset_id, name: row!.name, content: row!.content };
    },
  };
}
