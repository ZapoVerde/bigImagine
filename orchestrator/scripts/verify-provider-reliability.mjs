// Proves io/providerReliability.ts's background sweep scheduling and server/adminServer.ts's
// parseReliabilitySweepBody — against a stub global fetch (no real, billed calls), no real
// Postgres, mirroring verify-provider-credentials.mjs's style. The core behaviors asserted:
//   * round-robin interleave (one BaseTen, then one AkashML — never all of one provider first)
//   * max one in-flight attempt per provider (a hung provider's next attempt waits for the abort)
//   * the probe request shape ({ provider: { order: [name], allow_fallbacks: false }, stream,
//     reasoning: { exclude: true } }) — exactly what pinning sends
//   * a hung provider is scored a per-request timeout and can't wedge the rest of the sweep
//   * not_found / no_provider_catalog / already_running error reasons

import { createLlmProviderForProfile } from '../dist/io/llm/index.js';
import {
  getProviderReliabilitySweep,
  startProviderReliabilitySweep,
} from '../dist/io/providerReliability.js';
import { parseReliabilitySweepBody } from '../dist/server/adminServer.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- parseReliabilitySweepBody ---
{
  assert(parseReliabilitySweepBody({}) !== undefined, 'parseReliabilitySweepBody accepts an empty body (all defaults)');
  assert(
    parseReliabilitySweepBody({ attemptsPerProvider: 5, delayMs: 1000 })?.attemptsPerProvider === 5,
    'parseReliabilitySweepBody accepts in-range attemptsPerProvider',
  );
  assert(
    parseReliabilitySweepBody({ attemptsPerProvider: 5, delayMs: 1000 })?.delayMs === 1000,
    'parseReliabilitySweepBody accepts in-range delayMs',
  );
  assert(parseReliabilitySweepBody({ attemptsPerProvider: 0 }) === undefined, 'parseReliabilitySweepBody rejects attemptsPerProvider below 1');
  assert(parseReliabilitySweepBody({ attemptsPerProvider: 11 }) === undefined, 'parseReliabilitySweepBody rejects attemptsPerProvider above 10');
  assert(parseReliabilitySweepBody({ attemptsPerProvider: 1.5 }) === undefined, 'parseReliabilitySweepBody rejects a non-integer attemptsPerProvider');
  assert(parseReliabilitySweepBody({ delayMs: 100 }) === undefined, 'parseReliabilitySweepBody rejects delayMs below 500');
  assert(parseReliabilitySweepBody({ delayMs: 12000 }) === undefined, 'parseReliabilitySweepBody rejects delayMs above 10000');
  assert(parseReliabilitySweepBody('not an object') === undefined, 'parseReliabilitySweepBody rejects a non-object body');
  assert(parseReliabilitySweepBody(null) === undefined, 'parseReliabilitySweepBody rejects null');
}

// --- The openai-compatible provider factory must expose listProviders (used by the sweep) ---
{
  const provider = createLlmProviderForProfile({
    kind: 'openai-compatible',
    model: 'test-model',
    apiKey: 'sk-test',
    baseUrl: 'https://or.example/v1',
    supportsVision: false,
  });
  assert(typeof provider.listProviders === 'function', 'an openai-compatible profile exposes listProviders (the sweep source of providers)');
}

// --- Stub global fetch: routes /endpoints to a live catalog, /chat/completions to an SSE probe ---
const events = []; // 'start:<name>' / 'end:<name>' in chronological order, for in-flight assertions
const probeCalls = [];
const router = { providers: ['A', 'B', 'C'], hangProvider: null };

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/endpoints')) {
    return new Response(
      JSON.stringify({
        data: { endpoints: router.providers.map((name) => ({ provider_name: name, tag: name.toLowerCase() })) },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (u.endsWith('/chat/completions')) {
    const body = JSON.parse(init.body);
    const name = body.provider.order[0];
    probeCalls.push({ url: u, body });
    events.push(`start:${name}`);
    if (router.hangProvider === name) {
      // a hung provider: accepts the request but never streams a byte — only the AbortController
      // fires. Proves the per-request timeout scores it and the sweep moves on without it wedging.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          events.push(`end:${name}`);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    await sleep(10);
    events.push(`end:${name}`);
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  throw new Error(`stub fetch got an unexpected URL: ${u}`);
};

// A fake LlmConnectionStore: 'missing' resolves to nothing, 'anthropic' to a kind without a
// provider catalog, everything else to the openai-compatible profile under test.
const fakeStore = {
  async resolveById(id) {
    if (id === 'missing') return undefined;
    if (id === 'anthropic') {
      return { kind: 'anthropic', model: 'claude-test', apiKey: 'sk-test', supportsVision: false };
    }
    return {
      kind: 'openai-compatible',
      model: 'test-model',
      apiKey: 'sk-test',
      baseUrl: 'https://or.example/v1',
      supportsVision: false,
    };
  },
};

async function waitForDone(id, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = getProviderReliabilitySweep(id);
    if (state && state.status === 'done') return state;
    await sleep(10);
  }
  return undefined;
}

// --- not_found ---
{
  const result = await startProviderReliabilitySweep(fakeStore, 'missing');
  assert(result.ok === false && result.reason === 'not_found', 'an unknown connection id returns not_found');
}

// --- no_provider_catalog (anthropic has no listProviders) ---
{
  const result = await startProviderReliabilitySweep(fakeStore, 'anthropic');
  assert(result.ok === false && result.reason === 'no_provider_catalog', 'a non-OpenRouter connection returns no_provider_catalog');
}

// --- fast sweep: interleave + in-flight bound + request shape + done ---
{
  events.length = 0;
  probeCalls.length = 0;
  router.providers = ['A', 'B', 'C'];
  router.hangProvider = null;

  const result = await startProviderReliabilitySweep(fakeStore, 'conn-1', { attemptsPerProvider: 2, delayMs: 1 });
  assert(result.ok === true, 'a valid connection starts a sweep');
  assert(result.ok && result.state.status === 'running', 'a fresh sweep reports status running');

  // The sweep runs in the background, so the firing order is only complete once it finishes — wait
  // for done, then read the recorded start/end events and probe bodies.
  const done = await waitForDone('conn-1');
  assert(done !== undefined, 'the sweep reaches status done');

  const startedNames = events.filter((e) => e.startsWith('start:')).map((e) => e.slice(6));
  assert(
    JSON.stringify(startedNames) === JSON.stringify(['A', 'B', 'C', 'A', 'B', 'C']),
    'attempts fire round-robin interleaved (A,B,C,A,B,C), never all of one provider first',
  );

  for (const name of ['A', 'B', 'C']) {
    const seq = events.filter((e) => e === `start:${name}` || e === `end:${name}`).join(',');
    assert(seq === `start:${name},end:${name},start:${name},end:${name}`, `provider ${name} never has two attempts in flight at once`);
  }

  const firstProbe = probeCalls[0];
  assert(firstProbe && firstProbe.url === 'https://or.example/v1/chat/completions', 'probes hit the connection baseUrl + /chat/completions');
  assert(
    JSON.stringify(firstProbe.body.provider) === JSON.stringify({ order: ['A'], allow_fallbacks: false }),
    'each probe pins exactly one provider ({ order: [name], allow_fallbacks: false }) — the request shape pinning sends',
  );
  assert(firstProbe.body.stream === true, 'probes stream (the shape that surfaces empty replies)');
  assert(firstProbe.body.reasoning?.exclude === true, 'probes send reasoning: { exclude: true }');
  assert(firstProbe.body.messages?.[0]?.role === 'system', 'probes carry the innocuous synthetic system prompt');

  assert(
    done.providers.every((p) => p.total === 2 && p.ok === 2),
    'every provider scores ok on every attempt (the stub always streams content)',
  );
  assert(done.finishedAt !== undefined, 'a finished sweep records finishedAt');
}

// --- hung provider: per-request timeout scores it, the sweep still completes, already_running ---
{
  events.length = 0;
  probeCalls.length = 0;
  router.providers = ['A', 'B', 'C', 'D'];
  router.hangProvider = 'D';

  const result = await startProviderReliabilitySweep(fakeStore, 'conn-2', {
    attemptsPerProvider: 2,
    delayMs: 1,
    requestTimeoutMs: 30,
  });
  assert(result.ok === true, 'a sweep with a hung provider starts');

  const duplicate = await startProviderReliabilitySweep(fakeStore, 'conn-2', { attemptsPerProvider: 2, delayMs: 1 });
  assert(duplicate.ok === false && duplicate.reason === 'already_running', 'starting a second sweep while one runs returns already_running');

  const done = await waitForDone('conn-2', 4000);
  assert(done !== undefined, 'the hung provider does not wedge the sweep — it still reaches done');
  const dRow = done.providers.find((p) => p.name === 'D');
  assert(dRow && dRow.total === 2 && dRow.ok === 0, 'the hung provider scores ok 0/2');
  assert(dRow && dRow.attempts.every((a) => a.note.includes('timed out')), 'the hung provider scores a per-request timeout note, not a hang');
  assert(done.providers.filter((p) => p.name !== 'D').every((p) => p.total === 2 && p.ok === 2), 'non-hung providers stay ok in the same sweep');
}

if (process.exitCode) {
  console.error('\nprovider reliability verification FAILED');
  process.exit(1);
}
console.log('\nprovider reliability verification passed');