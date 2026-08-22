/**
 * @file plugins/cards/src/searchChubCardsTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — searches Chub's Card catalog
 * @api-declaration createSearchChubCardsTool(settings) — returns search_chub_cards
 * @contract preserves Chub search protocol while exposing Card-oriented result vocabulary.
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { fetchThroughPiaProxy } from '@bigbrain/orchestrator/pia-proxy-fetch';

type Settings = PluginDeps['settings'];
const PAGE_SIZE = 48;
const SORTS = ['download_count', 'star_count', 'rating', 'n_favorites', 'created_at', 'last_activity_at', 'n_tokens', 'trending', 'random', 'default'] as const;
type Sort = (typeof SORTS)[number];

export interface ChubCardSummary { fullPath: string; name: string; tagline: string; avatarUrl: string; starCount: number; rating: number; ratingCount: number; nChats: number; nMessages: number; nFavorites: number; nTokens: number; forksCount: number; topics: string[]; createdAt: string; lastActivityAt: string; verified: boolean; recommended: boolean; hasGallery: boolean; }

export function createSearchChubCardsTool(settings: Settings): RegisteredTool {
  return { definition: { name: 'search_chub_cards', description: 'Search Chub for reusable Cards.', parameters: {
    type: 'object', properties: { query: { type: 'string' }, page: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } }, excludeTags: { type: 'array', items: { type: 'string' } }, sort: { type: 'string', enum: [...SORTS] }, minTokens: { type: 'number' }, maxTokens: { type: 'number' }, minRating: { type: 'number' } }, additionalProperties: false,
  } }, handler: async (args) => {
    const value = (args ?? {}) as Record<string, unknown>;
    const page = value.page ?? 1;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || (value.sort !== undefined && !SORTS.includes(value.sort as Sort))) throw new Error('search_chub_cards requires a positive page and valid sort');
    const params = new URLSearchParams({ first: String(PAGE_SIZE), page: String(page), nsfw: 'true' });
    if (typeof value.query === 'string' && value.query) params.set('search', value.query);
    if (Array.isArray(value.tags) && value.tags.length) params.set('tags', (value.tags as string[]).join(','));
    if (Array.isArray(value.excludeTags) && value.excludeTags.length) params.set('exclude_tags', (value.excludeTags as string[]).join(','));
    if (value.sort) params.set('sort', value.sort as string);
    if (typeof value.minTokens === 'number') params.set('min_tokens', String(value.minTokens));
    if (typeof value.maxTokens === 'number') params.set('max_tokens', String(value.maxTokens));
    if (typeof value.minRating === 'number') params.set('min_ai_rating', String(value.minRating));
    const response = await fetchThroughPiaProxy(settings, `https://api.chub.ai/search?${params}`);
    if (!response.ok) throw new Error(`chub.ai search failed with HTTP ${response.status}`);
    const body = (await response.json()) as { data?: { count?: number; nodes?: Array<Record<string, unknown>> } };
    const results = (body.data?.nodes ?? []).filter((node) => typeof node.fullPath === 'string' && typeof node.name === 'string').map((node) => ({
      fullPath: node.fullPath as string, name: node.name as string, tagline: (node.tagline as string) ?? '', avatarUrl: (node.avatar_url as string) ?? '', starCount: (node.starCount as number) ?? 0, rating: (node.rating as number) ?? 0, ratingCount: (node.ratingCount as number) ?? 0, nChats: (node.nChats as number) ?? 0, nMessages: (node.nMessages as number) ?? 0, nFavorites: (node.n_favorites as number) ?? 0, nTokens: (node.nTokens as number) ?? 0, forksCount: (node.forksCount as number) ?? 0, topics: (node.topics as string[]) ?? [], createdAt: (node.createdAt as string) ?? '', lastActivityAt: (node.lastActivityAt as string) ?? '', verified: (node.verified as boolean) ?? false, recommended: (node.recommended as boolean) ?? false, hasGallery: (node.hasGallery as boolean) ?? false,
    }));
    return { count: body.data?.count ?? results.length, page, results };
  } };
}
