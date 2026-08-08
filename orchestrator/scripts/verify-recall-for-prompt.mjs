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
  const values = new Map(value ? [['canon_recall_top_k', String(value)]] : []);
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

// --- Sanity: the exported constants are what the wiring depends on ---
assert(AUTO_RECALL_PAIRS === 3, 'AUTO_RECALL_PAIRS mirrors Canonize ragClassifierHistory (3)');
assert(AUTO_RECALL_CHUNK_TOP_K === 4, 'AUTO_RECALL_CHUNK_TOP_K is the fixed full-turn count (4)');

console.log('\nrecall-for-prompt verification passed');
if (process.exitCode) process.exit(process.exitCode);
