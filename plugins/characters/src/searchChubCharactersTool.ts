/**
 * @file plugins/characters/src/searchChubCharactersTool.ts
 * @stamp 2026-08-06
 * @architectural-role IO Wrapper — searches chub.ai's character catalog
 * @description
 * Backs the Browse Chub screen (frontend/src/views/BrowseChubView.tsx) and gives the LLM itself a
 * way to look up a character by name mid-chat. Fetches through io/piaProxyFetch.ts's pia-proxy
 * tunnel, same as importCharacterCardFromUrlTool.ts, since chub.ai blocks Australian IPs.
 *
 * GET https://api.chub.ai/search?search=<query>&first=<pageSize>&page=<page> confirmed live
 * (2026-08-05, via a direct curl through pia-proxy) — response shape is
 * {data: {count, nodes: [{fullPath, name, tagline, avatar_url, topics, ...}]}}.
 * `tags=<comma-separated topics>` confirmed live the same way — AND semantics (a node must carry
 * every listed topic, not any), matching chub's own site filter behavior. `exclude_tags` confirmed
 * live too — a node carrying any listed topic is dropped.
 *
 * Full node stats confirmed live (2026-08-06, via curl through pia-proxy): starCount, rating,
 * ratingCount, nChats, nMessages, n_favorites, nTokens, forksCount, topics, createdAt,
 * lastActivityAt, verified, recommended, hasGallery. All normalized onto the summary now.
 *
 * `sort` confirmed live the same way — an invalid value 400s with the full enum, which is where
 * CHUB_SORT_VALUES below comes from (trimmed to the subset meaningful as a UI sort choice).
 * `min_tokens`/`max_tokens` confirmed live as a real range filter (min_tokens=999999 dropped a
 * ~35k-result set to 6). `min_ai_rating` confirmed live too, but integer-only (a float value 400s).
 * By contrast, min_downloads/min_favorites/min_star_count/min_created_at/created_after/
 * min_last_activity_at/exclude_topics are all silently ignored — chub has no server-side range
 * filter for downloads, favorites, chats, messages, or dates; only `sort` touches those, and there
 * is no date-range filter at all (only sort=created_at / sort=last_activity_at). The frontend
 * handles those cases as a client-side trim over an already-fetched page instead.
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

// Must match BrowseChubView.tsx's own PAGE_SIZE — the tool doesn't echo it back in its response,
// so this is the one place that constant is duplicated rather than shared (no shared
// frontend/backend module exists to hold it).
const PAGE_SIZE = 48;

// The subset of chub's real `sort` enum (confirmed via a 400's error body, see file preamble)
// that's a meaningful UI sort choice. Single source of truth, reused in both isSearchArgs and the
// tool's JSON-schema enum — same convention as plugins/notes/src/updateNoteTool.ts's VALID_STATES.
const CHUB_SORT_VALUES = [
  'download_count', 'star_count', 'rating', 'n_favorites', 'created_at',
  'last_activity_at', 'n_tokens', 'trending', 'random', 'default',
] as const;
type ChubSort = (typeof CHUB_SORT_VALUES)[number];

interface ChubSearchNode {
  fullPath?: string;
  name?: string;
  tagline?: string;
  avatar_url?: string;
  starCount?: number;
  rating?: number;
  ratingCount?: number;
  nChats?: number;
  nMessages?: number;
  n_favorites?: number;
  nTokens?: number;
  forksCount?: number;
  topics?: string[];
  createdAt?: string;
  lastActivityAt?: string;
  verified?: boolean;
  recommended?: boolean;
  hasGallery?: boolean;
}

interface ChubSearchResponse {
  data?: { count?: number; nodes?: ChubSearchNode[] };
}

export interface ChubCharacterSummary {
  fullPath: string;
  name: string;
  tagline: string;
  avatarUrl: string;
  starCount: number;
  rating: number;
  ratingCount: number;
  nChats: number;
  nMessages: number;
  nFavorites: number;
  nTokens: number;
  forksCount: number;
  topics: string[];
  createdAt: string;
  lastActivityAt: string;
  verified: boolean;
  recommended: boolean;
  hasGallery: boolean;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((t) => typeof t === 'string');
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

interface SearchArgs {
  query?: string;
  page?: number;
  tags?: string[];
  excludeTags?: string[];
  sort?: ChubSort;
  minTokens?: number;
  maxTokens?: number;
  minRating?: number;
}

function isSearchArgs(value: unknown): value is SearchArgs {
  if (typeof value !== 'object' || value === null) return true;
  const v = value as Record<string, unknown>;
  if (v.query !== undefined && typeof v.query !== 'string') return false;
  if (v.page !== undefined && !isPositiveInt(v.page)) return false;
  if (v.tags !== undefined && !isStringArray(v.tags)) return false;
  if (v.excludeTags !== undefined && !isStringArray(v.excludeTags)) return false;
  if (v.sort !== undefined && !(CHUB_SORT_VALUES as readonly string[]).includes(v.sort as string)) return false;
  if (v.minTokens !== undefined && !isPositiveInt(v.minTokens)) return false;
  if (v.maxTokens !== undefined && !isPositiveInt(v.maxTokens)) return false;
  if (v.minRating !== undefined && !isPositiveInt(v.minRating)) return false;
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
          sort: {
            type: 'string',
            enum: CHUB_SORT_VALUES as unknown as string[],
            description: 'How to order results. Defaults to chub.ai\'s own default ordering.',
          },
          minTokens: { type: 'number', description: 'Only include cards with at least this many definition tokens.' },
          maxTokens: { type: 'number', description: 'Only include cards with at most this many definition tokens.' },
          minRating: { type: 'number', description: 'Only include cards with at least this average rating (integer, chub.ai only accepts whole numbers).' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      if (!isSearchArgs(args)) {
        throw new Error(
          'search_chub_characters requires query?: string, page?: positive integer, tags?: string[], excludeTags?: string[], ' +
            `sort?: one of ${CHUB_SORT_VALUES.join('|')}, minTokens?/maxTokens?/minRating?: positive integer`,
        );
      }
      const page = args.page ?? 1;
      const params = new URLSearchParams({ first: String(PAGE_SIZE), page: String(page) });
      if (args.query) params.set('search', args.query);
      if (args.tags && args.tags.length > 0) params.set('tags', args.tags.join(','));
      if (args.excludeTags && args.excludeTags.length > 0) params.set('exclude_tags', args.excludeTags.join(','));
      if (args.sort) params.set('sort', args.sort);
      if (args.minTokens !== undefined) params.set('min_tokens', String(args.minTokens));
      if (args.maxTokens !== undefined) params.set('max_tokens', String(args.maxTokens));
      if (args.minRating !== undefined) params.set('min_ai_rating', String(args.minRating));

      const response = await fetchThroughPiaProxy(settings, `https://api.chub.ai/search?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`chub.ai search failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as ChubSearchResponse;
      const nodes = body.data?.nodes ?? [];

      const results: ChubCharacterSummary[] = nodes
        .filter((n): n is ChubSearchNode & { fullPath: string; name: string } => typeof n.fullPath === 'string' && typeof n.name === 'string')
        .map((n) => ({
          fullPath: n.fullPath,
          name: n.name,
          tagline: n.tagline ?? '',
          avatarUrl: n.avatar_url ?? '',
          starCount: n.starCount ?? 0,
          rating: n.rating ?? 0,
          ratingCount: n.ratingCount ?? 0,
          nChats: n.nChats ?? 0,
          nMessages: n.nMessages ?? 0,
          nFavorites: n.n_favorites ?? 0,
          nTokens: n.nTokens ?? 0,
          forksCount: n.forksCount ?? 0,
          topics: n.topics ?? [],
          createdAt: n.createdAt ?? '',
          lastActivityAt: n.lastActivityAt ?? '',
          verified: n.verified ?? false,
          recommended: n.recommended ?? false,
          hasGallery: n.hasGallery ?? false,
        }));

      return { count: body.data?.count ?? results.length, page, results };
    },
  };
}
