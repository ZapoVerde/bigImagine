// Proves io/chatMemory/recallForPrompt.ts — the CNZ-style auto-recall block that
// buildChatMemorySystemPrompt's 'rp' branch appends at prompt-assembly time. Four things to
// pin down here (verify-server.mjs only smoke-covers the read via its empty-row stubs):
//   1. buildAutoRecallQuery's turn-pairing: the last AUTO_RECALL_PAIRS pairs, a trailing lone
//      user message (the just-sent entry) counts as its own pair, leading assistants are
//      skipped, whitespace is collapsed (CNZ's cleanForEmbedding shape).
//   2. buildAutoRecallPrompt's labeled output: <memory turns> blocks for chunks, fact bullets
//      for canon rows, the "Recalled from earlier..." header only when something matched.
//   3. The fail-open contract: an embedding failure or a DB throw must resolve to '' — never
//      reject, never break the caller's Promise.all.
//   4. The RAG dynamic cutoff (migrations 0091/0092, recallCutoff.ts): both lanes' SQL fetches
//      a candidate pool (Pool Multiple × Max, capped at 40) and the settings-driven threshold
//      decides how many leading rows actually get injected — chunks per chat_memory_auto_recall_
//      chunk_min/chunk_top_k, facts per canon_recall_min/canon_recall_top_k, sharing the 0091
//      Pool Multiple/Cutoff Mode knobs. The pure math itself is pinned by verify-recall-cutoff.
//      mjs; this file proves the settings → pool → slice wiring on both lanes.
//   5. Stage 3 temporal decay (recallCutoff.decayFactor): the chunks query divides each raw
//      distance by Canonize's factor max(0.70, 1 − 0.025·ln(2·ageChunks + 1)) in SQL, ages each
//      row against the chat's newest chunk ordinal, and orders/measures the DECAYED distance —
//      decay before pool formation, Canonize's pipeline order, chat lane only.

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
      { ordinal: 7, summary: 'old scene', content: 'User: x\nAssistant: y', distance: 0.1 },
    ],
    factRows: [
      { fact_id: 'f1', category: 'plot', summary: 'the heist', detail: 'planned for Tuesday', distance: 0.1 },
      { fact_id: 'f2', category: 'person', summary: 'Mara', detail: null, distance: 0.2 },
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
    chunkRows: [{ ordinal: 1, summary: null, content: 't', distance: 0.1 }],
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
  const session = createFakeSession({ chunkRows: [{ ordinal: 1, summary: null, content: 't', distance: 0.1 }] });
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
  assert(
    seenSql.some((sql) => /from chat_chunks[\s\S]*limit 6/.test(sql)),
    'auto_recall_chunk_top_k=2 sizes the candidate pool (poolSize(2, 2) = 6), not a direct LIMIT 2',
  );
  assert(
    seenSql.some((sql) => sql.includes('from chat_chunks') && sql.includes('as distance')),
    'the chunks query selects the (Stage 3 decayed) distance so the cutoff can measure the pool',
  );
  assert(
    seenSql.some(
      (sql) => sql.includes('from chat_chunks') && sql.includes('greatest(0.70') && sql.includes('ln('),
    ),
    'the chunks query mirrors recallCutoff.decayFactor (greatest(0.70, 1 − 0.025·ln(...))) in SQL',
  );
  assert(
    seenSql.some((sql) => sql.includes('from chat_chunks') && sql.includes('(select max(ordinal) from chat_chunks')),
    'the chunks query ages each row against the chat\'s newest chunk ordinal (max(ordinal))',
  );
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
    seenSql.some((sql) => /from chat_chunks[\s\S]*limit 8/.test(sql)),
    'a corrupt auto_recall_chunk_top_k falls back to the default Max (4) → pool 8, never NaN',
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
    seenSql.some((sql) => /from chat_chunks[\s\S]*limit 24/.test(sql)),
    'an oversized auto_recall_chunk_top_k clamps to the MAX_CHUNK_TOP_K cap (12) → pool 24',
  );
}

// --- 5. The RAG dynamic cutoff (migration 0091, recallCutoff.ts): the pool + threshold drive
// what actually gets injected ---
function countChunkBlocks(block) {
  return (block.match(/<memory turns=/g) || []).length;
}

{
  // A distance-spread pool where mean and mean+1sd return visibly different counts (the plan's
  // own wiring test): top_k=8 → pool = poolSize(8, 2) = 16; mean keeps the cluster clamped to
  // Max (8), mean+1sd keeps only the clearly-matched tail (4). Settings flow into the cutoff.
  const spread = [0.15, 0.18, 0.22, 0.25, 0.30, 0.35, 0.38, 0.42, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];
  const chunkRows = spread.map((distance, i) => ({ ordinal: i + 1, summary: null, content: `c${i}`, distance }));
  const makeSession = () => ({
    async query(sql) {
      if (sql.includes('from chat_chunks')) return chunkRows;
      if (sql.includes('from canon_facts')) return [];
      return [];
    },
  });
  const meanBlock = await buildAutoRecallPrompt(
    makeSession(),
    fakeSettings(
      new Map([
        ['chat_memory_auto_recall_chunk_top_k', '8'],
        ['chat_memory_auto_recall_cutoff_mode', 'mean'],
      ]),
    ),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  const sdBlock = await buildAutoRecallPrompt(
    makeSession(),
    fakeSettings(
      new Map([
        ['chat_memory_auto_recall_chunk_top_k', '8'],
        ['chat_memory_auto_recall_cutoff_mode', 'mean+1sd'],
      ]),
    ),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(
    countChunkBlocks(meanBlock) === 8,
    `mean mode injects the strong cluster clamped to Max (got ${countChunkBlocks(meanBlock)})`,
  );
  assert(
    countChunkBlocks(sdBlock) === 4,
    `mean+1sd injects visibly fewer chunks (got ${countChunkBlocks(sdBlock)})`,
  );
}
{
  // A flat pool (no signal) collapses to the Chunk Min floor — the cutoff actually cuts.
  const flat = Array.from({ length: 16 }, (_, i) => ({ ordinal: i + 1, summary: null, content: `f${i}`, distance: 0.5 }));
  const session = {
    async query(sql) {
      if (sql.includes('from chat_chunks')) return flat;
      if (sql.includes('from canon_facts')) return [];
      return [];
    },
  };
  const block = await buildAutoRecallPrompt(
    session,
    fakeSettings(
      new Map([
        ['chat_memory_auto_recall_chunk_min', '3'],
        ['chat_memory_auto_recall_cutoff_mode', 'mean'],
      ]),
    ),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(
    countChunkBlocks(block) === 3,
    `a flat pool collapses to the Chunk Min floor (3), not the full pool (got ${countChunkBlocks(block)})`,
  );
}
{
  // A min above the Max clamps to the Max at read time — it can never bypass the cutoff by
  // being larger than the pool (top_k=2 → pool 6; min=6 would bypass, clamped min=2 floors).
  const flat = Array.from({ length: 6 }, (_, i) => ({ ordinal: i + 1, summary: null, content: `g${i}`, distance: 0.5 }));
  const session = {
    async query(sql) {
      if (sql.includes('from chat_chunks')) return flat;
      if (sql.includes('from canon_facts')) return [];
      return [];
    },
  };
  const block = await buildAutoRecallPrompt(
    session,
    fakeSettings(
      new Map([
        ['chat_memory_auto_recall_chunk_top_k', '2'],
        ['chat_memory_auto_recall_chunk_min', '6'],
      ]),
    ),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(
    countChunkBlocks(block) === 2,
    `a min above the Max clamps to the Max (2) — the floor can never exceed the ceiling (got ${countChunkBlocks(block)})`,
  );
}
{
  // Pool Multiple drives the SQL pool: P=5 with top_k=2 → poolSize(2, 5) = 10 → LIMIT 10.
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
    fakeSettings(
      new Map([
        ['chat_memory_auto_recall_chunk_top_k', '2'],
        ['chat_memory_auto_recall_pool_multiple', '5'],
      ]),
    ),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(
    seenSql.some((sql) => /from chat_chunks[\s\S]*limit 10/.test(sql)),
    'chat_memory_auto_recall_pool_multiple=5 sizes the pool (poolSize(2, 5) = 10)',
  );
}
{
  // The pool caps at MAX_POOL_SIZE (40): top_k=999 clamps to 12, P=5 → poolSize(12, 5) = 60 → 40.
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
    fakeSettings(
      new Map([
        ['chat_memory_auto_recall_chunk_top_k', '999'],
        ['chat_memory_auto_recall_pool_multiple', '5'],
      ]),
    ),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(
    seenSql.some((sql) => /from chat_chunks[\s\S]*limit 40/.test(sql)),
    'the candidate pool is capped at MAX_POOL_SIZE (40), never an unbounded LIMIT',
  );
}

// --- 6. Stage 2: the same dynamic cutoff wired onto the canon_facts lane ---
// The shared 0091 knobs (Pool Multiple, Cutoff Mode) apply unchanged; the per-channel Max is
// canon_recall_top_k and the new Min floor is canon_recall_min (migration 0092). Facts are
// deduped per arc/entity by the query CTE before the cutoff measures their pool.
function countFactBullets(block) {
  return (block.match(/- \[/g) || []).length;
}

{
  // The plan's own wiring test for the fact lane: a distance-spread pool where mean and
  // mean+1sd return visibly different fact counts. canon_recall_top_k=8 → fact pool =
  // poolSize(8, 2) = 16; mean keeps the cluster clamped to Max (8), mean+1sd keeps only the
  // clearly-matched tail (4).
  const spread = [0.15, 0.18, 0.22, 0.25, 0.30, 0.35, 0.38, 0.42, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];
  const factRows = spread.map((distance, i) => ({
    fact_id: `f${i + 1}`,
    category: 'plot',
    summary: `fact ${i + 1}`,
    detail: null,
    distance,
  }));
  const makeSession = () => ({
    async query(sql) {
      if (sql.includes('from canon_facts')) return factRows;
      if (sql.includes('from chat_chunks')) return [];
      return [];
    },
  });
  const meanBlock = await buildAutoRecallPrompt(
    makeSession(),
    fakeSettings(
      new Map([
        ['canon_recall_top_k', '8'],
        ['chat_memory_auto_recall_cutoff_mode', 'mean'],
      ]),
    ),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  const sdBlock = await buildAutoRecallPrompt(
    makeSession(),
    fakeSettings(
      new Map([
        ['canon_recall_top_k', '8'],
        ['chat_memory_auto_recall_cutoff_mode', 'mean+1sd'],
      ]),
    ),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(
    countFactBullets(meanBlock) === 8,
    `mean mode injects the fact cluster clamped to Max (got ${countFactBullets(meanBlock)})`,
  );
  assert(
    countFactBullets(sdBlock) === 4,
    `mean+1sd injects visibly fewer facts (got ${countFactBullets(sdBlock)})`,
  );
}
{
  // A flat fact pool (no signal) collapses to the Canon facts Min floor.
  const flat = Array.from({ length: 16 }, (_, i) => ({
    fact_id: `ff${i}`,
    category: 'plot',
    summary: `flat ${i}`,
    detail: null,
    distance: 0.5,
  }));
  const session = {
    async query(sql) {
      if (sql.includes('from canon_facts')) return flat;
      if (sql.includes('from chat_chunks')) return [];
      return [];
    },
  };
  const block = await buildAutoRecallPrompt(
    session,
    fakeSettings(
      new Map([
        ['canon_recall_min', '3'],
        ['chat_memory_auto_recall_cutoff_mode', 'mean'],
      ]),
    ),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(
    countFactBullets(block) === 3,
    `a flat fact pool collapses to the Canon facts Min floor (3), not the full pool (got ${countFactBullets(block)})`,
  );
}
{
  // A fact Min above the fact Max clamps to the Max at read time (canon_recall_top_k=2 →
  // fact pool 6; min=6 would bypass, clamped min=2 floors).
  const flat = Array.from({ length: 6 }, (_, i) => ({
    fact_id: `fg${i}`,
    category: 'plot',
    summary: `g ${i}`,
    detail: null,
    distance: 0.5,
  }));
  const session = {
    async query(sql) {
      if (sql.includes('from canon_facts')) return flat;
      if (sql.includes('from chat_chunks')) return [];
      return [];
    },
  };
  const block = await buildAutoRecallPrompt(
    session,
    fakeSettings(
      new Map([
        ['canon_recall_top_k', '2'],
        ['canon_recall_min', '6'],
      ]),
    ),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(
    countFactBullets(block) === 2,
    `a fact Min above the Max clamps to the Max (2) — the floor can never exceed the ceiling (got ${countFactBullets(block)})`,
  );
}
{
  // The fact lane's SQL: the query selects the raw distance, and its LIMIT is the fact pool
  // (canon_recall_top_k=2 → poolSize(2, 2) = 6) bound as the $4 parameter — not a flat LIMIT 2.
  const seenSql = [];
  const seenParams = [];
  const session = {
    async query(sql, params) {
      seenSql.push(sql);
      if (params) seenParams.push(params);
      if (sql.includes('from canon_facts')) return [];
      if (sql.includes('from chat_chunks')) return [];
      return [];
    },
  };
  await buildAutoRecallPrompt(
    session,
    fakeSettings(new Map([['canon_recall_top_k', '2']])),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  const factSql = seenSql.find((sql) => sql.includes('from canon_facts'));
  const factParams = seenParams.find((params, i) => seenSql[i].includes('from canon_facts'));
  assert(
    factParams && factParams[3] === 6,
    'canon_recall_top_k=2 sizes the fact candidate pool ($4 bound to poolSize(2, 2) = 6)',
  );
  assert(
    factSql && factSql.includes('as distance'),
    'the canon_facts query selects the raw distance so the cutoff can measure the fact pool',
  );
}

// --- Sanity: the exported constants are what the wiring depends on ---
assert(AUTO_RECALL_PAIRS === 3, 'AUTO_RECALL_PAIRS mirrors Canonize ragClassifierHistory (3)');
assert(AUTO_RECALL_CHUNK_TOP_K === 4, 'AUTO_RECALL_CHUNK_TOP_K is the default Max for the dynamic cutoff (4)');

console.log('\nrecall-for-prompt verification passed');
if (process.exitCode) process.exit(process.exitCode);
