// Proves io/piaProxyFetch.ts's two contracts: it throws a clear error when pia_proxy_url isn't
// configured (rather than fetching nothing or crashing obscurely), and when it is configured, it
// builds the correct /fetch?url= request against the configured pia-proxy address.

import { fetchThroughPiaProxy } from '../dist/io/piaProxyFetch.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function fakeSettings(value) {
  return { get: async (key) => (key === 'pia_proxy_url' ? value : undefined), set: async () => {} };
}

const realFetch = globalThis.fetch;

// --- Throws when unset, rather than silently fetching nothing ---
{
  try {
    await fetchThroughPiaProxy(fakeSettings(undefined), 'https://api.chub.ai/search?search=x');
    assert(false, 'throws when pia_proxy_url is unset');
  } catch (err) {
    assert(err instanceof Error && err.message.includes('pia_proxy_url'), 'throws a clear error when pia_proxy_url is unset');
  }
}

// --- Builds the correct request URL when configured ---
{
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const target = 'https://api.chub.ai/search?search=sabrina&first=3';
  const response = await fetchThroughPiaProxy(fakeSettings('http://pia-proxy:8080'), target);

  assert(
    requestedUrl === `http://pia-proxy:8080/fetch?url=${encodeURIComponent(target)}`,
    'constructs the correct pia-proxy /fetch?url= request, with the target URL encoded',
  );
  assert(response.status === 200, 'returns the raw Response from pia-proxy');
}

globalThis.fetch = realFetch;

if (process.exitCode) {
  console.error('\npia-proxy fetch verification FAILED');
  process.exit(1);
}
console.log('\npia-proxy fetch verification passed');
