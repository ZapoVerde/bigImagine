/**
 * @file plugins/context-stack-presets/src/createContextStackPresetTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — creates a named, ordered prompt-stack preset
 * @description
 * A preset is a name plus its whole ordered slots array — moved as one JSON payload in/out, same
 * "whole small object at a time" shape prompt_presets uses for its own single content field
 * (migration 0042's own rationale). is_builtin is never accepted as an argument: it always
 * defaults to false at the DB layer, and context_stack_presets' insert_own RLS policy would
 * reject an insert under any other user_id anyway — this tool just never gives an LLM caller a
 * parameter that could even suggest otherwise.
 *
 * @api-declaration
 * createCreateContextStackPresetTool() — returns the create_context_stack_preset RegisteredTool
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

function isCreateArgs(value: unknown): value is { name: string; slots: SlotInput[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    (value as Record<string, unknown>).name !== '' &&
    isSlotInputArray((value as Record<string, unknown>).slots)
  );
}

export function createCreateContextStackPresetTool(): RegisteredTool {
  return {
    definition: {
      name: 'create_context_stack_preset',
      description:
        'Save a named, ordered prompt-stack preset: which context slots (character-card fields plus custom blocks) go into an assembled turn, and in what order.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A short name for this preset, e.g. "Lore-Heavy".' },
          slots: {
            type: 'array',
            description: 'The ordered list of slots this preset assembles, first to last.',
            items: {
              type: 'object',
              properties: {
                slotType: { type: 'string', enum: ['marker', 'custom'] },
                markerKey: {
                  type: 'string',
                  description:
                    'Required when slotType is "marker": which field to inject, e.g. "description", "scenario", "recent_history".',
                },
                enabled: { type: 'boolean', description: 'Defaults to true.' },
                customRole: { type: 'string', enum: ['system', 'user', 'assistant'], description: 'Required when slotType is "custom".' },
                customContent: { type: 'string', description: 'Required when slotType is "custom": the static text for this block.' },
                label: { type: 'string', description: 'Optional display name for this slot, e.g. "Earthy Physicality". Cosmetic only.' },
              },
              required: ['slotType'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'slots'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isCreateArgs(args)) {
        throw new Error('create_context_stack_preset requires name: string and a non-empty slots: array argument');
      }
      const [presetRow] = await ctx.db.query<PresetRow>(
        'insert into context_stack_presets (user_id, name) values ($1, $2) returning preset_id, name, is_builtin, updated_at',
        [ctx.userId, args.name],
      );

      const slotRows: SlotRow[] = [];
      for (const [position, slot] of args.slots.entries()) {
        const [row] = await ctx.db.query<SlotRow>(
          `insert into context_stack_slots (preset_id, position, slot_type, marker_key, enabled, custom_role, custom_content, label)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning slot_type, marker_key, enabled, custom_role, custom_content, label`,
          slotInputToInsertParams(slot, presetRow!.preset_id, position),
        );
        slotRows.push(row!);
      }

      return {
        presetId: presetRow!.preset_id,
        name: presetRow!.name,
        isBuiltin: presetRow!.is_builtin,
        slots: slotRows.map(slotRowToWire),
        updatedAt: presetRow!.updated_at,
      };
    },
  };
}
