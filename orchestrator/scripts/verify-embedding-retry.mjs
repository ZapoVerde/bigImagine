// Proves io/embeddings/retry.ts — the vector-LLM twin of llmGate.ts's retry loop. A retryable
// failure (a thrown transport error like `TypeError: fetch failed`, or an HTTP 429/5xx parsed
// from the adapter's message) is retried up to llm_gate_max_retries times with bounded backoff,
// so a transient stale-socket or vendor blip on an embed call never fails the caller's whole
// recall. A non-retryable failure (a real 4xx — bad key/model) passes straight through without
// retry, since retrying would just re-burn the same refusal. The same llm_gate_* settings keys
// govern both providers, so one knob tunes every LLM + vector call.
//
// The base provider is scripted per test (like verify-llm-gate.mjs's createFakeBase), and the
// settings store is a fake, so this runs offline — no Voyage key, no network.

import { createRetryingEmbeddingProvider } from '../dist/io/embeddings/retry.js';
import { createStubEmbeddingProvider } from '../dist/io/embeddings/stub.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakeSettings(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

function createScriptedBase(turns) {
  let i = 0;
  return {
    name: 'scripted',
    dimension: 4,
    async embed(texts) {
      const next = turns[i++];
      if (next === undefined) throw new Error('scripted base provider called more times than scripted');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

// --- a retryable transport throw is retried and succeeds on the next attempt ---
{
  const settings = createFakeSettings({ llm_gate_max_retries: '2' });
  const base = createScriptedBase([
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
    [[1, 2, 3, 4]],
  ]);
  const wrapped = createRetryingEmbeddingProvider(base, settings);
  const vectors = await wrapped.embed(['hello']);
  assert(vectors.length === 1 && vectors[0][0] === 1, 'a retryable transport failure is retried and the call succeeds');
  assert(wrapped.name === 'scripted' && wrapped.dimension === 4, 'the wrapper preserves name and dimension');
}

// --- an HTTP 429 is retryable (parsed from the adapter-style message) ---
{
  const settings = createFakeSettings({ llm_gate_max_retries: '1' });
  const base = createScriptedBase([new Error('Voyage AI API error 429: rate limited'), [[0, 0, 0, 0]]]);
  const wrapped = createRetryingEmbeddingProvider(base, settings);
  const vectors = await wrapped.embed(['x']);
  assert(vectors.length === 1, 'a 429 response is retried once then succeeds');
}

// --- a 5xx is retryable ---
{
  const settings = createFakeSettings({ llm_gate_max_retries: '1' });
  const base = createScriptedBase([new Error('Voyage AI API error 503: overloaded'), [[0, 0, 0, 0]]]);
  const wrapped = createRetryingEmbeddingProvider(base, settings);
  const vectors = await wrapped.embed(['x']);
  assert(vectors.length === 1, 'a 503 response is retried once then succeeds');
}

// --- a 4xx (bad key/model) is NOT retried — passes straight through ---
{
  const settings = createFakeSettings({ llm_gate_max_retries: '3' });
  const base = createScriptedBase([new Error('Voyage AI API error 401: Provided API key is invalid.')]);
  const wrapped = createRetryingEmbeddingProvider(base, settings);
  let threw = false;
  try {
    await wrapped.embed(['x']);
  } catch (err) {
    threw = err.message.includes('401');
  }
  assert(threw, 'a 401 is not retried — the refusal propagates immediately');
}

// --- a dimension-mismatch response (permanent config error) is NOT retried, even though its
// "256-dim" digit could be misparsed as a status without the response-shape exclusion ---
{
  const settings = createFakeSettings({ llm_gate_max_retries: '3' });
  const base = createScriptedBase([
    new Error('Voyage AI returned a 256-dim embedding but output_dimension=2048 was requested — model "voyage-4-large" may not support that dimension'),
  ]);
  const wrapped = createRetryingEmbeddingProvider(base, settings);
  let threw = false;
  try {
    await wrapped.embed(['x']);
  } catch (err) {
    threw = err.message.includes('256-dim');
  }
  assert(threw, 'a dimension-mismatch response is not retried — it propagates immediately');
}

// --- retries exhausted -> the last error propagates ---
{
  const settings = createFakeSettings({ llm_gate_max_retries: '2' });
  const fail = new TypeError('fetch failed');
  const base = createScriptedBase([fail, fail, fail]);
  const wrapped = createRetryingEmbeddingProvider(base, settings);
  let threw = false;
  try {
    await wrapped.embed(['x']);
  } catch (err) {
    threw = err === fail;
  }
  assert(threw, 'after llm_gate_max_retries + 1 attempts the last error propagates');
}

// --- default settings fall back to llmGate's defaults (2 retries) ---
{
  const settings = createFakeSettings({});
  const fail = new TypeError('fetch failed');
  const base = createScriptedBase([fail, fail, [[5, 5, 5, 5]]]);
  const wrapped = createRetryingEmbeddingProvider(base, settings);
  const vectors = await wrapped.embed(['x']);
  assert(vectors[0][0] === 5, 'with no settings set, the default of 2 retries is used and the 3rd attempt succeeds');
}

// --- corrupt (non-numeric) settings fall back to defaults instead of NaN ---
{
  const settings = createFakeSettings({ llm_gate_max_retries: 'abc', llm_gate_retry_base_ms: 'xyz', llm_gate_retry_max_ms: '' });
  const fail = new TypeError('fetch failed');
  const base = createScriptedBase([fail, fail, [[7, 7, 7, 7]]]);
  const wrapped = createRetryingEmbeddingProvider(base, settings);
  const vectors = await wrapped.embed(['x']);
  assert(vectors[0][0] === 7, 'corrupt settings fall back to the default of 2 retries (3 attempts total)');
}

// --- a clean first call is never re-invoked (no spurious retries) ---
{
  const settings = createFakeSettings({ llm_gate_max_retries: '2' });
  const base = createScriptedBase([[[9, 9, 9, 9]]]);
  const wrapped = createRetryingEmbeddingProvider(base, settings);
  const vectors = await wrapped.embed(['x']);
  assert(vectors[0][0] === 9, 'a successful first attempt returns without any extra calls');
}

// --- empty input passes through untouched (the voyage adapter short-circuits; so must we) ---
{
  const settings = createFakeSettings({});
  const base = createStubEmbeddingProvider(8);
  const wrapped = createRetryingEmbeddingProvider(base, settings);
  const vectors = await wrapped.embed([]);
  assert(Array.isArray(vectors) && vectors.length === 0, 'empty input embeds to an empty array through the wrapper');
}
