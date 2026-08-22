/**
 * @file plugins/cards/src/cardTypes.ts
 * @stamp 2026-08-22
 * @architectural-role Pure — Card wire-shape declarations
 * @description
 * Names the canonical Card result shapes used by the Cards plugin. Runtime Character types remain
 * in the Characters domain and are not reused here.
 *
 * @api-declaration
 * CardSummaryRow, CardDetailRow — database row shapes used by Card CRUD tools
 *
 * @contract
 *   assertions:
 *     purity:          pure (types only)
 *     state_ownership: []
 *     external_io:     []
 */

export interface CardSummaryRow {
  card_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  has_avatar: boolean;
}

export interface CardDetailRow extends CardSummaryRow {
  persona: string;
  appearance: string;
  scenario: string;
  system_prompt: string;
  example_dialogue: string;
  greetings: string[];
  spec_version: 'v2' | 'v3';
  has_source_json: boolean;
}
