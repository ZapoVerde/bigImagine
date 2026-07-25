/**
 * @file plugins/web/src/braveSearchProvider.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — Brave Search API access
 * @description
 * A thin SearchProvider interface in front of Brave's Web Search API, deliberately not baked
 * into webSearchTool.ts directly: swapping to a different provider (Exa, SerpAPI, ...) later
 * means writing a new adapter behind SearchProvider, not touching the tool definition or
 * orchestrator wiring — same seam shape as io/llm/types.ts's LlmProvider (bb_principles.md §6).
 *
 * Returns only title/url/snippet — no page content. This is deliberately a search tool, not a
 * fetch tool: fetching an arbitrary URL the LLM picks would need its own SSRF guard (the
 * orchestrator shares a docker network with Postgres and other internal services), which is a
 * separate, not-yet-built capability. plugins/recipes/src/importRecipeTool.ts already owns the
 * one case that needs full-page fetching (a known recipe URL); this module only ever calls
 * Brave's own API host, never a URL the LLM supplies, so it carries no SSRF surface itself.
 *
 * @api-declaration
 * SearchResult — { title, url, snippet }
 * SearchProvider — .search(query, count?) -> SearchResult[]
 * createBraveSearchProvider(apiKey) -> SearchProvider
 *
 * @contract
 *   assertions:
 *     purity:          impure (network call)
 *     state_ownership: []
 *     external_io:     [Brave Search API]
 */

import { fetchWithRetry } from '@bigbrain/orchestrator/http-retry';
import { log } from '@bigbrain/orchestrator/logger';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const MAX_COUNT = 10;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  search(query: string, count?: number): Promise<SearchResult[]>;
}

interface BraveResponse {
  web?: {
    results?: { title?: string; url?: string; description?: string }[];
  };
}

export function createBraveSearchProvider(apiKey: string): SearchProvider {
  return {
    async search(query: string, count = 5): Promise<SearchResult[]> {
      const boundedCount = Math.max(1, Math.min(count, MAX_COUNT));
      const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${boundedCount}`;

      const response = await fetchWithRetry(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      });

      if (!response.ok) {
        log.warn(`brave search: request failed with HTTP ${response.status} for query "${query}"`);
        throw new Error(`Brave Search API returned HTTP ${response.status}`);
      }

      const body = (await response.json()) as BraveResponse;
      const results = body.web?.results ?? [];
      if (results.length === 0) {
        log.info(`brave search: no results for query "${query}"`);
      }

      return results
        .filter((r): r is { title: string; url: string; description?: string } => Boolean(r.title && r.url))
        .map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? '' }));
    },
  };
}
