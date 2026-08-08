// Proves io/chatMemory/recallForPrompt.ts — the CNZ-style auto-recall block that
// buildChatMemorySystemPrompt's 'rp' branch appends at prompt-assembly time. Three things to
// pin down here (verify-server.mjs only smoke-covers the read via its empty-row stubs):
//   1. buildAutoRecallQuery's turn-pairing: the last AUTO_RECALL_PAIRS pairs, a trailing lone
//      user message (the just-sent entry) counts as its own pair, leading assistants are
//      skipped, whitespace is collapsed (CNZ's cleanForEmbedding shape).
//   2. buildAutoRecallPrompt's labeled output: <memory turns> blocks for chunks, fact bullets
//      for canon rows, the "Recalled from earlier..." header only when something matched.
//   3. The fail-open contract: an embedding failure or a DB throw must resolve to '' — never
//      reject, never break the caller's Promise.all.

import { createStubEmbeddingProvider } from '../dist/io/embeddings/stub.js';
import {
  AUTO_RECALL_PAIRS,
  AUTO_RECALL_CHUNK_TOP_K,
  buildAutoRecallPrompt,
  buildAutoRecallQuery,
} from '../dist/io/chatMemory/recallForPrompt.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake session: DbSession.query returns T[] directly (postgres.ts), NOT pg's {rows} shape
// (that unwrap happens inside withUserScope's inTransaction). The fake is a session-shaped
// object so buildAutoRecallPrompt can be driven without a PostgresClient at all.
function createFakeSession({ chunkRows = [], factRows = [], throwOn = null } = {}) {
  return {
    async query(sql) {
      if (sql.includes('from chat_chunks')) {
        if (throwOn === 'chunks') throw new Error('chunks boom');
        return chunkRows;
      }
      if (sql.includes('from canon_facts')) {
        if (throwOn === 'facts') throw new Error('facts boom');
        return factRows;
      }
      return [];
    },
  };
}

function fakeSettings(value) {
  // value may be a single canon_recall_top_k (legacy call sites) or a full map of key → raw.
  const entries =
    value && !(value instanceof Map)
      ? [['canon_recall_top_k', String(value)]]
      : value instanceof Map
        ? [...value.entries()]
        : [];
  const values = new Map(entries);
  return { get: (k) => Promise.resolve(values.get(k)) };
}

// --- 1. buildAutoRecallQuery: pairing + trailing lone user + clean ---
{
  const q = buildAutoRecallQuery([
    { role: 'user', content: 'first   user' },
    { role: 'assistant', content: 'first   assistant' },
    { role: 'user', content: 'second user' },
    { role: 'assistant', content: 'second assistant' },
  ], 2);
  assert(
    q === 'User: first user Assistant: first assistant User: second user Assistant: second assistant',
    'pairing joins user+assistant into turns, whitespace collapsed, last 2 pairs kept',
  );
}
{
  const q = buildAutoRecallQuery([
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' }, // trailing lone user — the just-sent entry
  ], 2);
  assert(
    q === 'User: one Assistant: two User: three',
    'a trailing lone user message counts as its own pair (the user\'s last entry is always included)',
  );
}
{
  const q = buildAutoRecallQuery([
    { role: 'assistant', content: 'leading assistant skipped' },
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ], 3);
  assert(q === 'User: a Assistant: b', 'a leading assistant with no prior user is skipped, not mispaired');
}
{
  const q = buildAutoRecallQuery([{ role: 'user', content: '  a   b\n\nc  ' }], 3);
  assert(q === 'User: a b c', 'whitespace is collapsed to single spaces (cleanForEmbedding shape)');
}
{
  const q = buildAutoRecallQuery([], 3);
  assert(q === '', 'an empty message list yields an empty query (fail-open input)');
}

// --- 2. buildAutoRecallPrompt: labeled output ---
{
  const session = createFakeSession({
    chunkRows: [
      { ordinal: 7, summary: 'old scene', content: 'User: x\nAssistant: y' },
    ],
    factRows: [
      { fact_id: 'f1', category: 'plot', summary: 'the heist', detail: 'planned for Tuesday' },
      { fact_id: 'f2', category: 'person', summary: 'Mara', detail: null },
    ],
  });
  const block = await buildAutoRecallPrompt(
    session,
    fakeSettings(5),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'last entry' }],
  );
  assert(
    block.startsWith('Recalled from earlier in this conversation (archived):'),
    'block opens with the labeled header',
  );
  assert(
    block.includes('<memory turns="7">\nUser: x\nAssistant: y\n</memory>'),
    'chunk content is wrapped in a <memory turns> block with its ordinal',
  );
  assert(
    block.includes('- [plot] the heist — planned for Tuesday') && block.includes('- [person] Mara'),
    'canon facts render as [category] summary — detail bullets',
  );
}
{
  // Empty reads (no chunks, no facts) → '' — a silent no-match, same as CNZ's nothing-to-inject.
  const session = createFakeSession();
  const block = await buildAutoRecallPrompt(
    session,
    fakeSettings(),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(block === '', 'no matches at all → empty block, nothing injected');
}
{
  // Corrupt canon_recall_top_k must fall back to the default, never reach `limit NaN`.
  const session = createFakeSession({
    chunkRows: [{ ordinal: 1, summary: null, content: 't' }],
  });
  const block = await buildAutoRecallPrompt(
    session,
    fakeSettings('not-a-number'),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(block.includes('<memory turns="1">'), 'a corrupt canon_recall_top_k falls back to the default top-k, not NaN');
}

// --- 3. Fail-open: any retrieval failure resolves to '', never rejects ---
{
  for (const throwOn of ['chunks', 'facts']) {
    const session = createFakeSession({ throwOn });
    const block = await buildAutoRecallPrompt(
      session,
      fakeSettings(),
      createStubEmbeddingProvider(8),
      'user-1',
      'chat-1',
      [{ role: 'user', content: 'hi' }],
    );
    assert(block === '', `a DB failure on ${throwOn} resolves to '' (fail-open, no rejection)`);
  }
}
{
  const explodingEmbeddings = {
    name: 'boom',
    dimension: 8,
    embed: async () => {
      throw new Error('embedding provider down');
    },
  };
  const session = createFakeSession();
  const block = await buildAutoRecallPrompt(
    session,
    fakeSettings(),
    explodingEmbeddings,
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(block === '', "an embedding failure resolves to '' (fail-open)");
}

// --- 4. The three retrieval knobs (migration 0077) drive the read path ---
{
  // enabled='false' must short-circuit before any embedding/DB call (the master switch).
  const session = createFakeSession({ chunkRows: [{ ordinal: 1, summary: null, content: 't' }] });
  const seen = [];
  const probingEmbeddings = {
    name: 's',
    dimension: 8,
    embed: async (texts) => {
      seen.push(...texts);
      return texts.map(() => [1, 2, 3, 4, 5, 6, 7, 8]);
    },
  };
  const block = await buildAutoRecallPrompt(
    session,
    fakeSettings(new Map([['chat_memory_auto_recall_enabled', 'false']])),
    probingEmbeddings,
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(block === '', "auto_recall_enabled='false' disables the injection entirely");
  assert(seen.length === 0, "enabled='false' never even embeds (no query, no DB call)");
}
{
  // pairs + chunk top-k override the query size and the SQL limit, from settings not constants.
  const seenSql = [];
  const session = {
    async query(sql) {
      seenSql.push(sql);
      if (sql.includes('from chat_chunks')) return [];
      if (sql.includes('from canon_facts')) return [];
      return [];
    },
  };
  const seenQueries = [];
  const probingEmbeddings = {
    name: 's',
    dimension: 8,
    embed: async (texts) => {
      seenQueries.push(...texts);
      return texts.map(() => [1, 2, 3, 4, 5, 6, 7, 8]);
    },
  };
  const block = await buildAutoRecallPrompt(
    session,
    fakeSettings(
      new Map([
        ['chat_memory_auto_recall_pairs', '2'],
        ['chat_memory_auto_recall_chunk_top_k', '2'],
      ]),
    ),
    probingEmbeddings,
    'user-1',
    'chat-1',
    [
      { role: 'user', content: 'p1u' },
      { role: 'assistant', content: 'p1a' },
      { role: 'user', content: 'p2u' },
      { role: 'assistant', content: 'p2a' },
      { role: 'user', content: 'p3u' },
      { role: 'assistant', content: 'p3a' },
    ],
  );
  assert(block === '', 'no matches → empty block');
  assert(
    seenQueries[0] === 'User: p2u Assistant: p2a User: p3u Assistant: p3a',
    'auto_recall_pairs=2 keeps only the last 2 turn-pairs in the query',
  );
  assert(seenSql.some((sql) => /from chat_chunks[\s\S]*limit 2/.test(sql)), 'auto_recall_chunk_top_k=2 becomes the chunks SQL limit');
}
{
  // A corrupt chunk top-k falls back to the constant default, never a NaN limit.
  const seenSql = [];
  const session = {
    async query(sql) {
      seenSql.push(sql);
      if (sql.includes('from chat_chunks')) return [];
      if (sql.includes('from canon_facts')) return [];
      return [];
    },
  };
  await buildAutoRecallPrompt(
    session,
    fakeSettings(new Map([['chat_memory_auto_recall_chunk_top_k', 'not-a-number']])),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(
    seenSql.some((sql) => /from chat_chunks[\s\S]*limit 4/.test(sql)),
    'a corrupt auto_recall_chunk_top_k falls back to the default limit (4), not NaN',
  );
}
{
  // A huge (corrupt or mis-set) chunk top-k clamps to MAX_CHUNK_TOP_K, never an unbounded limit.
  const seenSql = [];
  const session = {
    async query(sql) {
      seenSql.push(sql);
      if (sql.includes('from chat_chunks')) return [];
      if (sql.includes('from canon_facts')) return [];
      return [];
    },
  };
  await buildAutoRecallPrompt(
    session,
    fakeSettings(new Map([['chat_memory_auto_recall_chunk_top_k', '999']])),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(
    seenSql.some((sql) => /from chat_chunks[\s\S]*limit 12/.test(sql)),
    'an oversized auto_recall_chunk_top_k clamps to the MAX_CHUNK_TOP_K cap (12)',
  );
}

// --- Sanity: the exported constants are what the wiring depends on ---
assert(AUTO_RECALL_PAIRS === 3, 'AUTO_RECALL_PAIRS mirrors Canonize ragClassifierHistory (3)');
assert(AUTO_RECALL_CHUNK_TOP_K === 4, 'AUTO_RECALL_CHUNK_TOP_K is the fixed full-turn count (4)');

console.log('\nrecall-for-prompt verification passed');
if (process.exitCode) process.exit(process.exitCode);
