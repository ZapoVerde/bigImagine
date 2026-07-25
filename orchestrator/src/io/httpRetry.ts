/**
 * @file orchestrator/src/io/httpRetry.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — resilient fetch for long-lived outbound HTTP
 * @description
 * Node's built-in fetch (undici) keeps idle keep-alive sockets in a pool inside a long-running
 * process; a socket that goes stale between infrequent requests — exactly bigBrain's traffic
 * pattern, chat messages arrive minutes apart, not back-to-back — can fail on reuse with a bare
 * `TypeError: fetch failed` before any request ever reaches the remote server. Confirmed live
 * against DeepSeek: an isolated fresh-process fetch succeeds immediately every time, but the
 * long-running orchestrator process hit this repeatedly in one session, always after a
 * multi-minute idle gap, always recovering instantly on a second attempt — a stale-socket-reuse
 * bug, not a real network or vendor problem.
 *
 * Retrying is safe here specifically because a thrown fetch error means the request never
 * produced a response — nothing downstream (Postgres writes, the classification pipeline) runs
 * until complete()/listModels() returns successfully, so a retried LLM call can at worst waste
 * one duplicate API call, never a duplicate DB write.
 *
 * retryOnFailure is the general shape underneath fetchWithRetry, pulled out so
 * fetchUntrusted.ts's DNS lookup — a thrown-error-prone step ahead of the fetch itself, not the
 * fetch — can retry on the same policy instead of duplicating the loop. Confirmed live: a
 * transient `getaddrinfo EAI_AGAIN` on that lookup and a bare Voyage `fetch failed` both resolved
 * on a plain retry with no code change, same class of problem as the stale-socket case above.
 *
 * @api-declaration
 * retryOnFailure(label, fn, maxRetries = 1) — retries only a thrown failure, logging each attempt
 *   under `label`; the last error is rethrown once retries are exhausted
 * fetchWithRetry(url, init, maxRetries = 1) — retries only a thrown (network-level) failure,
 *   never an HTTP error status (4xx/5xx); those are real responses the caller must handle itself
 *
 * @contract
 *   assertions:
 *     purity:          impure (network call)
 *     state_ownership: []
 *     external_io:     [whatever URL the caller passes]
 */

import { log } from './logger.js';

export async function retryOnFailure<T>(label: string, fn: () => Promise<T>, maxRetries = 1): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const willRetry = attempt < maxRetries;
      log.warn(
        `${label} failed (attempt ${attempt + 1}/${maxRetries + 1})${willRetry ? ', retrying' : ', giving up'}`,
        err,
      );
    }
  }
  throw lastError;
}

export function fetchWithRetry(url: string, init: RequestInit, maxRetries = 1): Promise<Response> {
  return retryOnFailure(`fetch to ${url} — likely a stale keep-alive socket, see io/httpRetry.ts`, () => fetch(url, init), maxRetries);
}
