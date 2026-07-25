// Proves io/fetchUntrusted.ts actually stops a fetch to a private/reserved address before any
// request goes out, and that it stays out of the way for an ordinary public URL. Uses the
// injectable resolveHost seam (same pattern as verify-date-context.mjs's injectable `now`) rather
// than faking node:dns itself.

import { fetchUntrustedUrl } from '../dist/io/fetchUntrusted.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const realFetch = globalThis.fetch;

// --- A hostname resolving to a public address is fetched normally ---
{
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('ok', { status: 200 });
  };

  const resolveHost = async () => [{ address: '93.184.216.34' }];
  const response = await fetchUntrustedUrl('https://example.invalid/recipe', {}, 1, resolveHost);
  assert(fetchCalled, 'a public-resolving hostname reaches the real fetch');
  assert(response.status === 200, 'the real response is returned unchanged');
}

// --- A hostname resolving to a private address is refused before fetch runs ---
{
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('should never get here', { status: 200 });
  };

  const resolveHost = async () => [{ address: '169.254.169.254' }];
  try {
    await fetchUntrustedUrl('https://example.invalid/recipe', {}, 1, resolveHost);
    assert(false, 'a hostname resolving to the cloud metadata address throws instead of fetching');
  } catch {
    assert(true, 'a hostname resolving to the cloud metadata address throws instead of fetching');
  }
  assert(!fetchCalled, 'fetch() is never called once a resolved address is blocked');
}

// --- One blocked address among several resolved addresses is enough to refuse ---
{
  globalThis.fetch = async () => new Response('should never get here', { status: 200 });

  const resolveHost = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];
  try {
    await fetchUntrustedUrl('https://example.invalid/recipe', {}, 1, resolveHost);
    assert(false, 'a mix of public and private resolved addresses still refuses the fetch');
  } catch {
    assert(true, 'a mix of public and private resolved addresses still refuses the fetch');
  }
}

// --- A non-http(s) protocol is refused before any DNS resolution happens ---
{
  let resolveCalled = false;
  const resolveHost = async () => {
    resolveCalled = true;
    return [{ address: '93.184.216.34' }];
  };

  try {
    await fetchUntrustedUrl('file:///etc/passwd', {}, 1, resolveHost);
    assert(false, 'a non-http(s) URL throws before resolving or fetching');
  } catch {
    assert(true, 'a non-http(s) URL throws before resolving or fetching');
  }
  assert(!resolveCalled, 'DNS resolution never runs for a non-http(s) protocol');
}

globalThis.fetch = realFetch;

if (process.exitCode) {
  console.error('\nfetch-untrusted verification FAILED');
  process.exit(1);
}
console.log('\nfetch-untrusted verification passed');
