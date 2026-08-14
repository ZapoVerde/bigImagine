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
//      distance by Canonize's factor max(0.70, 1 − 0.025·ln(pairsPerChunk·ageChunks + 1)) in SQL
//      (pairsPerChunk bound as $5 — the live chat_memory_chunk_pairs setting, default 2), ages
//      each row against the chat's newest chunk ordinal, and orders/measures the DECAYED
//      distance — decay before pool formation, Canonize's pipeline order, chat lane only.
//   6. Stage 4 keyword lane (recallCutoff.blendKeyword, migration 0093): the chunks query
//      scores every row with ts_rank(content_tsv, ...) as kw_score (tsquery = the OR of the
//      query text's lexemes), fetches the KEYWORD_WINDOW_SIZE window (≥ the pool) instead of
//      the pool alone, and the blend re-ranks the window by blended distance before the cutoff
//      — a strong keyword hit can promote a mediocre vector match into the injected set.
//   7. Stage 5 header lane (recallCutoff.mergeLanes/dualBonus, migration 0094): the chunk
//      path issues a SECOND chat_chunks query against summary_vector_embed (same decayed
//      distance, NULL rows skipped, same window), fuses the two windows with best-of scoring
//      + the 1.08× dual-confirmation bonus before the keyword blend, and can recall chunks
//      the content lane never fetched.

import { createStubEmbeddingProvider } from '../dist/io/embeddings/stub.js';
import {
  AUTO_RECALL_PAIRS,
  AUTO_RECALL_CHUNK_TOP_K,
  DEFAULT_LEAD_IN_CHUNKS,
  MAX_LEAD_IN_CHUNKS,
  DEFAULT_PLOT_TOP_K,
  DEFAULT_PLOT_MIN,
  DEFAULT_PLOT_FLOOR_SYNCS,
  buildAutoRecallPrompt,
  buildAutoRecallParts,
  buildAutoRecallQuery,
} from '../dist/io/chatMemory/recallForPrompt.js';
import { reduceArcEntries } from '../dist/io/chatMemory/recallPlotLane.js';

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
// The fake pool matches by SQL substring (the documented verify-script hazard): the plot lane
// (recallPlotLane.ts) issues THREE canon_facts-shaped queries that must not be confused with the
// fact lane's — discriminated here by `category = 'plot'` first, then chat_sync_points (the
// recency-floor query) and `arc_tag = $3` (the per-arc card-history query).
function createFakeSession({
  chunkRows = [],
  headerRows = [],
  factRows = [],
  plotPoolRows = [],
  plotFloorRows = [],
  plotHistoryByArc = {},
  leadInRows = [],
  throwOn = null,
} = {}) {
  const seenSql = [];
  const seenCalls = [];
  return {
    seenSql,
    seenCalls,
    async query(sql, params) {
      seenSql.push(sql);
      seenCalls.push({ sql, params });
      // Lead-in CTE (chunkLeadIn.ts, migration 0100) — checked BEFORE the generic
      // `from chat_chunks` lane matcher below, because both the CTE's seed and recursive arms
      // embed `from chat_chunks`.
      if (sql.includes('with recursive lead_in')) return leadInRows;
      if (sql.includes('from chat_chunks')) {
        if (throwOn === 'chunks') throw new Error('chunks boom');
        // Stage 5: the chunk path issues TWO chat_chunks queries — the content lane
        // (vector_embed <->) and the header lane (summary_vector_embed <->).
        if (sql.includes('summary_vector_embed')) return headerRows;
        return chunkRows;
      }
      if (sql.includes("category = 'plot'") && sql.includes('from canon_facts')) {
        if (throwOn === 'plots') throw new Error('plots boom');
        if (sql.includes('from chat_sync_points')) return plotFloorRows;
        if (sql.includes('arc_tag = $3')) return plotHistoryByArc[params?.[2]] ?? [];
        return plotPoolRows;
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
      { ordinal: 7, summary: 'old scene', content: 'User: x\nAssistant: y', distance: 0.1, kw_score: 0 },
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
    chunkRows: [{ ordinal: 1, summary: null, content: 't', distance: 0.1, kw_score: 0 }],
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
  const session = createFakeSession({ chunkRows: [{ ordinal: 1, summary: null, content: 't', distance: 0.1, kw_score: 0 }] });
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
  const seenChunkParams = [];
  const session = {
    async query(sql, params) {
      seenSql.push(sql);
      if (sql.includes('from chat_chunks')) {
        seenChunkParams.push(params ?? []);
        return [];
      }
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
    seenSql.some((sql) => /from chat_chunks[\s\S]*limit 100/.test(sql)),
    'auto_recall_chunk_top_k=2 still fetches the keyword window (≥ pool 6 → limit 100), not a direct LIMIT 2',
  );
  assert(
    seenSql.some((sql) => sql.includes('from chat_chunks') && sql.includes('as distance')),
    'the chunks query selects the (Stage 3 decayed) distance so the cutoff can measure the pool',
  );
  assert(
    seenSql.some((sql) => sql.includes('from chat_chunks') && sql.includes('ts_rank(content_tsv')),
    'the chunks query scores every row with ts_rank over content_tsv (the Stage 4 keyword lane)',
  );
  assert(
    seenSql.some((sql) => sql.includes('from chat_chunks') && sql.includes("to_tsvector('english', $4)")),
    "the chunks query builds the keyword tsquery from the embedded query text's lexemes (to_tsvector('english', $4))",
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
  assert(
    seenSql.some((sql) => sql.includes('summary_vector_embed <-> $3') && sql.includes('greatest(0.70')),
    'the header lane query (Stage 5) measures the same decayed distance against summary_vector_embed',
  );
  assert(
    seenSql.some((sql) => sql.includes('summary_vector_embed') && sql.includes('is not null')),
    'the header lane skips rows that predate migration 0094 (summary_vector_embed IS NOT NULL)',
  );
  assert(
    seenSql.some((sql) => sql.includes('summary_vector_embed') && sql.includes('ts_rank(content_tsv')),
    'the header lane computes the same lane-independent keyword score (ts_rank over content_tsv)',
  );
  assert(
    seenSql.some((sql) => /summary_vector_embed[\s\S]*limit 100/.test(sql)),
    'the header lane fetches the same KEYWORD_WINDOW window (limit 100)',
  );
  assert(
    seenSql.filter((sql) => sql.includes('from chat_chunks') && sql.includes('as distance')).length === 2,
    'the chunk path issues exactly two chat_chunks queries — the content lane and the header lane',
  );
  assert(
    seenSql.some((sql) => sql.includes('from chat_chunks') && sql.includes('ln($5 * greatest(0')),
    "the chunks query takes the chunk size as the $5 bound parameter — decay(age, pairs) is live",
  );
  assert(
    seenSql.every((sql) => !sql.includes('ln(2 *')),
    'no chat_chunks query hardcodes the old ln(2 * age) decay — the parameterization replaced it',
  );
  assert(
    seenChunkParams.some((params) => params.length === 5 && params[4] === 2),
    "the decay's $5 parameter is the chunk size in pairs (2, the default when the setting is unset)",
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
    seenSql.some((sql) => /from chat_chunks[\s\S]*limit 100/.test(sql)),
    'a corrupt auto_recall_chunk_top_k falls back to the default Max (8) → window 100, never NaN',
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
    seenSql.some((sql) => /from chat_chunks[\s\S]*limit 100/.test(sql)),
    'an oversized auto_recall_chunk_top_k clamps to the MAX_CHUNK_TOP_K cap (12) → window 100, never unbounded',
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
  const chunkRows = spread.map((distance, i) => ({ ordinal: i + 1, summary: null, content: `c${i}`, distance, kw_score: 0 }));
  const makeSession = () => ({
    async query(sql) {
      if (sql.includes('from chat_chunks')) {
        if (sql.includes('summary_vector_embed')) return []; // Stage 5: header lane inert in this fixture
        return chunkRows;
      }
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
  const flat = Array.from({ length: 16 }, (_, i) => ({ ordinal: i + 1, summary: null, content: `f${i}`, distance: 0.5, kw_score: 0 }));
  const session = {
    async query(sql) {
      if (sql.includes('from chat_chunks')) {
        if (sql.includes('summary_vector_embed')) return []; // Stage 5: header lane inert in this fixture
        return flat;
      }
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
  const flat = Array.from({ length: 6 }, (_, i) => ({ ordinal: i + 1, summary: null, content: `g${i}`, distance: 0.5, kw_score: 0 }));
  const session = {
    async query(sql) {
      if (sql.includes('from chat_chunks')) {
        if (sql.includes('summary_vector_embed')) return []; // Stage 5: header lane inert in this fixture
        return flat;
      }
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
  // Pool Multiple still floors the chunk window (the pool concept survives as the window floor
  // and the fact lane's LIMIT): P=5 with top_k=2 → poolSize(2, 5) = 10 → window = max(10, 100).
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
    seenSql.some((sql) => /from chat_chunks[\s\S]*limit 100/.test(sql)),
    'chat_memory_auto_recall_pool_multiple=5 still floors the window above the pool (window ≥ pool 10 → limit 100)',
  );
}
{
  // The chunk fetch is bounded by the keyword window (100), not the old MAX_POOL_SIZE (40):
  // top_k=999 clamps to 12, P=5 → poolSize(12, 5) = 60 → capped pool 40 → window 100.
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
    seenSql.some((sql) => /from chat_chunks[\s\S]*limit 100/.test(sql)),
    'the keyword window caps the chunk fetch (100) — never an unbounded LIMIT',
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
      if (sql.includes("category = 'plot'") && sql.includes('from canon_facts')) return [];
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
      if (sql.includes("category = 'plot'") && sql.includes('from canon_facts')) return [];
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
      if (sql.includes("category = 'plot'") && sql.includes('from canon_facts')) return [];
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
  // The plot lane also queries canon_facts (its pool query), so pick the FACT lane's query by
  // its distinct-on-coalesce CTE marker — the fake pool's exact-substring matching hazard the
  // plan's Files section warns about.
  const factSqlIndex = seenSql.findIndex(
    (sql) => sql.includes('from canon_facts') && sql.includes('distinct on (coalesce'),
  );
  const factSql = seenSql[factSqlIndex];
  const factParams = seenParams[factSqlIndex];
  assert(
    factParams && factParams[3] === 6,
    'canon_recall_top_k=2 sizes the fact candidate pool ($4 bound to poolSize(2, 2) = 6)',
  );
  assert(
    factSql && factSql.includes('as distance'),
    'the canon_facts query selects the raw distance so the cutoff can measure the fact pool',
  );
}

// --- 7. Stage 4: the keyword blend re-ranks the chunk window before the cutoff ---
{
  // The plan's own wiring test for the keyword lane: the same distance-spread window as the
  // cutoff tests, but ordinal 10 (distance 0.50 — a mediocre vector match) carries the ONLY
  // keyword hit (kw_score 100). Without the blend, mean+1sd keeps ordinals 1-4 (threshold ≈
  // 0.2525) and ordinal 10 stays out. With the blend, ordinal 10's distance collapses to ≈
  // 0.078 (top keyword + 30% of the top vector similarity) — it is injected while marginal
  // rows drop out. Proves the blend is wired into buildAutoRecallParts's chunk path end to
  // end, not just unit-tested in isolation (the fake window mirrors the real SQL, which now
  // selects kw_score).
  const spread = [0.15, 0.18, 0.22, 0.25, 0.30, 0.35, 0.38, 0.42, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];
  const makeRows = (keywordOnOrdinal10) =>
    spread.map((distance, i) => ({
      ordinal: i + 1,
      summary: null,
      content: `c${i + 1}`,
      distance,
      kw_score: keywordOnOrdinal10 && i === 9 ? 100 : 0,
    }));
  const run = (rows) =>
    buildAutoRecallPrompt(
      {
        async query(sql) {
          if (sql.includes('from chat_chunks')) {
            if (sql.includes('summary_vector_embed')) return []; // Stage 5: header lane inert in this fixture
            return rows;
          }
          if (sql.includes('from canon_facts')) return [];
          return [];
        },
      },
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
  const baseline = await run(makeRows(false));
  const blended = await run(makeRows(true));
  assert(!baseline.includes('<memory turns="10">'), 'without a keyword hit the mediocre vector match is NOT injected');
  assert(blended.includes('<memory turns="10">'), 'the keyword blend promotes the mediocre vector match into the injected set');
}

// --- 8. Stage 5: the header lane can ADD recall the content lane missed ---
{
  // A chunk the content lane never fetched (ordinal 30 — no row in the content window at all)
  // but whose summary embedding is the closest match of all. mergeLanes fuses the two windows
  // (the header-only row joins with its header distance), the blend keeps it unchanged (no
  // keyword), and mean+1sd over the fused pool injects it. Without the header lane the chunk
  // simply does not exist in the window — this proves the header lane is wired end to end into
  // buildAutoRecallParts's chunk path, not just unit-tested.
  const spread = [0.15, 0.18, 0.22, 0.25, 0.30, 0.35, 0.38, 0.42, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];
  const chunkRows = spread.map((distance, i) => ({ ordinal: i + 1, summary: null, content: `c${i + 1}`, distance, kw_score: 0 }));
  const headerRows = [{ ordinal: 30, summary: 's30', content: 'header-only chunk', distance: 0.05, kw_score: 0 }];
  const run = (withHeader) =>
    buildAutoRecallPrompt(
      {
        async query(sql) {
          if (sql.includes('from chat_chunks')) {
            if (sql.includes('summary_vector_embed')) return withHeader ? headerRows : [];
            return chunkRows;
          }
          if (sql.includes('from canon_facts')) return [];
          return [];
        },
      },
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
  const withoutHeader = await run(false);
  const withHeader = await run(true);
  assert(!withoutHeader.includes('<memory turns="30">'), 'without the header lane the chunk is not recalled at all');
  assert(withHeader.includes('<memory turns="30">'), 'the header lane recalls a chunk the content lane never fetched');
}

// --- 9. Status filter (plot-arc-recall-plan.md §15 flag): the silent lanes read
// `status <> 'rejected'`, and the fact lane's dedup tie-break falls back to proposed_at so a
// freshly-proposed row (no approved_at yet) keeps its per-arc/entity dedup win ---
{
  const seenSql = [];
  const session = {
    async query(sql) {
      seenSql.push(sql);
      if (sql.includes('from chat_chunks')) return [];
      if (sql.includes("category = 'plot'") && sql.includes('from canon_facts')) return [];
      if (sql.includes('from canon_facts')) return [];
      return [];
    },
  };
  await buildAutoRecallPrompt(
    session,
    fakeSettings(),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  const factSql = seenSql.find((sql) => sql.includes('from canon_facts') && sql.includes('coalesce'));
  assert(
    factSql && factSql.includes("f.status <> 'rejected'"),
    "the fact lane reads status <> 'rejected' — a proposed fact is eligible for silent injection the moment it exists (never a one-sync-cycle lag)",
  );
  assert(
    factSql && factSql.includes('coalesce(approved_at, proposed_at)'),
    'the fact-lane dedup tie-break falls back to proposed_at when approved_at is null — a fresh proposed row wins its arc/entity over a stale approved row',
  );
}
{
  // A rejected row must never reach the lanes' queries at all (both lanes filter it in SQL).
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
    fakeSettings(),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  const plotPoolSql = seenSql.find(
    (sql) => sql.includes("category = 'plot'") && sql.includes('from canon_facts') && !sql.includes('chat_sync_points') && !sql.includes('arc_tag = $3'),
  );
  assert(
    plotPoolSql && plotPoolSql.includes("f.status <> 'rejected'"),
    "the plot lane's pool query filters status <> 'rejected' too — a rejected row is the only row for an arc and the arc simply never appears",
  );
}

// --- 10. The ranked plot-arc lane (recallPlotLane.ts, migration 0097): selection, recency
// floor, bounding, and card reduction — exercised through buildAutoRecallParts with the fake
// pool standing in for the real SQL ---
{
  // The per-arc card-history query is a SEPARATE step from arc selection: the pool row that
  // got the arc selected (its best-scoring beat) is not what the card renders — the card is
  // built from the arc's full current history (first + last three). Here the matching pool row
  // says 'old match' but the history has 5 current entries: the card shows f1, f3, f4, f5.
  const five = [
    { summary: 'f1', detail: '' },
    { summary: 'f2', detail: '' },
    { summary: 'f3', detail: '' },
    { summary: 'f4', detail: '' },
    { summary: 'f5', detail: '' },
  ];
  const parts = await buildAutoRecallParts(
    createFakeSession({
      plotPoolRows: [{ arc_tag: 'heist', summary: 'old match beat', detail: '', distance: 0.1 }],
      plotHistoryByArc: { heist: five },
    }),
    fakeSettings(),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(parts.plots.length === 1 && parts.plots[0].arc_tag === 'heist', 'the arc whose best-scoring row matched is selected');
  assert(
    parts.plots[0].entries.map((e) => e.summary).join(',') === 'f1,f3,f4,f5',
    'the card contains the CURRENT first + last-three history (f1, f3, f4, f5), not the matching pool row — selection and card content are separate steps',
  );
}
{
  // Card reduction, directly on the pure reducer: <= 4 entries keep everything (the plan's
  // Edge Cases: the `<= 4` branch, NOT `>= 4`, or a 4-entry arc's first item double-counts).
  assert(reduceArcEntries([1, 2, 3]).join(',') === '1,2,3', '3 entries return all 3, undeduplicated, in original order');
  assert(reduceArcEntries([1, 2, 3, 4]).join(',') === '1,2,3,4', '4 entries return all 4 — no double-count of the first item');
  assert(reduceArcEntries([1, 2, 3, 4, 5]).join(',') === '1,3,4,5', '5 entries reduce to first + last three (1, 3, 4, 5)');
  assert(reduceArcEntries([1]).join(',') === '1', 'a single-entry arc collapses to that one entry');
}
{
  // Recency floor vs. semantic cutoff: two arcs with equally poor scores (pool mean = 0.9 →
  // nothing clears the threshold → floored to Min 1, so only the first-ranked arc survives the
  // cutoff). The arc the cutoff dropped comes back ONLY via the recency floor.
  const plotPoolRows = [
    { arc_tag: 'a', summary: 'a beat', detail: '', distance: 0.9 },
    { arc_tag: 'b', summary: 'b beat', detail: '', distance: 0.9 },
  ];
  const hist = { a: [{ summary: 'a beat', detail: '' }], b: [{ summary: 'b beat', detail: '' }] };
  const run = (plotFloorRows) =>
    buildAutoRecallParts(
      createFakeSession({ plotPoolRows, plotFloorRows, plotHistoryByArc: hist }),
      fakeSettings(),
      createStubEmbeddingProvider(8),
      'user-1',
      'chat-1',
      [{ role: 'user', content: 'hi' }],
    );
  const withoutFloor = await run([]);
  const withFloor = await run([{ arc_tag: 'b' }]);
  assert(
    withoutFloor.plots.map((p) => p.arc_tag).join(',') === 'a',
    'an equally low-score arc with no recent-sync-tick row is not selected by the semantic cutoff alone',
  );
  assert(
    withFloor.plots.map((p) => p.arc_tag).join(',') === 'a,b',
    'an equally low-score arc with a row from the recent sync ticks is selected via the recency floor (Canonize\'s recency-based filler)',
  );
}
{
  // Bounding: the scored set ALONE already fills Max (6 scored arcs, Min 6 keeps them all via
  // the cold-pool bypass) + 2 floor-only arcs. This is the real stress case for the floor's
  // "guarantee of inclusion" — with the scored set already at capacity, the floor arcs must
  // still land by displacing the weakest scored arcs, not get silently dropped for lack of room.
  const scored = Array.from({ length: 6 }, (_, i) => ({
    arc_tag: `scored-${i}`,
    summary: `s${i}`,
    detail: '',
    distance: 0.1 + i * 0.01,
  }));
  const hist = {};
  for (const row of [...scored, { arc_tag: 'floor-a' }, { arc_tag: 'floor-b' }]) {
    hist[row.arc_tag] = [{ summary: `${row.arc_tag} beat`, detail: '' }];
  }
  const parts = await buildAutoRecallParts(
    createFakeSession({
      plotPoolRows: scored,
      plotFloorRows: [{ arc_tag: 'floor-a' }, { arc_tag: 'floor-b' }],
      plotHistoryByArc: hist,
    }),
    fakeSettings(new Map([['chat_memory_plot_recall_top_k', '6'], ['chat_memory_plot_recall_min', '6']])),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  const tags = parts.plots.map((p) => p.arc_tag);
  assert(tags.length === 6, `with more qualifying arcs than Max, exactly Max arcs are returned (got ${tags.length})`);
  assert(tags.slice(0, 4).join(',') === 'scored-0,scored-1,scored-2,scored-3', 'the highest-scoring arcs keep their representative-score rank order');
  assert(tags.includes('floor-a') && tags.includes('floor-b'), 'both floor-only arcs survive the cap by displacing the weakest scored arcs — the floor is a genuine guarantee, not just leftover room');
  assert(!tags.includes('scored-4') && !tags.includes('scored-5'), 'the weakest scored arcs are the ones trimmed to make room for the floor, not the floor arcs themselves');
}
{
  // Fail-open: a plot-lane throw must not take the chunk/fact lanes down with it (the lane
  // catches internally, so buildAutoRecallParts's Promise.all never rejects as a whole).
  const session = createFakeSession({
    chunkRows: [{ ordinal: 1, summary: null, content: 'c', distance: 0.1, kw_score: 0 }],
    factRows: [{ fact_id: 'f1', category: 'plot', summary: 'fact summary', detail: null, distance: 0.1 }],
    throwOn: 'plots',
  });
  const block = await buildAutoRecallPrompt(
    session,
    fakeSettings(),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(block.includes('<memory turns="1">'), 'a plot-lane failure must not take the chunk lane down with it');
  assert(block.includes('- [plot] fact summary'), 'a plot-lane failure must not take the fact lane down with it');
}
{
  // The query vector is embedded exactly once per turn and shared across all three lanes —
  // never one provider round trip per lane (a real cost concern worth pinning).
  let embedCalls = 0;
  const countingEmbeddings = {
    name: 's',
    dimension: 8,
    embed: async (texts) => {
      embedCalls += 1;
      return texts.map(() => [1, 2, 3, 4, 5, 6, 7, 8]);
    },
  };
  await buildAutoRecallPrompt(
    createFakeSession(),
    fakeSettings(),
    countingEmbeddings,
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(embedCalls === 1, 'the query vector is embedded exactly once per turn, shared across the chunk/fact/plot lanes');
}
{
  // The plot lane's SQL shapes: the pool query keeps one best-scoring row per arc_tag with a
  // deterministic arc_tag tie-break (bi_principles.md §17); the recency floor reads the chat's
  // most recent sync ticks by chat_sync_points.ordinal.
  const seenSql = [];
  const session = {
    async query(sql) {
      seenSql.push(sql);
      if (sql.includes('from chat_chunks')) return [];
      if (sql.includes('from canon_facts')) return [];
      return [];
    },
  };
  await buildAutoRecallParts(
    session,
    fakeSettings(),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  const poolSql = seenSql.find(
    (sql) => sql.includes("category = 'plot'") && sql.includes('from canon_facts') && !sql.includes('chat_sync_points') && !sql.includes('arc_tag = $3'),
  );
  assert(
    poolSql && poolSql.includes('distinct on (arc_tag)') && poolSql.includes('order by vector_embed <-> $3, arc_tag'),
    'the plot pool reduces to one best-scoring row per arc_tag with a deterministic arc_tag tie-break',
  );
  const floorSql = seenSql.find((sql) => sql.includes('from chat_sync_points'));
  assert(
    floorSql && floorSql.includes('order by ordinal desc') && floorSql.includes('limit $3'),
    'the recency floor reads the chat\'s most recent sync ticks by chat_sync_points.ordinal (limit = floor_syncs)',
  );
}

// --- 8. Lead-in window (migration 0100, chunkLeadIn.ts): the recursive-CTE walk over
// parent_chunk_id, the clamp, the merge ordering, and the off-by-one regression the plan pins
// down (the draft's depth-1 seed returned leadInCount - 1 rows; the corrected form seeds depth
// 0, bounds li.depth < $4, and filters depth > 0 — so leadInCount = 1 returns exactly the
// immediate predecessors). The SQL itself does the dedup and the retrieved-set exclusion
// structurally; the merge below it is a concatenate-and-sort. ---
{
  // SQL shape: seed depth 0, bound li.depth < $4, filter depth > 0, exclude the retrieved set.
  const session = createFakeSession({
    chunkRows: [
      { chunk_id: 'c10', parent_chunk_id: 'c9', ordinal: 10, summary: 's10', content: 'User: x\nAssistant: y', distance: 0.1, kw_score: 0 },
    ],
    leadInRows: [],
  });
  await buildAutoRecallParts(
    session,
    fakeSettings(new Map([['chat_memory_auto_recall_lead_in_chunks', '1']])),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  const cte = session.seenSql.find((sql) => sql.includes('with recursive lead_in'));
  assert(
    cte &&
      cte.includes('0 as depth') &&
      cte.includes('li.depth < $4') &&
      cte.includes('where depth > 0') &&
      cte.includes('chunk_id != all($3)'),
    'the lead-in CTE seeds depth 0, bounds the walk at li.depth < $4, filters depth > 0, and excludes the retrieved set (the corrected off-by-one form)',
  );
}
{
  // Off-by-one regression: leadInCount = 1 walks exactly one hop and merges exactly the
  // immediate predecessor (ordinal 9) ahead of the retrieved chunk (ordinal 10).
  const session = createFakeSession({
    chunkRows: [
      { chunk_id: 'c10', parent_chunk_id: 'c9', ordinal: 10, summary: 's10', content: 'User: x\nAssistant: y', distance: 0.1, kw_score: 0 },
    ],
    leadInRows: [{ chunk_id: 'c9', ordinal: 9, summary: 's9' }],
  });
  const parts = await buildAutoRecallParts(
    session,
    fakeSettings(new Map([['chat_memory_auto_recall_lead_in_chunks', '1']])),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  const cteCall = session.seenCalls.find((c) => c.sql.includes('with recursive lead_in'));
  assert(cteCall && cteCall.params[3] === 1, 'leadInCount = 1 binds $4 = 1 on the CTE (one hop back, never zero)');
  assert(
    parts.chunks.length === 2 &&
      parts.chunks[0].ordinal === 9 && parts.chunks[0].isLeadIn === true && parts.chunks[0].content === '' &&
      parts.chunks[1].ordinal === 10 && parts.chunks[1].isLeadIn !== true,
    'leadInCount = 1 merges exactly the immediate predecessor as a content-less lead-in entry, ahead of the retrieved chunk, sorted ascending',
  );
}
{
  // Two retrieved chunks with a shared ancestor: the merge concatenates and sorts by ordinal
  // (the CTE's `select distinct` + `chunk_id != all($3)` already guarantee no overlap and no
  // duplicates, so there is no second dedup pass). Lead-in entries carry summary, empty content.
  const session = createFakeSession({
    chunkRows: [
      { chunk_id: 'c20', parent_chunk_id: 'c19', ordinal: 20, summary: 's20', content: 'User: a\nAssistant: b', distance: 0.1, kw_score: 0 },
      { chunk_id: 'c18', parent_chunk_id: 'c17', ordinal: 18, summary: 's18', content: 'User: c\nAssistant: d', distance: 0.2, kw_score: 0 },
    ],
    leadInRows: [
      { chunk_id: 'c17', ordinal: 17, summary: 's17' },
      { chunk_id: 'c16', ordinal: 16, summary: 's16' },
      { chunk_id: 'c15', ordinal: 15, summary: 's15' },
    ],
  });
  const parts = await buildAutoRecallParts(
    session,
    fakeSettings(new Map([['chat_memory_auto_recall_lead_in_chunks', '3']])),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(
    parts.chunks.every((c, i) => i === 0 || parts.chunks[i - 1].ordinal < c.ordinal),
    'the merged chunks array is strictly ascending by ordinal (retrieved chunks + lead-ins)',
  );
  const leadIns = parts.chunks.filter((c) => c.isLeadIn);
  assert(
    leadIns.length === 3 && leadIns.map((c) => c.ordinal).join(',') === '15,16,17',
    'lead-ins come from the chains only — ordinals 15/16/17 — never a retrieved chunk id (the CTE excludes them structurally)',
  );
  assert(
    leadIns.every((c) => c.content === '' && c.summary),
    'a lead-in entry carries its summary with empty content (rendered from summary alone, never re-scored)',
  );
}
{
  // lead_in_chunks = 0 disables the walk entirely: no CTE query is issued and the recalled
  // chunks come back untouched (no lead-in entries).
  const session = createFakeSession({
    chunkRows: [
      { chunk_id: 'c1', parent_chunk_id: null, ordinal: 1, summary: 's1', content: 'User: x\nAssistant: y', distance: 0.1, kw_score: 0 },
    ],
    leadInRows: [{ chunk_id: 'c0', ordinal: 0, summary: 's0' }],
  });
  const parts = await buildAutoRecallParts(
    session,
    fakeSettings(new Map([['chat_memory_auto_recall_lead_in_chunks', '0']])),
    createStubEmbeddingProvider(8),
    'user-1',
    'chat-1',
    [{ role: 'user', content: 'hi' }],
  );
  assert(
    !session.seenSql.some((sql) => sql.includes('with recursive lead_in')) &&
      parts.chunks.length === 1 && !parts.chunks[0].isLeadIn,
    'lead_in_chunks = 0 disables lead-ins — resolveLeadInRows is never called, no CTE query, chunks unchanged',
  );
}
{
  // Parse-clamp-fallback: an out-of-range value clamps to MAX_LEAD_IN_CHUNKS (3), a corrupt
  // value falls back to DEFAULT_LEAD_IN_CHUNKS (2) — both observable through the $4 bound.
  for (const [raw, expected] of [
    ['99', MAX_LEAD_IN_CHUNKS],
    ['not-a-number', DEFAULT_LEAD_IN_CHUNKS],
  ]) {
    const session = createFakeSession({
      chunkRows: [
        { chunk_id: 'c1', parent_chunk_id: null, ordinal: 1, summary: 's1', content: 'User: x\nAssistant: y', distance: 0.1, kw_score: 0 },
      ],
      leadInRows: [],
    });
    await buildAutoRecallParts(
      session,
      fakeSettings(new Map([['chat_memory_auto_recall_lead_in_chunks', raw]])),
      createStubEmbeddingProvider(8),
      'user-1',
      'chat-1',
      [{ role: 'user', content: 'hi' }],
    );
    const cteCall = session.seenCalls.find((c) => c.sql.includes('with recursive lead_in'));
    assert(
      cteCall && cteCall.params[3] === expected,
      `lead_in_chunks raw '${raw}' binds $4 = ${expected} on the CTE (clamped to MAX / fallen back to DEFAULT)`,
    );
  }
}

// --- Sanity: the exported constants are what the wiring depends on ---
assert(AUTO_RECALL_PAIRS === 3, 'AUTO_RECALL_PAIRS mirrors Canonize ragClassifierHistory (3)');
assert(AUTO_RECALL_CHUNK_TOP_K === 8, 'AUTO_RECALL_CHUNK_TOP_K is the default Max for the dynamic cutoff (8 — CNZ ragChatMax)');
assert(MAX_LEAD_IN_CHUNKS === 3, 'MAX_LEAD_IN_CHUNKS caps the lead-in window at 3 (a corrupt value can never balloon the prompt)');
assert(DEFAULT_LEAD_IN_CHUNKS === 2, 'DEFAULT_LEAD_IN_CHUNKS is the lead-in window default (2 preceding chunks)');
assert(DEFAULT_PLOT_TOP_K === 6, 'DEFAULT_PLOT_TOP_K is the plot lane Max default (6 — fewer than the fact lane\'s 8, each result is a multi-entry card)');
assert(DEFAULT_PLOT_MIN === 1, 'DEFAULT_PLOT_MIN is the plot lane Min floor default (1)');
assert(DEFAULT_PLOT_FLOOR_SYNCS === 2, 'DEFAULT_PLOT_FLOOR_SYNCS is the recency-floor default (2 sync ticks)');

console.log('\nrecall-for-prompt verification passed');
if (process.exitCode) process.exit(process.exitCode);
