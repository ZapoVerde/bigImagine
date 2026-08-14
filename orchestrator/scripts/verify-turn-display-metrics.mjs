// Proves the Timing half of docs/plans/llm-stats-page-plan.md end to end:
//
//  1. recordTurnDisplayMetrics (io/turnDisplayMetrics.ts) round-trips every field — a full
//     record lands all 16 columns, an absent *_ms field stays null (never a fabricated zero).
//  2. POST /v1/turn-display-metrics rejects without chat auth (401), accepts a partial payload
//     (only the fields reached before an abort — a legitimate record), and treats a duplicate
//     message_id as an idempotent no-op ({ recorded: false }) instead of an error.
//  3. GET /v1/admin/turn-display-stats requires admin auth and hands a clamped `days` lookback
//     to the query, same [1, 365] bounds as /v1/admin/llm-stats.
//  4. GET /v1/chats/:chatId/turn-display-metrics/latest — the drawer Timing section's durable
//     "last turn" read — requires chat auth, returns the newest recorded turn for the chat (or
//     { turn: null } when it has none), scoped to the authenticated user by construction.

import { createPostgresClient } from '../dist/io/postgres.js';
import { createApiKeyStore } from '../dist/server/apiKeyStore.js';
import { startHttpServer } from '../dist/server/httpServer.js';
import { createStubLlmProvider } from '../dist/io/llm/stub.js';
import { recordTurnDisplayMetrics } from '../dist/io/turnDisplayMetrics.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// A fake pool that records turn_display_metrics inserts and simulates the migration 0102 unique
// index on message_id (a second insert for the same message_id throws code 23505, exactly what
// node-postgres surfaces), plus serves the admin stats read with a days-param recorder.
function createFakePool() {
  const inserts = [];
  const rows = [];
  const statsDaysRead = [];
  return {
    inserts,
    rows,
    statsDaysRead,
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) return { rows: [] };
          if (sql.includes('insert into turn_display_metrics')) {
            if (rows.some((r) => r.message_id === params[2])) {
              const err = new Error('duplicate key value violates unique constraint "turn_display_metrics_message"');
              err.code = '23505';
              throw err;
            }
            const row = {
              user_id: params[0],
              chat_id: params[1],
              message_id: params[2],
              dispatch_at: params[3],
              first_token_ms: params[4],
              last_token_ms: params[5],
              display_land_ms: params[6],
              display_settle_ms: params[7],
              header_start_ms: params[8],
              header_stop_ms: params[9],
              body_start_ms: params[10],
              body_stop_ms: params[11],
              footer_start_ms: params[12],
              footer_stop_ms: params[13],
              outcome: params[14],
              terminated_at_ms: params[15],
            };
            rows.push(row);
            inserts.push(params);
            return { rows: [] };
          }
          if (sql.includes('from turn_display_metrics') && sql.includes('limit 1')) {
            // GET /v1/chats/:chatId/turn-display-metrics/latest — newest row for the chat. Must
            // sit before the stats branch below: the latest query also contains "order by
            // created_at desc" (with the dispatch_at tiebreak), so "limit 1" is its distinguisher.
            const chatId = params[0];
            const match = rows
              .filter((r) => r.chat_id === chatId)
              .sort((a, b) => (a.dispatch_at < b.dispatch_at ? 1 : -1))[0];
            return {
              rows: match
                ? [
                    {
                      ...match,
                      turn_display_metric_id: `tdm-${match.message_id}`,
                      dispatch_at: new Date(match.dispatch_at),
                      created_at: new Date('2026-08-14T00:00:00.000Z'),
                    },
                  ]
                : [],
            };
          }
          if (sql.includes('from turn_display_metrics') && sql.includes('order by created_at desc')) {
            statsDaysRead.push(params[0]);
            // node-postgres returns timestamptz columns as Date objects — dispatch_at/created_at
            // come back as Date here so the row mapper's .toISOString() works exactly as it does
            // against a real database.
            return {
              rows: rows.map((r) => ({
                ...r,
                turn_display_metric_id: `tdm-${r.message_id}`,
                dispatch_at: new Date(r.dispatch_at),
                created_at: new Date('2026-08-14T00:00:00.000Z'),
              })),
            };
          }
          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

// --- Part 1: recordTurnDisplayMetrics round-trips every field, absent ones stay null ---
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  await recordTurnDisplayMetrics(db, {
    userId: 'u-full',
    chatId: 'chat-full',
    messageId: 'msg-full',
    dispatchAt: '2026-08-14T01:00:00.000Z',
    firstTokenMs: 120,
    lastTokenMs: 2400,
    displayLandMs: 480,
    displaySettleMs: 1600,
    headerStartMs: 60,
    headerStopMs: 300,
    bodyStartMs: 320,
    bodyStopMs: 1500,
    footerStartMs: 1560,
    footerStopMs: 1900,
    outcome: 'ok',
    terminatedAtMs: 2500,
  });
  const full = pool.inserts[0];
  assert(
    full[0] === 'u-full' && full[1] === 'chat-full' && full[2] === 'msg-full' && full[3] === '2026-08-14T01:00:00.000Z',
    'the insert carries userId (from auth, never the body), chatId, messageId, dispatchAt',
  );
  assert(
    full[4] === 120 && full[5] === 2400 && full[6] === 480 && full[7] === 1600 && full[8] === 60 &&
      full[9] === 300 && full[10] === 320 && full[11] === 1500 && full[12] === 1560 && full[13] === 1900 &&
      full[14] === 'ok' && full[15] === 2500,
    'all eleven *_ms fields, the outcome, and terminatedAtMs land in their columns',
  );

  await recordTurnDisplayMetrics(db, {
    userId: 'u-partial',
    chatId: 'chat-partial',
    messageId: 'msg-partial',
    dispatchAt: '2026-08-14T02:00:00.000Z',
    outcome: 'aborted',
    firstTokenMs: 90, // the only timing reached before the abort
  });
  const partial = pool.inserts[1];
  assert(
    partial[5] === null && partial[6] === null && partial[7] === null && partial[8] === null &&
      partial[9] === null && partial[10] === null && partial[11] === null && partial[12] === null &&
      partial[13] === null && partial[15] === null && partial[14] === 'aborted',
    'an absent timing field stays null — a partial (aborted) record is stored honestly, not zero-filled',
  );
}

// --- Part 2 + 3: the HTTP endpoints against a real server ---
const pool = createFakePool();
const db = createPostgresClient(pool);
const server = startHttpServer({
  llm: createStubLlmProvider([]),
  db,
  tools: { list: () => [], call: async () => ({}) },
  apiKeys: createApiKeyStore('good-key:11111111-1111-1111-1111-111111111111'),
  accessIdentity: { resolve: async () => undefined },
  chats: {},
  adminApiKey: 'the-admin-key',
  settings: { get: async () => undefined, set: async () => {} },
  llmConnections: {
    list: async () => [],
    resolveById: async () => undefined,
    resolveByName: async () => undefined,
    resolveActive: async () => undefined,
  },
  imageConnections: {
    list: async () => [],
    resolveById: async () => undefined,
    resolveActive: async () => undefined,
  },
  port: 0,
});
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const AUTH = { 'content-type': 'application/json', authorization: 'Bearer good-key' };
const ADMIN = { authorization: 'Bearer the-admin-key' };

const postNoAuthRes = await fetch(`${base}/v1/turn-display-metrics`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chatId: 'c', messageId: 'm', dispatchAt: '2026-08-14T00:00:00.000Z', outcome: 'ok' }),
});
assert(postNoAuthRes.status === 401, 'POST /v1/turn-display-metrics with no chat auth returns 401');

const postPartialRes = await fetch(`${base}/v1/turn-display-metrics`, {
  method: 'POST',
  headers: AUTH,
  body: JSON.stringify({
    chatId: 'chat-http',
    messageId: 'msg-http-1',
    dispatchAt: '2026-08-14T03:00:00.000Z',
    outcome: 'error',
    firstTokenMs: 75,
    bodyStartMs: 400,
  }),
});
const postPartialBody = await postPartialRes.json();
assert(postPartialRes.status === 200 && postPartialBody.recorded === true, 'a partial payload (aborted/error-shaped) is accepted and recorded');
assert(pool.rows.length === 1 && pool.rows[0].user_id === '11111111-1111-1111-1111-111111111111', 'the row is attributed to the authenticated user — never a userId from the body');
assert(pool.rows[0].body_start_ms === 400 && pool.rows[0].last_token_ms === null && pool.rows[0].terminated_at_ms === null, 'present fields land, absent ones stay null through the HTTP path');

const postDuplicateRes = await fetch(`${base}/v1/turn-display-metrics`, {
  method: 'POST',
  headers: AUTH,
  body: JSON.stringify({ chatId: 'chat-http', messageId: 'msg-http-1', dispatchAt: '2026-08-14T03:00:00.000Z', outcome: 'error', firstTokenMs: 75 }),
});
const postDuplicateBody = await postDuplicateRes.json();
assert(
  postDuplicateRes.status === 200 && postDuplicateBody.recorded === false && pool.rows.length === 1,
  'a duplicate message_id is an idempotent no-op ({ recorded: false }, one row) — never a 500 the recorder would have to interpret',
);

const postBadOutcomeRes = await fetch(`${base}/v1/turn-display-metrics`, {
  method: 'POST',
  headers: AUTH,
  body: JSON.stringify({ chatId: 'c', messageId: 'm-bad', dispatchAt: '2026-08-14T00:00:00.000Z', outcome: 'pending' }),
});
assert(postBadOutcomeRes.status === 400, 'a body with an unknown outcome is rejected (400)');

const postNegativeRes = await fetch(`${base}/v1/turn-display-metrics`, {
  method: 'POST',
  headers: AUTH,
  body: JSON.stringify({ chatId: 'c', messageId: 'm-neg', dispatchAt: '2026-08-14T00:00:00.000Z', outcome: 'ok', firstTokenMs: -5 }),
});
assert(postNegativeRes.status === 400, 'a negative *_ms field is rejected (400) — omit, never fabricate a negative');

const statsNoAuthRes = await fetch(`${base}/v1/admin/turn-display-stats`);
assert(statsNoAuthRes.status === 401, 'GET /v1/admin/turn-display-stats with no admin auth returns 401');

const statsRes = await fetch(`${base}/v1/admin/turn-display-stats`, { headers: ADMIN });
const statsBody = await statsRes.json();
assert(statsRes.status === 200 && Array.isArray(statsBody.turns) && statsBody.turns.length === 1, 'GET /v1/admin/turn-display-stats with the admin key returns the recorded rows');
assert(
  statsBody.turns[0].messageId === 'msg-http-1' && statsBody.turns[0].outcome === 'error' && statsBody.turns[0].bodyStartMs === 400,
  'rows map to the camelCase wire shape with the recorded values intact',
);

pool.statsDaysRead.length = 0;
await fetch(`${base}/v1/admin/turn-display-stats`, { headers: ADMIN });
await fetch(`${base}/v1/admin/turn-display-stats?days=9999`, { headers: ADMIN });
await fetch(`${base}/v1/admin/turn-display-stats?days=0`, { headers: ADMIN });
await fetch(`${base}/v1/admin/turn-display-stats?days=banana`, { headers: ADMIN });
assert(
  pool.statsDaysRead.join(',') === '30,365,1,30',
  `the turn-display days lookback reaches the query clamped into [1, 365] (got ${pool.statsDaysRead.join(',')})`,
);

// --- Part 4: GET /v1/chats/:chatId/turn-display-metrics/latest — the drawer's durable last turn ---
const latestNoAuthRes = await fetch(`${base}/v1/chats/chat-http/turn-display-metrics/latest`);
assert(latestNoAuthRes.status === 401, 'GET /v1/chats/:id/turn-display-metrics/latest with no chat auth returns 401');

const latestRes = await fetch(`${base}/v1/chats/chat-http/turn-display-metrics/latest`, { headers: AUTH });
const latestBody = await latestRes.json();
assert(
  latestRes.status === 200 &&
    latestBody.turn?.messageId === 'msg-http-1' &&
    latestBody.turn?.outcome === 'error' &&
    latestBody.turn?.bodyStartMs === 400 &&
    latestBody.turn?.userId === '11111111-1111-1111-1111-111111111111',
  'GET latest returns the newest recorded turn for the chat, mapped to the camelCase wire shape',
);

const latestEmptyRes = await fetch(`${base}/v1/chats/chat-other/turn-display-metrics/latest`, { headers: AUTH });
const latestEmptyBody = await latestEmptyRes.json();
assert(
  latestEmptyRes.status === 200 && latestEmptyBody.turn === null,
  'GET latest for a chat with no recorded turns returns { turn: null } — the drawer empty state, not an error',
);

server.close();

if (process.exitCode) {
  console.error('\nturn-display-metrics verification FAILED');
  process.exit(1);
}
console.log('\nturn-display-metrics verification passed');
