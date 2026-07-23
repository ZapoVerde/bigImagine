// Proves the OpenAPI tool surface (openApiToolServer.ts + httpServer.ts's two new routes) against
// a real HTTP server, same style as verify-server.mjs's Part 3 — real fetch() calls, not a
// simulated request object, since routing/parsing/auth are exactly what's under test here.

import { createToolRegistry } from '../dist/orchestrator/toolRegistry.js';
import { createApiKeyStore } from '../dist/server/apiKeyStore.js';
import { startHttpServer } from '../dist/server/httpServer.js';
import { createPostgresClient } from '../dist/io/postgres.js';
import { buildOpenApiSpec } from '../dist/server/openApiToolServer.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakePool() {
  const scopedCalls = [];
  return {
    scopedCalls,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            scopedCalls.push(scopedUserId);
            return { rows: [] };
          }
          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

// --- buildOpenApiSpec: pure, no server needed ---
{
  const spec = buildOpenApiSpec(
    [
      { name: 'add_list_item', description: 'Add an item.', parameters: { type: 'object', properties: { item_name: { type: 'string' } } } },
      { name: 'get_list_items', description: 'List items.', parameters: { type: 'object', properties: {} } },
    ],
    'http://bigbrain-orchestrator:8787/v1/tools',
  );
  assert(spec.openapi === '3.1.0', 'the spec declares OpenAPI 3.1.0');
  assert(spec.servers[0].url === 'http://bigbrain-orchestrator:8787/v1/tools', 'the servers entry carries the given base URL');
  assert(Object.keys(spec.paths).length === 2, 'one path was generated per tool definition');
  assert(spec.paths['/add_list_item'].post.operationId === 'add_list_item', "a tool's operationId matches its name");
  assert(
    spec.paths['/add_list_item'].post.requestBody.content['application/json'].schema.properties.item_name.type === 'string',
    "a tool's JSON-Schema parameters are carried through verbatim as the request body schema",
  );
  assert(
    spec.paths['/add_list_item'].post.security[0].bearerAuth !== undefined,
    'each operation declares the bearerAuth security requirement',
  );
  assert(spec.components.securitySchemes.bearerAuth.scheme === 'bearer', 'the spec declares a bearer security scheme');
}

// --- the real HTTP server, end to end ---
const echoTool = {
  definition: {
    name: 'echo_tool',
    description: 'Echoes its arguments back.',
    parameters: { type: 'object', properties: { x: { type: 'number' } } },
  },
  handler: async (args) => ({ echoed: args }),
};
const throwingTool = {
  definition: { name: 'throwing_tool', description: 'Always throws.', parameters: { type: 'object', properties: {} } },
  handler: async () => {
    throw new Error('simulated tool failure');
  },
};

const pool = createFakePool();
const db = createPostgresClient(pool);
const tools = createToolRegistry([echoTool, throwingTool]);
const apiKeys = createApiKeyStore('good-key:11111111-1111-1111-1111-111111111111');

const server = startHttpServer({
  llm: { name: 'unused', async complete() { throw new Error('should not be called by this surface'); } },
  db,
  tools,
  apiKeys,
  modelName: 'bigbrain',
  port: 0,
  publicBaseUrl: 'http://bigbrain-orchestrator:8787',
});
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// --- GET /v1/tools/openapi.json ---
const specRes = await fetch(`${base}/v1/tools/openapi.json`);
const specBody = await specRes.json();
assert(specRes.status === 200, 'GET /v1/tools/openapi.json returns 200');
assert(specBody.servers[0].url === 'http://bigbrain-orchestrator:8787/v1/tools', 'the live spec uses the configured publicBaseUrl');
assert(
  Object.keys(specBody.paths).sort().join(',') === '/echo_tool,/throwing_tool',
  'the live spec lists exactly the tools in the registry, no more and no fewer',
);
assert(specRes.status !== 401, 'the spec itself requires no authentication (a client needs to read it before it can know how to authenticate calls)');

// --- POST /v1/tools/:name: auth ---
const noAuthRes = await fetch(`${base}/v1/tools/echo_tool`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ x: 1 }),
});
assert(noAuthRes.status === 401, 'a tool invocation with no auth header returns 401');

const wrongKeyRes = await fetch(`${base}/v1/tools/echo_tool`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-key' },
  body: JSON.stringify({ x: 1 }),
});
assert(wrongKeyRes.status === 401, 'a tool invocation with an unrecognized key returns 401');

// --- POST /v1/tools/:name: success, and scoped to the right user ---
const okRes = await fetch(`${base}/v1/tools/echo_tool`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer good-key' },
  body: JSON.stringify({ x: 42 }),
});
const okBody = await okRes.json();
assert(okRes.status === 200, 'a correctly authenticated, known-tool invocation returns 200');
assert(okBody.echoed.x === 42, "the tool's own handler ran and its result is returned verbatim, unwrapped");
assert(
  pool.scopedCalls.includes('11111111-1111-1111-1111-111111111111'),
  "the invocation was scoped via withUserScope to the key's resolved user_id, not something the request body could claim",
);

// --- POST /v1/tools/:name: unknown tool name ---
const unknownRes = await fetch(`${base}/v1/tools/nonexistent_tool`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer good-key' },
  body: JSON.stringify({}),
});
assert(unknownRes.status === 404, 'invoking an unregistered tool name returns 404, not a crash');

// --- POST /v1/tools/:name: the tool's own handler throws ---
const throwRes = await fetch(`${base}/v1/tools/throwing_tool`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer good-key' },
  body: JSON.stringify({}),
});
const throwBody = await throwRes.json();
assert(throwRes.status === 500, "a tool handler throwing returns 500, doesn't crash the server");
assert(throwBody.error?.includes('simulated tool failure'), "the 500 response surfaces the handler's own error message");

// the server is still alive and answering after a handler threw
const stillAliveRes = await fetch(`${base}/healthz`);
assert(stillAliveRes.status === 200, 'the server keeps serving requests after a tool handler threw');

// --- POST /v1/tools/:name: malformed JSON body ---
const badJsonRes = await fetch(`${base}/v1/tools/echo_tool`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer good-key' },
  body: 'not json{{',
});
assert(badJsonRes.status === 400, 'a malformed JSON body returns 400, not a 500 or a crash');

server.close();

if (process.exitCode) {
  console.error('\nOpenAPI tool server verification FAILED');
  process.exit(1);
}
console.log('\nOpenAPI tool server verification passed');
