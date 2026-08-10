/**
 * @file plugins/context-stack-presets/src/slotRows.ts
 * @stamp 2026-08-04
 * @architectural-role Pure Function — maps between context_stack_slots DB rows and the wire shape
 *   create/get/update pass a preset's slot array as
 * @description
 * create/get/update all move a whole preset's slots as one JSON array in/out, same "whole small
 * object at a time" shape prompt_presets uses for its own single content field (migration 0042's
 * own rationale) — so all three need the same row<->wire mapping and inbound-shape validation.
 * One shared place for that, rather than three near-copies of it.
 *
 * @api-declaration
 * SlotRow — context_stack_slots columns as returned by a `select ... order by position` or an
 *   `insert ... returning`
 * SlotInput — the wire shape a create/update tool call's `slots` array accepts
 * isSlotInputArray(value) — type guard for an inbound `slots` argument
 * slotRowToWire(row) — SlotRow -> SlotInput, for a tool's return value
 * slotInputToInsertParams(input, presetId, position) — SlotInput -> the 9 bound params
 *   context_stack_slots' insert expects, respecting its marker/custom shape check constraint
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export interface SlotRow {
  slot_type: string;
  marker_key: string | null;
  enabled: boolean;
  custom_role: string | null;
  custom_content: string | null;
  label: string | null;
  tag_enabled: boolean;
}

export interface SlotInput {
  slotType: 'marker' | 'custom';
  markerKey?: string;
  enabled?: boolean;
  customRole?: 'system' | 'user' | 'assistant';
  customContent?: string;
  /** Optional display name (migration 0060) — names the wrapper tag when tagEnabled (0085),
   *  ignored by assemblePromptStack otherwise. */
  label?: string;
  /** Migration 0085: wrap this slot's assembled content in <Friendly Name>…</Friendly Name>. */
  tagEnabled?: boolean;
}

function isValidSlotInput(value: unknown): value is SlotInput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.slotType !== 'marker' && v.slotType !== 'custom') return false;
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return false;
  if (v.label !== undefined && typeof v.label !== 'string') return false;
  if (v.tagEnabled !== undefined && typeof v.tagEnabled !== 'boolean') return false;

  if (v.slotType === 'marker') {
    return typeof v.markerKey === 'string' && v.markerKey !== '';
  }
  return (
    (v.customRole === 'system' || v.customRole === 'user' || v.customRole === 'assistant') &&
    typeof v.customContent === 'string' &&
    v.customContent !== ''
  );
}

export function isSlotInputArray(value: unknown): value is SlotInput[] {
  return Array.isArray(value) && value.length > 0 && value.every(isValidSlotInput);
}

export function slotRowToWire(row: SlotRow): SlotInput {
  const label = row.label ?? undefined;
  if (row.slot_type === 'custom') {
    return {
      slotType: 'custom',
      enabled: row.enabled,
      customRole: row.custom_role as 'system' | 'user' | 'assistant',
      customContent: row.custom_content!,
      label,
      tagEnabled: row.tag_enabled,
    };
  }
  return { slotType: 'marker', enabled: row.enabled, markerKey: row.marker_key!, label, tagEnabled: row.tag_enabled };
}

export function slotInputToInsertParams(
  input: SlotInput,
  presetId: string,
  position: number,
): [string, number, string, string | null, boolean, string | null, string | null, string | null, boolean] {
  const enabled = input.enabled ?? true;
  const label = input.label ?? null;
  const tagEnabled = input.tagEnabled ?? false;
  if (input.slotType === 'marker') {
    return [presetId, position, 'marker', input.markerKey!, enabled, null, null, label, tagEnabled];
  }
  return [presetId, position, 'custom', null, enabled, input.customRole!, input.customContent!, label, tagEnabled];
}
