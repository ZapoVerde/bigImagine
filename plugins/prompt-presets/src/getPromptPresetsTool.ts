/**
 * @file plugins/prompt-presets/src/getPromptPresetsTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — lists a user's instruction sets, full content included
 * @description
 * Unlike get_notes (which deliberately omits content for a lighter browsing payload), presets are
 * short reusable snippets — returning full content directly avoids a second round trip before the
 * chat settings pane can actually apply one.
 *
 * @api-declaration
 * createGetPromptPresetsTool() — returns the get_prompt_presets RegisteredTool
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

export function createGetPromptPresetsTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_prompt_presets',
      description: "List the user's saved instruction sets (name and content).",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: async (_args, ctx) => {
      const rows = await ctx.db.query<PresetRow>(
        'select preset_id, name, content, updated_at from prompt_presets where user_id = $1 order by updated_at desc',
        [ctx.userId],
      );
      return rows.map((r) => ({ presetId: r.preset_id, name: r.name, content: r.content, updatedAt: r.updated_at }));
    },
  };
}
