// Proves io/embeddings/voyage.ts's request shape, in particular that embed() carries a bounded
// AbortSignal — embed() is called from inside withUserScope by several tool handlers (recall/
// search/save tools), so a hung Voyage response must not pin that transaction's connection for
// undici's default ~300s (the same class of failure as the 2026-08-17 524 incident, see
// io/piaProxyFetch.ts's matching fix and verify-pia-proxy-fetch.mjs).

import { createVoyageEmbeddingProvider } from '../dist/io/embeddings/voyage.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const realFetch = globalThis.fetch;

// --- embed() sends the correct request, with a bounded-timeout signal ---
{
  let requestedUrl;
  let requestedInit;
  globalThis.fetch = async (url, init) => {
    requestedUrl = url;
    requestedInit = init;
    return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3, 4], index: 0 }] }), { status: 200 });
  };

  const provider = createVoyageEmbeddingProvider({ apiKey: 'k', model: 'voyage-3-large', outputDimension: 4 });
  const vectors = await provider.embed(['hello']);

  assert(requestedUrl === 'https://api.voyageai.com/v1/embeddings', 'posts to the Voyage embeddings endpoint');
  assert(
    requestedInit?.signal instanceof AbortSignal && !requestedInit.signal.aborted,
    'the fetch carries an AbortSignal timeout, so a hung Voyage response times out instead of hanging',
  );
  assert(vectors.length === 1 && vectors[0][0] === 1, 'returns the parsed embedding');
}

// --- empty input never fetches at all (no request to bound) ---
{
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };
  const provider = createVoyageEmbeddingProvider({ apiKey: 'k', model: 'voyage-3-large', outputDimension: 4 });
  const vectors = await provider.embed([]);
  assert(!called && vectors.length === 0, 'empty input short-circuits without a fetch');
}

globalThis.fetch = realFetch;

if (process.exitCode) {
  console.error('\nvoyage fetch verification FAILED');
  process.exit(1);
}
console.log('\nvoyage fetch verification passed');
