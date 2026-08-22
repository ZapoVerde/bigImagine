/**
 * @file plugins/cards/src/importCardFromUrlTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — imports a Chub Card through pia-proxy
 * @api-declaration createImportCardFromUrlTool(settings) — returns import_card_from_url
 * @contract preserves the Chub protocol and writes only a canonical Card.
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { fetchThroughPiaProxy } from '@bigbrain/orchestrator/pia-proxy-fetch';
import { decodePngCard, parseCardJson } from './cardCodec.js';
import { insertCardFromCard } from './insertCardFromCard.js';

type Settings = PluginDeps['settings'];
interface Detail { node?: { max_res_url?: string } }

export function extractChubFullPath(input: string): string {
  const value = input.trim();
  try {
    const url = new URL(value); const marker = '/characters/'; const index = url.pathname.indexOf(marker);
    if (index < 0) throw new Error(`"${input}" is not a Chub character URL`);
    return url.pathname.slice(index + marker.length).replace(/\/+$/, '');
  } catch (error) {
    if (error instanceof Error && error.message.includes('not a Chub')) throw error;
    return value.replace(/^\/+|\/+$/g, '');
  }
}

export function createImportCardFromUrlTool(settings: Settings): RegisteredTool {
  return { definition: { name: 'import_card_from_url', description: 'Import a Card from a Chub page URL or creator/slug.', parameters: {
    type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false,
  } }, handler: async (args, ctx) => {
    const value = args as Record<string, unknown>;
    if (!value || typeof value.url !== 'string' || !value.url.trim()) throw new Error('import_card_from_url requires url: string');
    const fullPath = extractChubFullPath(value.url);
    const detail = await fetchThroughPiaProxy(settings, `https://api.chub.ai/api/characters/${fullPath}?full=true`);
    if (!detail.ok) throw new Error(`chub.ai lookup for "${fullPath}" failed with HTTP ${detail.status}`);
    const node = ((await detail.json()) as Detail).node;
    if (!node?.max_res_url) throw new Error(`chub.ai has no card PNG for "${fullPath}"`);
    const image = await fetchThroughPiaProxy(settings, node.max_res_url);
    if (!image.ok) throw new Error(`fetching ${fullPath}'s card PNG failed with HTTP ${image.status}`);
    const bytes = Buffer.from(await image.arrayBuffer());
    const sourceJson = JSON.parse(decodePngCard(bytes));
    return insertCardFromCard(ctx.db, ctx.userId, parseCardJson(sourceJson), sourceJson, ctx.embeddings, bytes);
  } };
}
