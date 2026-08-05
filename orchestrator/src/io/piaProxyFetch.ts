/**
 * @file orchestrator/src/io/piaProxyFetch.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — fetch a URL through the standalone pia-proxy container
 * @description
 * chub.ai blocks Australian IPs, so plugins/characters' chub import/search tools can't fetch it
 * directly from this container's own egress. stacks/pia-proxy (a sibling Dockge stack, not part of
 * this codebase — see its own docker-compose.yml) is a small standalone HTTP API that routes a
 * fetch through a real PIA WireGuard tunnel and streams the response straight back; this is the
 * one place that container's URL is read.
 *
 * pia_proxy_url (io/orchestratorSettings.ts) is a plain internal container address
 * (http://pia-proxy:8080), not a secret — same live-read-every-call, no-restart shape as
 * ntfy_server_url, so pointing it at a different pia-proxy deployment from the Settings tab takes
 * effect on the very next call.
 *
 * Deliberately doesn't use fetchUntrustedUrl (io/fetchUntrusted.ts)'s SSRF guard: pia_proxy_url
 * itself is admin-configured, same trust level as an LLM provider base URL, not something a chat
 * turn supplied. The `targetUrl` passed in is untrusted in general (an LLM tool call or a browser
 * query param can shape it), but every current caller builds it from a fixed host
 * (api.chub.ai/avatars.charhub.io) itself — see importCharacterCardFromUrlTool.ts and
 * searchChubCharactersTool.ts — except the one route that takes a raw url straight from the
 * browser (httpServer.ts's chub-avatar route), which guards with its own explicit host allowlist
 * before ever calling this. pia-proxy's own server.js does no SSRF filtering on its end either
 * (bi_principles.md's trust-boundary note in stacks/pia-proxy/docker-compose.yml) — this codebase
 * is the one place that matters.
 *
 * @api-declaration
 * fetchThroughPiaProxy(settings, targetUrl) — throws if pia_proxy_url is unset; otherwise fetches
 *   `${piaProxyUrl}/fetch?url=<targetUrl>` and returns the raw Response
 *
 * @contract
 *   assertions:
 *     purity:          impure (network call)
 *     state_ownership: []
 *     external_io:     [the configured pia-proxy container]
 */

import type { OrchestratorSettingsStore } from './orchestratorSettings.js';
import { fetchWithRetry } from './httpRetry.js';

export async function fetchThroughPiaProxy(settings: OrchestratorSettingsStore, targetUrl: string): Promise<Response> {
  const piaProxyUrl = await settings.get('pia_proxy_url');
  if (!piaProxyUrl) {
    throw new Error('pia_proxy_url is not configured in Settings');
  }
  return fetchWithRetry(`${piaProxyUrl}/fetch?url=${encodeURIComponent(targetUrl)}`, {});
}
