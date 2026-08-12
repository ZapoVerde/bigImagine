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
  const swipes = []; // { swipe_id, message_id, created_at } (chat_message_swipes, migration 0059)
  const locations = []; // { location_id, user_id, status } (locations, migration 0067; status is settled by
  // the sync tick below — 0096 moved the chat/swipe anchor off the row and onto the link table)
  const characters = []; // { character_id, user_id, status } (characters, migration 0067)
  const locationChatLinks = []; // { location_id, chat_id, anchor_swipe_id } (migration 0096)
  const characterChatLinks = []; // { character_id, chat_id, anchor_swipe_id } (migration 0096)
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
    swipes,
    locations,
    characters,
    locationChatLinks,
    characterChatLinks,
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

          // runOneChatSync's per-chat advisory lock (chatMemorySync.ts) — pure DB-side
          // serialization, no rows, nothing for the in-memory fake to track.
          if (sql.includes('pg_advisory_xact_lock')) {
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

          // runOneChatSync's per-chat kind read (chatMemorySync.ts) — the seeded sessions here are
          // all 'chat'-kind (the household-digest lane), so absent a stored kind, default 'chat'.
          if (sql.startsWith('select kind from chat_sessions')) {
            const sess = chatSessions.get(params[0]);
            return { rows: sess ? [{ kind: sess.kind ?? 'chat' }] : [] };
          }

          // runOneChatSync's own full-transcript read (now carrying active_swipe_id for the
          // transient settle step — matched loosely so both column lists hit the same handler)
          if (sql.includes('select message_id, role, content')) {
            const rows = chatMessages
              .filter((m) => m.chat_id === params[0])
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id))
              .map((m) => ({ message_id: m.message_id, role: m.role, content: m.content, active_swipe_id: m.active_swipe_id ?? null }));
            return { rows };
          }

          // segway.md §2.5 settle step: a message's non-active swipes, for demotion. Anchored on
          // 'select' — the demote UPDATEs below embed the identical `from chat_message_swipes
          // where message_id` text inside their subquery.
          if (sql.startsWith('select') && sql.includes('from chat_message_swipes where message_id')) {
            const rows = swipes
              .filter((s) => s.message_id === params[0])
              .map((s) => ({ swipe_id: s.swipe_id }));
            return { rows };
          }

          // segway.md §2.5 settle step: promote the active swipe's rows, demote the alternates'.
          // db/migrations/0096: the anchor lives on location_chat_links/character_chat_links now,
          // not on the row — promotion/demotion only ever flips status, never touches the link.
          if (sql.includes("update locations set status = 'permanent'")) {
            const [userId, anchorSwipeId] = params;
            const linkedIds = new Set(locationChatLinks.filter((l) => l.anchor_swipe_id === anchorSwipeId).map((l) => l.location_id));
            const promoted = locations.filter((l) => l.user_id === userId && l.status === 'transient' && linkedIds.has(l.location_id));
            for (const l of promoted) l.status = 'permanent';
            return { rows: promoted.map((l) => ({ location_id: l.location_id })) };
          }
          if (sql.includes("update characters set status = 'permanent'")) {
            const [userId, anchorSwipeId] = params;
            const linkedIds = new Set(characterChatLinks.filter((c) => c.anchor_swipe_id === anchorSwipeId).map((c) => c.character_id));
            const promoted = characters.filter((c) => c.user_id === userId && c.status === 'transient' && linkedIds.has(c.character_id));
            for (const c of promoted) c.status = 'permanent';
            return { rows: promoted.map((c) => ({ character_id: c.character_id })) };
          }
          if (sql.includes("update locations set status = 'inactive'")) {
            const [userId, messageId, activeSwipeId] = params;
            const alternateIds = new Set(swipes.filter((s) => s.message_id === messageId && s.swipe_id !== activeSwipeId).map((s) => s.swipe_id));
            const linkedIds = new Set(locationChatLinks.filter((l) => alternateIds.has(l.anchor_swipe_id)).map((l) => l.location_id));
            const demoted = locations.filter((l) => l.user_id === userId && l.status === 'transient' && linkedIds.has(l.location_id));
            for (const l of demoted) l.status = 'inactive';
            return { rows: demoted.map((l) => ({ location_id: l.location_id })) };
          }
          if (sql.includes("update characters set status = 'inactive'")) {
            const [userId, messageId, activeSwipeId] = params;
            const alternateIds = new Set(swipes.filter((s) => s.message_id === messageId && s.swipe_id !== activeSwipeId).map((s) => s.swipe_id));
            const linkedIds = new Set(characterChatLinks.filter((c) => alternateIds.has(c.anchor_swipe_id)).map((c) => c.character_id));
            const demoted = characters.filter((c) => c.user_id === userId && c.status === 'transient' && linkedIds.has(c.character_id));
            for (const c of demoted) c.status = 'inactive';
            return { rows: demoted.map((c) => ({ character_id: c.character_id })) };
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

          // 0079 sync inspection: the rp lane's bridge-prompt persistence (chatMemorySync.ts
          // updates the just-inserted sync point after the bridge runs) and the canon_facts
          // inserts it stamps with that sync's id.
          if (sql.includes('update chat_sync_points set bridge_prompt')) {
            const [syncId, bridgePrompt] = params;
            const sp = chatSyncPoints.find((p) => p.sync_id === syncId);
            if (sp) sp.bridge_prompt = bridgePrompt;
            return { rows: [] };
          }

          // The bridge's open-thread read (latest-approved-per-arc_tag) and the two curators'
          // existing-entry reads — all empty on a first sync, which is all this script exercises.
          if (sql.includes('select distinct on (arc_tag)')) {
            return { rows: [] };
          }
          if (sql.includes('select distinct on (entity_key)')) {
            return { rows: [] };
          }

          if (sql.includes('insert into canon_facts')) {
            // Column order (0079): (user_id, category, arc_tag|entity_key, summary, detail,
            // vector_embed, chat_id, sync_id) — arc_tag for the bridge's plot lane, entity_key
            // for the two curators, exactly one of them present per insert. Param layout differs
            // by lane: plot/people put the category in the SQL as a literal (7 params), the
            // lorebook lane passes it as $2 (8 params).
            const isPlot = sql.includes("'plot'");
            const isPerson = sql.includes("'person'");
            let userId, category, tag, summary, detail, chatId, syncId;
            if (isPlot) {
              [userId, tag, summary, detail, , chatId, syncId] = params;
              category = 'plot';
            } else if (isPerson) {
              [userId, tag, summary, detail, , chatId, syncId] = params;
              category = 'person';
            } else {
              [userId, category, tag, summary, detail, , chatId, syncId] = params;
            }
            canonFacts.push({
              fact_id: randomUUID(),
              chat_id: chatId,
              user_id: userId,
              category,
              status: 'proposed',
              approved_at: null,
              arc_tag: category === 'plot' ? tag : null,
              entity_key: category === 'plot' ? null : tag,
              summary,
              detail,
              sync_id: syncId ?? null,
              proposed_at: now(),
            });
            return { rows: [] };
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
      if (options.forceTool === 'bridge_chat_memory') {
        return {
          message: { role: 'assistant', content: '' },
          toolCalls: [
            {
              id: randomUUID(),
              name: 'bridge_chat_memory',
              arguments: {
                events: '| When | What | Who |\n|------|------|-----|',
                scene: 'SCENE: A quiet square at dusk.',
                plot_entries: [{ name: 'The Ashford Siege Breaks Open', content: 'The siege wall breached.', arc_tag: 'siege_break' }],
              },
            },
          ],
        };
      }
      if (options.forceTool === 'curate_lorebook') {
        return {
          message: { role: 'assistant', content: '' },
          toolCalls: [
            {
              id: randomUUID(),
              name: 'curate_lorebook',
              arguments: { entries: [{ action: 'new', name: 'The Pavilion', category: 'place', content: 'A weathered pavilion.' }] },
            },
          ],
        };
      }
      if (options.forceTool === 'curate_people') {
        return {
          message: { role: 'assistant', content: '' },
          toolCalls: [
            {
              id: randomUUID(),
              name: 'curate_people',
              arguments: { entries: [{ action: 'new', name: 'Elena Ashford', content: '**Appearance:** tall.\n**Goals:** hold the gate.' }] },
            },
          ],
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

// --- segway.md §2.5: the transient settle step promotes the active swipe's rows and demotes the
// alternate swipes' rows for the messages leaving the live window, never deleting anything ---
{
  const settleChatId = randomUUID();
  pool.chatSessions.set(settleChatId, { user_id: USER, archived_at: null });
  const settleMessages = [];
  for (let i = 1; i <= 12; i++) {
    settleMessages.push({
      message_id: randomUUID(),
      chat_id: settleChatId,
      user_id: USER,
      role: i % 2 === 1 ? 'user' : 'assistant',
      content: `settle-${i}`,
      created_at: pool.now(),
      active_swipe_id: null,
    });
  }
  // The last archived message (index 7 of the 12 — 8 archive, 4 stay live) has an active swipe
  // plus one alternate, with transient rows anchored to each; a permanent row must stay put.
  const activeSwipeId = randomUUID();
  const alternateSwipeId = randomUUID();
  settleMessages[7].active_swipe_id = activeSwipeId;
  pool.chatMessages.push(...settleMessages);
  pool.swipes.push({ swipe_id: activeSwipeId, message_id: settleMessages[7].message_id, created_at: pool.now() });
  pool.swipes.push({ swipe_id: alternateSwipeId, message_id: settleMessages[7].message_id, created_at: pool.now() });

  const promotedLocation = { location_id: randomUUID(), user_id: USER, status: 'transient' };
  const demotedLocation = { location_id: randomUUID(), user_id: USER, status: 'transient' };
  const permanentLocation = { location_id: randomUUID(), user_id: USER, status: 'permanent' };
  const promotedCharacter = { character_id: randomUUID(), user_id: USER, status: 'transient' };
  const demotedCharacter = { character_id: randomUUID(), user_id: USER, status: 'transient' };
  pool.locations.push(promotedLocation, demotedLocation, permanentLocation);
  pool.characters.push(promotedCharacter, demotedCharacter);
  // db/migrations/0096: the chat/swipe anchor lives on the link row, not the location/character row.
  pool.locationChatLinks.push({ location_id: promotedLocation.location_id, chat_id: settleChatId, anchor_swipe_id: activeSwipeId });
  pool.locationChatLinks.push({ location_id: demotedLocation.location_id, chat_id: settleChatId, anchor_swipe_id: alternateSwipeId });
  pool.characterChatLinks.push({ character_id: promotedCharacter.character_id, chat_id: settleChatId, anchor_swipe_id: activeSwipeId });
  pool.characterChatLinks.push({ character_id: demotedCharacter.character_id, chat_id: settleChatId, anchor_swipe_id: alternateSwipeId });

  await runChatMemorySyncTick(deps);

  const promotedLocationLink = pool.locationChatLinks.find((l) => l.location_id === promotedLocation.location_id);
  const promotedCharacterLink = pool.characterChatLinks.find((c) => c.character_id === promotedCharacter.character_id);
  assert(promotedLocation.status === 'permanent', "the archived turn's active-swipe location promotes to permanent");
  assert(promotedCharacter.status === 'permanent', "the archived turn's active-swipe character promotes to permanent too");
  assert(promotedLocationLink?.anchor_swipe_id === activeSwipeId, "promotion never clears the link row's anchor_swipe_id (that used to sever the row's only FK path back to its chat)");
  assert(promotedCharacterLink?.anchor_swipe_id === activeSwipeId, "promotion never clears the character link's anchor_swipe_id either");
  assert(demotedLocation.status === 'inactive', "the archived turn's alternate-swipe location demotes to inactive — not deleted");
  assert(demotedCharacter.status === 'inactive', "the archived turn's alternate-swipe character demotes to inactive — not deleted");
  assert(permanentLocation.status === 'permanent', 'a permanent row is untouched by the settle step');
  assert(pool.locations.length === 3 && pool.characters.length === 2, 'nothing is ever deleted by the settle step');
}

// --- The 2026-08-09 sync_point duplicate-key regression (chatMemorySync.ts): the poll tick fires
// every POLL_INTERVAL_MS while a single pass takes minutes of LLM round-trips, so ticks overlap
// by construction. Two overlapping passes for the same chat both read the same last-synced
// ordinal, both compute the same nextOrdinal, and the loser's chat_sync_points insert dies on the
// (chat_id, ordinal) unique constraint. The in-flight guard must let pass A win and make pass B
// skip ('skipped' status, zero extra LLM work, zero extra chunks) instead of racing it. ---
{
  const CONCUR_CHAT_ID = randomUUID();
  pool.chatSessions.set(CONCUR_CHAT_ID, { user_id: USER, archived_at: null });
  seedMessages(CONCUR_CHAT_ID, 'CONCUR', 12); // clears the due threshold

  // Gate the fake LLM's summarize calls so pass A is provably parked mid-pipeline (before it can
  // commit its sync point) when pass B runs. aInside flips before the gate await — the record of
  // the call being entered is what the poller below waits on.
  const realComplete = llm.complete;
  let releaseGate;
  let aInside = false;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  llm.complete = async (messages, tools, options) => {
    if (options.forceTool === 'summarize_chat_chunk') {
      aInside = true;
      await gate;
    }
    return realComplete.call(llm, messages, tools, options);
  };

  try {
    const passA = runChatMemorySyncTick(deps); // don't await — hold it mid-flight
    let waited = 0;
    while (!aInside && waited < 1000) {
      await new Promise((r) => setTimeout(r, 5));
      waited++;
    }
    assert(aInside, 'test setup: pass A reaches the gated summarize step (so it is provably in flight)');

    // Pass B: findDueChats still sees the chat as due (A hasn't committed), but the in-flight
    // guard must skip it — no second summarize/embed/bridge pipeline, no second sync point, and
    // the status row says 'skipped', not a second attempt.
    const summarizeCallsBeforeB = llm.calls.filter((c) => c.options.forceTool === 'summarize_chat_chunk').length;
    const chunksBeforeB = pool.chatChunks.filter((c) => c.chat_id === CONCUR_CHAT_ID).length;
    await runChatMemorySyncTick(deps);
    const statusWhileAFlying = pool.chatMemorySyncStatus.get(CONCUR_CHAT_ID);
    assert(statusWhileAFlying?.last_status === 'skipped', "the overlapping tick records 'skipped' — the guard short-circuits before any work");
    assert(
      llm.calls.filter((c) => c.options.forceTool === 'summarize_chat_chunk').length === summarizeCallsBeforeB,
      'the overlapping tick launches zero additional summarize calls for the in-flight chat',
    );
    assert(
      pool.chatChunks.filter((c) => c.chat_id === CONCUR_CHAT_ID).length === chunksBeforeB,
      'the overlapping tick adds no chunks — it never reaches the sync_point insert, let alone collides on the ordinal',
    );

    releaseGate();
    await passA;

    assert(
      pool.chatChunks.filter((c) => c.chat_id === CONCUR_CHAT_ID).length === 2,
      'pass A alone archives its 2 chunks (8 of 12 messages) once it finishes',
    );
    assert(
      pool.chatMemorySyncStatus.get(CONCUR_CHAT_ID)?.last_status === 'ok',
      "the winning pass's commit overwrites the transient 'skipped' with ok",
    );
  } finally {
    llm.complete = realComplete;
  }
}

// --- The rp lane (db/migrations/0079_sync_inspection.sql): a sync of an rp chat persists the
// fully-rendered bridge prompt onto its sync point and stamps every canon-fact proposal it writes
// (plot/lorebook/people) with that sync's id — the write side of the sync-status panel's "click a
// sync and play it back" inspection. ---
{
  const RP_CHAT_ID = randomUUID();
  pool.chatSessions.set(RP_CHAT_ID, { user_id: USER, archived_at: null, kind: 'rp' });
  seedMessages(RP_CHAT_ID, 'RP', 12); // same 12-message due profile as the household tick above

  const chunksBefore = pool.chatChunks.length;
  await runChatMemorySyncTick(deps);

  assert(pool.chatChunks.length === chunksBefore + 2, "an rp chat's tick archives its chunks like any other chat");
  const rpSyncs = pool.chatSyncPoints.filter((sp) => sp.chat_id === RP_CHAT_ID);
  assert(rpSyncs.length === 1, "an rp chat's successful tick writes exactly one sync point");
  const rpSyncId = rpSyncs[0].sync_id;
  assert(
    rpSyncs[0].bridge_prompt?.includes('NARRATIVE CHRONICLER') && rpSyncs[0].bridge_prompt.includes('TRANSCRIPT:'),
    'the bridge prompt the sync sent the model is persisted onto the sync point (system + transcript + previous output)',
  );
  assert(
    rpSyncs[0].bridge_prompt.includes('RP-user-1'),
    "the persisted bridge prompt carries this sync's raw transcript, not a placeholder",
  );

  const rpEntries = [...pool.chatMemoryEntries.values()].filter((e) => e.chat_id === RP_CHAT_ID);
  assert(rpEntries.length === 2, 'the bridge writes its SCENE and EVENTS entries');
  assert(
    rpEntries.every((e) => e.sync_id === rpSyncId),
    'both bridge entries point at the sync that created them, so the inspection can list them per sync',
  );

  const rpFacts = pool.canonFacts.filter((f) => f.chat_id === RP_CHAT_ID);
  assert(rpFacts.length === 3, 'the tick proposes one plot, one lorebook, and one people fact');
  assert(
    rpFacts.every((f) => f.sync_id === rpSyncId),
    'every canon-fact proposal the sync wrote carries its sync_id — plot, lorebook, and people lanes alike',
  );
  assert(
    rpFacts.some((f) => f.category === 'plot' && f.arc_tag === 'siege_break'),
    "the bridge's plot proposal lands with its arc_tag intact",
  );
  assert(
    rpFacts.some((f) => f.category === 'person' && f.entity_key === 'person:elena-ashford'),
    "the people curator's proposal lands with its entity_key intact",
  );
  assert(
    pool.chatMemorySyncStatus.get(RP_CHAT_ID)?.last_entries_updated === 5,
    'an rp sync reports 5 entries updated (scene + events + plot + lorebook + people)',
  );
}

if (process.exitCode) {
  console.error('\nchat memory sync verification FAILED');
  process.exit(1);
}
console.log('\nchat memory sync verification passed');
