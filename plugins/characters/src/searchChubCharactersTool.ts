/**
 * @file plugins/characters/src/searchChubCharactersTool.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — searches chub.ai's character catalog
 * @description
 * Backs the Browse Chub screen (frontend/src/views/BrowseChubView.tsx) and gives the LLM itself a
 * way to look up a character by name mid-chat. Fetches through io/piaProxyFetch.ts's pia-proxy
 * tunnel, same as importCharacterCardFromUrlTool.ts, since chub.ai blocks Australian IPs.
 *
 * GET https://api.chub.ai/search?search=<query>&first=<pageSize>&page=<page> confirmed live
 * (2026-08-05, via a direct curl through pia-proxy) — response shape is
 * {data: {count, nodes: [{fullPath, name, tagline, avatar_url, topics, ...}]}}. Normalized down to
 * just the fields the grid needs; nodes carries far more (star counts, ratings) that nothing here
 * uses yet. `tags=<comma-separated topics>` confirmed live the same way — AND semantics (a node
 * must carry every listed topic, not any), matching chub's own site filter behavior.
 * `exclude_tags=<comma-separated topics>` confirmed live too — a node carrying any listed topic is
 * dropped.
 *
 * @api-declaration
 * createSearchChubCharactersTool(settings) — returns the search_chub_characters RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (network IO via pia-proxy)
 *     state_ownership: []
 *     external_io:     [pia-proxy (and, through it, chub.ai)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import { fetchThroughPiaProxy } from '@bigbrain/orchestrator/pia-proxy-fetch';

type OrchestratorSettingsStore = PluginDeps['settings'];

const PAGE_SIZE = 24;

interface ChubSearchNode {
  fullPath?: string;
  name?: string;
  tagline?: string;
  avatar_url?: string;
}

interface ChubSearchResponse {
  data?: { count?: number; nodes?: ChubSearchNode[] };
}

export interface ChubCharacterSummary {
  fullPath: string;
  name: string;
  tagline: string;
  avatarUrl: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((t) => typeof t === 'string');
}

function isSearchArgs(value: unknown): value is { query?: string; page?: number; tags?: string[]; excludeTags?: string[] } {
  if (typeof value !== 'object' || value === null) return true;
  const v = value as Record<string, unknown>;
  if (v.query !== undefined && typeof v.query !== 'string') return false;
  if (v.page !== undefined && (typeof v.page !== 'number' || !Number.isInteger(v.page) || v.page < 1)) return false;
  if (v.tags !== undefined && !isStringArray(v.tags)) return false;
  if (v.excludeTags !== undefined && !isStringArray(v.excludeTags)) return false;
  return true;
}

export function createSearchChubCharactersTool(settings: OrchestratorSettingsStore): RegisteredTool {
  return {
    definition: {
      name: 'search_chub_characters',
      description:
        'Search chub.ai for character cards by name/keyword and/or topic tags. Results can be imported with import_character_card_from_url.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text. Omit to browse without filtering.' },
          page: { type: 'number', description: `Page number, ${PAGE_SIZE} results per page. Defaults to 1.` },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Topic tags a result must have all of (e.g. ["Fantasy", "Romance"]). Case-sensitive, matches chub.ai\'s own topic names.',
          },
          excludeTags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Topic tags a result must have none of. Case-sensitive, matches chub.ai\'s own topic names.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      if (!isSearchArgs(args)) {
        throw new Error('search_chub_characters requires query?: string, page?: positive integer, tags?: string[], excludeTags?: string[]');
      }
      const page = args.page ?? 1;
      const params = new URLSearchParams({ first: String(PAGE_SIZE), page: String(page) });
      if (args.query) params.set('search', args.query);
      if (args.tags && args.tags.length > 0) params.set('tags', args.tags.join(','));
      if (args.excludeTags && args.excludeTags.length > 0) params.set('exclude_tags', args.excludeTags.join(','));

      const response = await fetchThroughPiaProxy(settings, `https://api.chub.ai/search?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`chub.ai search failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as ChubSearchResponse;
      const nodes = body.data?.nodes ?? [];

      const results: ChubCharacterSummary[] = nodes
        .filter((n): n is ChubSearchNode & { fullPath: string; name: string } => typeof n.fullPath === 'string' && typeof n.name === 'string')
        .map((n) => ({ fullPath: n.fullPath, name: n.name, tagline: n.tagline ?? '', avatarUrl: n.avatar_url ?? '' }));

      return { count: body.data?.count ?? results.length, page, results };
    },
  };
}
