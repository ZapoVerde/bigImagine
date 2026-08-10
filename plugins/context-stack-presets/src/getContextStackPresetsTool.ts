/**
 * @file plugins/context-stack-presets/src/getContextStackPresetsTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — lists the user's own presets plus the shipped built-ins
 * @description
 * Deliberately no `where user_id = $1` here (unlike get_prompt_presets) — context_stack_presets'
 * select_own_or_builtin RLS policy already returns exactly "this caller's own rows, plus every
 * is_builtin row" on its own; adding an explicit user_id filter on top would AND against that
 * policy and hide the built-ins again, which is the one thing this tool exists to avoid.
 *
 * Two queries, not one join — presets first, then that batch's slots via `preset_id = any(...)`
 * (same pattern chatSessions.ts's chat_chunks/chat_memory_entries reads use for a batch), grouped
 * back onto their preset in JS. A join would repeat every preset column once per slot row for no
 * benefit, since slots are grouped right back into arrays either way.
 *
 * isDefault / isCleanupDefault (db/migrations/0061_default_context_stack_preset.sql and
 * 0071_default_cleanup_preset.sql) are a third, tiny query — this caller's own
 * users.default_context_stack_preset_id + users.default_cleanup_preset_id, compared against each
 * preset_id in JS — kept separate from the "presets first" query above rather than folded into it
 * as a join, since it's a pair of scalar reads against a different table, not per-row join keys.
 *
 * @api-declaration
 * createGetContextStackPresetsTool() — returns the get_context_stack_presets RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { slotRowToWire, type SlotRow } from './slotRows.js';

interface PresetRow {
  preset_id: string;
  name: string;
  is_builtin: boolean;
  updated_at: string;
}

export function createGetContextStackPresetsTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_context_stack_presets',
      description: "List the user's own prompt-stack presets plus the shipped built-in presets, each with its full ordered slot list.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: async (_args, ctx) => {
      const presetRows = await ctx.db.query<PresetRow>(
        'select preset_id, name, is_builtin, updated_at from context_stack_presets order by is_builtin desc, updated_at desc',
      );
      if (presetRows.length === 0) return [];

      const presetIds = presetRows.map((p) => p.preset_id);
      const slotRows = await ctx.db.query<SlotRow & { preset_id: string }>(
        `select preset_id, slot_type, marker_key, enabled, custom_role, custom_content, label, tag_enabled, group_name
         from context_stack_slots where preset_id = any($1) order by preset_id, position`,
        [presetIds],
      );

      const slotsByPreset = new Map<string, SlotRow[]>();
      for (const row of slotRows) {
        const existing = slotsByPreset.get(row.preset_id);
        if (existing) existing.push(row);
        else slotsByPreset.set(row.preset_id, [row]);
      }

      const [userRow] = await ctx.db.query<{
        default_context_stack_preset_id: string | null;
        default_cleanup_preset_id: string | null;
      }>('select default_context_stack_preset_id, default_cleanup_preset_id from users where user_id = $1', [ctx.userId]);
      const defaultPresetId = userRow?.default_context_stack_preset_id ?? null;
      const defaultCleanupPresetId = userRow?.default_cleanup_preset_id ?? null;

      return presetRows.map((p) => ({
        presetId: p.preset_id,
        name: p.name,
        isBuiltin: p.is_builtin,
        isDefault: p.preset_id === defaultPresetId,
        isCleanupDefault: p.preset_id === defaultCleanupPresetId,
        slots: (slotsByPreset.get(p.preset_id) ?? []).map(slotRowToWire),
        updatedAt: p.updated_at,
      }));
    },
  };
}
