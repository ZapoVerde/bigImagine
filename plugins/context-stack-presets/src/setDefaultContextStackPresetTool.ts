/**
 * @file plugins/context-stack-presets/src/setDefaultContextStackPresetTool.ts
 * @stamp 2026-08-07
 * @architectural-role IO Wrapper — sets or clears the caller's default prompt-stack and/or cleanup
 *   preset
 * @description
 * Writes users.default_context_stack_preset_id (db/migrations/0061_default_context_stack_preset.sql)
 * or users.default_cleanup_preset_id (0071_default_cleanup_preset.sql), selected by the `kind`
 * argument — the preset frontend/src/views/CharactersView.tsx's startRp() auto-applies to every
 * new RP chat right after apply_character_to_chat (kind 'prompt': the prompt stack itself; kind
 * 'cleanup': the chat's cleanup_preset_id for the turn-loop cleanup pass). An omitted/empty
 * presetId clears that default back to "no default" — the same "absent means clear" shape
 * context_stack_slots' own label field uses (migration 0060, PromptStacksView.tsx's
 * `label: e.target.value || undefined`), chosen over a nullable JSON-schema type since no tool
 * definition in this codebase uses one. The two defaults are independent columns — one preset can
 * be default for both roles, or two presets can each own one.
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

export type DefaultPresetKind = 'prompt' | 'cleanup';

function isSetDefaultArgs(value: unknown): value is { presetId?: string; kind?: DefaultPresetKind } {
  if (typeof value !== 'object' || value === null) return false;
  const { presetId, kind } = value as Record<string, unknown>;
  if (presetId !== undefined && typeof presetId !== 'string') return false;
  if (kind !== undefined && kind !== 'prompt' && kind !== 'cleanup') return false;
  return true;
}

export function createSetDefaultContextStackPresetTool(): RegisteredTool {
  return {
    definition: {
      name: 'set_default_context_stack_preset',
      description:
        "Set which prompt-stack preset is this user's default, auto-applied to every new RP chat right after the character is applied. kind 'prompt' (default) is the prompt stack itself (users.default_context_stack_preset_id); kind 'cleanup' is the cleanup preset auto-applied to the chat's cleanup_preset_id (users.default_cleanup_preset_id). Omit presetId (or pass an empty string) to clear that kind's default.",
      parameters: {
        type: 'object',
        properties: {
          presetId: {
            type: 'string',
            description: 'The preset to make default. Omit to clear the default.',
          },
          kind: {
            type: 'string',
            enum: ['prompt', 'cleanup'],
            description: "Which default to set: 'prompt' (the prompt stack, default) or 'cleanup' (the cleanup preset).",
          },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isSetDefaultArgs(args)) {
        throw new Error('set_default_context_stack_preset requires an optional presetId: string and optional kind: "prompt" | "cleanup"');
      }
      const presetId = args.presetId ? args.presetId : null;
      const kind = args.kind ?? 'prompt';
      // Column comes from a closed two-value enum above — never from caller text.
      const column = kind === 'cleanup' ? 'default_cleanup_preset_id' : 'default_context_stack_preset_id';

      if (presetId !== null) {
        const visible = await ctx.db.query<{ preset_id: string }>(
          'select preset_id from context_stack_presets where preset_id = $1 and (user_id = $2 or is_builtin)',
          [presetId, ctx.userId],
        );
        if (visible.length === 0) return { set: false, reason: 'preset not found' };
      }

      await ctx.db.query(`update users set ${column} = $2 where user_id = $1`, [ctx.userId, presetId]);
      return { set: true, presetId, kind };
    },
  };
}
