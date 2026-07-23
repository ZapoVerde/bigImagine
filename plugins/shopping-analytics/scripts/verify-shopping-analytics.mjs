// Proves both tools end to end through info/registerTools (the real loader contract) using a
// fake Postgres pool — same approach as document-ingestion's verify-ingest.mjs. No LLM/embeddings
// stubs needed here: neither tool calls a provider, which is itself part of what this proves —
// see logPurchaseTool.ts and shoppingAnalyticsTool.ts for why.

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { info, registerTools } from '../dist/index.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const canned = [
  { item_name: 'milk', purchase_count: 3, avg_days_between: '5.5', last_purchased_at: '2026-07-20T00:00:00Z' },
  { item_name: 'eggs', purchase_count: 1, avg_days_between: null, last_purchased_at: '2026-07-01T00:00:00Z' },
];

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
          if (sql.includes('insert into shopping_logs')) {
            inserts.push({ scopedUserId, params });
            return { rows: [{ log_id: `fake-log-id-${inserts.length}` }] };
          }
          if (sql.includes('from shopping_logs')) {
            assert(scopedUserId === params[0], 'the analytics query is scoped to the requesting user');
            return { rows: canned };
          }
          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

assert(
  info.id === 'shopping-analytics' && /^[a-z0-9_-]+$/.test(info.id),
  'info.id is present and matches the id format pluginLoader.ts requires',
);

// registerTools accepts the full PluginDeps shape but this plugin uses none of it.
const pluginTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion: undefined });
assert(pluginTools.length === 2, 'registerTools returns exactly two tools');

const registry = createToolRegistry(pluginTools);
assert(registry.definitions().some((d) => d.name === 'log_purchase'), 'log_purchase is registered');
assert(
  registry.definitions().some((d) => d.name === 'get_shopping_patterns'),
  'get_shopping_patterns is registered',
);

const pool = createFakePool();
const db = createPostgresClient(pool);
const userId = '11111111-1111-1111-1111-111111111111';

// --- log_purchase ---
const logTool = registry.get('log_purchase');

const staple = await db.withUserScope(userId, (session) =>
  logTool.handler({ item_name: 'milk', is_staple: true }, { userId, db: session }),
);
assert(staple.itemName === 'milk' && staple.isStaple === true, 'a staple purchase is logged with is_staple: true');

const oneOff = await db.withUserScope(userId, (session) =>
  logTool.handler({ item_name: 'birthday candles' }, { userId, db: session }),
);
assert(oneOff.isStaple === false, 'is_staple defaults to false when omitted');

assert(pool.inserts.length === 2, 'exactly two rows were inserted');
assert(pool.inserts.every((i) => i.scopedUserId === userId), 'both inserts happened inside the correct user_id scope');
const [firstInsert] = pool.inserts;
assert(firstInsert.params[0] === userId, 'user_id column matches the requesting user');
assert(firstInsert.params[1] === 'milk', 'item_name column matches the logged item');
assert(firstInsert.params[2] === true, 'is_staple column matches the argument');

try {
  await logTool.handler({ item_name: '' }, { userId, db: await pool.connect() });
  assert(false, 'empty item_name is rejected');
} catch {
  assert(true, 'empty item_name is rejected');
}

// --- get_shopping_patterns ---
const analyticsTool = registry.get('get_shopping_patterns');
const patterns = await db.withUserScope(userId, (session) =>
  analyticsTool.handler({}, { userId, db: session }),
);

assert(patterns.length === 2, 'get_shopping_patterns returns one row per item');
const milk = patterns.find((p) => p.itemName === 'milk');
assert(milk.purchaseCount === 3, 'purchase_count is passed through');
assert(milk.avgDaysBetween === 5.5, 'a numeric avg_days_between is converted from string to number');
assert(milk.lastPurchasedAt === '2026-07-20T00:00:00Z', 'last_purchased_at is passed through');
const eggs = patterns.find((p) => p.itemName === 'eggs');
assert(eggs.avgDaysBetween === null, 'an item with only one purchase has a null avg_days_between, not 0 or NaN');

if (process.exitCode) {
  console.error('\nshopping analytics verification FAILED');
  process.exit(1);
}
console.log('\nshopping analytics verification passed');
