/**
 * @file plugins/web/src/index.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as calendar/lists/recipes): an `info`
 * object and an async `registerTools`. No startBackgroundJobs — web_search is purely a per-call
 * tool, nothing to poll.
 *
 * BIGBRAIN_BRAVE_API_KEY is a secret (docs/bb_principles.md §12: an API key grants access on its
 * own) — resolved via deps.credentials ('brave_api_key', db/migrations/0016_web_search_
 * credentials.sql), same encrypted write-only store index.ts uses for the LLM/Notion/calendar
 * keys, editable from the Settings tab rather than a .env round-trip.
 *
 * Best-effort like Notion sync and calendar ICS feeds: no key resolved (DB or env seed) means
 * registerTools returns no tools at all, rather than registering a tool that would just fail on
 * every call — the LLM never sees web_search offered if it can't actually work.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [web_search], or [] if brave_api_key isn't configured
 *
 * @contract
 *   assertions:
 *     purity:          impure (resolves a credential; constructs a tool that does network IO)
 *     state_ownership: []
 *     external_io:     [Postgres, via deps.credentials]
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { log } from '@bigbrain/orchestrator/logger';
import { createBraveSearchProvider } from './braveSearchProvider.js';
import { createWebSearchTool } from './webSearchTool.js';

export const info = {
  id: 'web',
  name: 'Web',
  description: 'General-purpose web search (Brave Search API) for recipes, code patterns, and general facts.',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  const apiKey = await deps.credentials.resolve('brave_api_key', process.env.BIGBRAIN_BRAVE_API_KEY);
  if (!apiKey) {
    log.info('web: no brave_api_key configured (Settings tab or BIGBRAIN_BRAVE_API_KEY), web_search disabled');
    return [];
  }

  return [createWebSearchTool(createBraveSearchProvider(apiKey))];
}
