// Integration test for the two pieces that make bigBrain "dynamic like ST": the plugin loader
// actually discovering and importing the real, compiled document-ingestion plugin from disk
// (not a fake), and the HTTP server round-tripping a real request through it end to end,
// including auth. LLM/embeddings are still stubs (no live network in this sandbox), but
// everything else — dynamic import, HTTP, JSON parsing, SSE framing — is exercised for real.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins } from '../dist/orchestrator/pluginLoader.js';
import { createToolRegistry } from '../dist/orchestrator/toolRegistry.js';
import { createApiKeyStore } from '../dist/server/apiKeyStore.js';
import { startHttpServer } from '../dist/server/httpServer.js';
import { createStubLlmProvider } from '../dist/io/llm/stub.js';
import { createStubEmbeddingProvider } from '../dist/io/embeddings/stub.js';
import { createPostgresClient } from '../dist/io/postgres.js';
import { createFieldCipher } from '../dist/io/fieldCipher.js';
import { CREDENTIAL_NAMES } from '../dist/io/providerCredentials.js';
import { randomBytes } from 'node:crypto';

const testCipher = createFieldCipher({ BIGBRAIN_FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') });

// A hand-rolled fake satisfying ProviderCredentialStore's shape directly — this suite is testing
// the HTTP wiring (adminServer.ts, httpServer.ts's routes/auth), not providerCredentials.ts's own
// DB logic, which verify-provider-credentials.mjs already covers against a fake pool.
function createFakeCredentialStore() {
  const values = new Map();
  return {
    setCalls: [],
    async list() {
      return CREDENTIAL_NAMES.map((name) => ({
        name,
        configured: values.has(name),
        updatedAt: values.has(name) ? '2026-01-01T00:00:00.000Z' : null,
      }));
    },
    async resolve(name) {
      return values.get(name);
    },
    async set(name, value) {
      values.set(name, value);
      this.setCalls.push({ name, value });
    },
  };
}

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakePool() {
  const inserts = [];
  return {
    inserts,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }
          if (sql.includes('insert into unstructured_notes')) {
            inserts.push({ scopedUserId, params });
            return { rows: [{ note_id: 'fake-note-id-1' }] };
          }
          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

// --- Part 1: the loader against the real plugins/ directory ---
const realPluginsDir = new URL('../../plugins', import.meta.url).pathname;
const realTools = await loadPlugins(realPluginsDir, {
  llm: createStubLlmProvider([]), // registerTools() itself makes no LLM calls, just wiring
  embeddings: createStubEmbeddingProvider(8),
  cipher: testCipher,
  notion: undefined,
});
assert(
  realTools.some((t) => t.definition.name === 'ingest_note'),
  'loadPlugins discovers and dynamically imports the real document-ingestion plugin from disk',
);

// --- Part 2: a broken plugin is skipped, not fatal ---
{
  const scratchDir = mkdtempSync(join(tmpdir(), 'bigbrain-plugin-check-'));
  const badPluginDir = join(scratchDir, 'broken-plugin', 'dist');
  mkdirSync(badPluginDir, { recursive: true });
  writeFileSync(join(badPluginDir, 'index.js'), "throw new Error('boom at import time');\n");

  const goodPluginDir = join(scratchDir, 'good-plugin', 'dist');
  mkdirSync(goodPluginDir, { recursive: true });
  writeFileSync(
    join(goodPluginDir, 'index.js'),
    "export const info = { id: 'good-plugin', name: 'Good', description: 'x' };\n" +
      'export async function registerTools() { return [{ definition: { name: "noop", description: "x", parameters: {} }, handler: async () => ({}) }]; }\n',
  );

  const tools = await loadPlugins(scratchDir, { llm: null, embeddings: null, cipher: null, notion: undefined });
  assert(
    tools.some((t) => t.definition.name === 'noop'),
    'a broken sibling plugin does not prevent a good plugin from loading',
  );
  assert(tools.length === 1, 'only the good plugin contributed tools — the broken one was skipped, not crashed past');

  rmSync(scratchDir, { recursive: true, force: true });
}

// --- Part 3: the HTTP server, end to end, including auth ---
// Two full rounds scripted per request below (one non-streaming, one streaming), sharing this
// one long-lived stub instance the same way a real server shares one LlmProvider across requests.
const llm = createStubLlmProvider([
  { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'c1', name: 'echo', arguments: { x: 1 } }] },
  { message: { role: 'assistant', content: 'final answer' }, toolCalls: [] },
  { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'c2', name: 'echo', arguments: { x: 2 } }] },
  { message: { role: 'assistant', content: 'final answer' }, toolCalls: [] },
]);
const echoTool = {
  definition: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } },
  handler: async (args) => args,
};
const pool = createFakePool();
const db = createPostgresClient(pool);
const tools = createToolRegistry([echoTool]);
const apiKeys = createApiKeyStore('good-key:11111111-1111-1111-1111-111111111111');
const credentials = createFakeCredentialStore();
const restartCalls = [];

const server = startHttpServer({
  llm,
  db,
  tools,
  apiKeys,
  adminApiKey: 'the-admin-key',
  credentials,
  modelName: 'bigbrain',
  port: 0,
  triggerRestart: () => restartCalls.push(Date.now()),
});
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const modelsRes = await fetch(`${base}/v1/models`);
const modelsBody = await modelsRes.json();
assert(modelsRes.status === 200 && modelsBody.data?.[0]?.id === 'bigbrain', 'GET /v1/models returns the bigbrain model entry');

const healthRes = await fetch(`${base}/healthz`);
assert(healthRes.status === 200, 'GET /healthz returns 200');

const noAuthRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
});
assert(noAuthRes.status === 401, 'POST /v1/chat/completions with no auth header returns 401');

const wrongKeyRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-key' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
});
assert(wrongKeyRes.status === 401, 'POST /v1/chat/completions with an unrecognized key returns 401');

const badBodyRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer good-key' },
  body: JSON.stringify({ notMessages: true }),
});
assert(badBodyRes.status === 400, 'POST /v1/chat/completions with a malformed body returns 400');

const notFoundRes = await fetch(`${base}/not/a/real/route`);
assert(notFoundRes.status === 404, 'an unknown route returns 404');

const okRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer good-key' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'please echo' }] }),
});
const okBody = await okRes.json();
assert(okRes.status === 200, 'a correctly authenticated request returns 200');
assert(okBody.object === 'chat.completion' && okBody.choices?.[0]?.message?.content === 'final answer', 'the response is OpenAI chat.completion-shaped with the loop\'s real reply');
assert(
  pool.inserts.length === 0 && true, // no insert expected for the echo tool; presence check only guards against accidental cross-test pollution
  'no unrelated DB writes happened for this request',
);

const streamRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer good-key' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'please echo' }], stream: true }),
});
const streamText = await streamRes.text();
assert(streamRes.headers.get('content-type')?.includes('text/event-stream'), 'stream:true gets an SSE content-type');
assert(streamText.includes('"content":"final answer"'), 'the SSE payload carries the final reply');
assert(streamText.trim().endsWith('data: [DONE]'), 'the SSE stream ends with the [DONE] terminator');

// --- Landing page ---
const landingRes = await fetch(`${base}/`);
const landingBody = await landingRes.text();
assert(landingRes.status === 200, 'GET / serves the landing page unauthenticated');
assert(landingBody.includes('<html') && landingBody.includes('/v1/admin'), 'the landing page links to Settings');

// --- Admin credentials routes ---
const adminPageRes = await fetch(`${base}/v1/admin`);
assert(adminPageRes.status === 200, 'GET /v1/admin serves the static page unauthenticated');
assert((await adminPageRes.text()).includes('<html'), 'GET /v1/admin returns HTML');

const listNoAuthRes = await fetch(`${base}/v1/admin/credentials`);
assert(listNoAuthRes.status === 401, 'GET /v1/admin/credentials with no auth header returns 401');

const listWrongKeyRes = await fetch(`${base}/v1/admin/credentials`, {
  headers: { authorization: 'Bearer not-the-admin-key' },
});
assert(listWrongKeyRes.status === 401, 'GET /v1/admin/credentials with the wrong key returns 401');

const listOkRes = await fetch(`${base}/v1/admin/credentials`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
const listOkBody = await listOkRes.json();
assert(listOkRes.status === 200, 'GET /v1/admin/credentials with the correct admin key returns 200');
assert(
  listOkBody.credentials.length === 4 && listOkBody.credentials.every((c) => c.configured === false),
  'GET /v1/admin/credentials returns all four names, none configured yet',
);

const setNoAuthRes = await fetch(`${base}/v1/admin/credentials`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'deepseek_api_key', value: 'sk-new' }),
});
assert(setNoAuthRes.status === 401, 'POST /v1/admin/credentials with no auth header returns 401');
assert(credentials.setCalls.length === 0, 'the unauthenticated POST never reached the credential store');

const setOkRes = await fetch(`${base}/v1/admin/credentials`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ name: 'deepseek_api_key', value: 'sk-new' }),
});
const setOkBody = await setOkRes.json();
assert(setOkRes.status === 202, 'an authenticated POST /v1/admin/credentials returns 202');
assert(setOkBody.status === 'restarting', 'the response body signals a restart is coming');
assert(
  credentials.setCalls.length === 1 && credentials.setCalls[0].name === 'deepseek_api_key' && credentials.setCalls[0].value === 'sk-new',
  'the credential store actually recorded the write',
);

await new Promise((resolve) => setTimeout(resolve, 250));
assert(restartCalls.length === 1, 'triggerRestart fired exactly once after the response flushed, instead of the real process.exit');

server.close();

// --- Part 4: dynamic model catalog + per-request model override ---
{
  const capturedOptions = [];
  const dynamicLlm = {
    name: 'fake-with-catalog',
    async complete(_messages, _tools, options) {
      capturedOptions.push(options);
      return { message: { role: 'assistant', content: 'ok' }, toolCalls: [] };
    },
    async listModels() {
      return [{ id: 'vendor/model-a' }, { id: 'vendor/model-b' }];
    },
  };
  const db2 = createPostgresClient(createFakePool());
  const apiKeys2 = createApiKeyStore('good-key-2:22222222-2222-2222-2222-222222222222');
  const server2 = startHttpServer({
    llm: dynamicLlm,
    db: db2,
    tools: createToolRegistry([]),
    apiKeys: apiKeys2,
    adminApiKey: 'unused-in-this-part',
    credentials: createFakeCredentialStore(),
    modelName: 'bigbrain',
    port: 0,
  });
  await new Promise((resolve) => server2.once('listening', resolve));
  const base2 = `http://127.0.0.1:${server2.address().port}`;

  const modelsRes2 = await fetch(`${base2}/v1/models`);
  const modelsBody2 = await modelsRes2.json();
  assert(
    modelsBody2.data.length === 2 && modelsBody2.data.some((m) => m.id === 'vendor/model-a'),
    'GET /v1/models returns the live catalog when the provider exposes listModels',
  );

  const withModelRes = await fetch(`${base2}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good-key-2' },
    body: JSON.stringify({ model: 'vendor/model-a', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const withModelBody = await withModelRes.json();
  assert(
    capturedOptions[0]?.model === 'vendor/model-a',
    'a request-specified model is passed through to llm.complete() as options.model',
  );
  assert(
    withModelBody.model === 'vendor/model-a',
    'the response echoes back the request-specified model, not the fixed modelName',
  );

  const withoutModelRes = await fetch(`${base2}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good-key-2' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  const withoutModelBody = await withoutModelRes.json();
  assert(
    capturedOptions[1]?.model === undefined,
    'omitting model in the request leaves options.model unset so the provider default applies',
  );
  assert(
    withoutModelBody.model === 'bigbrain',
    'the response falls back to the fixed modelName label when no model was requested',
  );

  server2.close();
}

if (process.exitCode) {
  console.error('\nserver verification FAILED');
  process.exit(1);
}
console.log('\nserver verification passed');
