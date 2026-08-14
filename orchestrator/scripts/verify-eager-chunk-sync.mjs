// Verification for orchestrator/src/orchestrator/eagerChunkSync.ts (docs/plans/
// eager-chunk-sync-plan.md) — the eager chat-memory chunk step that runs right after a turn
// persists, chunking + summarizing + embedding the rolled-off turn pairs the moment a whole
// 2-pair chunk exists, so the sync tick's own job shrinks to consolidation. Runs against a fake
// Postgres pool (no real Postgres) plus fake LLM/embeddings providers, mirroring
// verify-chat-memory-sync.mjs's style.
//
// The one behavior this file exists specifically to prove: maybeEagerChunk is a two-phase
// no-op-or-chunk with the eligibility counted in turn-pairs (seeded greeting folded into turn 1)
// — never raw message counts — so the eager boundary can never drift off the tick's turn-aligned
// archive boundary, and the eligible span never reaches into the live window.

import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../dist/io/postgres.js';
import { maybeEagerChunk } from '../dist/orchestrator/eagerChunkSync.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake pool: in-memory chat_messages / chat_sync_points / chat_chunks tables, covering
// exactly the queries eagerChunkSync.ts issues. ---
function createFakePool() {
  const chatMessages = []; // { message_id, chat_id, user_id, role, content, created_at }
  const chatSyncPoints = []; // { sync_id, chat_id, user_id, ordinal, last_message_id, closed_at }
  const chatChunks = []; // { chat_id, sync_id, user_id, ordinal, content, summary, vector_embed }
  let lockQueries = 0;
  let clock = 1000;
  const now = () => new Date((clock += 1000)).toISOString();

  return {
    chatMessages,
    chatSyncPoints,
    chatChunks,
    lockQueries: () => lockQueries,
    now,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          // The per-chat advisory lock — counted so tests can assert the no-op path never
          // reaches the locked phase.
          if (sql.includes('pg_advisory_xact_lock')) {
            lockQueries++;
            return { rows: [] };
          }

          // Pre-check + locked-phase message count
          if (sql.includes('select count(*)::text as n from chat_messages')) {
            const n = chatMessages.filter((m) => m.chat_id === params[0]).length;
            return { rows: [{ n: String(n) }] };
          }

          // Pre-check + locked-phase chunk count (doubles as the startOrdinal source)
          if (sql.includes('select count(*)::text as n from chat_chunks')) {
            const n = chatChunks.filter((c) => c.chat_id === params[0]).length;
            return { rows: [{ n: String(n) }] };
          }

          // Locked-phase transcript read
          if (sql.includes('select message_id, role, content from chat_messages')) {
            const rows = chatMessages
              .filter((m) => m.chat_id === params[0])
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id))
              .map((m) => ({ message_id: m.message_id, role: m.role, content: m.content }));
            return { rows };
          }

          // Open-sync-point lookup
          if (sql.includes('closed_at is null')) {
            const rows = chatSyncPoints
              .filter((sp) => sp.chat_id === params[0] && !sp.closed_at)
              .sort((a, b) => b.ordinal - a.ordinal)
              .slice(0, 1)
              .map((sp) => ({ sync_id: sp.sync_id }));
            return { rows };
          }

          // Next-ordinal derivation for a fresh open point
          if (sql.includes('select max(ordinal)')) {
            const rows = chatSyncPoints.filter((sp) => sp.chat_id === params[0]);
            const m = rows.length ? String(Math.max(...rows.map((sp) => sp.ordinal))) : null;
            return { rows: [{ m }] };
          }

          // Fresh open sync point (no closed_at in the eager insert's column list — stays open)
          if (sql.includes('insert into chat_sync_points')) {
            const [chatId, userId, ordinal, lastMessageId] = params;
            const row = { sync_id: randomUUID(), chat_id: chatId, user_id: userId, ordinal, last_message_id: lastMessageId, closed_at: null };
            chatSyncPoints.push(row);
            return { rows: [{ sync_id: row.sync_id }] };
          }

          // Chunk insert (content + summary lanes, matching the tick's own insert shape)
          if (sql.includes('insert into chat_chunks')) {
            const [chatId, syncId, userId, ordinal, content, summary, vectorEmbed, summaryVectorEmbed, parentChunkId] = params;
            const chunkId = randomUUID();
            chatChunks.push({ chunk_id: chunkId, chat_id: chatId, sync_id: syncId, user_id: userId, ordinal, content, summary, vector_embed: vectorEmbed, summary_vector_embed: summaryVectorEmbed, parent_chunk_id: parentChunkId ?? null });
            return { rows: [{ chunk_id: chunkId }] };
          }

          // The lead-in chain's prev-chunk read (eagerChunkSync.ts Phase 2, migration 0100): the
          // batch's first chunk links to the chat's current max-ordinal row.
          if (sql.includes('from chat_chunks') && sql.includes('order by ordinal desc limit 1')) {
            const [chatId] = params;
            const rows = chatChunks
              .filter((c) => c.chat_id === chatId)
              .sort((a, b) => b.ordinal - a.ordinal)
              .slice(0, 1)
              .map((c) => ({ chunk_id: c.chunk_id }));
            return { rows };
          }

          // Open point's anchor advances to the newly-chunked span end
          if (sql.includes('update chat_sync_points set last_message_id')) {
            const [syncId, lastMessageId] = params;
            const sp = chatSyncPoints.find((p) => p.sync_id === syncId);
            if (sp) sp.last_message_id = lastMessageId;
            return { rows: [] };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

function createFakeLlm() {
  const calls = [];
  return {
    calls,
    name: 'fake-llm',
    supportsVision: false,
    async complete(messages, _tools, options = {}) {
      calls.push({ messages, options });
      if (options.forceTool === 'summarize_chat_chunk') {
        const content = messages.find((m) => m.role === 'user').content;
        return {
          message: { role: 'assistant', content: '' },
          toolCalls: [{ id: randomUUID(), name: 'summarize_chat_chunk', arguments: { summary: `Summary[${content}]` } }],
        };
      }
      throw new Error(`fake llm got an unexpected forceTool: ${options.forceTool}`);
    },
  };
}

function createFakeEmbeddings() {
  return {
    name: 'fake-embeddings',
    dimension: 3,
    async embed(texts) {
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
  };
}

function createFakeSettingsStore(initial) {
  const map = new Map(Object.entries(initial));
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
  };
}

const USER = randomUUID();

const pool = createFakePool();
const db = createPostgresClient(pool);
const llm = createFakeLlm();
const embeddings = createFakeEmbeddings();
// live window 2 pairs (4 messages) — one whole 2-pair chunk needs 2 eligible pairs, i.e. 4 turns.
const settings = createFakeSettingsStore({ chat_memory_live_window_pairs: '2' });
const llmConnections = { async resolveByName() { return undefined; } };
const deps = { db, llm, embeddings, settings, llmConnections };

function seedMessages(chatId, tag, count) {
  for (let i = 1; i <= count; i++) {
    const role = i % 2 === 1 ? 'user' : 'assistant';
    pool.chatMessages.push({
      message_id: randomUUID(),
      chat_id: chatId,
      user_id: USER,
      role,
      content: `${tag}-${role}-${i}`,
      created_at: pool.now(),
    });
  }
  return pool.chatMessages.filter((m) => m.chat_id === chatId).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function summarizeCalls() {
  return llm.calls.filter((c) => c.options.forceTool === 'summarize_chat_chunk');
}

// --- No whole chunk eligible -> strict no-op: no chunks, no sync point, and no advisory-lock
// query even issued (the cheap pre-check returns before the locked phase). ---
{
  const NOOP_CHAT_ID = randomUUID();
  seedMessages(NOOP_CHAT_ID, 'NOOP', 6); // 3 turns; eligible = 3 - 2 = 1 pair < one whole chunk

  const result = await maybeEagerChunk(deps, USER, NOOP_CHAT_ID);

  assert(result.status === 'noop' && result.chunksAdded === 0, 'a turn below a whole-chunk boundary returns noop');
  assert(pool.chatChunks.length === 0, 'a no-op adds no chunk rows');
  assert(pool.chatSyncPoints.length === 0, 'a no-op touches no sync point');
  assert(pool.lockQueries() === 0, 'a no-op never issues the advisory-lock query');
  assert(summarizeCalls().length === 0, 'a no-op makes no summarize LLM call');
}

// --- Exactly one whole chunk eligible -> one new chunk tied to a freshly-opened (closed_at null)
// sync point, with the content + summary embedding lanes both written. ---
let ONE_CHAT_ID;
{
  ONE_CHAT_ID = randomUUID();
  const msgs = seedMessages(ONE_CHAT_ID, 'ONE', 8); // 4 turns; eligible = 4 - 2 = 2 pairs

  const result = await maybeEagerChunk(deps, USER, ONE_CHAT_ID);

  assert(result.status === 'ok' && result.chunksAdded === 1, 'a turn that completes a whole chunk produces exactly one chunk');
  assert(pool.chatChunks.length === 1, 'exactly one chunk row is written');
  assert(pool.chatChunks[0].ordinal === 0, 'the first chunk starts ordinal numbering at 0');
  assert(pool.chatChunks[0].content === 'User: ONE-user-1\nAssistant: ONE-assistant-2\nUser: ONE-user-3\nAssistant: ONE-assistant-4', 'the chunk covers the first whole 2-pair group');
  assert(pool.chatChunks[0].vector_embed != null && pool.chatChunks[0].summary_vector_embed != null, 'both the content lane and the 0094 summary lane are embedded');
  assert(pool.chatSyncPoints.length === 1, 'one sync point is opened');
  assert(pool.chatSyncPoints[0].closed_at === null, 'the eagerly-opened sync point starts open (closed_at null)');
  assert(pool.chatSyncPoints[0].ordinal === 0, 'the first sync point gets ordinal 0');
  assert(pool.chatSyncPoints[0].last_message_id === msgs[3].message_id, "the open point's anchor is the last message its chunk covers");
  assert(summarizeCalls().length === 1, 'the mandatory chunk summary was LLM-summarized (chat_chunks.summary is not null)');
  assert(
    pool.chatChunks[0].parent_chunk_id === null,
    'the first eager chunk is the chain head (parent_chunk_id null, migration 0100)',
  );
}

// --- A second eager call in the same open window reuses the same sync_id (no second point, same
// ordinal) and chunks only the next unchunked span. ---
{
  const msgs = seedMessages(ONE_CHAT_ID, 'ONE', 4); // 6 turns total now; eligible = 6 - 2 - 2 = 2
  const result = await maybeEagerChunk(deps, USER, ONE_CHAT_ID);

  assert(result.status === 'ok' && result.chunksAdded === 1, 'the follow-up turn completes one more chunk');
  assert(pool.chatChunks.length === 2, 'two chunk rows total');
  assert(pool.chatChunks[1].ordinal === 1, 'the second chunk continues numbering from count(*)');
  assert(pool.chatChunks[1].content === 'User: ONE-user-5\nAssistant: ONE-assistant-6\nUser: ONE-user-7\nAssistant: ONE-assistant-8', 'the second chunk covers the next unchunked span — no re-chunking');
  assert(pool.chatSyncPoints.length === 1, 'the open sync point is reused — no second point is opened');
  assert(pool.chatSyncPoints[0].ordinal === 0, "the reused point's ordinal is unchanged across eager calls");
  assert(pool.chatSyncPoints[0].last_message_id === msgs[7].message_id, "the open point's anchor advances to the new span end");
  assert(
    pool.chatChunks[1].parent_chunk_id === pool.chatChunks[0].chunk_id,
    "the second eager chunk links to the first via parent_chunk_id — the batch chain is contiguous across calls",
  );
}

// --- Greeting folded into turn 1 (eager-chunk-sync-plan): a lone leading assistant message is
// never its own turn, pair, chunk, or live-window slot — it rides inside turn 1, and the first
// chunk is [greeting, u1, a1, u2]. ---
{
  const GREETING_CHAT_ID = randomUUID();
  pool.chatMessages.push({
    message_id: randomUUID(),
    chat_id: GREETING_CHAT_ID,
    user_id: USER,
    role: 'assistant',
    content: 'Welcome to the story.',
    created_at: pool.now(),
  });
  seedMessages(GREETING_CHAT_ID, 'GRT', 8); // 4 turns after the greeting

  const result = await maybeEagerChunk(deps, USER, GREETING_CHAT_ID);

  const greetingChunks = pool.chatChunks.filter((c) => c.chat_id === GREETING_CHAT_ID);
  assert(result.status === 'ok' && result.chunksAdded === 1, 'a greeting chat forms its first chunk once 4 turns exist (greeting is not counted as a turn)');
  assert(
    greetingChunks[0].content === 'Assistant: Welcome to the story.\nUser: GRT-user-1\nAssistant: GRT-assistant-2\nUser: GRT-user-3',
    'the first chunk is [greeting, u1, a1, u2] — the greeting folds into turn pair 1',
  );
}

// --- Eligibility units regression (the count(*) * pairsPerChunk conversion): 20 existing
// chunks (40 pairs' worth = 80 messages) + a live window of 8 pairs must leave exactly 2 eligible
// pairs (4 messages), not 64 — the raw chunk count fed straight into the pair arithmetic would
// re-chunk the already-covered span and reach into the live window. ---
{
  const UNITS_CHAT_ID = randomUUID();
  const msgs = seedMessages(UNITS_CHAT_ID, 'UNIT', 100); // 50 turns
  const openSyncId = randomUUID();
  pool.chatSyncPoints.push({ sync_id: openSyncId, chat_id: UNITS_CHAT_ID, user_id: USER, ordinal: 0, last_message_id: msgs[79].message_id, closed_at: null });
  for (let o = 0; o < 20; o++) {
    pool.chatChunks.push({ chat_id: UNITS_CHAT_ID, sync_id: openSyncId, user_id: USER, ordinal: o, content: `UNIT-chunk-${o}`, summary: 'S', vector_embed: '[0.1]' });
  }

  await settings.set('chat_memory_live_window_pairs', '8'); // 8 pairs = 16 messages live
  const result = await maybeEagerChunk(deps, USER, UNITS_CHAT_ID);

  assert(result.status === 'ok' && result.chunksAdded === 1, '20 chunks + 8-pair live window + 50 turns: exactly 1 chunk eligible (4 messages), not 16');
  assert(pool.chatChunks.filter((c) => c.chat_id === UNITS_CHAT_ID).length === 21, 'exactly one chunk is added on top of the 20 existing');
  const newChunk = pool.chatChunks.find((c) => c.ordinal === 20);
  assert(
    newChunk?.content === 'User: UNIT-user-81\nAssistant: UNIT-assistant-82\nUser: UNIT-user-83\nAssistant: UNIT-assistant-84',
    'the new chunk covers exactly the rolled-off-but-unchunked span (messages 80-83) — never the already-covered span, never the live window',
  );
  await settings.set('chat_memory_live_window_pairs', '2');
}

// --- Failure isolation: a throwing embeddings provider (or summarize call) must never escape
// maybeEagerChunk — it resolves as a noop, leaving chunking to the sync tick. ---
{
  const FAIL_CHAT_ID = randomUUID();
  seedMessages(FAIL_CHAT_ID, 'FAIL', 8);
  const chunksBefore = pool.chatChunks.length;
  const syncsBefore = pool.chatSyncPoints.length;

  const realEmbed = embeddings.embed;
  embeddings.embed = async () => {
    throw new Error('embeddings provider unreachable');
  };
  let threw = false;
  let result;
  try {
    result = await maybeEagerChunk(deps, USER, FAIL_CHAT_ID);
  } catch {
    threw = true;
  }
  embeddings.embed = realEmbed;

  assert(!threw, 'maybeEagerChunk never throws out of the eager path');
  assert(result.status === 'noop' && result.chunksAdded === 0, 'a failed eager pass resolves as a noop');
  assert(pool.chatChunks.length === chunksBefore, 'a failed eager pass persists no chunks');
  assert(pool.chatSyncPoints.length === syncsBefore, 'a failed eager pass opens no sync point');
}

// --- Truncate/rerun floor: messages removed from the live-window tail must never push the
// eligibility arithmetic negative — the max(0, ...) floor makes it a clean no-op. ---
{
  const TRUNC_CHAT_ID = randomUUID();
  const msgs = seedMessages(TRUNC_CHAT_ID, 'TRUNC', 12); // 6 turns
  const openSyncId = randomUUID();
  pool.chatSyncPoints.push({ sync_id: openSyncId, chat_id: TRUNC_CHAT_ID, user_id: USER, ordinal: 0, last_message_id: msgs[7].message_id, closed_at: null });
  pool.chatChunks.push(
    { chat_id: TRUNC_CHAT_ID, sync_id: openSyncId, user_id: USER, ordinal: 0, content: 'TRUNC-1..4', summary: 'S', vector_embed: '[0.1]' },
    { chat_id: TRUNC_CHAT_ID, sync_id: openSyncId, user_id: USER, ordinal: 1, content: 'TRUNC-5..8', summary: 'S', vector_embed: '[0.1]' },
  );
  // Truncate the live-window tail: only 5 messages survive (2 full turns + 1 user message).
  const surviving = msgs.slice(0, 5);
  pool.chatMessages.length = 0;
  pool.chatMessages.push(...surviving);
  const locksBefore = pool.lockQueries();

  const result = await maybeEagerChunk(deps, USER, TRUNC_CHAT_ID);

  assert(result.status === 'noop' && result.chunksAdded === 0, 'eligibility never goes negative after a truncate — max(0, ...) floors it to a noop');
  assert(pool.chatChunks.filter((c) => c.chat_id === TRUNC_CHAT_ID).length === 2, 'a truncate no-op leaves the surviving chunks untouched');
  assert(pool.lockQueries() === locksBefore, 'the truncated no-op is caught by the cheap pre-check — no lock taken');
}

if (process.exitCode) {
  console.error('\neager chunk sync verification FAILED');
  process.exit(1);
}
console.log('\neager chunk sync verification passed');
