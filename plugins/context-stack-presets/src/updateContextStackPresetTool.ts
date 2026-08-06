/**
 * @file plugins/context-stack-presets/src/updateContextStackPresetTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — renames and/or reorders a prompt-stack preset's slots
 * @description
 * Only the fields actually supplied are changed — same "build the SET clause from present keys"
 * approach as updatePromptPresetTool.ts/chatSessions.ts's updateChat. When slots is supplied, the
 * whole array is replaced (delete-then-reinsert, same convention saveDocument.ts uses for
 * document_chunks) rather than diffed, since slot count/order/content can all shift between edits
 * of the same preset and a partial-slot-update shape would need its own separate identity for
 * slots (there isn't one worth exposing — slot_id is never returned to a caller).
 *
 * A builtin preset is unreachable here without any special-case code: context_stack_presets'
 * update_own RLS policy only matches rows where user_id = the caller, so an attempt to edit a
 * builtin (owned by the fixed system user) simply returns zero rows — same "not found" result a
 * caller gets for an id that doesn't exist at all, and the same reasoning delete_own on
 * context_stack_slots gives the delete-then-reinsert step below.
 *
 * @api-declaration
 * createUpdateContextStackPresetTool() — returns the update_context_stack_preset RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { isSlotInputArray, slotInputToInsertParams, slotRowToWire, type SlotInput, type SlotRow } from './slotRows.js';

interface PresetRow {
  preset_id: string;
  name: string;
  is_builtin: boolean;
  updated_at: string;
}

function isUpdateArgs(value: unknown): value is { presetId: string; name?: string; slots?: SlotInput[] } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.presetId !== 'string' || v.presetId === '') return false;
  if (v.name !== undefined && typeof v.name !== 'string') return false;
  if (v.slots !== undefined && !isSlotInputArray(v.slots)) return false;
  return true;
}

export function createUpdateContextStackPresetTool(): RegisteredTool {
  return {
    definition: {
      name: 'update_context_stack_preset',
      description: "Rename a prompt-stack preset and/or replace its ordered slots. Only the fields provided are changed.",
      parameters: {
        type: 'object',
        properties: {
          presetId: { type: 'string', description: 'The preset to edit.' },
          name: { type: 'string' },
          slots: {
            type: 'array',
            description: 'If provided, replaces the entire ordered slots list.',
            items: {
              type: 'object',
              properties: {
                slotType: { type: 'string', enum: ['marker', 'custom'] },
                markerKey: { type: 'string' },
                enabled: { type: 'boolean' },
                customRole: { type: 'string', enum: ['system', 'user', 'assistant'] },
                customContent: { type: 'string' },
                label: { type: 'string', description: 'Optional display name for this slot. Cosmetic only.' },
              },
              required: ['slotType'],
              additionalProperties: false,
            },
          },
        },
        required: ['presetId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isUpdateArgs(args)) {
        throw new Error('update_context_stack_preset requires a presetId: string argument');
      }

      const sets: string[] = ['updated_at = now()'];
      const params: unknown[] = [args.presetId, ctx.userId];
      if (args.name !== undefined) {
        params.push(args.name);
        sets.push(`name = $${params.length}`);
      }
      const [presetRow] = await ctx.db.query<PresetRow>(
        `update context_stack_presets set ${sets.join(', ')} where preset_id = $1 and user_id = $2
         returning preset_id, name, is_builtin, updated_at`,
        params,
      );
      if (!presetRow) return { found: false, presetId: args.presetId };

      let slotRows: SlotRow[];
      if (args.slots !== undefined) {
        await ctx.db.query('delete from context_stack_slots where preset_id = $1', [args.presetId]);
        slotRows = [];
        for (const [position, slot] of args.slots.entries()) {
          const [row] = await ctx.db.query<SlotRow>(
            `insert into context_stack_slots (preset_id, position, slot_type, marker_key, enabled, custom_role, custom_content, label)
             values ($1, $2, $3, $4, $5, $6, $7, $8)
             returning slot_type, marker_key, enabled, custom_role, custom_content, label`,
            slotInputToInsertParams(slot, args.presetId, position),
          );
          slotRows.push(row!);
        }
      } else {
        slotRows = await ctx.db.query<SlotRow>(
          `select slot_type, marker_key, enabled, custom_role, custom_content, label
           from context_stack_slots where preset_id = $1 order by position`,
          [args.presetId],
        );
      }

      return {
        found: true,
        presetId: presetRow.preset_id,
        name: presetRow.name,
        isBuiltin: presetRow.is_builtin,
        slots: slotRows.map(slotRowToWire),
        updatedAt: presetRow.updated_at,
      };
    },
  };
}
