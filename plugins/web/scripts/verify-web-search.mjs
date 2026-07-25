// Proves the web plugin end to end through info/registerTools (the real loader contract), plus
// braveSearchProvider.ts's request/response shape directly against a stubbed global fetch — same
// approach as plugins/calendar's verify-calendar.mjs for its ICS-sync fetch path. No Postgres
// involved: this plugin touches no table, only deps.credentials.

import { info, registerTools } from '../dist/index.js';
import { createBraveSearchProvider } from '../dist/braveSearchProvider.js';
import { createWebSearchTool } from '../dist/webSearchTool.js';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

assert(
  info.id === 'web' && /^[a-z0-9_-]+$/.test(info.id),
  'info.id is present and matches the id format pluginLoader.ts requires',
);

// --- registerTools is best-effort: no brave_api_key resolved means no tools registered ---
{
  const fakeCredentials = { async resolve() { return undefined; } };
  const fakeSettings = { async get() { return undefined; } };
  const originalEnvKey = process.env.BIGBRAIN_BRAVE_API_KEY;
  delete process.env.BIGBRAIN_BRAVE_API_KEY;
  try {
    const tools = await registerTools({ credentials: fakeCredentials, settings: fakeSettings });
    assert(tools.length === 0, 'registerTools returns no tools when brave_api_key is unconfigured');
  } finally {
    if (originalEnvKey === undefined) delete process.env.BIGBRAIN_BRAVE_API_KEY;
    else process.env.BIGBRAIN_BRAVE_API_KEY = originalEnvKey;
  }
}

// --- registerTools resolves the key through deps.credentials (not raw env) and registers web_search ---
{
  const resolveCalls = [];
  const fakeCredentials = {
    async resolve(name, envFallback) {
      resolveCalls.push({ name, envFallback });
      return 'fake-brave-key';
    },
  };
  const tools = await registerTools({ credentials: fakeCredentials, settings: { async get() { return undefined; } } });
  assert(tools.length === 1, 'registerTools returns exactly one tool when brave_api_key resolves');
  assert(
    resolveCalls.some((c) => c.name === 'brave_api_key'),
    'registerTools resolves brave_api_key through deps.credentials, not process.env directly',
  );

  const registry = createToolRegistry(tools);
  assert(registry.definitions().some((d) => d.name === 'web_search'), 'web_search is registered');
}

// --- braveSearchProvider: request shape and response parsing ---
{
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  let capturedHeaders;
  globalThis.fetch = async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init?.headers;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          web: {
            results: [
              { title: 'Real Recipe', url: 'https://example.com/recipe', description: 'A tasty recipe.' },
              { title: 'No URL here' }, // missing url — must be filtered out
            ],
          },
        };
      },
    };
  };
  try {
    const provider = createBraveSearchProvider('fake-brave-key');
    const results = await provider.search('chicken tikka masala', 100); // count over MAX_COUNT

    assert(capturedUrl.includes('q=chicken%20tikka%20masala') || capturedUrl.includes('q=chicken+tikka+masala'), 'the query is URL-encoded into the request');
    assert(capturedUrl.includes('count=10'), 'count is capped at MAX_COUNT (10) even when a caller asks for more');
    assert(capturedHeaders['X-Subscription-Token'] === 'fake-brave-key', 'the API key is sent as X-Subscription-Token');

    assert(results.length === 1, 'a result missing url/title is filtered out');
    assert(
      results[0].title === 'Real Recipe' && results[0].url === 'https://example.com/recipe' && results[0].snippet === 'A tasty recipe.',
      'a well-formed result is mapped to {title, url, snippet}',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- braveSearchProvider: a non-ok HTTP response throws rather than returning empty results silently ---
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, async json() { return {}; } });
  try {
    const provider = createBraveSearchProvider('fake-brave-key');
    let threw = false;
    try {
      await provider.search('anything');
    } catch {
      threw = true;
    }
    assert(threw, 'a non-ok HTTP response throws instead of returning an empty/misleading result');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- webSearchTool: handler validation and pass-through shape ---
{
  const stubProvider = { async search(query, count) { return [{ title: 't', url: 'u', snippet: 's' }]; } };
  const tool = createWebSearchTool(stubProvider);

  let threw = false;
  try {
    await tool.handler({}, { userId: 'x', db: undefined });
  } catch {
    threw = true;
  }
  assert(threw, 'web_search requires a non-empty query argument');

  const result = await tool.handler({ query: 'test query' }, { userId: 'x', db: undefined });
  assert(result.query === 'test query' && result.results.length === 1, 'web_search returns the query and provider results untouched');
}
