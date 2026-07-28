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

// handleAdminSettingsGet falls back to this when the fake settings store has no row yet — set
// deterministically rather than relying on whatever happens to be in the test process's env.
process.env.BIGBRAIN_LLM_ACTIVE_PROFILE = 'deepseek';

// Real LlmProfile shapes (not fakes) — handleAdminSettingsModels builds a real adapter
// (createLlmProviderForProfile) around whichever one it's asked about, so these need real-shaped
// baseUrls for the mocked-fetch model-catalog test further down to intercept.
const llmProfiles = {
  deepseek: {
    kind: 'openai-compatible',
    model: 'deepseek-v4-flash',
    apiKey: 'sk-test-deepseek',
    baseUrl: 'https://example.invalid/deepseek',
  },
  openrouter: {
    kind: 'openai-compatible',
    model: 'google/gemini-3.5-flash-lite',
    apiKey: 'sk-test-openrouter',
    baseUrl: 'https://example.invalid/openrouter',
  },
};

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

// A hand-rolled fake satisfying OrchestratorSettingsStore's shape directly — this suite is testing
// the HTTP wiring (adminServer.ts, httpServer.ts's routes/auth), not orchestratorSettings.ts's own
// DB logic.
function createFakeSettingsStore() {
  const values = new Map();
  return {
    setCalls: [],
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
      this.setCalls.push({ key, value });
    },
  };
}

// A hand-rolled fake satisfying AccessIdentityResolver's shape directly — this suite is testing
// httpServer.ts's own auth-path wiring (Access-header-first, Bearer-key fallback), not
// accessIdentity.ts's real JWT/JWKS verification, which verify-access-identity.mjs already covers
// against a real local JWKS endpoint and real signatures.
function createFakeAccessIdentityResolver() {
  const calls = [];
  return {
    calls,
    async userIdForAccessJwt(jwt) {
      calls.push(jwt);
      return jwt === 'valid-access-jwt' ? '33333333-3333-3333-3333-333333333333' : undefined;
    },
  };
}

// A hand-rolled fake satisfying ChatSessionStore's shape directly — this suite is testing
// httpServer.ts's own route wiring and the chat_id persistence hook, not chatSessions.ts's real
// SQL, which verify-chat-sessions.mjs already covers against a fake pool.
function createFakeChatSessionStore() {
  const sessions = new Map();
  const messagesByChat = new Map();
  const folders = new Map();
  let counter = 0;
  const newId = (prefix) => `${prefix}-${++counter}`;

  return {
    sessions,
    async listChats(userId, opts = {}) {
      let rows = [...sessions.values()].filter((s) => s.userId === userId);
      if (opts.search) {
        const q = opts.search.toLowerCase();
        rows = rows.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            (messagesByChat.get(s.chatId) ?? []).some((m) => m.content.toLowerCase().includes(q)),
        );
      }
      if (opts.folderId) rows = rows.filter((s) => s.folderId === opts.folderId);
      return rows
        .map((s) => ({ chatId: s.chatId, title: s.title, folderId: s.folderId, updatedAt: s.updatedAt }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async createChat(userId, init = {}) {
      const chatId = newId('chat');
      const row = {
        chatId,
        userId,
        title: init.title ?? 'New chat',
        folderId: init.folderId ?? null,
        params: {},
        toolNames: null,
        canvasNoteId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sessions.set(chatId, row);
      messagesByChat.set(chatId, []);
      return row;
    },
    async getChat(userId, chatId) {
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return undefined;
      return { session: row, messages: messagesByChat.get(chatId) ?? [] };
    },
    async updateChat(userId, chatId, patch) {
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return undefined;
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.folderId !== undefined) row.folderId = patch.folderId;
      if (patch.params !== undefined) row.params = patch.params;
      if (patch.toolNames !== undefined) row.toolNames = patch.toolNames;
      if (patch.canvasNoteId !== undefined) row.canvasNoteId = patch.canvasNoteId;
      row.updatedAt = new Date().toISOString();
      return row;
    },
    async deleteChat(userId, chatId) {
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return false;
      sessions.delete(chatId);
      messagesByChat.delete(chatId);
      return true;
    },
    async appendMessages(userId, chatId, messages) {
      const arr = messagesByChat.get(chatId) ?? [];
      // A monotonic counter, not wall-clock time — two messages appended in the same call (or
      // the same millisecond) must still sort deterministically, the exact real-Postgres bug
      // clock_timestamp() fixed in chatSessions.ts itself (see appendMessages there).
      for (const m of messages) arr.push({ messageId: newId('msg'), role: m.role, content: m.content, createdAt: ++counter });
      messagesByChat.set(chatId, arr);
      const row = sessions.get(chatId);
      if (row) row.updatedAt = new Date().toISOString();
    },
    async deleteMessage(userId, chatId, messageId) {
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return false;
      const arr = messagesByChat.get(chatId) ?? [];
      const idx = arr.findIndex((m) => m.messageId === messageId);
      if (idx === -1) return false;
      arr.splice(idx, 1);
      return true;
    },
    async truncateMessagesFrom(userId, chatId, messageId) {
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return false;
      const arr = messagesByChat.get(chatId) ?? [];
      const target = arr.find((m) => m.messageId === messageId);
      if (!target) return false;
      messagesByChat.set(
        chatId,
        arr.filter((m) => m.createdAt < target.createdAt),
      );
      return true;
    },
    async listFolders(userId) {
      return [...folders.values()].filter((f) => f.userId === userId);
    },
    async createFolder(userId, init) {
      const folderId = newId('folder');
      const row = { folderId, userId, name: init.name, parentId: init.parentId ?? null };
      folders.set(folderId, row);
      return row;
    },
    async updateFolder(userId, folderId, patch) {
      const row = folders.get(folderId);
      if (!row || row.userId !== userId) return undefined;
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.parentId !== undefined) row.parentId = patch.parentId;
      return row;
    },
    async deleteFolder(userId, folderId) {
      const row = folders.get(folderId);
      if (!row || row.userId !== userId) return false;
      folders.delete(folderId);
      for (const s of sessions.values()) if (s.folderId === folderId) s.folderId = null;
      return true;
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
// startBackgroundJobs: false — this only tests loadPlugins/registerTools discovery, not
// background-job behavior. Without it, temporal/calendar's real setInterval pollers would run
// against createFakePool() forever (it only recognizes a few query shapes), throwing on every
// tick and keeping the process alive indefinitely instead of letting this script finish.
const realPluginsDir = new URL('../../plugins', import.meta.url).pathname;
const realTools = await loadPlugins(
  realPluginsDir,
  {
    llm: createStubLlmProvider([]), // registerTools() itself makes no LLM calls, just wiring
    embeddings: createStubEmbeddingProvider(8),
    cipher: testCipher,
    notion: undefined,
    db: createPostgresClient(createFakePool()),
    credentials: createFakeCredentialStore(),
    settings: createFakeSettingsStore(),
  },
  { startBackgroundJobs: false },
);
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
// One full round (tool call + final answer) scripted per request that reaches runTurn below —
// two for the original non-streaming/streaming pair, two more for the Cloudflare-Access-auth
// requests added alongside them — sharing this one long-lived stub instance the same way a real
// server shares one LlmProvider across requests.
const llm = createStubLlmProvider([
  { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'c1', name: 'echo', arguments: { x: 1 } }] },
  { message: { role: 'assistant', content: 'final answer' }, toolCalls: [] },
  { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'c2', name: 'echo', arguments: { x: 2 } }] },
  { message: { role: 'assistant', content: 'final answer' }, toolCalls: [] },
  { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'c3', name: 'echo', arguments: { x: 3 } }] },
  { message: { role: 'assistant', content: 'final answer' }, toolCalls: [] },
  { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'c4', name: 'echo', arguments: { x: 4 } }] },
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
const settings = createFakeSettingsStore();
const accessIdentity = createFakeAccessIdentityResolver();
const chats = createFakeChatSessionStore();
const restartCalls = [];

const server = startHttpServer({
  llm,
  db,
  tools,
  apiKeys,
  accessIdentity,
  chats,
  adminApiKey: 'the-admin-key',
  credentials,
  settings,
  llmProfiles,
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

// --- Cloudflare Access identity takes priority over, and can substitute for, a Bearer key ---
const accessNoKeyRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': 'valid-access-jwt' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'please echo' }] }),
});
assert(accessNoKeyRes.status === 200, 'a valid Cf-Access-Jwt-Assertion header authenticates with no Bearer key at all');
assert(accessIdentity.calls.includes('valid-access-jwt'), 'the Access header was actually passed to the resolver');

const accessInvalidFallsThroughRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'cf-access-jwt-assertion': 'not-a-real-jwt',
    authorization: 'Bearer good-key',
  },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'please echo' }] }),
});
assert(
  accessInvalidFallsThroughRes.status === 200,
  'an unresolvable Access header falls through to the Bearer key instead of hard-failing',
);

const whoamiNoAuthRes = await fetch(`${base}/v1/whoami`);
assert(whoamiNoAuthRes.status === 401, 'GET /v1/whoami with no auth at all returns 401');

const whoamiKeyRes = await fetch(`${base}/v1/whoami`, { headers: { authorization: 'Bearer good-key' } });
const whoamiKeyBody = await whoamiKeyRes.json();
assert(whoamiKeyRes.status === 200 && whoamiKeyBody.userId === '11111111-1111-1111-1111-111111111111', 'GET /v1/whoami resolves via a Bearer key');

const whoamiAccessRes = await fetch(`${base}/v1/whoami`, { headers: { 'cf-access-jwt-assertion': 'valid-access-jwt' } });
const whoamiAccessBody = await whoamiAccessRes.json();
assert(
  whoamiAccessRes.status === 200 && whoamiAccessBody.userId === '33333333-3333-3333-3333-333333333333',
  'GET /v1/whoami resolves via a Cloudflare Access identity with no key at all',
);

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

// --- Frontend SPA static serving (frontend/dist, built by `npm run build --workspace=@bigbrain/frontend`) ---
const rootRes = await fetch(`${base}/`);
const rootBody = await rootRes.text();
assert(rootRes.status === 200, 'GET / serves the built frontend SPA unauthenticated');
assert(rootRes.headers.get('content-type')?.includes('text/html'), 'GET / returns text/html');
assert(rootBody.includes('<div id="root">'), 'GET / serves the SPA shell (index.html)');

// index.html references its real, content-hashed built assets — fetch whatever it actually
// references rather than hardcoding a filename that changes every build.
const assetPaths = [...new Set(rootBody.match(/\/assets\/[^"']+/g) ?? [])];
assert(assetPaths.length > 0, 'the built index.html references at least one /assets/ file');
for (const assetPath of assetPaths) {
  const assetRes = await fetch(`${base}${assetPath}`);
  const expectedType = assetPath.endsWith('.css') ? 'text/css' : 'application/javascript';
  assert(assetRes.status === 200, `GET ${assetPath} returns 200`);
  assert(assetRes.headers.get('content-type')?.includes(expectedType), `GET ${assetPath} has content-type ${expectedType}`);
}

const missingAssetRes = await fetch(`${base}/assets/does-not-exist.js`);
assert(missingAssetRes.status === 404, 'GET /assets/<missing file> returns 404');

const traversalRes = await fetch(`${base}/assets/..%2f..%2fpackage.json`);
assert(traversalRes.status === 404, 'GET /assets/<path traversal attempt> is rejected, not served');

// --- Admin credentials routes ---

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
  listOkBody.credentials.length === CREDENTIAL_NAMES.length && listOkBody.credentials.every((c) => c.configured === false),
  'GET /v1/admin/credentials returns every credential name, none configured yet',
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

// --- Admin settings routes (connection picker) ---

const settingsNoAuthRes = await fetch(`${base}/v1/admin/settings`);
assert(settingsNoAuthRes.status === 401, 'GET /v1/admin/settings with no auth header returns 401');

const settingsGetRes = await fetch(`${base}/v1/admin/settings`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
const settingsGetBody = await settingsGetRes.json();
assert(settingsGetRes.status === 200, 'GET /v1/admin/settings with the correct admin key returns 200');
assert(
  settingsGetBody.activeProfile === 'deepseek' &&
    settingsGetBody.activeModel === 'deepseek-v4-flash' &&
    JSON.stringify(settingsGetBody.profileNames) === JSON.stringify(['deepseek', 'openrouter']),
  'GET /v1/admin/settings falls back to the env active profile and its static model before anything has been saved, and lists every known profile',
);
assert(
  Array.isArray(settingsGetBody.visionCapableProfiles) && settingsGetBody.visionCapableProfiles.length === 0,
  'GET /v1/admin/settings reports no vision-capable profiles before anything has been saved',
);

const settingsSetNoAuthRes = await fetch(`${base}/v1/admin/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ value: 'openrouter' }),
});
assert(settingsSetNoAuthRes.status === 401, 'POST /v1/admin/settings with no auth header returns 401');
assert(settings.setCalls.length === 0, 'the unauthenticated POST never reached the settings store');

const settingsSetBadNameRes = await fetch(`${base}/v1/admin/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ value: 'not-a-real-profile' }),
});
assert(settingsSetBadNameRes.status === 400, 'POST /v1/admin/settings rejects a profile name that is not a known profile');

const settingsSetBadModelRes = await fetch(`${base}/v1/admin/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ value: 'openrouter', model: '' }),
});
assert(settingsSetBadModelRes.status === 400, 'POST /v1/admin/settings rejects an empty-string model');

const settingsSetOkRes = await fetch(`${base}/v1/admin/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ value: 'openrouter', model: 'anthropic/claude-4' }),
});
const settingsSetOkBody = await settingsSetOkRes.json();
assert(settingsSetOkRes.status === 202, 'an authenticated POST /v1/admin/settings with a known profile and model returns 202');
assert(settingsSetOkBody.status === 'restarting', 'the response body signals a restart is coming');
assert(
  settings.setCalls.length === 2 &&
    settings.setCalls[0].key === 'active_llm_profile' &&
    settings.setCalls[0].value === 'openrouter' &&
    settings.setCalls[1].key === 'active_llm_model' &&
    settings.setCalls[1].value === 'anthropic/claude-4',
  'the settings store recorded both the profile and model writes, in that order',
);

await new Promise((resolve) => setTimeout(resolve, 250));
assert(restartCalls.length === 2, 'triggerRestart fired again after the settings save flushed');

const settingsGetAfterSaveRes = await fetch(`${base}/v1/admin/settings`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
const settingsGetAfterSaveBody = await settingsGetAfterSaveRes.json();
assert(
  settingsGetAfterSaveBody.activeProfile === 'openrouter' && settingsGetAfterSaveBody.activeModel === 'anthropic/claude-4',
  'GET /v1/admin/settings reflects the newly saved active profile AND model, even before the restart completes',
);

// A profile switch with no model in the body leaves the previously saved model override alone —
// setActiveProfile only touches active_llm_model when one is actually given.
const settingsSetProfileOnlyRes = await fetch(`${base}/v1/admin/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ value: 'deepseek' }),
});
assert(settingsSetProfileOnlyRes.status === 202, 'switching profile alone (no model) still succeeds');
assert(settings.setCalls.length === 3, 'omitting model means only the profile write happens, not a second settings.set call');

// --- Admin settings: supportsVision toggle (Stage 5 — vision) ---

const settingsSetVisionOnRes = await fetch(`${base}/v1/admin/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ value: 'openrouter', model: 'anthropic/claude-4', supportsVision: true }),
});
assert(settingsSetVisionOnRes.status === 202, 'marking a profile vision-capable succeeds');

const settingsGetAfterVisionOnBody = await (
  await fetch(`${base}/v1/admin/settings`, { headers: { authorization: 'Bearer the-admin-key' } })
).json();
assert(
  JSON.stringify(settingsGetAfterVisionOnBody.visionCapableProfiles) === JSON.stringify(['openrouter']),
  'GET /v1/admin/settings reflects the newly marked vision-capable profile',
);

// Omitting supportsVision on a later save of the SAME profile leaves its flag untouched.
const settingsResaveNoVisionFieldRes = await fetch(`${base}/v1/admin/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ value: 'openrouter', model: 'anthropic/claude-4' }),
});
assert(settingsResaveNoVisionFieldRes.status === 202, 'resaving the same profile without supportsVision still succeeds');
const settingsGetAfterResaveBody = await (
  await fetch(`${base}/v1/admin/settings`, { headers: { authorization: 'Bearer the-admin-key' } })
).json();
assert(
  JSON.stringify(settingsGetAfterResaveBody.visionCapableProfiles) === JSON.stringify(['openrouter']),
  'omitting supportsVision on a save leaves the previously stored flag untouched',
);

// Explicitly turning it back off removes it from the stored list.
const settingsSetVisionOffRes = await fetch(`${base}/v1/admin/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ value: 'openrouter', model: 'anthropic/claude-4', supportsVision: false }),
});
assert(settingsSetVisionOffRes.status === 202, 'unmarking a profile as vision-capable succeeds');
const settingsGetAfterVisionOffBody = await (
  await fetch(`${base}/v1/admin/settings`, { headers: { authorization: 'Bearer the-admin-key' } })
).json();
assert(
  settingsGetAfterVisionOffBody.visionCapableProfiles.length === 0,
  'explicitly setting supportsVision: false removes the profile from the stored list',
);

const settingsSetBadVisionRes = await fetch(`${base}/v1/admin/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ value: 'openrouter', supportsVision: 'yes' }),
});
assert(settingsSetBadVisionRes.status === 400, 'POST /v1/admin/settings rejects a non-boolean supportsVision');

// --- Admin calendar-settings route (docs/bb_principles.md §13) ---

const calNoAuthRes = await fetch(`${base}/v1/admin/calendar-settings`);
assert(calNoAuthRes.status === 401, 'GET /v1/admin/calendar-settings with no auth header returns 401');

const calSetNoAuthRes = await fetch(`${base}/v1/admin/calendar-settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ owner_user_id: 'nope' }),
});
assert(calSetNoAuthRes.status === 401, 'POST /v1/admin/calendar-settings with no auth header returns 401');

const calSetEmptyRes = await fetch(`${base}/v1/admin/calendar-settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({}),
});
assert(calSetEmptyRes.status === 400, 'POST /v1/admin/calendar-settings with neither field given returns 400');

const calSetOkRes = await fetch(`${base}/v1/admin/calendar-settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ owner_user_id: '55555555-5555-5555-5555-555555555555', mask_work_calendar: true }),
});
const calSetOkBody = await calSetOkRes.json();
assert(calSetOkRes.status === 202 && calSetOkBody.status === 'restarting', 'an authenticated POST /v1/admin/calendar-settings returns 202/restarting');
assert(
  settings.setCalls.some((c) => c.key === 'calendar_owner_user_id' && c.value === '55555555-5555-5555-5555-555555555555') &&
    settings.setCalls.some((c) => c.key === 'mask_work_calendar' && c.value === 'true'),
  'the settings store recorded both the owner and mask writes',
);

const calGetAfterSaveRes = await fetch(`${base}/v1/admin/calendar-settings`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
const calGetAfterSaveBody = await calGetAfterSaveRes.json();
assert(
  calGetAfterSaveBody.ownerUserId === '55555555-5555-5555-5555-555555555555' && calGetAfterSaveBody.maskWorkCalendar === true,
  'GET /v1/admin/calendar-settings reflects the newly saved values, even before the restart completes',
);

await new Promise((resolve) => setTimeout(resolve, 250));
assert(restartCalls.length === 7, 'triggerRestart fired again after the calendar settings save flushed');

// --- Admin notion-settings route (docs/bb_principles.md §13) ---

const notionSettingsNoAuthRes = await fetch(`${base}/v1/admin/notion-settings`);
assert(notionSettingsNoAuthRes.status === 401, 'GET /v1/admin/notion-settings with no auth header returns 401');

const notionSetOkRes = await fetch(`${base}/v1/admin/notion-settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ owner_user_id: '66666666-6666-6666-6666-666666666666', lists_data_source_id: 'ds-123' }),
});
const notionSetOkBody = await notionSetOkRes.json();
assert(notionSetOkRes.status === 202 && notionSetOkBody.status === 'restarting', 'an authenticated POST /v1/admin/notion-settings returns 202/restarting');
assert(
  settings.setCalls.some((c) => c.key === 'notion_owner_user_id' && c.value === '66666666-6666-6666-6666-666666666666') &&
    settings.setCalls.some((c) => c.key === 'notion_lists_data_source_id' && c.value === 'ds-123'),
  'the settings store recorded both the owner and data-source writes',
);

await new Promise((resolve) => setTimeout(resolve, 250));
assert(restartCalls.length === 8, 'triggerRestart fired again after the notion settings save flushed');

// --- Admin google-calendar routes: settings, then the OAuth auth-url/callback dance ---

const gcalSettingsNoAuthRes = await fetch(`${base}/v1/admin/google-calendar-settings`);
assert(gcalSettingsNoAuthRes.status === 401, 'GET /v1/admin/google-calendar-settings with no auth header returns 401');

const authUrlBeforeConfiguredRes = await fetch(`${base}/v1/admin/google-calendar/auth-url`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
assert(authUrlBeforeConfiguredRes.status === 400, 'GET auth-url with no google_calendar_client_id configured yet returns 400');

const gcalSetOkRes = await fetch(`${base}/v1/admin/google-calendar-settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ client_id: 'test-client-id.apps.googleusercontent.com', owner_user_id: '77777777-7777-7777-7777-777777777777', calendar_id: 'primary' }),
});
const gcalSetOkBody = await gcalSetOkRes.json();
assert(gcalSetOkRes.status === 202 && gcalSetOkBody.status === 'restarting', 'an authenticated POST /v1/admin/google-calendar-settings returns 202/restarting');
assert(
  settings.setCalls.some((c) => c.key === 'google_calendar_client_id' && c.value === 'test-client-id.apps.googleusercontent.com'),
  'the settings store recorded the client id write',
);
await new Promise((resolve) => setTimeout(resolve, 250));
assert(restartCalls.length === 9, 'triggerRestart fired again after the google-calendar settings save flushed');

// The client secret is a real secret (bb_principles.md §12) — set through the generic credentials
// route, same as any other provider_credentials entry, not a google-calendar-specific field.
const gcalSecretRes = await fetch(`${base}/v1/admin/credentials`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ name: 'google_calendar_client_secret', value: 'test-client-secret' }),
});
assert(gcalSecretRes.status === 202, 'setting google_calendar_client_secret via the generic credentials route succeeds');
await new Promise((resolve) => setTimeout(resolve, 250));
assert(restartCalls.length === 10, 'triggerRestart fired again after the client secret write flushed');

const authUrlRes = await fetch(`${base}/v1/admin/google-calendar/auth-url`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
const authUrlBody = await authUrlRes.json();
assert(authUrlRes.status === 200, 'GET auth-url succeeds once a client id is configured');
const consentUrl = new URL(authUrlBody.url);
assert(consentUrl.hostname === 'accounts.google.com', 'the consent URL points at Google');
assert(consentUrl.searchParams.get('client_id') === 'test-client-id.apps.googleusercontent.com', 'the consent URL carries the configured client id');
assert(consentUrl.searchParams.get('scope') === 'https://www.googleapis.com/auth/calendar.events', 'the consent URL requests the events-only scope, not the broader calendar scope');
assert(consentUrl.searchParams.get('access_type') === 'offline' && consentUrl.searchParams.get('prompt') === 'consent', 'offline access + forced consent, so a refresh token is issued even on a second connection');
const state = consentUrl.searchParams.get('state');
assert(typeof state === 'string' && state.length > 0, 'the consent URL carries a freshly minted state nonce');

const callbackNoStateRes = await fetch(`${base}/v1/admin/google-calendar/callback?code=some-code`, { redirect: 'manual' });
assert(callbackNoStateRes.status === 400, 'the callback route rejects a request with no state at all');

const callbackWrongStateRes = await fetch(`${base}/v1/admin/google-calendar/callback?code=some-code&state=not-the-real-nonce`, { redirect: 'manual' });
assert(callbackWrongStateRes.status === 400, 'the callback route rejects an unrecognized state');

// Callback deliberately isn't gated by isAdminAuthorized (a plain browser GET from Google's own
// redirect can't carry a bearer token) — proven here by never sending an authorization header
// on any of these callback requests, unlike every other /v1/admin/* route in this file.
const originalFetchForGoogleAuth = globalThis.fetch;
const tokenCalls = [];
globalThis.fetch = async (url, init) => {
  if (url !== 'https://oauth2.googleapis.com/token') return originalFetchForGoogleAuth(url, init);
  tokenCalls.push(init?.body);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ access_token: 'fake-access-token', refresh_token: 'fake-refresh-token', expires_in: 3600 }),
    text: async () => '',
  };
};
try {
  const callbackOkRes = await fetch(`${base}/v1/admin/google-calendar/callback?code=real-code&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
  });
  assert(callbackOkRes.status === 302 && callbackOkRes.headers.get('location') === '/?google_calendar=connected', 'a successful callback redirects back to / with a connected status');
  assert(tokenCalls.length === 1, 'the callback exchanged the code with Google\'s real token endpoint (stubbed here)');
  assert(
    credentials.setCalls.some((c) => c.name === 'google_calendar_refresh_token' && c.value === 'fake-refresh-token'),
    'the returned refresh token was written to provider_credentials',
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert(restartCalls.length === 11, 'triggerRestart fired again after the refresh token write flushed');

  const callbackReplayRes = await fetch(`${base}/v1/admin/google-calendar/callback?code=real-code&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
  });
  assert(callbackReplayRes.status === 400, 'the same state cannot be replayed — single-use, regardless of outcome');

  // Google not returning a refresh token (e.g. a second consent for an already-granted app) is a
  // real, documented failure mode — the callback should redirect to an error status, not crash.
  const authUrlAgainRes = await fetch(`${base}/v1/admin/google-calendar/auth-url`, { headers: { authorization: 'Bearer the-admin-key' } });
  const stateNoRefresh = new URL((await authUrlAgainRes.json()).url).searchParams.get('state');
  globalThis.fetch = async (url, init) => {
    if (url !== 'https://oauth2.googleapis.com/token') return originalFetchForGoogleAuth(url, init);
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ access_token: 'fake-access-token', expires_in: 3600 }), text: async () => '' };
  };
  const callbackNoRefreshRes = await fetch(
    `${base}/v1/admin/google-calendar/callback?code=real-code&state=${encodeURIComponent(stateNoRefresh)}`,
    { redirect: 'manual' },
  );
  assert(
    callbackNoRefreshRes.status === 302 && callbackNoRefreshRes.headers.get('location') === '/?google_calendar=error',
    'no refresh token in the response redirects to an error status instead of throwing past the response',
  );
} finally {
  globalThis.fetch = originalFetchForGoogleAuth;
}

const callbackNoCodeStateRes = await fetch(`${base}/v1/admin/google-calendar/callback?state=irrelevant`, { redirect: 'manual' });
assert(callbackNoCodeStateRes.status === 400, 'an unrecognized state still 400s on the state check first, even with no code param');

const authUrlForDenialRes = await fetch(`${base}/v1/admin/google-calendar/auth-url`, { headers: { authorization: 'Bearer the-admin-key' } });
const stateForDenial = new URL((await authUrlForDenialRes.json()).url).searchParams.get('state');
const callbackDeniedRes = await fetch(`${base}/v1/admin/google-calendar/callback?state=${encodeURIComponent(stateForDenial)}`, { redirect: 'manual' });
assert(
  callbackDeniedRes.status === 302 && callbackDeniedRes.headers.get('location') === '/?google_calendar=denied',
  'a valid state with no code (the user declined consent) redirects to a denied status, not an error',
);

// --- Admin settings/models route (the model dropdown within a chosen connection) ---

const modelsNoAuthRes = await fetch(`${base}/v1/admin/settings/models?profile=openrouter`);
assert(modelsNoAuthRes.status === 401, 'GET /v1/admin/settings/models with no auth header returns 401');

const modelsUnknownProfileRes = await fetch(`${base}/v1/admin/settings/models?profile=not-a-real-profile`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
assert(modelsUnknownProfileRes.status === 404, 'GET /v1/admin/settings/models for an unknown profile returns 404');

// This mock has to coexist with the test's own outer fetch() calls to the local test server —
// both go through the same globalThis.fetch in this single process — so it only fakes the one
// URL it cares about and delegates everything else (including the loopback call below) to the
// real fetch.
const originalFetch = globalThis.fetch;
const calledUrls = [];
globalThis.fetch = async (url, init) => {
  if (url !== 'https://example.invalid/openrouter/models') return originalFetch(url, init);
  calledUrls.push(url);
  return {
    ok: true,
    json: async () => ({
      data: [
        { id: 'google/gemini-3.5-flash-lite', pricing: { prompt: '0.0000001', completion: '0.0000004' } },
        { id: 'anthropic/claude-4' },
      ],
    }),
    text: async () => '',
  };
};
try {
  const modelsOkRes = await fetch(`${base}/v1/admin/settings/models?profile=openrouter`, {
    headers: { authorization: 'Bearer the-admin-key' },
  });
  const modelsOkBody = await modelsOkRes.json();
  assert(
    calledUrls.length === 1,
    "the models route queried the requested profile's own baseUrl (openrouter), not the currently active one (deepseek)",
  );
  assert(modelsOkRes.status === 200, 'GET /v1/admin/settings/models for a known profile returns 200');
  assert(
    modelsOkBody.models.length === 2 && modelsOkBody.models.some((m) => m.id === 'anthropic/claude-4'),
    'the response carries the live model catalog fetched from that connection',
  );
  assert(
    modelsOkBody.defaultModel === 'google/gemini-3.5-flash-lite',
    "defaultModel is the profile's own static config model, not any override",
  );
  const priced = modelsOkBody.models.find((m) => m.id === 'google/gemini-3.5-flash-lite');
  assert(
    priced?.pricing?.prompt === '0.0000001' && priced?.pricing?.completion === '0.0000004',
    "a model with a pricing field (OpenRouter's own extension) carries it through to the response",
  );
  const unpriced = modelsOkBody.models.find((m) => m.id === 'anthropic/claude-4');
  assert(unpriced?.pricing === undefined, 'a model with no pricing field (e.g. DeepSeek-shaped entries) is left without one, not a fabricated default');
} finally {
  globalThis.fetch = originalFetch;
}

const modelsAccessRes = await fetch(`${base}/v1/admin/settings/models?profile=openrouter`, {
  headers: { 'cf-access-jwt-assertion': 'not-a-real-jwt' },
});
assert(
  modelsAccessRes.status === 401,
  'GET /v1/admin/settings/models is gated by the same isAdminAuthorized check (an unresolvable Access header still 401s)',
);

// A valid Cloudflare Access identity authorizes admin routes with no admin key at all — the
// gate is Access itself now, not a second manually-typed secret (see isAdminAuthorized).
const accessAdminRes = await fetch(`${base}/v1/admin/settings`, {
  headers: { 'cf-access-jwt-assertion': 'valid-access-jwt' },
});
assert(accessAdminRes.status === 200, 'GET /v1/admin/settings with a valid Access identity and no admin key returns 200');

const accessAdminWrongJwtRes = await fetch(`${base}/v1/admin/settings`, {
  headers: { 'cf-access-jwt-assertion': 'not-a-real-jwt' },
});
assert(
  accessAdminWrongJwtRes.status === 401,
  'GET /v1/admin/settings with an unresolvable Access header and no admin key still returns 401',
);

// --- Chat/folder CRUD routes ---
for (const [method, path] of [
  ['GET', '/v1/chats'],
  ['POST', '/v1/chats'],
  ['GET', '/v1/chats/whatever'],
  ['POST', '/v1/chats/whatever'],
  ['DELETE', '/v1/chats/whatever'],
  ['GET', '/v1/folders'],
  ['POST', '/v1/folders'],
]) {
  const res = await fetch(`${base}${path}`, { method });
  assert(res.status === 401, `${method} ${path} with no auth returns 401`);
}

const auth = { authorization: 'Bearer good-key' };
const createChatRes = await fetch(`${base}/v1/chats`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Weekend trip' }),
});
const createdChat = await createChatRes.json();
assert(createChatRes.status === 201 && createdChat.title === 'Weekend trip', 'POST /v1/chats creates a session with the given title');

const listChatsRes = await fetch(`${base}/v1/chats`, { headers: auth });
const listChatsBody = await listChatsRes.json();
assert(
  listChatsRes.status === 200 && listChatsBody.chats.some((c) => c.chatId === createdChat.chatId),
  'GET /v1/chats lists the newly created chat',
);

const getChatRes = await fetch(`${base}/v1/chats/${createdChat.chatId}`, { headers: auth });
const getChatBody = await getChatRes.json();
assert(
  getChatRes.status === 200 && getChatBody.session.chatId === createdChat.chatId && Array.isArray(getChatBody.messages),
  'GET /v1/chats/:id returns the session and its (empty) message list',
);

const updateChatRes = await fetch(`${base}/v1/chats/${createdChat.chatId}`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ params: { system: 'Be terse.' }, tool_names: [] }),
});
const updateChatBody = await updateChatRes.json();
assert(
  updateChatRes.status === 200 && updateChatBody.params.system === 'Be terse.' && Array.isArray(updateChatBody.toolNames),
  'POST /v1/chats/:id updates params and tool_names',
);

const missingChatRes = await fetch(`${base}/v1/chats/does-not-exist`, { headers: auth });
assert(missingChatRes.status === 404, 'GET /v1/chats/:id for an unknown id returns 404');

const createFolderRes = await fetch(`${base}/v1/folders`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Travel' }),
});
const createdFolder = await createFolderRes.json();
assert(createFolderRes.status === 201 && createdFolder.name === 'Travel', 'POST /v1/folders creates a folder');

const listFoldersRes = await fetch(`${base}/v1/folders`, { headers: auth });
const listFoldersBody = await listFoldersRes.json();
assert(
  listFoldersRes.status === 200 && listFoldersBody.folders.some((f) => f.folderId === createdFolder.folderId),
  'GET /v1/folders lists the newly created folder',
);

const deleteChatRes = await fetch(`${base}/v1/chats/${createdChat.chatId}`, { method: 'DELETE', headers: auth });
const deleteChatBody = await deleteChatRes.json();
assert(deleteChatRes.status === 200 && deleteChatBody.deleted === true, 'DELETE /v1/chats/:id deletes the chat');

const getDeletedChatRes = await fetch(`${base}/v1/chats/${createdChat.chatId}`, { headers: auth });
assert(getDeletedChatRes.status === 404, 'a deleted chat 404s afterward');

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
    accessIdentity: createFakeAccessIdentityResolver(),
    chats: createFakeChatSessionStore(),
    adminApiKey: 'unused-in-this-part',
    credentials: createFakeCredentialStore(),
    settings: createFakeSettingsStore(),
    llmProfiles,
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

// --- Part 5: chat_id ties a turn to a persisted session — its params/tools apply, exchange is stored ---
{
  const capturedCalls = [];
  const capturingLlm = {
    name: 'capturing',
    async complete(messages, toolDefs) {
      capturedCalls.push({ messages, toolDefs });
      return { message: { role: 'assistant', content: 'terse reply' }, toolCalls: [] };
    },
  };
  const db3 = createPostgresClient(createFakePool());
  const apiKeys3 = createApiKeyStore('good-key-3:33333333-3333-3333-3333-333333333333');
  const chats3 = createFakeChatSessionStore();
  const tools3 = createToolRegistry([echoTool]);
  const server3 = startHttpServer({
    llm: capturingLlm,
    db: db3,
    tools: tools3,
    apiKeys: apiKeys3,
    accessIdentity: createFakeAccessIdentityResolver(),
    chats: chats3,
    adminApiKey: 'unused-in-this-part',
    credentials: createFakeCredentialStore(),
    settings: createFakeSettingsStore(),
    llmProfiles,
    modelName: 'bigbrain',
    port: 0,
  });
  await new Promise((resolve) => server3.once('listening', resolve));
  const base3 = `http://127.0.0.1:${server3.address().port}`;
  const userId3 = '33333333-3333-3333-3333-333333333333';

  const chat = await chats3.createChat(userId3, {});
  await chats3.updateChat(userId3, chat.chatId, {
    params: { system: 'Be terse.', temperature: 0.3 },
    toolNames: [], // no tools allowed in this chat
  });

  const missingChatIdRes = await fetch(`${base3}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good-key-3' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello there' }], chat_id: 'no-such-chat' }),
  });
  assert(missingChatIdRes.status === 404, 'chat_id pointing at an unknown/inaccessible chat returns 404');

  const chatRes = await fetch(`${base3}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good-key-3' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello there' }], chat_id: chat.chatId }),
  });
  assert(chatRes.status === 200, 'a request with a valid chat_id succeeds');

  const call = capturedCalls[0];
  assert(
    call.messages[0].role === 'system' &&
      call.messages[0].content.startsWith('Today is') &&
      call.messages[0].content.endsWith('Be terse.'),
    "a current-date line is prepended ahead of the chat's own system prompt param, joined by a blank line",
  );
  assert(call.toolDefs.length === 0, "the chat's empty tool_names allow-list actually restricts what the model is offered (echo_tool exists but isn't sent)");

  const detail = await chats3.getChat(userId3, chat.chatId);
  assert(detail.messages.length === 2, 'both the user message and the reply were persisted');
  assert(
    detail.messages[0].role === 'user' && detail.messages[0].content === 'hello there' && detail.messages[1].content === 'terse reply',
    'persisted messages have the right role/content and order',
  );
  assert(detail.session.title === 'hello there', "an untitled chat's first exchange auto-titles it from the user's message");

  const withoutChatIdRes = await fetch(`${base3}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good-key-3' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'no session here' }] }),
  });
  assert(withoutChatIdRes.status === 200, 'a request with no chat_id still works (Open WebUI-style stateless traffic)');
  const detailAfter = await chats3.getChat(userId3, chat.chatId);
  assert(detailAfter.messages.length === 2, 'a stateless request (no chat_id) does not touch any persisted session');

  // index 1 is generateChatTitle's own llm.complete() call, fired by the previous request's
  // first-exchange auto-titling (chat.chatId's session was still untitled) — the stateless
  // request's own turn is the one after that.
  const statelessCall = capturedCalls[2];
  assert(
    statelessCall.messages[0].role === 'system' && statelessCall.messages[0].content.startsWith('Today is'),
    'the date-context line is prepended even for a request with no chat_id and no custom system prompt at all',
  );

  // --- Message delete/truncate routes, and edit/rerun's dedup logic ---
  const auth3 = { authorization: 'Bearer good-key-3' };
  const chat2 = await chats3.createChat(userId3, {});
  await chats3.appendMessages(userId3, chat2.chatId, [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ]);
  const seeded = await chats3.getChat(userId3, chat2.chatId);
  const [seededUser, seededAssistant] = seeded.messages;

  const deleteMsgNoAuthRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${seededAssistant.messageId}`, {
    method: 'DELETE',
  });
  assert(deleteMsgNoAuthRes.status === 401, 'DELETE /v1/chats/:id/messages/:messageId with no auth returns 401');

  const deleteMsgUnknownRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/no-such-id`, {
    method: 'DELETE',
    headers: auth3,
  });
  assert(deleteMsgUnknownRes.status === 404, 'DELETE for an unknown message id returns 404');

  const deleteMsgOkRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${seededAssistant.messageId}`, {
    method: 'DELETE',
    headers: auth3,
  });
  const deleteMsgOkBody = await deleteMsgOkRes.json();
  assert(
    deleteMsgOkRes.status === 200 && deleteMsgOkBody.deleted === true,
    'DELETE /v1/chats/:id/messages/:messageId removes the message and returns 200',
  );
  const afterDeleteMsg = await chats3.getChat(userId3, chat2.chatId);
  assert(
    afterDeleteMsg.messages.length === 1 && afterDeleteMsg.messages[0].messageId === seededUser.messageId,
    'exactly the targeted message is gone, the rest of the chat is untouched',
  );

  // Re-seed a second exchange to prove truncate removes everything chronologically after the
  // target, not just the target itself.
  await chats3.appendMessages(userId3, chat2.chatId, [{ role: 'assistant', content: 'first answer again' }]);
  await chats3.appendMessages(userId3, chat2.chatId, [
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'second answer' },
  ]);
  const seeded2 = await chats3.getChat(userId3, chat2.chatId);
  const [u1, a1, u2] = seeded2.messages;

  const truncateNoAuthRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${u2.messageId}/truncate`, { method: 'POST' });
  assert(truncateNoAuthRes.status === 401, 'POST .../truncate with no auth returns 401');

  const truncateUnknownRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/no-such-id/truncate`, {
    method: 'POST',
    headers: auth3,
  });
  assert(truncateUnknownRes.status === 404, 'POST .../truncate for an unknown message id returns 404');

  const truncateOkRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${u2.messageId}/truncate`, {
    method: 'POST',
    headers: auth3,
  });
  const truncateOkBody = await truncateOkRes.json();
  assert(
    truncateOkRes.status === 200 && truncateOkBody.truncated === true,
    'POST .../truncate removes the message and everything after it, returns 200',
  );
  const afterTruncate = await chats3.getChat(userId3, chat2.chatId);
  assert(
    afterTruncate.messages.length === 2 &&
      afterTruncate.messages[0].messageId === u1.messageId &&
      afterTruncate.messages[1].messageId === a1.messageId,
    'truncating from the second question removes it and its answer, leaving only the first exchange',
  );

  // "rerun": truncate the last assistant reply, then resend the identical (now-shorter) history —
  // must NOT duplicate the user message that's already persisted.
  const rerunTruncateRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${a1.messageId}/truncate`, {
    method: 'POST',
    headers: auth3,
  });
  assert(rerunTruncateRes.status === 200, 'truncating the assistant reply to rerun it succeeds');
  const rerunHistory = await chats3.getChat(userId3, chat2.chatId);
  assert(rerunHistory.messages.length === 1, 'only the user message remains after truncating the reply being rerun');

  const rerunRes = await fetch(`${base3}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth3, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'first question' }], chat_id: chat2.chatId }),
  });
  assert(rerunRes.status === 200, 'the rerun-style resend succeeds');
  const afterRerun = await chats3.getChat(userId3, chat2.chatId);
  assert(
    afterRerun.messages.length === 2 && afterRerun.messages[0].content === 'first question' && afterRerun.messages[1].role === 'assistant',
    'a rerun resend (same message count as already persisted) appends only the new assistant reply, not a duplicate user message',
  );

  // "edit": truncate from the message being edited, then resend with new content plus one more
  // message than what's now persisted — a genuinely new turn, so both rows insert.
  const editTruncateRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${afterRerun.messages[0].messageId}/truncate`, {
    method: 'POST',
    headers: auth3,
  });
  assert(editTruncateRes.status === 200, 'truncating from the message being edited succeeds');
  const editHistory = await chats3.getChat(userId3, chat2.chatId);
  assert(editHistory.messages.length === 0, 'truncating from the very first message empties the chat');

  const editRes = await fetch(`${base3}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth3, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'first question, edited' }], chat_id: chat2.chatId }),
  });
  assert(editRes.status === 200, 'the edit-style resend succeeds');
  const afterEdit = await chats3.getChat(userId3, chat2.chatId);
  assert(
    afterEdit.messages.length === 2 && afterEdit.messages[0].content === 'first question, edited' && afterEdit.messages[1].role === 'assistant',
    'an edit resend (one more message than already persisted) appends both the edited user message and the new reply',
  );

  // --- A chat's own profile override swaps in a throwaway provider for that turn, no restart ---
  const originalFetch3 = globalThis.fetch;
  const capturedProfileCalls = [];
  globalThis.fetch = async (url, init) => {
    if (url !== 'https://example.invalid/openrouter/chat/completions') return originalFetch3(url, init);
    capturedProfileCalls.push({ url, authorization: init.headers.authorization });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'from openrouter' } }] }),
      text: async () => '',
    };
  };
  try {
    const profileChat = await chats3.createChat(userId3, {});
    // title set away from the default so the auto-titling call (also routed through turnLlm) doesn't
    // fire and muddy capturedProfileCalls — that behavior is already covered in Part 5 above.
    await chats3.updateChat(userId3, profileChat.chatId, { params: { profile: 'openrouter' }, title: 'Already named' });

    const profileRes = await fetch(`${base3}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth3, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'which connection is this' }], chat_id: profileChat.chatId }),
    });
    const profileBody = await profileRes.json();
    assert(profileRes.status === 200, "a chat_id whose params name a valid profile still succeeds");
    assert(
      capturedProfileCalls.length === 1 && capturedProfileCalls[0].authorization === 'Bearer sk-test-openrouter',
      "the turn was routed through the chat's overridden profile (openrouter), not the boot-time llm",
    );
    assert(
      profileBody.choices[0].message.content === 'from openrouter',
      "the reply came back from the overridden connection's own response",
    );
    assert(
      profileBody.model === 'google/gemini-3.5-flash-lite',
      "the echoed model falls back to the overridden profile's own default model, not the boot-time modelName",
    );

    const capturedCallsBefore = capturedCalls.length;
    const unknownProfileChat = await chats3.createChat(userId3, {});
    await chats3.updateChat(userId3, unknownProfileChat.chatId, {
      params: { profile: 'not-a-real-profile' },
      title: 'Already named',
    });
    const unknownProfileRes = await fetch(`${base3}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth3, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], chat_id: unknownProfileChat.chatId }),
    });
    assert(unknownProfileRes.status === 200, 'a chat_id naming an unknown profile still succeeds (falls back, does not fail the turn)');
    assert(
      capturedCalls.length === capturedCallsBefore + 1 && capturedProfileCalls.length === 1,
      'an unknown profile override falls back to the boot-time llm rather than throwing or hitting any provider',
    );
  } finally {
    globalThis.fetch = originalFetch3;
  }

  server3.close();
}

// --- Part 6: Canvas — a tool call's focusHint persists as chat_sessions.canvas_note_id ---
{
  const focusingLlm = {
    name: 'focusing',
    calls: 0,
    async complete() {
      this.calls += 1;
      if (this.calls === 1) {
        return { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'c1', name: 'touch_note', arguments: {} }] };
      }
      return { message: { role: 'assistant', content: 'noted' }, toolCalls: [] };
    },
  };
  const focusingTool = {
    definition: { name: 'touch_note', description: 'test', parameters: { type: 'object', properties: {} } },
    handler: async () => ({ noteId: 'note-canvas-1' }),
    focusHint: (result) => result.noteId ?? null,
  };
  const db5 = createPostgresClient(createFakePool());
  const apiKeys5 = createApiKeyStore('good-key-5:55555555-5555-5555-5555-555555555555');
  const chats5 = createFakeChatSessionStore();
  const userId5 = '55555555-5555-5555-5555-555555555555';
  const server5 = startHttpServer({
    llm: focusingLlm,
    db: db5,
    tools: createToolRegistry([focusingTool]),
    apiKeys: apiKeys5,
    accessIdentity: createFakeAccessIdentityResolver(),
    chats: chats5,
    adminApiKey: 'unused-in-this-part',
    credentials: createFakeCredentialStore(),
    settings: createFakeSettingsStore(),
    llmProfiles,
    modelName: 'bigbrain',
    port: 0,
  });
  await new Promise((resolve) => server5.once('listening', resolve));
  const base5 = `http://127.0.0.1:${server5.address().port}`;
  const auth5 = { authorization: 'Bearer good-key-5' };

  const chat5 = await chats5.createChat(userId5, {});
  assert(chat5.canvasNoteId === null, 'a fresh chat starts with no canvas focus');

  const focusRes = await fetch(`${base5}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth5, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'draft me a note' }], chat_id: chat5.chatId }),
  });
  const focusBody = await focusRes.json();
  assert(focusRes.status === 200, 'a turn whose tool call declares a focusHint still succeeds');
  assert(
    Object.keys(focusBody).sort().join(',') === 'choices,created,id,model,object'.split(',').sort().join(','),
    'the OpenAI-shaped completion response carries no leaked canvas/focus field — Canvas is plumbed via chat_sessions, not this endpoint',
  );
  const afterFocus = await chats5.getChat(userId5, chat5.chatId);
  assert(afterFocus.session.canvasNoteId === 'note-canvas-1', "the turn's focusHint persisted as the chat's canvas_note_id");

  // A subsequent turn that doesn't call any focus-hinting tool must leave the existing focus alone.
  const noFocusRes = await fetch(`${base5}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth5, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'thanks' }], chat_id: chat5.chatId }),
  });
  assert(noFocusRes.status === 200, 'a follow-up turn succeeds');
  const afterNoFocus = await chats5.getChat(userId5, chat5.chatId);
  assert(
    afterNoFocus.session.canvasNoteId === 'note-canvas-1',
    "a turn that doesn't touch any note leaves the chat's existing canvas focus untouched",
  );

  // The manual close path: POST /v1/chats/:id with canvas_note_id: null clears it.
  const closeRes = await fetch(`${base5}/v1/chats/${chat5.chatId}`, {
    method: 'POST',
    headers: { ...auth5, 'content-type': 'application/json' },
    body: JSON.stringify({ canvas_note_id: null }),
  });
  const closeBody = await closeRes.json();
  assert(closeRes.status === 200 && closeBody.canvasNoteId === null, 'POST /v1/chats/:id with canvas_note_id: null clears the canvas focus');

  server5.close();
}

// --- Admin timezone route (feeds handleChatCompletions's date-context line) ---
{
  const settings4 = createFakeSettingsStore();
  const server4 = startHttpServer({
    llm,
    db: createPostgresClient(createFakePool()),
    tools: createToolRegistry([]),
    apiKeys: createApiKeyStore('good-key-4:44444444-4444-4444-4444-444444444444'),
    accessIdentity: createFakeAccessIdentityResolver(),
    chats: createFakeChatSessionStore(),
    adminApiKey: 'the-admin-key',
    credentials: createFakeCredentialStore(),
    settings: settings4,
    llmProfiles,
    modelName: 'bigbrain',
    port: 0,
    triggerRestart: () => {
      throw new Error('timezone changes must never trigger a restart');
    },
  });
  await new Promise((resolve) => server4.once('listening', resolve));
  const base4 = `http://127.0.0.1:${server4.address().port}`;

  const tzNoAuthRes = await fetch(`${base4}/v1/admin/timezone`);
  assert(tzNoAuthRes.status === 401, 'GET /v1/admin/timezone with no auth header returns 401');

  const tzDefaultRes = await fetch(`${base4}/v1/admin/timezone`, { headers: { authorization: 'Bearer the-admin-key' } });
  const tzDefaultBody = await tzDefaultRes.json();
  assert(
    tzDefaultRes.status === 200 && tzDefaultBody.timezone === 'UTC',
    'GET /v1/admin/timezone defaults to UTC before anything has been saved',
  );

  const tzBadRes = await fetch(`${base4}/v1/admin/timezone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
    body: JSON.stringify({ value: 'Not/A_Real_Zone' }),
  });
  assert(tzBadRes.status === 400, 'POST /v1/admin/timezone rejects a name Intl does not recognize as a timezone');

  const tzOkRes = await fetch(`${base4}/v1/admin/timezone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
    body: JSON.stringify({ value: 'America/New_York' }),
  });
  const tzOkBody = await tzOkRes.json();
  assert(
    tzOkRes.status === 200 && tzOkBody.timezone === 'America/New_York',
    'POST /v1/admin/timezone with a valid IANA name returns 200 immediately (not 202/restarting)',
  );
  assert(settings4.setCalls.some((c) => c.key === 'household_timezone' && c.value === 'America/New_York'), 'the settings store recorded the write');

  const tzAfterSaveRes = await fetch(`${base4}/v1/admin/timezone`, { headers: { authorization: 'Bearer the-admin-key' } });
  const tzAfterSaveBody = await tzAfterSaveRes.json();
  assert(tzAfterSaveBody.timezone === 'America/New_York', 'GET /v1/admin/timezone reflects the newly saved value with no restart required');

  server4.close();
}

if (process.exitCode) {
  console.error('\nserver verification FAILED');
  process.exit(1);
}
console.log('\nserver verification passed');
