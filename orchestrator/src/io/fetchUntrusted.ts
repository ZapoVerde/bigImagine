/**
 * @file orchestrator/src/io/fetchUntrusted.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — SSRF-guarded fetch for URLs that did not come from admin config
 * @description
 * Wraps httpRetry.ts's fetchWithRetry for the one fetch target in the platform that isn't
 * something the deployer configured (an admin-set Notion token, calendar feed, or LLM provider
 * base URL) but something a chat turn supplied — import_recipe's `url` argument, reachable from
 * the LLM's own tool call and therefore from a prompt-injected page as easily as from the
 * household member who started the conversation. Resolves the hostname via DNS itself and checks
 * every resolved address against util/ssrfGuard.ts before the real fetch runs, so a hostname that
 * resolves to a container on the same Docker network, a loopback service, or a cloud metadata
 * endpoint (169.254.169.254) is rejected before any request reaches it — the URL's string form
 * alone can't be trusted, since DNS decides where a hostname actually points.
 *
 * Every other fetchWithRetry caller (Notion, Google Calendar, the LLM providers, ICS calendar
 * feeds, weather/search) stays unguarded on purpose: those destinations are admin-configured, and
 * some homelab deployments legitimately point an LLM provider or calendar feed at another
 * container on the same private network — this guard would break a deliberate setup, not stop an
 * attacker, if applied there.
 *
 * Does not pin the fetch to the resolved address (no Host-header rewriting): fetch() re-resolves
 * the hostname itself, so in principle DNS could answer differently the second time (rebinding).
 * Accepted for now — this defends against an opportunistic prompt-injected URL, not a targeted
 * attacker who controls DNS for a domain they get the model to fetch, and pinning needs a custom
 * fetch dispatcher that's a bigger change than this warrants today.
 *
 * The DNS lookup itself (not just the fetch fetchWithRetry already covers) turned out to be a
 * second, separate spot a transient failure (`getaddrinfo EAI_AGAIN`) can surface — same class of
 * problem httpRetry.ts's stale-socket case describes, just one step earlier. Retried on the same
 * policy via httpRetry.ts's retryOnFailure rather than a second copy of that loop.
 *
 * @api-declaration
 * fetchUntrustedUrl(url, init, maxRetries?, resolveHost?) — same contract as http-retry's
 *   fetchWithRetry, but throws before ever calling fetch() if the URL's protocol isn't http/https
 *   or any address its host resolves to is loopback/private/link-local/reserved. resolveHost is
 *   injectable (defaults to a real DNS lookup) for deterministic verification, same seam as
 *   util/dateContext.ts's `now` parameter.
 *
 * @contract
 *   assertions:
 *     purity:          impure (DNS resolution, network fetch)
 *     state_ownership: []
 *     external_io:     [DNS, whatever URL the caller passes]
 */

import { lookup } from 'node:dns/promises';
import { fetchWithRetry, retryOnFailure } from './httpRetry.js';
import { log } from './logger.js';
import { isBlockedAddress } from '../util/ssrfGuard.js';

type ResolveHost = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultResolveHost: ResolveHost = (hostname) => lookup(hostname, { all: true, verbatim: true });

export async function fetchUntrustedUrl(
  url: string,
  init: RequestInit,
  maxRetries = 1,
  resolveHost: ResolveHost = defaultResolveHost,
): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`fetchUntrustedUrl: refusing non-http(s) protocol "${parsed.protocol}" for ${url}`);
  }

  const records = await retryOnFailure(`DNS lookup for ${parsed.hostname}`, () => resolveHost(parsed.hostname), maxRetries);
  const blocked = records.find((record) => isBlockedAddress(record.address));
  if (blocked) {
    log.warn(`fetchUntrustedUrl: refusing ${url} — ${parsed.hostname} resolves to ${blocked.address}, a private/reserved address`);
    throw new Error(`fetchUntrustedUrl: refusing to fetch ${url} — resolves to a private or reserved address`);
  }

  return fetchWithRetry(url, init, maxRetries);
}
