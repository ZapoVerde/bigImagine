// Verification for orchestrator/src/orchestrator/chatChunkResize.ts (docs/plans/completed/
// chunk-size-resize-plan.md) — the admin-triggered backfill that re-chunks every chat's archived
// history at the live chat_memory_chunk_pairs size. Runs against a fake Postgres pool (no real
// Postgres) plus fake LLM/embeddings providers, mirroring verify-eager-chunk-sync.mjs's style.
//
// The one behavior this file exists specifically to prove: the resize pass resolves its
// summarization connection EXCLUSIVELY through the live chat_memory_profile setting (the shared
// resolveChatMemoryLlm resolver in chatMemorySync.ts) — never through a chat's own
// params->>'profile', which is the narrator/generation connection, a different configuration
// domain. A legacy RP chat whose narrator profile points at a dead model must have its chunks
// regenerated through the working chat_memory_profile connection, never the dead narrator model.

import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../dist/io/postgres.js';
import { runChatChunkResize } from '../dist/orchestrator/chatChunkResize.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake pool: in-memory chat_sessions / chat_messages / chat_sync_points / chat_chunks /
// chat_chunk_resize_status tables, covering exactly the queries chatChunkResize.ts issues. The
// chat_sessions.params map is pure test bookkeeping (the narrator profile the code under test must
// NEVER read) — any attempt to query it hits the unexpected-query throw below. ---
function createFakePool() {
  const chatSessions = new Map(); // chat_id -> { user_id, params }
  const chatMessages = []; // { message_id, chat_id, user_id, role, content, created_at }
  const chatSyncPoints = []; // { sync_id, chat_id, user_id, ordinal, last_message_id, closed_at }
  const chatChunks = []; // { chat_id, sync_id, user_id, ordinal, content, summary, vector_embed }
  const resizeStatus = { status: 'idle', chats_total: 0, chats_done: 0, finished_at: null };
  let clock = 1000;
  const now = () => new Date((clock += 1000)).toISOString();

  return {
    chatSessions,
    chatMessages,
    chatSyncPoints,
    chatChunks,
    resizeStatus,
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

          // resizeOneChat's per-chat advisory lock (chatChunkResize.ts) — pure DB-side
          // serialization, no rows.
          if (sql.includes('pg_advisory_xact_lock')) {
            return { rows: [] };
          }

          // The connection-backed resize llm is a gated openai-compatible provider, which meters
          // every complete() into llm_calls (io/llm/llmGate.ts) — swallowed here.
          if (sql.includes('insert into llm_calls')) {
            return { rows: [] };
          }

          // runChatChunkResize's chat enumeration (withSystemScope).
          if (sql.includes('from chat_sessions where archived_at is null')) {
            const rows = [];
            for (const [chatId, sess] of chatSessions) {
              if (!sess.archived_at) rows.push({ chat_id: chatId, user_id: sess.user_id });
            }
            return { rows };
          }

          // runChatChunkResize's status updates — three distinct UPDATE shapes.
          if (sql.includes('update chat_chunk_resize_status set chats_total')) {
            resizeStatus.chats_total = params[0];
            return { rows: [] };
          }
          if (sql.includes('update chat_chunk_resize_status set chats_done')) {
            resizeStatus.chats_done += 1;
            return { rows: [] };
          }
          if (sql.includes("update chat_chunk_resize_status set status = 'done'")) {
            resizeStatus.status = 'done';
            resizeStatus.finished_at = now();
            return { rows: [] };
          }

          // resizeOneChat's full-transcript read.
          if (sql.includes('select message_id, role, content from chat_messages')) {
            const rows = chatMessages
              .filter((m) => m.chat_id === params[0])
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id))
              .map((m) => ({ message_id: m.message_id, role: m.role, content: m.content }));
            return { rows };
          }

          // resizeOneChat's most-recent sync-point read.
          if (sql.includes('select sync_id, last_message_id from chat_sync_points')) {
            const rows = chatSyncPoints
              .filter((sp) => sp.chat_id === params[0])
              .sort((a, b) => b.ordinal - a.ordinal)
              .slice(0, 1)
              .map((sp) => ({ sync_id: sp.sync_id, last_message_id: sp.last_message_id }));
            return { rows };
          }

          // resizeOneChat's wipe-and-regenerate delete + insert.
          if (sql.startsWith('delete from chat_chunks')) {
            const [chatId] = params;
            for (let i = chatChunks.length - 1; i >= 0; i--) {
              if (chatChunks[i].chat_id === chatId) chatChunks.splice(i, 1);
            }
            return { rows: [] };
          }
          if (sql.includes('insert into chat_chunks')) {
            const [chatId, syncId, userId, ordinal, content, summary, vectorEmbed, summaryVectorEmbed, parentChunkId] = params;
            const chunkId = randomUUID();
            chatChunks.push({ chunk_id: chunkId, chat_id: chatId, sync_id: syncId, user_id: userId, ordinal, content, summary, vector_embed: vectorEmbed, summary_vector_embed: summaryVectorEmbed, parent_chunk_id: parentChunkId ?? null });
            return { rows: [{ chunk_id: chunkId }] };
          }

          // resizeOneChat's advance-only anchor update.
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

// --- The resize llm rides the shared resolveChatMemoryLlm connection (chatMemorySync.ts) — a
// gated openai-compatible provider called over HTTP — so the fake LLM seam moves into a mocked
// global fetch, dispatching on the request's forced tool_choice. Two distinct endpoints prove the
// lock: the active connection and the one chat_memory_profile names. ---
const ACTIVE_FAKE_BASE = 'https://resize-active-fake.example';
const NAMED_FAKE_BASE = 'https://resize-named-fake.example';

function fakeResizeProfile(baseUrl, model) {
  return {
    kind: 'openai-compatible',
    model,
    apiKey: 'test-key',
    baseUrl,
    supportsVision: false,
    priceInputPerMillion: 1,
    priceOutputPerMillion: 2,
    priceCacheHitPerMillion: 0.5,
    pricePeakInputPerMillion: 1,
    pricePeakOutputPerMillion: 2,
    pricePeakCacheHitPerMillion: 0.5,
  };
}

const llmConnections = {
  async resolveActive() {
    return fakeResizeProfile(ACTIVE_FAKE_BASE, 'resize-active-model');
  },
  async resolveByName(name) {
    return name === 'resize-profile' ? fakeResizeProfile(NAMED_FAKE_BASE, 'resize-named-model') : undefined;
  },
};

function createFakeHttpBackend() {
  return { calls: [] };
}

function oaiToolResponse(name, args) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: { content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    text: async () => '',
  };
}

function installResizeFetchMock(backend) {
  const originalFetch = globalThis.fetch;
  const knownBases = [ACTIVE_FAKE_BASE, NAMED_FAKE_BASE];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (knownBases.includes(u.replace('/chat/completions', ''))) {
      const body = JSON.parse(init.body);
      const forceTool = body.tool_choice?.function?.name;
      backend.calls.push({ messages: body.messages, options: { forceTool, model: body.model }, url: u });
      if (forceTool === 'summarize_chat_chunk') {
        const content = body.messages.find((m) => m.role === 'user').content;
        return oaiToolResponse('summarize_chat_chunk', { summary: `Summary[${content}]` });
      }
      throw new Error(`fake resize HTTP backend got an unexpected forceTool: ${forceTool}`);
    }
    return originalFetch(url, init);
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
const CHAT_ID = randomUUID();

const pool = createFakePool();
pool.chatSessions.set(CHAT_ID, {
  user_id: USER,
  archived_at: null,
  // Pure test bookkeeping — the narrator/generation profile this legacy RP chat points at a dead
  // model. The resize pass must NEVER read it (the fake pool throws on any params->>'profile'
  // query), and must regenerate the archive through chat_memory_profile instead.
  params: { profile: 'obsolete-rp-model' },
});
const msgs = [];
for (let i = 1; i <= 12; i++) {
  msgs.push({
    message_id: randomUUID(),
    chat_id: CHAT_ID,
    user_id: USER,
    role: i % 2 === 1 ? 'user' : 'assistant',
    content: `RZ-${i % 2 === 1 ? 'user' : 'assistant'}-${i}`,
    created_at: pool.now(),
  });
}
pool.chatMessages.push(...msgs);
// One prior sync point (anchor at msgs[3]) + existing chunks at the old size, so the pass has
// something to wipe-and-regenerate and exercises the advance-only anchor update.
const oldSyncId = randomUUID();
pool.chatSyncPoints.push({ sync_id: oldSyncId, chat_id: CHAT_ID, user_id: USER, ordinal: 0, last_message_id: msgs[3].message_id, closed_at: pool.now() });
pool.chatChunks.push(
  { chat_id: CHAT_ID, sync_id: oldSyncId, user_id: USER, ordinal: 0, content: 'old-0', summary: 'old-summary-0', vector_embed: '[0.1]' },
  { chat_id: CHAT_ID, sync_id: oldSyncId, user_id: USER, ordinal: 1, content: 'old-1', summary: 'old-summary-1', vector_embed: '[0.1]' },
);

const db = createPostgresClient(pool);
const backend = createFakeHttpBackend();
installResizeFetchMock(backend);
const llm = { calls: backend.calls, name: 'fake-llm', supportsVision: false, complete: async () => { throw new Error('unused — resize llm comes from the connection provider'); } };
const embeddings = createFakeEmbeddings();
// live window 2 pairs, chunk pairs 2 (default) — 12 messages = 6 turns → 4 eligible turns = 2 chunks.
const settings = createFakeSettingsStore({
  chat_memory_live_window_pairs: '2',
  chat_memory_chunk_pairs: '2',
});
const deps = { db, llm, embeddings, settings, llmConnections };

function summarizeCalls() {
  return backend.calls.filter((c) => c.options.forceTool === 'summarize_chat_chunk');
}

// --- The connection contract (chatChunkResize.ts's resolveResizeSettings → resolveChatMemoryLlm):
// the backfill regenerates summaries EXCLUSIVELY through the live chat_memory_profile setting.
// This chat's narrator profile points at a dead model — that must be ignored entirely. ---
{
  await settings.set('chat_memory_profile', 'resize-profile');
  const activeCallsBefore = backend.calls.filter((c) => c.url === `${ACTIVE_FAKE_BASE}/chat/completions`).length;
  await runChatChunkResize(deps);
  await settings.set('chat_memory_profile', undefined);

  const namedSummaries = summarizeCalls().filter((c) => c.url === `${NAMED_FAKE_BASE}/chat/completions`);
  assert(namedSummaries.length === 2, 'the resize pass regenerates both chunks through the chat_memory_profile connection');
  assert(
    backend.calls.filter((c) => c.url === `${ACTIVE_FAKE_BASE}/chat/completions`).length === activeCallsBefore,
    "the resize pass never touches the active connection while chat_memory_profile is set — and never the chat's dead narrator profile",
  );

  const newChunks = pool.chatChunks.filter((c) => c.chat_id === CHAT_ID).sort((a, b) => a.ordinal - b.ordinal);
  assert(newChunks.length === 2, 'the pass wrote 2 regenerated chunks at the live size');
  assert(
    newChunks[0].summary === 'Summary[User: RZ-user-1\nAssistant: RZ-assistant-2\nUser: RZ-user-3\nAssistant: RZ-assistant-4]',
    "the regenerated chunks carry summaries produced THROUGH the chat_memory_profile connection (content proves the real request body)",
  );
  assert(newChunks[0].parent_chunk_id === null && newChunks[1].parent_chunk_id === newChunks[0].chunk_id, 'the regenerated batch is a fresh contiguous chain (head + link)');
  assert(pool.chatChunks.every((c) => c.sync_id === oldSyncId), 'the regenerated chunks reuse the chat\u2019s most-recent sync point');

  const sp = pool.chatSyncPoints.find((p) => p.chat_id === CHAT_ID);
  assert(sp?.last_message_id === msgs[7].message_id, "the anchor advanced to the new span end (advance-only, from msgs[3] to msgs[7])");
  assert(pool.resizeStatus.status === 'done' && pool.resizeStatus.chats_total === 1 && pool.resizeStatus.chats_done === 1, 'the singleton status row records a clean one-chat pass');
}

// --- With chat_memory_profile unset, the resize pass falls back to the household's active
// connection (the defined fallback policy) — still never the chat narrator profile. ---
{
  // Simulate the claim that normally resets the singleton before each pass (claimChatChunkResize).
  pool.resizeStatus.status = 'idle';
  pool.resizeStatus.chats_total = 0;
  pool.resizeStatus.chats_done = 0;

  const ACTIVE_CHAT_ID = randomUUID();
  pool.chatSessions.set(ACTIVE_CHAT_ID, { user_id: USER, archived_at: null, params: { profile: 'dead-narrator' } });
  const activeMsgs = [];
  for (let i = 1; i <= 12; i++) {
    activeMsgs.push({
      message_id: randomUUID(),
      chat_id: ACTIVE_CHAT_ID,
      user_id: USER,
      role: i % 2 === 1 ? 'user' : 'assistant',
      content: `RZACT-${i % 2 === 1 ? 'user' : 'assistant'}-${i}`,
      created_at: pool.now(),
    });
  }
  pool.chatMessages.push(...activeMsgs);
  const activeSyncId = randomUUID();
  pool.chatSyncPoints.push({ sync_id: activeSyncId, chat_id: ACTIVE_CHAT_ID, user_id: USER, ordinal: 0, last_message_id: activeMsgs[3].message_id, closed_at: pool.now() });
  pool.chatChunks.push(
    { chat_id: ACTIVE_CHAT_ID, sync_id: activeSyncId, user_id: USER, ordinal: 0, content: 'old', summary: 'old', vector_embed: '[0.1]' },
  );

  const activeCallsBefore = backend.calls.filter((c) => c.url === `${ACTIVE_FAKE_BASE}/chat/completions`).length;
  await runChatChunkResize(deps);

  // This pass regenerates BOTH non-archived chats (the legacy CHAT_ID from the first block, now
  // synced via the fallback too, plus ACTIVE_CHAT_ID) — 2 chunks each, all on the active endpoint.
  const activeSummaries = summarizeCalls().filter((c) => c.url === `${ACTIVE_FAKE_BASE}/chat/completions`);
  assert(
    activeSummaries.length === 4,
    'with chat_memory_profile unset, the resize pass falls back to the ACTIVE connection for every chat — a defined, logged policy, never any chat narrator profile',
  );
  assert(backend.calls.filter((c) => c.url === `${ACTIVE_FAKE_BASE}/chat/completions`).length === activeCallsBefore + 4, 'all fallback summaries rode the active connection');
  assert(pool.resizeStatus.chats_total === 2 && pool.resizeStatus.chats_done === 2, 'the second pass ran across both chats and finished');
}

if (process.exitCode) {
  console.error('\nchat chunk resize verification FAILED');
  process.exit(1);
}
console.log('\nchat chunk resize verification passed');