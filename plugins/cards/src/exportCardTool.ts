/**
 * @file plugins/cards/src/exportCardTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — exports Card source JSON and Card-owned media
 * @api-declaration createExportCardTool() — returns export_card
 * @contract reads cards and Card media only; source_json is preferred verbatim.
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { buildCardJson, encodePngCard } from './cardCodec.js';
import { readCardMedia } from './cardMediaStorage.js';

const PLACEHOLDER_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'card';

export function createExportCardTool(): RegisteredTool {
  return { definition: { name: 'export_card', description: 'Export a reusable Card as PNG or JSON.', parameters: {
    type: 'object', properties: { cardId: { type: 'string' }, format: { type: 'string', enum: ['png', 'json'] } },
    required: ['cardId', 'format'], additionalProperties: false,
  } }, handler: async (args, ctx) => {
    const value = args as Record<string, unknown>;
    if (!value || typeof value.cardId !== 'string' || !['png', 'json'].includes(value.format as string)) throw new Error('export_card requires cardId and format');
    const rows = await ctx.db.query<any>(`select name, persona, scenario, system_prompt, example_dialogue, greetings, source_json, avatar_path is not null as has_avatar from cards where card_id = $1 and user_id = $2`, [value.cardId, ctx.userId]);
    const row = rows[0]; if (!row) return { found: false, cardId: value.cardId };
    const json = row.source_json ?? buildCardJson({ name: row.name, persona: row.persona, scenario: row.scenario, systemPrompt: row.system_prompt, exampleDialogue: row.example_dialogue, greetings: row.greetings });
    if (value.format === 'json') return { found: true, format: 'json', filename: `${slugify(row.name)}.json`, json };
    const png = encodePngCard((row.has_avatar ? await readCardMedia(value.cardId) : null) ?? PLACEHOLDER_PNG, JSON.stringify(json));
    return { found: true, format: 'png', filename: `${slugify(row.name)}.png`, mimeType: 'image/png', base64: png.toString('base64') };
  } };
}
