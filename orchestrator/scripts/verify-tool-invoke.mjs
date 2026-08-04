// Proves the direct tool-invocation surface (toolInvoke.ts + httpServer.ts's GET /v1/tools and
// POST /v1/tools/:name) against a real HTTP server, same style as verify-server.mjs's Part 3 —
// real fetch() calls, not a simulated request object, since routing/parsing/auth are exactly
// what's under test here. This surface used to be OpenAPI-spec-branded (an openApiToolServer.ts
// serving GET /v1/tools/openapi.json for an external OpenAPI-based caller); that spec-serving
// route and its module were removed, and GET /v1/tools was simplified to a plain, auth-gated
// {names: [...]} listing for the native frontend — see toolInvoke.ts's own doc comment.

import { createToolRegistry } from '../dist/orchestrator/toolRegistry.js';
import { createApiKeyStore } from '../dist/server/apiKeyStore.js';
import { startHttpServer } from '../dist/server/httpServer.js';
import { createPostgresClient } from '../dist/io/postgres.js';

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
});
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// --- GET /v1/tools ---
const listNoAuthRes = await fetch(`${base}/v1/tools`);
assert(listNoAuthRes.status === 401, 'GET /v1/tools with no auth header returns 401');

const listRes = await fetch(`${base}/v1/tools`, { headers: { authorization: 'Bearer good-key' } });
const listBody = await listRes.json();
assert(listRes.status === 200, 'GET /v1/tools with a valid key returns 200');
assert(
  Array.isArray(listBody.names) && listBody.names.sort().join(',') === 'echo_tool,throwing_tool',
  'the tool list carries exactly the names in the registry, no more and no fewer',
);

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
  console.error('\ntool invoke verification FAILED');
  process.exit(1);
}
console.log('\ntool invoke verification passed');
