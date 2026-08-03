/**
 * @file plugins/web/src/webSearchTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — the web_search RegisteredTool
 * @description
 * One general-purpose search tool covering all three current use cases (recipe discovery, code
 * pattern/docs lookup, general facts) rather than one tool per use case: Brave's query syntax
 * already supports operators (e.g. "site:github.com") the LLM can embed directly in the query
 * string, so a narrower "code search" tool would just be this same tool with a pre-baked prefix.
 * Returns raw title/url/snippet per result — no summarization here (bb_principles.md §2: the LLM
 * reasons about what the results mean, this tool only moves data). The tool description itself
 * tells the LLM to cite source url(s) in its answer, since url is otherwise easy for it to drop
 * from a paraphrased response even though it was right there in the tool result.
 *
 * No ctx.db/ctx.userId use: search results aren't household data, so no user_id scoping applies
 * (bb_principles.md §4 governs data that *is* user-owned; this has none).
 *
 * @api-declaration
 * createWebSearchTool(provider) — returns the web_search RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (delegates to the injected SearchProvider's network call)
 *     state_ownership: []
 *     external_io:     [whatever SearchProvider is given does]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import type { SearchProvider } from './braveSearchProvider.js';

interface WebSearchArgs {
  query: string;
  count?: number;
}

function isWebSearchArgs(value: unknown): value is WebSearchArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.query !== 'string' || v.query === '') return false;
  if (v.count !== undefined && typeof v.count !== 'number') return false;
  return true;
}

export function createWebSearchTool(provider: SearchProvider): RegisteredTool {
  return {
    definition: {
      name: 'web_search',
      description:
        'Search the web and return matching pages (title, url, snippet). Use for finding code ' +
        'patterns/documentation (e.g. include "site:github.com" in the query), or general facts. Does not ' +
        'fetch full page content — for a document worth ingesting, pass its url to ingest_url. ' +
        'When answering from these results, always include the source url(s) you drew on, not just a prose summary.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query. Supports operators like site:example.com.' },
          count: { type: 'number', description: 'Number of results to return (default 5, max 10).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      if (!isWebSearchArgs(args)) {
        throw new Error('web_search requires a non-empty query: string argument');
      }

      const results = await provider.search(args.query, args.count);
      return { query: args.query, results };
    },
  };
}
