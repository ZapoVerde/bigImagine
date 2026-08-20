// Proves orchestrator/chatMemorySync.ts's rolling sync pipeline against a fake in-memory pool (no
// real Postgres) plus fake LLM/embeddings providers, mirroring verify-chat-sessions.mjs's style.
// The one behavior this file exists specifically to prove: chat_memory_digest_horizon_pairs makes
// distillChatMemory re-read a trailing horizon of chat_chunks.summary on every sync, not just the
// chunks that tick freshly produced (docs/chat-memory.md's "Settings" section).

import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../dist/io/postgres.js';
import { runChatMemorySyncTick, archiveChatMemory, computeChatSyncHealth } from '../dist/orchestrator/chatMemorySync.js';

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
  const chatSyncPoints = []; // { sync_id, chat_id, user_id, ordinal, last_message_id, closed_at }
  const chatChunks = []; // { chat_id, sync_id, user_id, ordinal, content, summary, vector_embed }
  const chatMemoryEntries = new Map(); // `${chat_id}::${topic_key}` -> row
  const householdMemory = []; // { user_id, source_chat_id, content, source }
  const chatMemorySyncStatus = new Map(); // chat_id -> row (chat_memory_sync_status, migration 0055)
  const canonFacts = []; // { fact_id, chat_id, user_id, status, approved_at } (canon_facts, migration 0058)
  const swipes = []; // { swipe_id, message_id, created_at } (chat_message_swipes, migration 0059)
  const locations = []; // { location_id, user_id, status } (locations, migration 0067; status is settled by
  // the sync tick below — 0096 moved the chat/swipe anchor off the row and onto the link table)
  const characters = []; // { character_id, user_id, name, appearance, status } (characters, migration 0067;
  // name+appearance for the upsert_people write-back, character-appearance-field-plan.md)
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

          // findDueChats — the "last sync point" anchor is closed-only now (eager-chunk-sync-plan:
          // an open, chunk-only point is never a consolidation boundary, so it must not suppress
          // due-ness). Also the permanent-failure suppression (migration 0127): a chat whose last
          // attempt was a permanent failure under the CURRENT connection signature — params[1] —
          // is excluded until the signature differs or the retry window (params[2], seconds)
          // elapses, so a dead "No endpoints found for <model>" 404 doesn't re-fire every 30s tick.
          if (sql.includes('from chat_sessions cs')) {
            const [threshold, signature, retrySeconds] = params;
            const due = [];
            for (const [chatId, sess] of chatSessions) {
              if (sess.user_id !== scopedUserId || sess.archived_at) continue;
              const st = chatMemorySyncStatus.get(chatId);
              if (st && st.last_status === 'error' && st.last_error_kind === 'permanent') {
                if (st.failure_signature === signature) {
                  const elapsed = new Date(now()).getTime() - new Date(st.last_attempt_at).getTime();
                  if (elapsed < retrySeconds * 1000) continue;
                }
              }
              const chatSyncs = chatSyncPoints.filter((sp) => sp.chat_id === chatId && sp.closed_at);
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

          // The connection-backed sync llm is a gated openai-compatible provider, which meters
          // every complete() into llm_calls (io/llm/llmGate.ts) — swallowed here; the sync path
          // itself is what these tests are about, not the meter.
          if (sql.includes('insert into llm_calls')) {
            return { rows: [] };
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

          // runOneChatSync's open-sync-point lookup (eager-chunk-sync-plan: reuse-or-create) —
          // checked before the closed-only lastSynced branch below (neither matches the other).
          if (sql.includes('closed_at is null')) {
            const rows = chatSyncPoints
              .filter((sp) => sp.chat_id === params[0] && !sp.closed_at)
              .sort((a, b) => b.ordinal - a.ordinal)
              .slice(0, 1)
              .map((sp) => ({ sync_id: sp.sync_id, last_message_id: sp.last_message_id, ordinal: sp.ordinal }));
            return { rows };
          }

          if (sql.includes('select last_message_id, ordinal from chat_sync_points')) {
            const rows = chatSyncPoints
              .filter((sp) => sp.chat_id === params[0] && sp.closed_at)
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
            if (sql.includes('closed_at')) row.closed_at = now();
            chatSyncPoints.push(row);
            return { rows: [{ sync_id: row.sync_id }] };
          }

          if (sql.includes('insert into chat_chunks')) {
            const [chatId, syncId, userId, ordinal, content, summary, vectorEmbed, summaryVectorEmbed, parentChunkId] = params;
            const chunkId = randomUUID();
            chatChunks.push({ chunk_id: chunkId, chat_id: chatId, sync_id: syncId, user_id: userId, ordinal, content, summary, vector_embed: vectorEmbed, parent_chunk_id: parentChunkId ?? null });
            return { rows: [{ chunk_id: chunkId }] };
          }

          // The lead-in chain's prev-chunk read (chatMemorySync.ts insert_chunks step, migration
          // 0100): the batch's first chunk links to the chat's current max-ordinal row.
          if (sql.includes('from chat_chunks') && sql.includes('order by ordinal desc limit 1')) {
            const [chatId] = params;
            const rows = chatChunks
              .filter((c) => c.chat_id === chatId)
              .sort((a, b) => b.ordinal - a.ordinal)
              .slice(0, 1)
              .map((c) => ({ chunk_id: c.chunk_id }));
            return { rows };
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
            // Two param layouts: the digest lane passes topic_key as $4 (5 params); the rp bridge
            // hard-codes 'scene'/'events' as a VALUES literal (4 params, $4 = content). Disambiguate
            // by which literal the SQL carries so topic_key lands correctly for both lanes.
            if (sql.includes("'scene'") || sql.includes("'events'")) {
              const [chatId, syncId, userId, content] = params;
              const topicKey = sql.includes("'scene'") ? 'scene' : 'events';
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
              const [chatId, userId, step, error, kind, signature] = params;
              const prev = chatMemorySyncStatus.get(chatId);
              chatMemorySyncStatus.set(chatId, {
                chat_id: chatId,
                user_id: userId,
                last_attempt_at: now(),
                last_status: 'error',
                last_step: step,
                last_error: error,
                last_error_kind: kind,
                failure_signature: signature,
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
                last_error_kind: null,
                failure_signature: null,
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
              last_error_kind: null,
              failure_signature: null,
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

          // The reuse-then-close update (eager-chunk-sync-plan): the tick reuses an open sync
          // point, stamps its own archiveEnd as last_message_id, and closes it. Checked before
          // the bridge_prompt update below — different column sets, neither matches the other.
          if (sql.includes('update chat_sync_points set last_message_id')) {
            const [syncId, lastMessageId] = params;
            const sp = chatSyncPoints.find((p) => p.sync_id === syncId);
            if (sp) {
              sp.last_message_id = lastMessageId;
              sp.closed_at = now();
            }
            return { rows: [] };
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

          if (sql.includes('insert into canon_facts')) {            // Column order (0079): (user_id, category, arc_tag|entity_key, summary, detail,
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

          // character-appearance-field-plan.md: the upsert_people step's exact case-insensitive
          // name lookup (scoped to user_id) and the frozen-once-set appearance write-back.
          if (sql.startsWith('select character_id, appearance from characters')) {
            const [userId, name] = params;
            const row = characters.find(
              (c) => c.user_id === userId && typeof c.name === 'string' && c.name.toLowerCase() === String(name).toLowerCase(),
            );
            return { rows: row ? [{ character_id: row.character_id, appearance: row.appearance }] : [] };
          }
          if (sql.startsWith('update characters set appearance')) {
            const [characterId, userId, appearance] = params;
            const row = characters.find((c) => c.character_id === characterId && c.user_id === userId);
            if (row) row.appearance = appearance;
            return { rows: [] };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

// --- The sync's llm rides the shared chat-memory connection (chatMemorySync.ts's
// resolveChatMemoryLlm: chat_memory_profile when set, else the household's active connection —
// never the chat's own params->>'profile') and calls it over HTTP — so the fake LLM seam moves
// into a mocked global fetch. The mock dispatches on the request's forced tool_choice, records
// each request as the same { messages, options } shape the old fake recorded (every llm.calls-based
// helper below is untouched), and returns the same turns — except the chunk classifier, which is a
// tool-free completion keyed on tool_choice's absence (chat-memory-structured-output-plan). Two
// distinct fake endpoints exist so the lock can be proven: the active connection and the named one
// a chat is locked to. ---
const ACTIVE_FAKE_BASE = 'https://sync-active-fake.example';
const NAMED_FAKE_BASE = 'https://sync-named-fake.example';
const MEMORY_C_FAKE_BASE = 'https://sync-memory-c-fake.example';
const MEMORY_D_FAKE_BASE = 'https://sync-memory-d-fake.example';

function fakeSyncProfile(baseUrl, model) {
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
    return fakeSyncProfile(ACTIVE_FAKE_BASE, 'sync-active-model');
  },
  async resolveByName(name) {
    if (name === 'sync-profile') return fakeSyncProfile(NAMED_FAKE_BASE, 'sync-named-model');
    if (name === 'memory-c') return fakeSyncProfile(MEMORY_C_FAKE_BASE, 'memory-c-model');
    if (name === 'memory-d') return fakeSyncProfile(MEMORY_D_FAKE_BASE, 'memory-d-model');
    return undefined;
  },
};

function createFakeHttpBackend() {
  return { calls: [], gateHook: null, curatePeopleOverride: null, worldCuratorOverride: null };
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

function oaiTextResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: { role: 'assistant', content, tool_calls: null },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    text: async () => '',
  };
}

function installSyncFetchMock(backend) {
  const originalFetch = globalThis.fetch;
  const knownBases = [ACTIVE_FAKE_BASE, NAMED_FAKE_BASE, MEMORY_C_FAKE_BASE, MEMORY_D_FAKE_BASE];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (knownBases.includes(u.replace('/chat/completions', ''))) {
      // Permanent/transient-failure injection: when set, every sync call in this pass returns that
      // HTTP status so the tick's error path (and the classifier stamping it) can be exercised.
      if (backend.forceStatus) {
        return {
          ok: false,
          status: backend.forceStatus,
          text: async () => `{"error":{"message":"forced failure ${backend.forceStatus}"}}`,
          json: async () => ({ error: { message: `forced failure ${backend.forceStatus}` } }),
        };
      }
      const body = JSON.parse(init.body);
      const forceTool = body.tool_choice?.function?.name;
      backend.calls.push({ messages: body.messages, options: { forceTool, model: body.model }, url: u, tools: body.tools });
      if (backend.gateHook) await backend.gateHook(forceTool);
      // Plain-text completions (chat-memory-structured-output-plan + chat-memory-world-curator-
      // plan + chat-memory-people-curator-plan: no forced tool — raw text out, parsed locally).
      // FOUR tool-free callers now share the same connection within one tick — the chunk
      // classifier, the rp bridge, the rp world curator, and the rp people curator — so the backend
      // routes on a distinguishing string in the system prompt (the bridge's chronicler header, the
      // world curator's lorebook-curator header, the people curator's people-curator header) rather
      // than on tool_choice's absence alone; routing on absence would silently serve the
      // classifier's canned summary to the others and surface as a confusing parser failure.
      if (!forceTool) {
        const sys = body.messages.find((m) => m.role === 'system')?.content ?? '';
        const content = body.messages.find((m) => m.role === 'user').content;
        if (sys.includes('NARRATIVE CHRONICLER')) {
          return oaiTextResponse(
            `EVENTS:
| When | What | Who |
|------|------|-----|

SCENE:
A quiet square at dusk.

**NEW: The Ashford Siege Breaks Open**
The siege wall breached.
#siege_break`,
          );
        }
        if (sys.includes('LOREBOOK CURATOR')) {
          return oaiTextResponse(
            backend.worldCuratorOverride ??
              `**UPDATE: Existing Place**
Category: place
[replacement text]

**NEW: New Concept**
Category: concept
[new content]

**DUPLICATE: Redundant Thing**
Duplicate of: Primary Thing`,
          );
        }
        if (sys.includes('PEOPLE CURATOR')) {
          return oaiTextResponse(
            backend.curatePeopleOverride ??
              `**UPDATE: Existing Person**
## Appearance
A weathered face under a heavy brow.

## Personality
Loyal ↔ brusque: warm beneath the gruffness.

## Core Misread
He believes debts are only ever paid in blood.

## Connections
| Person | Relation | Tone |
|--------|----------|------|

## Relationship with the protagonist
He trusts the protagonist now.

## Goals
Major: Hold the gate.
Minor: Mend his shield.
Minor: Repay the carpenter.
Minor: Find his brother.

**NEW: Elena Ashford**
## Appearance
Tall, with a lantern jaw and steel-grey eyes.

## Personality
Resolute ↔ guarded: steel wrapped in courtesy.

## Core Misread
She mistakes silence for indifference.

## Connections
| Person | Relation | Tone |
|--------|----------|------|

## Relationship with the protagonist
She has begun to trust the protagonist's word.

## Goals
Major: Hold the eastern gate.
Minor: Recover the lost ledger.
Minor: Secure the supply road.
Minor: Find her brother.`,
          );
        }
        return oaiTextResponse(`Summary[${content}]`);
      }
      switch (forceTool) {
        case 'distill_chat_memory':
          return oaiToolResponse('distill_chat_memory', { entries: [{ topic_key: 'thread', content: `Entry #${backend.calls.length}` }] });
        case 'classify_household_memory':
          return oaiToolResponse('classify_household_memory', { memories: ['A durable fact worth remembering.'] });
      }
      throw new Error(`fake sync HTTP backend got an unexpected forceTool: ${forceTool}`);
    }
    return originalFetch(url, init);
  };
}

function createFakeEmbeddings() {
  const seen = [];
  return {
    name: 'fake-embeddings',
    dimension: 3,
    seen,
    async embed(texts) {
      seen.push(...texts);
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
  };
}

function createFakeSettingsStore(initial) {
  const map = new Map(Object.entries(initial));
  const getCounts = new Map();
  return {
    getCounts,
    async get(key) {
      getCounts.set(key, (getCounts.get(key) ?? 0) + 1);
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
const backend = createFakeHttpBackend();
installSyncFetchMock(backend);
// deps.llm is unused for real sync work — resolveSyncSettings swaps in the shared
// resolveChatMemoryLlm gated provider (chat_memory_profile or the active connection). Kept as a
// shim so the llm.calls helpers below read the HTTP backend's recorded requests unchanged.
const llm = { calls: backend.calls, name: 'fake-llm', supportsVision: false, complete: async () => { throw new Error('unused — sync llm comes from the connection provider'); } };
const embeddings = createFakeEmbeddings();
// live window 2 pairs (4 msgs), sync-every 2 pairs (4 msgs) -> due once 8 unsynced messages pile
// up; digest horizon 8 pairs -> ceil(8 / 2 pairs-per-chunk) = 4 chunks re-read every sync.
const settings = createFakeSettingsStore({
  chat_memory_live_window_pairs: '2',
  chat_memory_sync_every_pairs: '2',
  chat_memory_digest_horizon_pairs: '8',
});
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

// The rp bridge is a tool-free completion too (chat-memory-structured-output-plan Chunk 2), so it
// is identified by the chronicler header in its system prompt, not by forceTool's absence — the
// same discriminator the fake HTTP backend uses to route the tool-free callers apart.
function isBridgeCall(c) {
  return (
    c.options.forceTool === undefined &&
    (c.messages.find((m) => m.role === 'system')?.content ?? '').includes('NARRATIVE CHRONICLER')
  );
}

// The rp world curator is a third tool-free completion (chat-memory-world-curator-plan.md), keyed
// on its own lorebook-curator header — distinct from the bridge's chronicler header and the
// classifier's headerless prompt, so the two pre-existing call-count assertions that assumed only
// two tool-free callers (summarizeCalls, and the connection-lock check below) must exclude it.
function isWorldCuratorCall(c) {
  return (
    c.options.forceTool === undefined &&
    (c.messages.find((m) => m.role === 'system')?.content ?? '').includes('LOREBOOK CURATOR')
  );
}

// The rp people curator is a fourth tool-free completion (chat-memory-people-curator-plan.md),
// keyed on its own people-curator header — distinct from the bridge, world curator, and
// classifier. The same two call-count assertions that already exclude bridge and world must
// exclude people too, or they silently go wrong once people joins the tool-free pool.
function isPeopleCuratorCall(c) {
  return (
    c.options.forceTool === undefined &&
    (c.messages.find((m) => m.role === 'system')?.content ?? '').includes('PEOPLE CURATOR')
  );
}

function bridgeCalls() {
  return llm.calls.filter(isBridgeCall);
}

function worldCuratorCalls() {
  return llm.calls.filter(isWorldCuratorCall);
}

function peopleCuratorCalls() {
  return llm.calls.filter(isPeopleCuratorCall);
}

function summarizeCalls() {
  return llm.calls.filter(
    (c) => c.options.forceTool === undefined && !isBridgeCall(c) && !isWorldCuratorCall(c) && !isPeopleCuratorCall(c),
  );
}

// --- Tick 1: 12 fresh messages, well past the 8-message due threshold ---
seedMessages(CHAT_ID, 'T1', 12);
await runChatMemorySyncTick(deps);

assert(pool.chatChunks.length === 2, 'tick 1 archives exactly 2 chunks (8 of 12 messages; 4 held back by the live window)');
{
  const tick1Chain = pool.chatChunks.filter((c) => c.chat_id === CHAT_ID).sort((a, b) => a.ordinal - b.ordinal);
  assert(
    tick1Chain.length === 2 &&
      tick1Chain[0].parent_chunk_id === null &&
      tick1Chain[1].parent_chunk_id === tick1Chain[0].chunk_id,
    'tick 1 links its batch via parent_chunk_id: the first chunk is the chain head (null parent), the second links to the first (migration 0100)',
  );
}
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
{
  const chain = pool.chatChunks.filter((c) => c.chat_id === CHAT_ID).sort((a, b) => a.ordinal - b.ordinal);
  assert(
    chain.length === 4 &&
      chain[0].parent_chunk_id === null &&
      chain[1].parent_chunk_id === chain[0].chunk_id &&
      chain[2].parent_chunk_id === chain[1].chunk_id &&
      chain[3].parent_chunk_id === chain[2].chunk_id,
    "tick 2's batch links to tick 1's last chunk — the whole 4-chunk chain is contiguous via parent_chunk_id (no gaps, one head)",
  );
}
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
// clear the outer filter while still not having a full chunk (pairs_per_chunk × 2 messages) worth
// to archive. ---
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

  // Gate the fake HTTP backend's summarize calls so pass A is provably parked mid-pipeline (before
  // it can commit its sync point) when pass B runs. aInside flips before the gate await — the
  // record of the call being entered is what the poller below waits on.
  let releaseGate;
  let aInside = false;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  backend.gateHook = async (forceTool) => {
    if (!forceTool) {
      aInside = true;
      await gate;
    }
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
    const summarizeCallsBeforeB = summarizeCalls().length;
    const chunksBeforeB = pool.chatChunks.filter((c) => c.chat_id === CONCUR_CHAT_ID).length;
    await runChatMemorySyncTick(deps);
    const statusWhileAFlying = pool.chatMemorySyncStatus.get(CONCUR_CHAT_ID);
    assert(statusWhileAFlying?.last_status === 'skipped', "the overlapping tick records 'skipped' — the guard short-circuits before any work");
    assert(
      summarizeCalls().length === summarizeCallsBeforeB,
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
    backend.gateHook = null;
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

  // character-appearance-field-plan.md: the people curator's entry carries a separate
  // `appearance`; a matching characters row (exact case-insensitive name, appearance blank)
  // receives it in the same tick. The curator's strict two-word name "Elena Ashford" matches
  // the scraped characters row verbatim.
  pool.characters.push({ character_id: randomUUID(), user_id: USER, name: 'Elena Ashford', appearance: '', status: 'transient' });

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
  assert(
    rpSyncs[0].bridge_prompt?.includes('PREVIOUS OUTPUT:') && rpSyncs[0].bridge_prompt.includes('OUTPUT FORMAT'),
    "the persisted inspection prompt still renders the system prompt, transcript, previous output, and the output-format block (only the forced-tool sentence is gone)",
  );

  // chat-memory-structured-output-plan Chunk 2 + chat-memory-world-curator-plan.md +
  // chat-memory-people-curator-plan.md: the bridge, world curator, and people curator are now
  // plain-text completions parsed locally, so their requests carry no tools and no forceTool — and
  // the fake backend discriminates all three from the chunk classifier's tool-free call within the
  // same 'rp' tick via their distinct system-prompt headers.
  assert(
    bridgeCalls().length === 1,
    'exactly one bridge call this tick — the fake backend routed the bridge to its own canned text output, not the classifier summary',
  );
  assert(
    bridgeCalls().every((c) => c.tools === undefined && c.options.forceTool === undefined),
    'each bridge request carries no tools array and no forceTool — ordinary completion transport',
  );
  assert(
    worldCuratorCalls().length === 1,
    'exactly one world-curator call this tick, routed on its own lorebook-curator header',
  );
  assert(
    worldCuratorCalls().every((c) => c.tools === undefined && c.options.forceTool === undefined),
    'each world-curator request carries no tools array and no forceTool — ordinary completion transport',
  );
  assert(
    peopleCuratorCalls().length === 1,
    'exactly one people-curator call this tick, routed on its own people-curator header — before the generic classifier fallthrough',
  );
  assert(
    peopleCuratorCalls().every((c) => c.tools === undefined && c.options.forceTool === undefined),
    'each people-curator request carries no tools array and no forceTool — ordinary completion transport',
  );
  const peoplePrompt = peopleCuratorCalls()[0].messages.find((m) => m.role === 'system')?.content;
  assert(
    peoplePrompt?.includes('## Relationship with the protagonist'),
    '{{user}} is still interpolated into the people-curator prompt before it is sent (resolved to the persona name)',
  );
  {
    const toolFree = llm.calls.filter((c) => c.options.forceTool === undefined);
    const bridged = toolFree.filter(isBridgeCall);
    const worlded = toolFree.filter(isWorldCuratorCall);
    const people = toolFree.filter(isPeopleCuratorCall);
    const classified = toolFree.filter((c) => !isBridgeCall(c) && !isWorldCuratorCall(c) && !isPeopleCuratorCall(c));
    assert(
      bridged.length + worlded.length + people.length + classified.length === toolFree.length,
      'the four tool-free callers partition every tool-free request with no overlap (bridge / world curator / people curator / classifier)',
    );
  }

  const rpEntries = [...pool.chatMemoryEntries.values()].filter((e) => e.chat_id === RP_CHAT_ID);
  assert(rpEntries.length === 2, 'the bridge writes its SCENE and EVENTS entries');
  assert(
    rpEntries.every((e) => e.sync_id === rpSyncId),
    'both bridge entries point at the sync that created them, so the inspection can list them per sync',
  );
  assert(
    rpEntries.find((e) => e.topic_key === 'scene')?.content === 'A quiet square at dusk.',
    "the parsed SCENE body is stored with no SCENE: heading — the raw text response was parsed, not re-wrapped",
  );
  assert(
    rpEntries.find((e) => e.topic_key === 'events')?.content === '| When | What | Who |\n|------|------|-----|',
    "the parsed EVENTS table is stored table-only (header + separator, no heading)",
  );

  const rpFacts = pool.canonFacts.filter((f) => f.chat_id === RP_CHAT_ID);
  // The fake world-curator text parses into UPDATE + NEW + DUPLICATE. The UPDATE and NEW insert
  // their canon_facts rows (proposed, keyed by entity_key); the DUPLICATE names an entry that does
  // not exist among existingRows (this is a first sync), so its category lookup misses and it is
  // skipped per-entry downstream — structurally well-formed, but no existing entry to flag.
  assert(rpFacts.length === 5, 'the tick proposes one plot, two world (update+new), and two people (update+new) facts');
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
    "the people curator's NEW proposal lands with its entity_key intact",
  );
  const peopleUpdate = rpFacts.find((f) => f.entity_key === 'person:existing-person');
  assert(
    peopleUpdate?.category === 'person' && peopleUpdate?.summary.includes('Hold the gate'),
    "the people curator's UPDATE maps to the same proposed person/canon path, with the card's content intact",
  );
  const elenaFact = rpFacts.find((f) => f.entity_key === 'person:elena-ashford');
  assert(
    elenaFact?.summary.startsWith('## Personality') && !elenaFact.summary.includes('## Appearance'),
    "the remaining person-card markdown lands in the fact's summary (content) starting at ## Personality, never ## Appearance",
  );
  const worldUpdate = rpFacts.find((f) => f.entity_key === 'place:existing-place');
  assert(worldUpdate?.category === 'place' && worldUpdate?.summary === '[replacement text]', "the world UPDATE maps to the same existing-entry update path, with 'place' surviving unchanged");
  const worldNew = rpFacts.find((f) => f.entity_key === 'concept:new-concept');
  assert(worldNew?.category === 'concept' && worldNew?.summary === '[new content]', "the world NEW maps to the same proposed canon-fact creation path, with 'concept' surviving unchanged");
  assert(
    !rpFacts.some((f) => f.detail === 'Redundant Thing'),
    "the DUPLICATE lands in the existing duplicate handling — category resolved from existingRows, and with no matching existing entry on a first sync it is skipped, not inserted",
  );
  const elenaChar = pool.characters.find((c) => c.name === 'Elena Ashford');
  assert(
    elenaChar?.appearance === 'Tall, with a lantern jaw and steel-grey eyes.',
    "the rp tick's people-curator appearance writes back onto the matching appearance-blank characters row",
  );
  assert(
    pool.chatMemorySyncStatus.get(RP_CHAT_ID)?.last_entries_updated === 8,
    'an rp sync reports 8 entries updated (scene + events + plot + 3 world entries + 2 people)',
  );
}

// --- chat-memory-world-curator-plan.md §8/§12: a malformed world-curator response fails the whole
// sync stage. The curator's plain text is parsed strictly — one bad block throws before
// upsert_world_memory ever runs, so zero world results from that pass are committed and the sync
// records the failure at the exact curate_world_memory step (the real Postgres rollback of the
// pre-world writes — chunks, sync point, bridge entries — is the same single-transaction step
// machinery the FAIL test above exercises; this fake pool's ROLLBACK is a no-op for writes that
// predate the failing step, so those particular rows can't be asserted away here). ---
{
  const BAD_WORLD_CHAT_ID = randomUUID();
  pool.chatSessions.set(BAD_WORLD_CHAT_ID, { user_id: USER, archived_at: null, kind: 'rp' });
  seedMessages(BAD_WORLD_CHAT_ID, 'BADWORLD', 12);

  backend.worldCuratorOverride = `**NEW: Good Concept**
Category: concept
Fine content.

**UPDATE: Broken Entry**
Category: person
Person is not a valid world category.`;
  await runChatMemorySyncTick(deps);
  backend.worldCuratorOverride = null;

  assert(
    pool.canonFacts.filter((f) => f.chat_id === BAD_WORLD_CHAT_ID && ['place', 'thing', 'concept'].includes(f.category)).length === 0,
    'on parser failure no world-curator results from that pass are committed — not even the well-formed NEW before the bad block',
  );
  const status = pool.chatMemorySyncStatus.get(BAD_WORLD_CHAT_ID);
  assert(status?.last_status === 'error', 'a malformed world-curator response records the sync as error');
  assert(status?.last_step === 'curate_world_memory', 'the status row names curate_world_memory as the exact failing step');
}

// --- chat-memory-people-curator-plan.md §12/§17: a malformed people-curator response fails the
// whole sync stage the same way. The curator's plain text is parsed strictly — one bad block
// throws before upsert_people ever runs, so zero person results from that pass are committed (not
// even the well-formed NEW preceding the bad block) and the sync records the failure at the exact
// curate_people step. The boundary does not advance: the tick recorded an error and no successful
// commit — last_success_at stays null (the fake pool's ROLLBACK is a no-op, so the pre-people rows
// the failing transaction wrote — chunks, sync point, bridge entries — cannot be asserted away
// here, the same limitation the world FAIL test above documents). ---
{
  const BAD_PEOPLE_CHAT_ID = randomUUID();
  pool.chatSessions.set(BAD_PEOPLE_CHAT_ID, { user_id: USER, archived_at: null, kind: 'rp' });
  seedMessages(BAD_PEOPLE_CHAT_ID, 'BADPEOPLE', 12);

  backend.curatePeopleOverride = `**NEW: Good Person**
## Appearance
Fine.

## Personality
Fine.

## Core Misread
Fine.

## Connections
| Person | Relation | Tone |
|--------|----------|------|

## Relationship with the protagonist
Fine.

## Goals
Major: Fine.
Minor: Fine.
Minor: Fine.
Minor: Fine.

**UPDATE: Broken Person**
## Personality
Missing every other section.`;
  await runChatMemorySyncTick(deps);
  backend.curatePeopleOverride = null;

  assert(
    pool.canonFacts.filter((f) => f.chat_id === BAD_PEOPLE_CHAT_ID && f.category === 'person').length === 0,
    'on parser failure no people-curator results from that pass are committed — not even the well-formed NEW before the bad block',
  );
  const status = pool.chatMemorySyncStatus.get(BAD_PEOPLE_CHAT_ID);
  assert(status?.last_status === 'error', 'a malformed people-curator response records the sync as error');
  assert(status?.last_step === 'curate_people', 'the status row names curate_people as the exact failing step');
  assert(status?.last_success_at == null, 'the failing tick never advanced the closed sync boundary — no successful commit was recorded');
}

// --- character-appearance-field-plan.md: the upsert_people appearance write-back's edge cases.
// A curator entry whose exact case-insensitive name matches no characters row still inserts its
// canon_facts row (the write-back never blocks or fails the tick); a matching row whose
// appearance is already non-empty is never overwritten (bi_principles.md §3 per field). ---
{
  const APPEAR_CHAT_ID = randomUUID();
  pool.chatSessions.set(APPEAR_CHAT_ID, { user_id: USER, archived_at: null, kind: 'rp' });
  seedMessages(APPEAR_CHAT_ID, 'APPEAR', 12);

  // One matching appearance-blank row, one matching already-filled row, and no row at all for
  // the third entry's name.
  pool.characters.push(
    { character_id: randomUUID(), user_id: USER, name: 'Mira Vale', appearance: '', status: 'transient' },
    { character_id: randomUUID(), user_id: USER, name: 'Garrick Stone', appearance: 'A heavyset old soldier.', status: 'transient' },
  );

  backend.curatePeopleOverride = `**NEW: Mira Vale**
## Appearance
Slender, with ash-blonde hair.

## Personality
Wary.

## Core Misread
She doubts every kindness offered.

## Connections
| Person | Relation | Tone |
|--------|----------|------|

## Relationship with the protagonist
She is measuring the protagonist still.

## Goals
Major: Guard her caravan.
Minor: Repay the innkeeper.
Minor: Recover her coin.
Minor: Cross the high pass.

**NEW: Unknown Stranger**
## Appearance
A hooded figure.

## Personality
Elusive.

## Core Misread
They mistake attention for threat.

## Connections
| Person | Relation | Tone |
|--------|----------|------|

## Relationship with the protagonist
They are watching the protagonist warily.

## Goals
Major: Reach the coast.
Minor: Avoid the patrols.
Minor: Find a guide.
Minor: Burn old letters.

**NEW: Garrick Stone**
## Appearance
Fresh description that must NOT land.

## Personality
Gruff.

## Core Misread
He thinks kindness is always a trap.

## Connections
| Person | Relation | Tone |
|--------|----------|------|

## Relationship with the protagonist
He owes the protagonist nothing yet.

## Goals
Major: Keep the forge running.
Minor: Settle the debt.
Minor: Mend the plough.
Minor: Train his apprentice.`;

  const peopleFactsBefore = pool.canonFacts.filter((f) => f.chat_id === APPEAR_CHAT_ID && f.category === 'person').length;
  await runChatMemorySyncTick(deps);
  backend.curatePeopleOverride = null;

  const mira = pool.characters.find((c) => c.name === 'Mira Vale');
  assert(mira?.appearance === 'Slender, with ash-blonde hair.', 'an exact name match writes appearance onto the blank characters row');
  const garrick = pool.characters.find((c) => c.name === 'Garrick Stone');
  assert(
    garrick?.appearance === 'A heavyset old soldier.',
    'a matching characters row whose appearance is already non-empty is never overwritten',
  );
  const peopleFactsAfter = pool.canonFacts.filter((f) => f.chat_id === APPEAR_CHAT_ID && f.category === 'person');
  assert(
    peopleFactsAfter.length === peopleFactsBefore + 3,
    'every curator entry still inserts its canon_facts row — a missing name match never skips the insert',
  );
  assert(
    peopleFactsAfter.some((f) => f.detail === 'Unknown Stranger'),
    "an entry with no matching characters row still lands as a canon_facts row (fuzzy name reconciliation is out of scope)",
  );
}

// --- chat-memory-people-curator-plan.md: curatePeople() is an ordinary text completion — the
// request carries no tools and no forceTool, {{user}} is still interpolated into the sent prompt,
// and the plain assistant text parses back into the PeopleCuratorEntryDraft shape with appearance
// carried distinctly from content; a 'duplicate' action entry carries neither. ---
{
  const { curatePeople } = await import('../dist/io/chatMemory/curatePeople.js');

  let capturedTools;
  let capturedOptions;
  let capturedMessages;
  const drafts = await curatePeople(
    {
      async complete(messages, tools, options) {
        capturedMessages = messages;
        capturedTools = tools;
        capturedOptions = options;
        return {
          message: {
            role: 'assistant',
            content:
              `**NEW: Mira Vale**
## Appearance
Slender, ash-blonde.

## Personality
Wary.

## Core Misread
She doubts every kindness.

## Connections
| Person | Relation | Tone |
|--------|----------|------|

## Relationship with Elara
She is testing the trust between them.

## Goals
Major: Guard her caravan.
Minor: Repay the innkeeper.
Minor: Recover her coin.
Minor: Cross the high pass.

**DUPLICATE: Mira V.**
Duplicate of: Mira Vale`,
          },
        };
      },
    },
    'TRANSCRIPT',
    '',
    'Elara',
  );
  assert(Array.isArray(capturedTools) && capturedTools.length === 0, 'curatePeople passes an empty tools array — no forced tool transport');
  assert(capturedOptions?.forceTool === undefined, 'curatePeople sends no forceTool');
  const sentPrompt = capturedMessages.find((m) => m.role === 'system')?.content;
  assert(sentPrompt?.includes('## Relationship with Elara'), '{{user}} is interpolated into the people-curator prompt before the model sees it');
  const newEntry = drafts.find((d) => d.name === 'Mira Vale');
  assert(newEntry?.appearance === 'Slender, ash-blonde.' && newEntry?.content.startsWith('## Personality'), "curatePeople round-trips appearance distinctly from content");
  const dupEntry = drafts.find((d) => d.action === 'duplicate');
  assert(dupEntry?.appearance === undefined && dupEntry?.content === undefined, "a 'duplicate' action entry has no appearance value (same as content today)");
}

// --- eager-chunk-sync-plan: the tick reuses-and-closes an eagerly-opened sync point. An open
// (closed_at null, chunk-only) point is consolidation in progress, not a boundary — so (a) a
// chat whose only sync point is open is still due, (b) the tick reuses the point's sync_id for
// its digest/bridge writes and closes it, and (c) its own chunking step is a top-up of only the
// not-yet-chunked span, never a re-chunk. ---
{
  const EAGER_CHAT_ID = randomUUID();
  pool.chatSessions.set(EAGER_CHAT_ID, { user_id: USER, archived_at: null });
  seedMessages(EAGER_CHAT_ID, 'EAGER', 12); // 6 turns; the tick archives turns 1-4 (msgs 0-7)

  // Simulate an eager pass that already chunked the whole archive span (msgs 0-7) under an open
  // sync point — no closed point exists, so findDueChats must still see the chat as due.
  const msgs = pool.chatMessages.filter((m) => m.chat_id === EAGER_CHAT_ID).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const openSyncId = randomUUID();
  pool.chatSyncPoints.push({ sync_id: openSyncId, chat_id: EAGER_CHAT_ID, user_id: USER, ordinal: 0, last_message_id: msgs[7].message_id, closed_at: null });
  pool.chatChunks.push(
    { chat_id: EAGER_CHAT_ID, sync_id: openSyncId, user_id: USER, ordinal: 0, content: 'EAGER-1..4', summary: 'S1', vector_embed: '[0.1]' },
    { chat_id: EAGER_CHAT_ID, sync_id: openSyncId, user_id: USER, ordinal: 1, content: 'EAGER-5..8', summary: 'S2', vector_embed: '[0.1]' },
  );

  await runChatMemorySyncTick(deps);

  const eagerSyncs = pool.chatSyncPoints.filter((sp) => sp.chat_id === EAGER_CHAT_ID);
  assert(eagerSyncs.length === 1, 'an open sync point is reused, never duplicated, by the consolidating tick');
  assert(eagerSyncs[0].closed_at != null, 'the consolidating tick closes the reused open sync point');
  assert(eagerSyncs[0].last_message_id === msgs[7].message_id, "the reused point's last_message_id is the tick's own archiveEnd (eager had it covered exactly)");
  const eagerChunks = pool.chatChunks.filter((c) => c.chat_id === EAGER_CHAT_ID);
  assert(eagerChunks.length === 2, 'a fully-covered window gets no extra chunks from the tick');
  assert(eagerChunks.every((c) => c.sync_id === openSyncId), 'the existing eager chunks stay under the reused sync_id');
  const eagerStatus = pool.chatMemorySyncStatus.get(EAGER_CHAT_ID);
  assert(eagerStatus?.last_status === 'ok', 'a chat whose only sync point is open is still due — the tick ran and consolidated it (not skipped)');
  assert(eagerStatus?.last_chunks_added === 0, 'chunksAdded is 0 when eager already covered the window — a legitimate ok, not an error/skip');
  assert(eagerStatus?.last_entries_updated === 1, 'the consolidation pass still ran the digest on the fully-covered window');
}

{
  const TOPUP_CHAT_ID = randomUUID();
  pool.chatSessions.set(TOPUP_CHAT_ID, { user_id: USER, archived_at: null });
  seedMessages(TOPUP_CHAT_ID, 'TOPUP', 12);

  // Eager covered only the first chunk's worth (msgs 0-3); the tick must top up msgs 4-7 under
  // the SAME sync_id, never re-chunk msgs 0-3 under new ordinals.
  const msgs = pool.chatMessages.filter((m) => m.chat_id === TOPUP_CHAT_ID).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const openSyncId = randomUUID();
  pool.chatSyncPoints.push({ sync_id: openSyncId, chat_id: TOPUP_CHAT_ID, user_id: USER, ordinal: 0, last_message_id: msgs[3].message_id, closed_at: null });
  pool.chatChunks.push({ chat_id: TOPUP_CHAT_ID, sync_id: openSyncId, user_id: USER, ordinal: 0, content: 'TOPUP-1..4', summary: 'S1', vector_embed: '[0.1]' });

  await runChatMemorySyncTick(deps);

  const topupSyncs = pool.chatSyncPoints.filter((sp) => sp.chat_id === TOPUP_CHAT_ID);
  assert(topupSyncs.length === 1, 'the top-up tick reuses the open sync point rather than opening a second');
  assert(topupSyncs[0].closed_at != null, 'the top-up tick closes the point it reused');
  assert(topupSyncs[0].last_message_id === msgs[7].message_id, "the closed point's last_message_id advances to the tick's own archiveEnd, not the eager-progress value");
  const topupChunks = pool.chatChunks.filter((c) => c.chat_id === TOPUP_CHAT_ID).sort((a, b) => a.ordinal - b.ordinal);
  assert(topupChunks.length === 2, 'the tick top-ups exactly the remaining chunk');
  assert(topupChunks[1].ordinal === 1, 'the top-up chunk continues eager numbering from count(*)');
  assert(topupChunks.every((c) => c.sync_id === openSyncId), 'top-up chunks land under the same sync_id as eager wrote');
  assert(
    topupChunks[1].content.includes('TOPUP-user-5') && topupChunks[1].content.includes('TOPUP-assistant-8') && !topupChunks[1].content.includes('TOPUP-user-1'),
    'the top-up chunk covers only the not-yet-chunked messages — no re-chunking, no overlapping content',
  );
}

// --- The connection contract (chatMemorySync.ts's resolveChatMemoryLlm): a sync's connection
// rides EXCLUSIVELY on the live chat_memory_profile setting — never on a chat's own
// params->>'profile' (that is the narrator/generation connection, a different configuration
// domain). With chat_memory_profile = 'sync-profile', an RP chat whose narrator profile names a
// dead model still syncs through the memory connection: summarize, bridge, and curators alike.
// This is the exact regression from the field — a legacy RP chat pointed at an obsolete narrator
// model used to drag the whole memory pipeline onto that dead model, a ×1500 permanent 404 loop. ---
{
  const LOCK_CHAT_ID = randomUUID();
  pool.chatSessions.set(LOCK_CHAT_ID, { user_id: USER, archived_at: null, kind: 'rp', params: { profile: 'obsolete-rp-model' } });
  seedMessages(LOCK_CHAT_ID, 'LOCK', 12);

  await settings.set('chat_memory_profile', 'sync-profile');
  const activeBaseCallsBefore = backend.calls.filter((c) => c.url === `${ACTIVE_FAKE_BASE}/chat/completions`).length;
  await runChatMemorySyncTick(deps);

  const namedCalls = backend.calls.filter((c) => c.url === `${NAMED_FAKE_BASE}/chat/completions`);
  const activeBaseCallsAfter = backend.calls.filter((c) => c.url === `${ACTIVE_FAKE_BASE}/chat/completions`).length;
  assert(
    namedCalls.filter((c) => c.options.forceTool === undefined && !isBridgeCall(c) && !isWorldCuratorCall(c) && !isPeopleCuratorCall(c)).length === 2,
    'with chat_memory_profile set, the rolling sync summarizes its chunks THROUGH that connection',
  );
  assert(
    namedCalls.some((c) => isBridgeCall(c) && c.url === `${NAMED_FAKE_BASE}/chat/completions`),
    "the rp bridge also rides the chat_memory_profile connection, not the chat's narrator profile",
  );
  assert(
    namedCalls.some((c) => isWorldCuratorCall(c) && c.url === `${NAMED_FAKE_BASE}/chat/completions`),
    'the world curator also rides the chat_memory_profile connection, alongside the bridge',
  );
  assert(
    namedCalls.some((c) => isPeopleCuratorCall(c) && c.url === `${NAMED_FAKE_BASE}/chat/completions`),
    'the people curator also rides the chat_memory_profile connection, alongside the bridge and world curator',
  );
  assert(
    !namedCalls.some((c) => c.options.forceTool === 'distill_chat_memory'),
    'an rp chat never runs the household distill lane',
  );
  assert(activeBaseCallsAfter === activeBaseCallsBefore, 'the chat_memory_profile sync never touches the active connection');
  assert(pool.chatMemorySyncStatus.get(LOCK_CHAT_ID)?.last_status === 'ok', 'the chat_memory_profile sync still completes');
  await settings.set('chat_memory_profile', undefined);
}

// --- The narrator profile is a different configuration domain: a chat whose params->>'profile'
// names a connection that no longer exists must NOT error the sync — that profile is only ever the
// interactive generation connection, and the chat-memory pipeline never reads it. With
// chat_memory_profile unset, such a chat syncs normally via the active connection. ---
{
  const REFUSE_CHAT_ID = randomUUID();
  pool.chatSessions.set(REFUSE_CHAT_ID, { user_id: USER, archived_at: null, params: { profile: 'ghost-connection' } });
  seedMessages(REFUSE_CHAT_ID, 'REFUSE', 12);

  const activeCallsBefore = backend.calls.filter((c) => c.url === `${ACTIVE_FAKE_BASE}/chat/completions`).length;
  await runChatMemorySyncTick(deps);

  const status = pool.chatMemorySyncStatus.get(REFUSE_CHAT_ID);
  assert(status?.last_status === 'ok', "a chat whose narrator profile names an unknown connection still syncs — the memory pipeline ignores the narrator profile");
  assert(
    backend.calls.filter((c) => c.url === `${ACTIVE_FAKE_BASE}/chat/completions`).length > activeCallsBefore,
    "the sync ran through the active connection — the narrator profile never errored it and never influenced it",
  );
  assert(pool.chatChunks.filter((c) => c.chat_id === REFUSE_CHAT_ID).length > 0, 'the chat actually archived chunks');
}

// --- The narrator profile changing A → B must leave the memory connection untouched: a sync's
// connection comes from chat_memory_profile alone, so editing a chat's narrator profile from one
// model to another keeps the memory pipeline riding the same chat_memory_profile connection on
// both sides of the edit. ---
{
  const NARR_CHAT_ID = randomUUID();
  pool.chatSessions.set(NARR_CHAT_ID, { user_id: USER, archived_at: null, params: { profile: 'narr-model-a' } });
  seedMessages(NARR_CHAT_ID, 'NARR', 12);

  const activeCallsBefore = backend.calls.filter((c) => c.url === `${ACTIVE_FAKE_BASE}/chat/completions`).length;
  const namedCallsBefore = backend.calls.filter((c) => c.url === `${NAMED_FAKE_BASE}/chat/completions`).length;
  await settings.set('chat_memory_profile', 'sync-profile');

  await runChatMemorySyncTick(deps); // narrator profile: narr-model-a
  const namedAfterA = backend.calls.filter((c) => c.url === `${NAMED_FAKE_BASE}/chat/completions`).length;
  assert(namedAfterA > namedCallsBefore, 'the first sync rides the chat_memory_profile connection');

  pool.chatSessions.get(NARR_CHAT_ID).params = { profile: 'narr-model-b' }; // narrator edited A → B
  seedMessages(NARR_CHAT_ID, 'NARR2', 12);
  await runChatMemorySyncTick(deps); // still due after the edit
  const namedAfterB = backend.calls.filter((c) => c.url === `${NAMED_FAKE_BASE}/chat/completions`).length;
  const activeCallsAfter = backend.calls.filter((c) => c.url === `${ACTIVE_FAKE_BASE}/chat/completions`).length;
  await settings.set('chat_memory_profile', undefined);

  assert(
    namedAfterB > namedAfterA,
    'editing the narrator profile A → B changes nothing for the memory pipeline — the second sync rides the same chat_memory_profile connection',
  );
  assert(activeCallsAfter === activeCallsBefore, 'neither sync ever touched the active connection — the memory connection is independent of the narrator profile');
  assert(pool.chatMemorySyncStatus.get(NARR_CHAT_ID)?.last_status === 'ok', 'the chat whose narrator profile changed still syncs fine');
}

// --- Settings read live: changing chat_memory_profile from C → D takes effect on the very next
// sync, no restart — the same "settings read live" contract every other chat-memory setting has
// (docs/chat-memory.md's Settings section). ---
{
  const LIVE_CHAT_ID = randomUUID();
  pool.chatSessions.set(LIVE_CHAT_ID, { user_id: USER, archived_at: null });
  seedMessages(LIVE_CHAT_ID, 'LIVEC', 12);

  await settings.set('chat_memory_profile', 'memory-c');
  await runChatMemorySyncTick(deps);
  const memoryCCalls = backend.calls.filter((c) => c.url === `${MEMORY_C_FAKE_BASE}/chat/completions`).length;
  assert(memoryCCalls > 0, 'with chat_memory_profile = memory-c, the sync rides the memory-c connection');

  seedMessages(LIVE_CHAT_ID, 'LIVED', 12);
  await settings.set('chat_memory_profile', 'memory-d');
  await runChatMemorySyncTick(deps);
  const memoryDCalls = backend.calls.filter((c) => c.url === `${MEMORY_D_FAKE_BASE}/chat/completions`).length;
  await settings.set('chat_memory_profile', undefined);

  assert(
    memoryDCalls > 0,
    'changing chat_memory_profile to memory-d takes effect on the very next sync — read live, no restart',
  );
}

// --- The unknown chat_memory_profile fallback is a defined, logged policy (fall back to the
// active connection), and it must never silently fall back to a chat's narrator profile instead. ---
{
  const UNKNOWN_MEM_CHAT_ID = randomUUID();
  pool.chatSessions.set(UNKNOWN_MEM_CHAT_ID, { user_id: USER, archived_at: null, params: { profile: 'dead-narrator' } });
  seedMessages(UNKNOWN_MEM_CHAT_ID, 'UNKMEM', 12);

  const activeCallsBefore = backend.calls.filter((c) => c.url === `${ACTIVE_FAKE_BASE}/chat/completions`).length;
  await settings.set('chat_memory_profile', 'ghost-memory-connection');
  await runChatMemorySyncTick(deps);
  await settings.set('chat_memory_profile', undefined);

  assert(
    backend.calls.filter((c) => c.url === `${ACTIVE_FAKE_BASE}/chat/completions`).length > activeCallsBefore,
    'an unknown chat_memory_profile falls back to the ACTIVE connection (logged), never to the chat narrator profile',
  );
  assert(pool.chatMemorySyncStatus.get(UNKNOWN_MEM_CHAT_ID)?.last_status === 'ok', 'the fallback sync still completes');
}

// --- computeChatSyncHealth: the pure turn-boundary health derivation behind both the status
// endpoint's syncHealth and handleChatCompletions's 409 CHAT_SYNC_STALLED guard. liveWindow 2 +
// syncEvery 2 pairs here: due at >= 4 unsynced turns, blocked at >= 6 (live window + TWO sync
// windows — the agreed one-full-sync-interval-of-grace budget). ---
{
  const turns = (n) => {
    const messages = [];
    for (let i = 1; i <= n; i++) {
      messages.push({ messageId: `t${i}u`, role: 'user' });
      messages.push({ messageId: `t${i}a`, role: 'assistant' });
    }
    return messages;
  };
  const base = {
    lastStatus: 'error',
    lastStep: 'summarize_embed',
    lastError: 'OpenAI-compatible API error 404: no endpoints',
    consecutiveErrors: 42,
    liveWindowPairs: 2,
    syncEveryPairs: 2,
  };

  const healthy = computeChatSyncHealth({ ...base, messages: turns(3), anchorMessageId: null });
  assert(healthy.state === 'healthy' && healthy.blocking === false, '3 unsynced turns (below live+sync) is healthy');
  assert(healthy.turnsUntilBlock === null, 'turnsUntilBlock is null outside warning');

  const warning = computeChatSyncHealth({ ...base, messages: turns(4), anchorMessageId: null });
  assert(warning.state === 'warning' && warning.blocking === false, '4 unsynced turns (live+sync) crosses into warning');
  assert(warning.turnsUntilBlock === 2, 'warning reports the turns remaining before block (6 - 4 = 2)');

  const warningEdge = computeChatSyncHealth({ ...base, messages: turns(5), anchorMessageId: null });
  assert(warningEdge.turnsUntilBlock === 1, 'at 5 unsynced turns exactly one more send is allowed before blocking');

  const blocked = computeChatSyncHealth({ ...base, messages: turns(6), anchorMessageId: null });
  assert(blocked.state === 'blocked' && blocked.blocking === true, '6 unsynced turns (live + 2 sync windows) blocks');
  assert(blocked.turnsUntilBlock === null, 'turnsUntilBlock is null once blocked');

  const anchored = computeChatSyncHealth({ ...base, messages: turns(8), anchorMessageId: 't4a' });
  assert(
    anchored.state === 'warning' && anchored.turnsUntilBlock === 2,
    'the anchor moves the boundary: turns after the last closed sync point count, not all turns',
  );
  assert(blocked.lastStatus === 'error' && blocked.lastError?.includes('404'), 'health carries the last attempt outcome for the banner');
  assert(blocked.consecutiveErrors === 42, 'health carries consecutiveErrors for the banner');

  const healthyBase = computeChatSyncHealth({ ...base, messages: turns(4), anchorMessageId: 't4a' });
  assert(healthyBase.state === 'healthy', 'no turns past the anchor is healthy even when a sync point exists');
}

// --- Resolve-once-per-tick: N due chats in one poll cycle must share ONE resolveSyncSettings
// (one settings read, one connection resolution) — previously each due chat re-resolved inside the
// loop, so every chat-memory settings key was read N times per tick (and mid-tick edits could
// split the roster across two different resolutions). ---
{
  const MULTI_A = randomUUID();
  const MULTI_B = randomUUID();
  pool.chatSessions.set(MULTI_A, { user_id: USER, archived_at: null });
  pool.chatSessions.set(MULTI_B, { user_id: USER, archived_at: null });
  seedMessages(MULTI_A, 'MULTA', 12);
  seedMessages(MULTI_B, 'MULTB', 12);

  settings.getCounts.clear();
  await runChatMemorySyncTick(deps);
  const reads = settings.getCounts.get('chat_memory_chunk_summary_prompt') ?? 0;
  assert(
    reads === 1,
    `resolveSyncSettings is resolved exactly once per tick no matter how many chats are due (${reads} reads — the per-chat re-resolution bug is fixed)`,
  );
  assert(pool.chatMemorySyncStatus.get(MULTI_A)?.last_status === 'ok' && pool.chatMemorySyncStatus.get(MULTI_B)?.last_status === 'ok', 'both multi-due chats still sync with the shared resolution');
}

// --- Permanent-failure suppression (migration 0127, bi_principles.md §11 follow-up): a 404 that
// previously re-fired once per 30s poll tick forever (observed ×1500 in a row) is classified
// permanent, stamped with the connection signature, and then EXCLUDED from the loop until the
// signature changes or the ~30min retry window elapses. ---
{
  const ACTIVE_SIGNATURE = 'openai-compatible|sync-active-model|https://sync-active-fake.example';
  const SUPPRESSED_CHAT = randomUUID();
  pool.chatSessions.set(SUPPRESSED_CHAT, { user_id: USER, archived_at: null });
  seedMessages(SUPPRESSED_CHAT, 'SUPP', 12);

  backend.forceStatus = 404;
  await runChatMemorySyncTick(deps);
  backend.forceStatus = null;

  const failed = pool.chatMemorySyncStatus.get(SUPPRESSED_CHAT);
  assert(failed?.last_status === 'error', 'a permanent 404 failure records chat_memory_sync_status as error');
  assert(failed?.last_error_kind === 'permanent', 'a 404 is classified permanent, not transient');
  assert(failed?.failure_signature === ACTIVE_SIGNATURE, 'the error row is stamped with the connection signature the failure ran through');

  const callsAfterFail = backend.calls.length;
  const attemptAfterFail = failed.last_attempt_at;
  await runChatMemorySyncTick(deps);

  assert(pool.chatMemorySyncStatus.get(SUPPRESSED_CHAT).last_attempt_at === attemptAfterFail, 'the suppressed chat is NOT re-attempted on the next 30s tick (last_attempt_at frozen)');
  assert(backend.calls.length === callsAfterFail, 'suppression issues zero LLM calls for the excluded chat');
  assert(pool.chatChunks.filter((c) => c.chat_id === SUPPRESSED_CHAT).length === 0, 'suppression never runs (and never archives) the failing chat');

  // A chat_memory_profile edit changes the signature → suppression lifts on the very next tick.
  await settings.set('chat_memory_profile', 'memory-d');
  await runChatMemorySyncTick(deps);
  await settings.set('chat_memory_profile', undefined);
  assert(pool.chatMemorySyncStatus.get(SUPPRESSED_CHAT)?.last_status === 'ok', 'changing chat_memory_profile lifts suppression — the next tick retries and succeeds');

  // The success cleared the permanent-failure stamp, so this chat is ordinary again.
  const recovered = pool.chatMemorySyncStatus.get(SUPPRESSED_CHAT);
  assert(recovered.last_error_kind === null && recovered.failure_signature === null, 'a successful sync clears the failure classification and signature');
}

// --- A transient failure (429) is NOT suppressed — the next tick retries normally, because a
// rate-limit/availability error can plausibly clear on its own. ---
{
  const TRANSIENT_CHAT = randomUUID();
  pool.chatSessions.set(TRANSIENT_CHAT, { user_id: USER, archived_at: null });
  seedMessages(TRANSIENT_CHAT, 'TRANS', 12);

  backend.forceStatus = 429;
  await runChatMemorySyncTick(deps);
  backend.forceStatus = null;

  const failed = pool.chatMemorySyncStatus.get(TRANSIENT_CHAT);
  assert(failed?.last_status === 'error' && failed?.last_error_kind === 'transient', 'a 429 is classified transient, never permanent');

  const callsBeforeRetry = backend.calls.length;
  await runChatMemorySyncTick(deps);
  assert(backend.calls.length > callsBeforeRetry, 'a transient failure is retried on the very next tick (not suppressed)');
  assert(pool.chatMemorySyncStatus.get(TRANSIENT_CHAT)?.last_status === 'ok', 'the retry after the transient failure succeeds');
}

// --- chat-memory-structured-output-plan.md: summarizeChatChunk itself is an ordinary completion
// (empty tools, no forceTool) whose raw text is parsed locally — no tool-call transport, no
// schema wrapper. The built-in prompt is the retrieval-header classifier (most-important-
// development, past tense, 2-4 sentences), not a generic digest. ---
{
  const { summarizeChatChunk, DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT } = await import('../dist/io/chatMemory/classifyChatChunk.js');

  let capturedTools;
  let capturedOptions;
  const summary = await summarizeChatChunk(
    {
      async complete(messages, tools, options) {
        capturedTools = tools;
        capturedOptions = options;
        return { message: { role: 'assistant', content: '  The gate fell.\n\n' } };
      },
    },
    'TRANSCRIPT',
  );
  assert(Array.isArray(capturedTools) && capturedTools.length === 0, 'summarizeChatChunk passes an empty tools array — no forced tool transport');
  assert(capturedOptions?.forceTool === undefined, 'summarizeChatChunk sends no forceTool');
  assert(summary === 'The gate fell.', 'plain assistant text becomes the chunk summary, trimmed');

  const fenced = await summarizeChatChunk(
    {
      async complete() {
        return { message: { role: 'assistant', content: '```markdown\nThe gate fell.\n```' } };
      },
    },
    'TRANSCRIPT',
  );
  assert(fenced === 'The gate fell.', 'one enclosing markdown fence is tolerated and stripped');

  let threwEmpty = false;
  try {
    await summarizeChatChunk(
      {
        async complete() {
          return { message: { role: 'assistant', content: '   \n  ' } };
        },
      },
      'TRANSCRIPT',
    );
  } catch {
    threwEmpty = true;
  }
  assert(threwEmpty, 'an empty/whitespace response throws');

  let sawCustom = null;
  await summarizeChatChunk(
    {
      async complete(messages) {
        sawCustom = messages.find((m) => m.role === 'system')?.content;
        return { message: { role: 'assistant', content: 'The gate fell.' } };
      },
    },
    'TRANSCRIPT',
    'CUSTOM PROMPT',
  );
  assert(sawCustom === 'CUSTOM PROMPT', 'an existing custom chunk_summary_prompt is passed through unchanged');

  assert(
    DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT.includes('most important durable development') &&
      DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT.includes('past tense') &&
      DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT.includes('Write 2–4 concise sentences'),
    'the built-in default is the retrieval-header classifier, not a generic digest',
  );
}

// --- chat-memory-structured-output-plan.md: the sync pipeline's integration path — chunks are
// summarized through a tool-free completion, the plain assistant text lands verbatim as
// chat_chunks.summary, and that same text rides the 0094 summary embedding lane. RP and ordinary
// chats both exercise this same classifier. ---
{
  const TOOLFREE_CHAT_ID = randomUUID();
  pool.chatSessions.set(TOOLFREE_CHAT_ID, { user_id: USER, archived_at: null });
  seedMessages(TOOLFREE_CHAT_ID, 'TOOLFREE', 12);

  const TOOLFREE_RP_ID = randomUUID();
  pool.chatSessions.set(TOOLFREE_RP_ID, { user_id: USER, archived_at: null, kind: 'rp' });
  seedMessages(TOOLFREE_RP_ID, 'TOOLFREE_RP', 12);

  embeddings.seen.length = 0;
  const summarizeCallsBefore = summarizeCalls().length;
  await runChatMemorySyncTick(deps);

  for (const chatId of [TOOLFREE_CHAT_ID, TOOLFREE_RP_ID]) {
    const chunks = pool.chatChunks.filter((c) => c.chat_id === chatId).sort((a, b) => a.ordinal - b.ordinal);
    assert(chunks.length === 2, 'a tool-free sync still archives its chunks for every chat kind');
    assert(
      chunks.every((c) => c.summary === `Summary[${c.content}]`),
      'the plain assistant text is stored verbatim as chat_chunks.summary — no tool wrapper',
    );
    assert(
      chunks.every((c) => embeddings.seen.includes(c.summary)),
      'the stored chunk summary is exactly the text the 0094 summary embedding lane embedded',
    );
  }

  const tfSummarizeCalls = summarizeCalls().slice(summarizeCallsBefore);
  assert(tfSummarizeCalls.length === 4, 'the tick summarized every chunk (2 per chat) through the tool-free completion');
  assert(
    tfSummarizeCalls.every((c) => c.tools === undefined && c.options.forceTool === undefined),
    'each summarize request carries no tools array and no forceTool — plain completion transport, not a forced tool call',
  );
}

if (process.exitCode) {
  console.error('\nchat memory sync verification FAILED');
  process.exit(1);
}
console.log('\nchat memory sync verification passed');
