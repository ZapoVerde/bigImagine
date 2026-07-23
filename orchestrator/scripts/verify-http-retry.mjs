// Proves io/httpRetry.ts actually recovers from the stale-keep-alive-socket failure we hit live
// against DeepSeek (a thrown "fetch failed" on the first attempt after an idle gap, succeeding
// immediately on retry) — and that it still fails loudly, not silently, once retries are exhausted.

import { fetchWithRetry } from '../dist/io/httpRetry.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const realFetch = globalThis.fetch;

// --- Recovers from exactly one transient failure, matching what we saw live ---
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const response = await fetchWithRetry('https://example.invalid/chat/completions', {});
  assert(calls === 2, 'a transient failure on the first attempt triggers exactly one retry');
  assert(response.status === 200, 'the retried request succeeds and its response is returned');
}

// --- Still throws if every attempt fails — no infinite/silent retrying ---
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError('fetch failed');
  };

  try {
    await fetchWithRetry('https://example.invalid/chat/completions', {}, 1);
    assert(false, 'exhausting all retries still throws rather than returning nothing');
  } catch (err) {
    assert(err instanceof TypeError, 'exhausting all retries still throws rather than returning nothing');
  }
  assert(calls === 2, 'exactly maxRetries+1 attempts were made (1 initial + 1 retry), not more');
}

// --- An HTTP error response (not a thrown error) is returned as-is, on the first attempt ---
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('bad request', { status: 400 });
  };

  const response = await fetchWithRetry('https://example.invalid/chat/completions', {});
  assert(calls === 1, 'an HTTP error status is not retried — only a thrown network-level failure is');
  assert(response.status === 400, 'the error response is passed through for the caller to handle');
}

globalThis.fetch = realFetch;

if (process.exitCode) {
  console.error('\nhttp retry verification FAILED');
  process.exit(1);
}
console.log('\nhttp retry verification passed');
