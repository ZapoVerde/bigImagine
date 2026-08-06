// Proves orchestrator/chatMemorySync.ts's rolling sync pipeline against a fake in-memory pool (no
// real Postgres) plus fake LLM/embeddings providers, mirroring verify-chat-sessions.mjs's style.
// The one behavior this file exists specifically to prove: chat_memory_digest_horizon_pairs makes
// distillChatMemory re-read a trailing horizon of chat_chunks.summary on every sync, not just the
// chunks that tick freshly produced (docs/chat-memory.md's "Settings" section).

import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../dist/io/postgres.js';
import { runChatMemorySyncTick, archiveChatMemory } from '../dist/orchestrator/chatMemorySync.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake pool: in-memory chat_sessions / chat_messages / chat_sync_points / chat_chunks /
// chat_memory_entries / household_memory tables, covering exactly the queries chatMemorySync.ts
// issues. ---
function createFakePool() {
  const users = [];
  const chatSessions = new Map(); // chat_id -> { user_id, archived_at }
  const chatMessages = []; // { message_id, chat_id, user_id, role, content, created_at }
  const chatSyncPoints = []; // { sync_id, chat_id, user_id, ordinal, last_message_id }
  const chatChunks = []; // { chat_id, sync_id, user_id, ordinal, content, summary, vector_embed }
  const chatMemoryEntries = new Map(); // `${chat_id}::${topic_key}` -> row
  const householdMemory = []; // { user_id, source_chat_id, content, source }
  const chatMemorySyncStatus = new Map(); // chat_id -> row (chat_memory_sync_status, migration 0055)
  const canonFacts = []; // { fact_id, chat_id, user_id, status, approved_at } (canon_facts, migration 0058)
  let clock = 1000;
  const now = () => new Date((clock += 1000)).toISOString();

  return {
    users,
    chatSessions,
    chatMessages,
    chatSyncPoints,
    chatChunks,
    chatMemoryEntries,
    householdMemory,
    chatMemorySyncStatus,
    canonFacts,
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

          if (sql === 'select user_id from users') {
            return { rows: users.map((u) => ({ user_id: u })) };
          }

          // findDueChats
          if (sql.includes('from chat_sessions cs')) {
            const [threshold] = params;
            const due = [];
            for (const [chatId, sess] of chatSessions) {
              if (sess.user_id !== scopedUserId || sess.archived_at) continue;
              const chatSyncs = chatSyncPoints.filter((sp) => sp.chat_id === chatId);
              const last = chatSyncs.length ? chatSyncs.reduce((a, b) => (b.ordinal > a.ordinal ? b : a)) : undefined;
              const anchor = last ? chatMessages.find((m) => m.message_id === last.last_message_id) : undefined;
              const count = chatMessages.filter(
                (m) => m.chat_id === chatId && (!anchor || m.created_at > anchor.created_at),
              ).length;
              if (count >= threshold) due.push({ chat_id: chatId });
            }
            return { rows: due };
          }

          // runOneChatSync's own full-transcript read
          if (sql.includes('select message_id, role, content from chat_messages')) {
            const rows = chatMessages
              .filter((m) => m.chat_id === params[0])
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id))
              .map((m) => ({ message_id: m.message_id, role: m.role, content: m.content }));
            return { rows };
          }

          // archiveChatMemory's tail read (checked before any other chat_messages branch)
          if (sql.includes('limit 20')) {
            const rows = chatMessages
              .filter((m) => m.chat_id === params[0])
              .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.message_id.localeCompare(a.message_id))
              .slice(0, 20)
              .map((m) => ({ role: m.role, content: m.content }));
            return { rows };
          }

          if (sql.includes('select last_message_id, ordinal from chat_sync_points')) {
            const rows = chatSyncPoints
              .filter((sp) => sp.chat_id === params[0])
              .sort((a, b) => b.ordinal - a.ordinal)
              .slice(0, 1)
              .map((sp) => ({ last_message_id: sp.last_message_id, ordinal: sp.ordinal }));
            return { rows };
          }

          if (sql.includes('select count(*)::text as n from chat_chunks')) {
            const n = chatChunks.filter((c) => c.chat_id === params[0]).length;
            return { rows: [{ n: String(n) }] };
          }

          if (sql.includes('insert into chat_sync_points')) {
            const [chatId, userId, ordinal, lastMessageId] = params;
            const row = { sync_id: randomUUID(), chat_id: chatId, user_id: userId, ordinal, last_message_id: lastMessageId };
            chatSyncPoints.push(row);
            return { rows: [{ sync_id: row.sync_id }] };
          }

          if (sql.includes('insert into chat_chunks')) {
            const [chatId, syncId, userId, ordinal, content, summary, vectorEmbed] = params;
            chatChunks.push({ chat_id: chatId, sync_id: syncId, user_id: userId, ordinal, content, summary, vector_embed: vectorEmbed });
            return { rows: [] };
          }

          // archiveChatMemory's own entries read (order by updated_at) — checked before the plain
          // runOneChatSync read below, since that plain query's text is a substring of this one.
          if (sql.includes('order by updated_at')) {
            const rows = [...chatMemoryEntries.values()]
              .filter((e) => e.chat_id === params[0])
              .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
              .map((e) => ({ topic_key: e.topic_key, content: e.content }));
            return { rows };
          }
          if (sql.includes('select topic_key, content from chat_memory_entries')) {
            const rows = [...chatMemoryEntries.values()]
              .filter((e) => e.chat_id === params[0])
              .map((e) => ({ topic_key: e.topic_key, content: e.content }));
            return { rows };
          }

          // The digest-horizon re-read
          if (sql.includes('select summary from chat_chunks')) {
            const [chatId, limit] = params;
            const rows = chatChunks
              .filter((c) => c.chat_id === chatId)
              .sort((a, b) => b.ordinal - a.ordinal)
              .slice(0, limit)
              .map((c) => ({ summary: c.summary }));
            return { rows };
          }

          if (sql.includes('insert into chat_memory_entries')) {
            const [chatId, syncId, userId, topicKey, content] = params;
            chatMemoryEntries.set(`${chatId}::${topicKey}`, {
              chat_id: chatId,
              sync_id: syncId,
              user_id: userId,
              topic_key: topicKey,
              content,
              updated_at: now(),
            });
            return { rows: [] };
          }

          if (sql.includes('insert into household_memory')) {
            const [userId, chatId, content] = params;
            householdMemory.push({ user_id: userId, source_chat_id: chatId, content, source: 'inferred' });
            return { rows: [] };
          }

          // recordSyncStatus's three upsert shapes (chatMemorySync.ts) — matched by the literal
          // status text each one's own VALUES clause hard-codes, same disambiguation approach the
          // archiveChatMemory/runOneChatSync branches above already use for overlapping query text.
          if (sql.includes('insert into chat_memory_sync_status')) {
            if (sql.includes("'error'")) {
              const [chatId, userId, step, error] = params;
              const prev = chatMemorySyncStatus.get(chatId);
              chatMemorySyncStatus.set(chatId, {
                chat_id: chatId,
                user_id: userId,
                last_attempt_at: now(),
                last_status: 'error',
                last_step: step,
                last_error: error,
                last_success_at: prev?.last_success_at ?? null,
                last_chunks_added: prev?.last_chunks_added ?? null,
                last_entries_updated: prev?.last_entries_updated ?? null,
                consecutive_errors: (prev?.consecutive_errors ?? 0) + 1,
              });
              return { rows: [] };
            }
            if (sql.includes("'skipped'")) {
              const [chatId, userId] = params;
              const prev = chatMemorySyncStatus.get(chatId);
              chatMemorySyncStatus.set(chatId, {
                ...prev,
                chat_id: chatId,
                user_id: userId,
                last_attempt_at: now(),
                last_status: 'skipped',
                last_step: null,
                last_error: null,
              });
              return { rows: [] };
            }
            const [chatId, userId, chunksAdded, entriesUpdated] = params;
            chatMemorySyncStatus.set(chatId, {
              chat_id: chatId,
              user_id: userId,
              last_attempt_at: now(),
              last_status: 'ok',
              last_step: null,
              last_error: null,
              last_success_at: now(),
              last_chunks_added: chunksAdded,
              last_entries_updated: entriesUpdated,
              consecutive_errors: 0,
            });
            return { rows: [] };
          }

          // canon_facts auto-promotion (chatMemorySync.ts's own step, run unconditionally at the
          // top of runOneChatSync for whatever chat it's called for — migration
          // 0058_canon_facts_chat_scoped.sql).
          if (sql.includes('update canon_facts set status')) {
            const [chatId] = params;
            const promoted = [];
            for (const f of canonFacts) {
              if (f.chat_id === chatId && f.status === 'proposed') {
                f.status = 'approved';
                f.approved_at = now();
                promoted.push({ fact_id: f.fact_id });
              }
            }
            return { rows: promoted };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

// --- Fake LlmProvider: dispatches on options.forceTool, records every call so tests can inspect
// exactly what prompt each forced-schema call was built with. ---
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
      if (options.forceTool === 'distill_chat_memory') {
        return {
          message: { role: 'assistant', content: '' },
          toolCalls: [
            { id: randomUUID(), name: 'distill_chat_memory', arguments: { entries: [{ topic_key: 'thread', content: `Entry #${calls.length}` }] } },
          ],
        };
      }
      if (options.forceTool === 'classify_household_memory') {
        return {
          message: { role: 'assistant', content: '' },
          toolCalls: [{ id: randomUUID(), name: 'classify_household_memory', arguments: { memories: ['A durable fact worth remembering.'] } }],
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
const CHAT_ID = randomUUID();
const NOT_DUE_CHAT_ID = randomUUID();

const pool = createFakePool();
pool.users.push(USER);
pool.chatSessions.set(CHAT_ID, { user_id: USER, archived_at: null });
pool.chatSessions.set(NOT_DUE_CHAT_ID, { user_id: USER, archived_at: null });

const db = createPostgresClient(pool);
const llm = createFakeLlm();
const embeddings = createFakeEmbeddings();
// live window 2 pairs (4 msgs), sync-every 2 pairs (4 msgs) -> due once 8 unsynced messages pile
// up; digest horizon 8 pairs -> ceil(8 / 2 pairs-per-chunk) = 4 chunks re-read every sync.
const settings = createFakeSettingsStore({
  chat_memory_live_window_pairs: '2',
  chat_memory_sync_every_pairs: '2',
  chat_memory_digest_horizon_pairs: '8',
});
const deps = { db, llm, embeddings, settings, llmProfiles: {} };

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
}

function distillCalls() {
  return llm.calls.filter((c) => c.options.forceTool === 'distill_chat_memory');
}

// --- Tick 1: 12 fresh messages, well past the 8-message due threshold ---
seedMessages(CHAT_ID, 'T1', 12);
await runChatMemorySyncTick(deps);

assert(pool.chatChunks.length === 2, 'tick 1 archives exactly 2 chunks (8 of 12 messages; 4 held back by the live window)');
assert(distillCalls().length === 1, 'tick 1 calls distill_chat_memory exactly once for the one due chat');
{
  const prompt = distillCalls()[0].messages.find((m) => m.role === 'user').content;
  assert(prompt.includes('T1-user-1'), "tick 1's distill prompt includes the chunk it just summarized");
  const itemCount = (prompt.match(/^\d+\. /gm) || []).length;
  assert(itemCount === 2, 'tick 1 sees only the 2 chunks that exist so far — nothing to widen beyond yet');
}
assert(pool.chatMemoryEntries.size === 1, 'the digest entry the fake LLM returned was upserted');
{
  const status = pool.chatMemorySyncStatus.get(CHAT_ID);
  assert(status?.last_status === 'ok', 'tick 1 records chat_memory_sync_status as ok for the chat it synced');
  assert(status?.last_chunks_added === 2 && status?.last_entries_updated === 1, "tick 1's status row carries the counts it actually produced");
  assert(status?.consecutive_errors === 0, "a successful tick's status row has no consecutive errors");
}

// --- Tick 2: 8 more messages, due again. The digest horizon (4 chunks) now exceeds what this
// tick alone produces (2 chunks) — this is the behavior the whole feature exists to prove. ---
seedMessages(CHAT_ID, 'T2', 8);
await runChatMemorySyncTick(deps);

assert(pool.chatChunks.length === 4, 'tick 2 archives 2 more chunks (4 total)');
assert(distillCalls().length === 2, 'distill_chat_memory has now been called once per tick, not once total');
{
  const tick2Prompt = distillCalls()[1].messages.find((m) => m.role === 'user').content;
  const itemCount = (tick2Prompt.match(/^\d+\. /gm) || []).length;
  assert(itemCount === 4, 'tick 2 digest horizon re-reads all 4 archived chunks, not just the 2 this tick freshly produced');
  assert(
    tick2Prompt.includes('T1-user-1'),
    "digest-horizon widening: tick 2's distill prompt still includes tick 1's own chunk summary, not just tick 2's new ones",
  );
  assert(tick2Prompt.includes('T2-user-1'), "tick 2's distill prompt also includes its own freshly archived chunk");
}

// --- A chat with too few unsynced messages is left alone entirely ---
seedMessages(NOT_DUE_CHAT_ID, 'NEVER', 5);
const chunksBeforeTick3 = pool.chatChunks.length;
const distillCallsBeforeTick3 = distillCalls().length;
await runChatMemorySyncTick(deps);
assert(pool.chatChunks.length === chunksBeforeTick3, 'a chat below the due threshold gets no new chunks');
assert(distillCalls().length === distillCallsBeforeTick3, 'a chat below the due threshold triggers no distill_chat_memory call');
// NOT_DUE_CHAT_ID never even reaches runOneChatSync — findDueChats' own rough SQL filter already
// excludes it, so it gets no status row at all (nothing was attempted, there's nothing to record).
assert(pool.chatMemorySyncStatus.get(NOT_DUE_CHAT_ID) === undefined, "a chat findDueChats never selects isn't attempted, so it gets no status row");

// --- runOneChatSync's own finer-grained no-op (chatMemorySync.ts:194-199) is a defensive check for
// when findDueChats' rough candidate filter over-selects — normally unreachable since that filter's
// own threshold (sync_every + live_window) is chosen so the inner check can't disagree. Force the
// mismatch here by temporarily lowering sync_every_pairs below a full chunk's worth, so a chat can
// clear the outer filter while still not having a full MESSAGES_PER_CHUNK worth to archive. ---
{
  const SKIP_CHAT_ID = randomUUID();
  pool.chatSessions.set(SKIP_CHAT_ID, { user_id: USER, archived_at: null });
  seedMessages(SKIP_CHAT_ID, 'SKIP', 6); // outer threshold with sync_every_pairs=1: 2 + 4 = 6

  await settings.set('chat_memory_sync_every_pairs', '1');
  const chunksBeforeSkip = pool.chatChunks.length;
  await runChatMemorySyncTick(deps);
  await settings.set('chat_memory_sync_every_pairs', '2');

  assert(pool.chatChunks.length === chunksBeforeSkip, "the inner no-op still archives nothing, even though findDueChats picked the chat up");
  const status = pool.chatMemorySyncStatus.get(SKIP_CHAT_ID);
  assert(status?.last_status === 'skipped', 'the inner no-op records chat_memory_sync_status as skipped, not silence');
  assert(status?.last_success_at == null, "skipping doesn't touch last_success_at");
  assert(status?.last_step === null && status?.last_error === null, 'a skip is not an error — no step/error recorded');
}

// --- A chat whose sync fails partway through records which step broke, and self-clears on the
// next successful attempt (chat_memory_sync_status, migration 0055 — bi_principles.md §11's read
// surface for this pipeline's existing log-only failure seams). ---
{
  const FAIL_CHAT_ID = randomUUID();
  pool.chatSessions.set(FAIL_CHAT_ID, { user_id: USER, archived_at: null });
  seedMessages(FAIL_CHAT_ID, 'FAIL', 12);

  const realEmbed = embeddings.embed;
  embeddings.embed = async () => {
    throw new Error('embeddings provider unreachable');
  };
  await runChatMemorySyncTick(deps);
  embeddings.embed = realEmbed;

  assert(pool.chatChunks.filter((c) => c.chat_id === FAIL_CHAT_ID).length === 0, "a failed tick's transaction rolls back — no chunks persist");
  {
    const status = pool.chatMemorySyncStatus.get(FAIL_CHAT_ID);
    assert(status?.last_status === 'error', 'a failed tick records chat_memory_sync_status as error');
    assert(status?.last_step === 'summarize_embed', 'the status row names the exact step that threw, not just "something failed"');
    assert(status?.last_error === 'embeddings provider unreachable', 'the status row carries the underlying error message');
    assert(status?.consecutive_errors === 1, 'the first failure sets consecutive_errors to 1');
  }

  // Same chat, still due (the failed tick never advanced its sync point) — a clean tick now
  // succeeds and the status row flips back to ok, clearing the error and resetting the streak.
  await runChatMemorySyncTick(deps);
  {
    const status = pool.chatMemorySyncStatus.get(FAIL_CHAT_ID);
    assert(status?.last_status === 'ok', 'a subsequent successful tick overwrites the error status with ok');
    assert(status?.last_step === null && status?.last_error === null, 'a successful tick clears the previous step/error');
    assert(status?.consecutive_errors === 0, 'a successful tick resets consecutive_errors back to 0');
  }
}

// --- canon_facts auto-promote at the chat's own next due sync tick (db/migrations/
// 0058_canon_facts_chat_scoped.sql) — a 'proposed' row flips to 'approved' as part of the same
// per-chat transaction as the rest of that tick, not on any separate schedule. A fact belonging to
// a chat that isn't due yet is left alone entirely — promotion only happens because
// runOneChatSync actually ran for that chat, not on a standalone timer. ---
{
  const CANON_CHAT_ID = randomUUID();
  pool.chatSessions.set(CANON_CHAT_ID, { user_id: USER, archived_at: null });
  seedMessages(CANON_CHAT_ID, 'CANON', 8); // clears the due threshold

  const proposedId = randomUUID();
  const alreadyApprovedId = randomUUID();
  pool.canonFacts.push(
    { fact_id: proposedId, chat_id: CANON_CHAT_ID, user_id: USER, status: 'proposed', approved_at: null },
    { fact_id: alreadyApprovedId, chat_id: CANON_CHAT_ID, user_id: USER, status: 'approved', approved_at: pool.now() },
  );

  const NOT_DUE_CANON_CHAT_ID = randomUUID();
  pool.chatSessions.set(NOT_DUE_CANON_CHAT_ID, { user_id: USER, archived_at: null });
  seedMessages(NOT_DUE_CANON_CHAT_ID, 'NOTDUE', 2); // well under the due threshold
  const untouchedId = randomUUID();
  pool.canonFacts.push({ fact_id: untouchedId, chat_id: NOT_DUE_CANON_CHAT_ID, user_id: USER, status: 'proposed', approved_at: null });

  await runChatMemorySyncTick(deps);

  const promoted = pool.canonFacts.find((f) => f.fact_id === proposedId);
  assert(promoted?.status === 'approved', "a proposed canon fact auto-promotes at its chat's own due sync tick");
  assert(promoted?.approved_at != null, 'promotion stamps approved_at');

  const alreadyApproved = pool.canonFacts.find((f) => f.fact_id === alreadyApprovedId);
  assert(alreadyApproved?.status === 'approved', 'an already-approved fact is left untouched, not re-stamped');

  const untouched = pool.canonFacts.find((f) => f.fact_id === untouchedId);
  assert(untouched?.status === 'proposed', "a fact belonging to a chat that isn't due yet is not promoted");
}

// --- archiveChatMemory: the one-shot end-of-chat long-term-memory extraction ---
{
  const archiveChatId = randomUUID();
  pool.chatMemoryEntries.set(`${archiveChatId}::topic_a`, {
    chat_id: archiveChatId,
    topic_key: 'topic_a',
    content: 'Household prefers oat milk.',
    updated_at: pool.now(),
  });
  pool.chatMessages.push({
    message_id: randomUUID(),
    chat_id: archiveChatId,
    user_id: USER,
    role: 'user',
    content: 'thanks, thats everything',
    created_at: pool.now(),
  });

  await archiveChatMemory(deps, USER, archiveChatId, 'Grocery run planning');

  const householdRow = pool.householdMemory.find((h) => h.source_chat_id === archiveChatId);
  assert(householdRow !== undefined, 'archiveChatMemory writes a household_memory row from the fake LLM response');
  assert(householdRow?.content === 'A durable fact worth remembering.', 'the row carries the memory text the LLM returned');
  assert(householdRow?.source === 'inferred', "archiveChatMemory always stamps source 'inferred', never 'user'");

  const call = llm.calls[llm.calls.length - 1];
  const digest = call.messages.find((m) => m.role === 'user').content;
  assert(digest.includes('Grocery run planning'), "the digest sent to classify_household_memory includes the chat's title");
  assert(digest.includes('Household prefers oat milk.'), 'the digest includes the existing key-ideas entries');
}

if (process.exitCode) {
  console.error('\nchat memory sync verification FAILED');
  process.exit(1);
}
console.log('\nchat memory sync verification passed');
