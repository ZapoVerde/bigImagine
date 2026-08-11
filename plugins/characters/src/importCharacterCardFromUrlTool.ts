/**
 * @file plugins/characters/src/importCharacterCardFromUrlTool.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — creates a character from a chub.ai character page URL
 * @description
 * The paste-a-chub.ai-URL-in-chat import path (mirrors bigBrain's import_recipe shape) — chub.ai
 * blocks Australian IPs, so every fetch here goes through io/piaProxyFetch.ts's pia-proxy tunnel,
 * never this container's own egress.
 *
 * Confirmed live against chub.ai's real API (2026-08-05, via a direct curl through pia-proxy):
 * a character page at https://chub.ai/characters/<fullPath> is backed by
 * GET https://api.chub.ai/api/characters/<fullPath>?full=true, whose response includes
 * `max_res_url` — a PNG at that URL that is *already* a spec-compliant chara_card_v2 PNG (a real
 * `chara` tEXt chunk containing V2-shaped JSON, `data.first_mes`/`data.mes_example` and all).
 * That means chub's own bespoke `definition` field (a different, non-spec key shape —
 * `first_message`/`example_dialogs` rather than the spec's `first_mes`/`mes_example`) never needs
 * touching at all: this tool fetches the PNG and hands it to cardCodec.ts's decodePngCard +
 * parseCardJson, the exact same parsing path a locally-uploaded card PNG goes through
 * (importCharacterCardTool.ts), then inserts via the same insertCharacterFromCard.ts helper. One
 * parsing path for both import routes, not two that could quietly drift apart.
 *
 * fullPath is extracted from the URL's own path segments after `/characters/`
 * (e.g. "botmaster/0edb974b-7b04-41bc-a5c8-1c4fcd8aa27a") — chub.ai's own URL shape, confirmed live
 * by fetching that exact page through pia-proxy.
 *
 * @api-declaration
 * createImportCharacterCardFromUrlTool() — returns the import_character_card_from_url
 *   RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (network IO via pia-proxy, Postgres IO via the injected session, filesystem via avatarStorage)
 *     state_ownership: []
 *     external_io:     [pia-proxy (and, through it, chub.ai), Postgres, filesystem]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import { fetchThroughPiaProxy } from '@bigbrain/orchestrator/pia-proxy-fetch';
import { decodePngCard, parseCardJson } from './cardCodec.js';
import { insertCharacterFromCard } from './insertCharacterFromCard.js';

type OrchestratorSettingsStore = PluginDeps['settings'];

interface ChubCharacterDetail {
  name?: string;
  max_res_url?: string;
}

function isImportFromUrlArgs(value: unknown): value is { url: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.url === 'string' && v.url.trim().length > 0;
}

// Accepts either a full chub.ai page URL (https://chub.ai/characters/<fullPath>) or a bare
// fullPath (creator/slug) — the LLM sometimes has just the slug from an earlier search result,
// not a full URL, so both are useful inputs to the same tool.
export function extractChubFullPath(input: string): string {
  const trimmed = input.trim();

  let parsed: URL | undefined;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Not a URL at all — treat it as a bare fullPath.
  }
  if (!parsed) return trimmed.replace(/^\/+|\/+$/g, '');

  const marker = '/characters/';
  const idx = parsed.pathname.indexOf(marker);
  if (idx === -1) {
    throw new Error(`"${input}" doesn't look like a chub.ai character URL (expected .../characters/<creator>/<slug>)`);
  }
  return parsed.pathname.slice(idx + marker.length).replace(/\/+$/, '');
}

export function createImportCharacterCardFromUrlTool(settings: OrchestratorSettingsStore): RegisteredTool {
  return {
    definition: {
      name: 'import_character_card_from_url',
      description: 'Import a character from a chub.ai character page URL (or creator/slug fullPath).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'A chub.ai character page URL, e.g. https://chub.ai/characters/botmaster/sabrina, or a bare creator/slug.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isImportFromUrlArgs(args)) {
        throw new Error('import_character_card_from_url requires url: string');
      }
      const fullPath = extractChubFullPath(args.url);

      const detailResponse = await fetchThroughPiaProxy(settings, `https://api.chub.ai/api/characters/${fullPath}?full=true`);
      if (!detailResponse.ok) {
        throw new Error(`chub.ai lookup for "${fullPath}" failed with HTTP ${detailResponse.status}`);
      }
      const detailBody = (await detailResponse.json()) as { node?: ChubCharacterDetail; errors?: unknown };
      const node = detailBody.node;
      if (!node?.max_res_url) {
        throw new Error(`chub.ai has no card PNG for "${fullPath}" (character not found or removed)`);
      }

      const pngResponse = await fetchThroughPiaProxy(settings, node.max_res_url);
      if (!pngResponse.ok) {
        throw new Error(`fetching ${fullPath}'s card PNG failed with HTTP ${pngResponse.status}`);
      }
      const bytes = Buffer.from(await pngResponse.arrayBuffer());

      const cardJson: unknown = JSON.parse(decodePngCard(bytes));
      const parsed = parseCardJson(cardJson);

      return insertCharacterFromCard(ctx.db, ctx.userId, parsed, cardJson, ctx.embeddings, bytes);
    },
  };
}
