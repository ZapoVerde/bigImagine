// Integration test for the two pieces that make bigBrain "dynamic like ST": the plugin loader
// actually discovering and importing the real, compiled document-ingestion plugin from disk
// (not a fake), and the HTTP server round-tripping a real request through it end to end,
// including auth. LLM/embeddings are still stubs (no live network in this sandbox), but
// everything else — dynamic import, HTTP, JSON parsing, SSE framing — is exercised for real.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins } from '../dist/orchestrator/pluginLoader.js';
import { createToolRegistry } from '../dist/orchestrator/toolRegistry.js';
import { createApiKeyStore } from '../dist/server/apiKeyStore.js';
import { startHttpServer } from '../dist/server/httpServer.js';
import { createStubLlmProvider } from '../dist/io/llm/stub.js';
import { createStubEmbeddingProvider } from '../dist/io/embeddings/stub.js';
import { createPostgresClient } from '../dist/io/postgres.js';
import { createFieldCipher } from '../dist/io/fieldCipher.js';
import { CREDENTIAL_NAMES } from '../dist/io/providerCredentials.js';
import { clearPromptTrace } from '../dist/io/promptTrace.js';
import { randomBytes } from 'node:crypto';

const testCipher = createFieldCipher({ BIGBRAIN_FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') });

// A hand-rolled fake satisfying LlmConnectionStore's shape directly (io/llmConnections.ts) — this
// suite is testing the HTTP wiring (adminServer.ts, httpServer.ts's routes/auth), not
// llmConnections.ts's own DB/encryption logic. listModelsForConnection/listProvidersForConnection
// build a real adapter (createLlmProviderForProfile) around whatever resolveById returns, so seeded
// rows need real-shaped baseUrls for the mocked-fetch model-catalog test further down to intercept.
function createFakeLlmConnectionStore(seedRows = []) {
  const rows = new Map(seedRows.map((r) => [r.id, { ...r }]));
  let nextId = 1;
  function toPublic(row) {
    const { apiKey, ...rest } = row;
    return rest;
  }
  function toProfile(row) {
    return { kind: row.kind, model: row.model, apiKey: row.apiKey, baseUrl: row.baseUrl ?? undefined, supportsVision: row.supportsVision };
  }
  return {
    rows,
    async list() {
      return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)).map(toPublic);
    },
    async create(init) {
      const id = `conn-${nextId++}`;
      const row = {
        id,
        name: init.name,
        kind: init.kind,
        model: init.model,
        apiKey: init.copyApiKeyFrom ? rows.get(init.copyApiKeyFrom)?.apiKey : init.apiKey,
        baseUrl: init.baseUrl ?? null,
        supportsVision: init.supportsVision ?? false,
        providerOrder: init.providerOrder ?? null,
        allowFallbacks: init.allowFallbacks ?? true,
        quantizations: init.quantizations ?? null,
        isActive: false,
        updatedAt: new Date().toISOString(),
      };
      rows.set(id, row);
      return toPublic(row);
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) return undefined;
      const { copyApiKeyFrom, ...rest } = patch;
      Object.assign(row, rest, { updatedAt: new Date().toISOString() });
      if (copyApiKeyFrom) row.apiKey = rows.get(copyApiKeyFrom)?.apiKey;
      return toPublic(row);
    },
    async remove(id) {
      const row = rows.get(id);
      if (!row) return 'not_found';
      if (row.isActive) return 'is_active';
      rows.delete(id);
      return 'ok';
    },
    async activate(id) {
      const row = rows.get(id);
      if (!row) return false;
      for (const r of rows.values()) r.isActive = false;
      row.isActive = true;
      return true;
    },
    async resolveById(id) {
      const row = rows.get(id);
      return row ? toProfile(row) : undefined;
    },
    async resolveByName(name) {
      const row = [...rows.values()].find((r) => r.name === name);
      return row ? toProfile(row) : undefined;
    },
    async resolveActive() {
      const row = [...rows.values()].find((r) => r.isActive);
      return row ? toProfile(row) : undefined;
    },
  };
}

// A hand-rolled fake satisfying ProviderCredentialStore's shape directly — this suite is testing
// the HTTP wiring (adminServer.ts, httpServer.ts's routes/auth), not providerCredentials.ts's own
// DB logic, which verify-provider-credentials.mjs already covers against a fake pool.
function createFakeCredentialStore() {
  const values = new Map();
  return {
    setCalls: [],
    async list() {
      return CREDENTIAL_NAMES.map((name) => ({
        name,
        configured: values.has(name),
        updatedAt: values.has(name) ? '2026-01-01T00:00:00.000Z' : null,
      }));
    },
    async resolve(name) {
      return values.get(name);
    },
    async set(name, value) {
      values.set(name, value);
      this.setCalls.push({ name, value });
    },
  };
}

// A hand-rolled fake satisfying OrchestratorSettingsStore's shape directly — this suite is testing
// the HTTP wiring (adminServer.ts, httpServer.ts's routes/auth), not orchestratorSettings.ts's own
// DB logic.
function createFakeSettingsStore() {
  const values = new Map();
  return {
    setCalls: [],
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
      this.setCalls.push({ key, value });
    },
  };
}

// A hand-rolled fake satisfying ImageConnectionStore's shape directly (io/imageConnections.ts) —
// this suite is testing the HTTP wiring (admin routes + deps plumbing), not the store's own
// DB/encryption logic. resolveById returns the decrypted profile shape generateLocationImage and
// the test route build providers from; seeding rows with real-shaped fields lets the admin
// route tests exercise create/list/update/activate/test against it.
function createFakeImageConnectionStore(seedRows = []) {
  const rows = new Map(seedRows.map((r) => [r.id, { ...r }]));
  let nextId = 1;
  function toPublic(row) {
    const { apiKey, ...rest } = row;
    return { ...rest, hasApiKey: apiKey != null };
  }
  function toProfile(row) {
    return {
      kind: row.kind,
      model: row.model,
      apiKey: row.apiKey ?? null,
      baseUrl: row.baseUrl ?? null,
      width: row.width ?? 1344,
      height: row.height ?? 768,
      samplingSteps: row.samplingSteps ?? 30,
      cfgScale: row.cfgScale ?? 7,
      samplerName: row.samplerName ?? null,
      masterPositiveStylePrefix: row.masterPositiveStylePrefix ?? null,
      masterNegativePrompt: row.masterNegativePrompt ?? null,
      workflowParameters: row.workflowParameters ?? null,
    };
  }
  return {
    rows,
    async list() {
      return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)).map(toPublic);
    },
    async create(init) {
      const id = `img-conn-${nextId++}`;
      const row = {
        id,
        name: init.name,
        kind: init.kind,
        model: init.model,
        apiKey: init.apiKey ?? null,
        baseUrl: init.baseUrl ?? null,
        width: init.width ?? 1344,
        height: init.height ?? 768,
        samplingSteps: init.samplingSteps ?? 30,
        cfgScale: init.cfgScale ?? 7,
        samplerName: init.samplerName ?? null,
        masterPositiveStylePrefix: init.masterPositiveStylePrefix ?? null,
        masterNegativePrompt: init.masterNegativePrompt ?? null,
        workflowParameters: init.workflowParameters ?? null,
        isActive: false,
        updatedAt: new Date().toISOString(),
      };
      rows.set(id, row);
      return toPublic(row);
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) return undefined;
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      return toPublic(row);
    },
    async remove(id) {
      const row = rows.get(id);
      if (!row) return 'not_found';
      if (row.isActive) return 'is_active';
      rows.delete(id);
      return 'ok';
    },
    async activate(id) {
      const row = rows.get(id);
      if (!row) return false;
      for (const r of rows.values()) r.isActive = false;
      row.isActive = true;
      return true;
    },
    async resolveById(id) {
      const row = rows.get(id);
      return row ? toProfile(row) : undefined;
    },
    async resolveActive() {
      const row = [...rows.values()].find((r) => r.isActive);
      return row ? toProfile(row) : undefined;
    },
  };
}

// A hand-rolled fake satisfying AccessIdentityResolver's shape directly — this suite is testing
// httpServer.ts's own auth-path wiring (Access-header-first, Bearer-key fallback), not
// accessIdentity.ts's real JWT/JWKS verification, which verify-access-identity.mjs already covers
// against a real local JWKS endpoint and real signatures.
function createFakeAccessIdentityResolver() {
  const calls = [];
  return {
    calls,
    async userIdForAccessJwt(jwt) {
      calls.push(jwt);
      return jwt === 'valid-access-jwt' ? '33333333-3333-3333-3333-333333333333' : undefined;
    },
  };
}

// A hand-rolled fake satisfying ChatSessionStore's shape directly — this suite is testing
// httpServer.ts's own route wiring and the chat_id persistence hook, not chatSessions.ts's real
// SQL, which verify-chat-sessions.mjs already covers against a fake pool.
function createFakeChatSessionStore() {
  const sessions = new Map();
  const messagesByChat = new Map();
  const folders = new Map();
  // Swipe variants per message id (alternate greetings, regenerations) — seeded directly by a
  // test (set(messageId, ['variant 1', 'variant 2'])) and consumed by the minimal cycleSwipe
  // below, which exists so the swipe routes' display-decoration can be exercised end to end.
  const swipesByMessage = new Map();
  const activeSwipeIdx = new Map();
  // Sync-status reads (GET /v1/chats/:id/sync-status) — seeded by a test with the same shape
  // io/chatSessions.ts's getChatSyncStatus returns, so the route's dispatch + settings plumbing
  // can be exercised end to end without the real store's DB.
  const syncStatusByChat = new Map();
  const syncInspections = new Map(); // sync_id -> ChatSyncInspection (0079, getChatSyncInspection)
  let counter = 0;
  const newId = (prefix) => `${prefix}-${++counter}`;

  return {
    sessions,
    swipesByMessage,
    syncStatusByChat,
    syncInspections,
    async listChats(userId, opts = {}) {
      let rows = [...sessions.values()].filter((s) => s.userId === userId);
      if (opts.search) {
        const q = opts.search.toLowerCase();
        rows = rows.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            (messagesByChat.get(s.chatId) ?? []).some((m) => m.content.toLowerCase().includes(q)),
        );
      }
      if (opts.folderId) rows = rows.filter((s) => s.folderId === opts.folderId);
      return rows
        .map((s) => ({ chatId: s.chatId, title: s.title, folderId: s.folderId, updatedAt: s.updatedAt }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async createChat(userId, init = {}) {
      const chatId = newId('chat');
      const row = {
        chatId,
        userId,
        title: init.title ?? 'New chat',
        folderId: init.folderId ?? null,
        params: {},
        toolNames: null,
        canvasNoteId: null,
        kind: init.kind ?? 'chat',
        characterId: init.characterId ?? null,
        promptStackPresetId: init.promptStackPresetId ?? null,
        cleanupPresetId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sessions.set(chatId, row);
      messagesByChat.set(chatId, []);
      return row;
    },
    async getChat(userId, chatId) {
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return undefined;
      return { session: row, messages: messagesByChat.get(chatId) ?? [] };
    },
    async updateChat(userId, chatId, patch) {
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return undefined;
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.folderId !== undefined) row.folderId = patch.folderId;
      if (patch.params !== undefined) row.params = patch.params;
      if (patch.toolNames !== undefined) row.toolNames = patch.toolNames;
      if (patch.canvasNoteId !== undefined) row.canvasNoteId = patch.canvasNoteId;
      if (patch.kind !== undefined) row.kind = patch.kind;
      if (patch.characterId !== undefined) row.characterId = patch.characterId;
      if (patch.promptStackPresetId !== undefined) row.promptStackPresetId = patch.promptStackPresetId;
      row.updatedAt = new Date().toISOString();
      return row;
    },
    async getChatSyncStatus(userId, chatId, dueAfterMessages) {
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return undefined;
      const entry = syncStatusByChat.get(chatId);
      return {
        lastAttemptAt: entry?.lastAttemptAt ?? null,
        lastStatus: entry?.lastStatus ?? null,
        lastStep: entry?.lastStep ?? null,
        lastError: entry?.lastError ?? null,
        lastSuccessAt: entry?.lastSuccessAt ?? null,
        lastChunksAdded: entry?.lastChunksAdded ?? null,
        lastEntriesUpdated: entry?.lastEntriesUpdated ?? null,
        consecutiveErrors: entry?.consecutiveErrors ?? 0,
        canonProposedCount: entry?.canonProposedCount ?? 0,
        canonApprovedCount: entry?.canonApprovedCount ?? 0,
        canonLastProposedAt: entry?.canonLastProposedAt ?? null,
        unsyncedMessages: (messagesByChat.get(chatId) ?? []).length,
        dueAfterMessages,
        syncs: [],
      };
    },
    async getChatSyncInspection(userId, chatId, syncId) {
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return undefined;
      const inspection = syncInspections.get(syncId);
      return inspection ?? undefined;
    },
    async deleteChat(userId, chatId) {
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return false;
      sessions.delete(chatId);
      messagesByChat.delete(chatId);
      return true;
    },
    async appendMessages(userId, chatId, messages) {
      const arr = messagesByChat.get(chatId) ?? [];
      // A monotonic counter, not wall-clock time — two messages appended in the same call (or
      // the same millisecond) must still sort deterministically, the exact real-Postgres bug
      // clock_timestamp() fixed in chatSessions.ts itself (see appendMessages there).
      const inserted = [];
      for (const m of messages) {
        const row = { messageId: newId('msg'), role: m.role, content: m.content, createdAt: ++counter };
        arr.push(row);
        inserted.push({ messageId: row.messageId, role: row.role });
      }
      messagesByChat.set(chatId, arr);
      const row = sessions.get(chatId);
      if (row) row.updatedAt = new Date().toISOString();
      return inserted;
    },
    async deleteMessage(userId, chatId, messageId) {
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return false;
      const arr = messagesByChat.get(chatId) ?? [];
      const idx = arr.findIndex((m) => m.messageId === messageId);
      if (idx === -1) return false;
      arr.splice(idx, 1);
      return true;
    },
    async cycleSwipe(userId, chatId, messageId, direction) {
      // Minimal mirror of io/chatSessions.ts's cycleSwipe over swipesByMessage — enough for the
      // swipe routes' display-decoration test: no swipes -> needs_regenerate/no_earlier_swipe,
      // seeded variants -> 'switched' with the target variant's content.
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return { status: 'not_found' };
      const target = (messagesByChat.get(chatId) ?? []).find((m) => m.messageId === messageId);
      if (!target) return { status: 'not_found' };
      const swipes = swipesByMessage.get(messageId) ?? [];
      if (swipes.length === 0) {
        return direction === 'next' ? { status: 'needs_regenerate' } : { status: 'no_earlier_swipe' };
      }
      const currentIdx = activeSwipeIdx.get(messageId) ?? 0;
      const targetIdx = direction === 'prev' ? currentIdx - 1 : currentIdx + 1;
      if (targetIdx < 0) return { status: 'no_earlier_swipe' };
      if (targetIdx >= swipes.length) return { status: 'needs_regenerate' };
      target.content = swipes[targetIdx];
      activeSwipeIdx.set(messageId, targetIdx);
      return {
        status: 'switched',
        message: {
          messageId,
          role: 'assistant',
          content: swipes[targetIdx],
          createdAt: target.createdAt,
          swipes: { index: targetIdx, count: swipes.length },
        },
      };
    },
    async truncateMessagesFrom(userId, chatId, messageId) {
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return false;
      const arr = messagesByChat.get(chatId) ?? [];
      const target = arr.find((m) => m.messageId === messageId);
      if (!target) return false;
      messagesByChat.set(
        chatId,
        arr.filter((m) => m.createdAt < target.createdAt),
      );
      return true;
    },
    async editMessageContent(userId, chatId, messageId, newContent) {
      // Minimal mirror of io/chatSessions.ts's editMessageContent (recordSwipeIfContent): rewrite
      // the message's content in place, same message_id, everything after untouched — the
      // pre-edit text preserved as a swipe (stashed as swipe #0 on the first edit).
      const row = sessions.get(chatId);
      if (!row || row.userId !== userId) return undefined;
      const target = (messagesByChat.get(chatId) ?? []).find((m) => m.messageId === messageId);
      if (!target) return undefined;
      let swipes = swipesByMessage.get(messageId) ?? [];
      if (swipes.length === 0) {
        swipes = [target.content];
        swipesByMessage.set(messageId, swipes);
        activeSwipeIdx.set(messageId, 0);
      }
      swipes.push(newContent);
      const idx = swipes.length - 1;
      activeSwipeIdx.set(messageId, idx);
      target.content = newContent;
      return {
        messageId,
        role: target.role,
        content: newContent,
        createdAt: target.createdAt,
        swipes: { index: idx, count: swipes.length },
      };
    },
    async listFolders(userId) {
      return [...folders.values()].filter((f) => f.userId === userId);
    },
    async createFolder(userId, init) {
      const folderId = newId('folder');
      const row = { folderId, userId, name: init.name, parentId: init.parentId ?? null };
      folders.set(folderId, row);
      return row;
    },
    async updateFolder(userId, folderId, patch) {
      const row = folders.get(folderId);
      if (!row || row.userId !== userId) return undefined;
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.parentId !== undefined) row.parentId = patch.parentId;
      return row;
    },
    async deleteFolder(userId, folderId) {
      const row = folders.get(folderId);
      if (!row || row.userId !== userId) return false;
      folders.delete(folderId);
      for (const s of sessions.values()) if (s.folderId === folderId) s.folderId = null;
      return true;
    },
  };
}

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakePool() {
  const inserts = [];
  // docs/prompt-macros.md's Stage 1: seeded directly by a test (push({character_id, user_id,
  // name, persona, scenario})) rather than through any insert path — nothing in this suite creates
  // characters, it only needs to read one back for {{char}}/{{description}}/{{scenario}}.
  const characters = [];
  // Per-turn narrator assembly (docs/turn-loop-plan.md §3.2): a test seeding an rp chat with a
  // promptStackPresetId can push({preset_id, slots: [...]}) here so buildNarratorStackItems's
  // context_stack_slots read resolves. Slots are shaped like context_stack_slots rows minus the
  // id/position columns.
  const slotsByPreset = new Map();
  // GET /v1/chats/:id/location-image (endpoint.md §6.4 + §5.1.8): resolveChatLocationImage's
  // reads — the chat's scene pointers, the scene-path current location, the previous (last
  // settled) location, and the active-swipe fallback. Modeled as the SQL rows they produce
  // (snake_case). chatLocationState is keyed by chatId; sceneLocations by sceneId;
  // fallbackLocations by `${userId}:${chatId}`. image_url null = the "location exists, render
  // still in flight" state the persistence contract relies on.
  const chatLocationState = new Map();
  const sceneLocations = new Map();
  const fallbackLocations = new Map();
  // GET /v1/admin/location-render-status (adminServer.ts getLocationRenderStatus): the users
  // roster read (withSystemScope, rows shaped {user_id}) + each user's recent-locations read
  // (withUserScope, rows shaped like the query's snake_case result columns).
  const renderStatusUsers = [];
  const renderStatusLocations = [];
  return {
    inserts,
    characters,
    slotsByPreset,
    setChatLocationState(chatId, state) {
      chatLocationState.set(chatId, state);
    },
    setSceneLocation(sceneId, row) {
      sceneLocations.set(sceneId, row);
    },
    setFallbackLocation(userId, chatId, row) {
      fallbackLocations.set(`${userId}:${chatId}`, row);
    },
    setRenderStatusUsers(rows) {
      renderStatusUsers.push(...rows);
    },
    setRenderStatusLocations(rows) {
      renderStatusLocations.push(...rows);
    },
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }
          if (sql.includes('insert into unstructured_notes')) {
            inserts.push({ scopedUserId, params });
            return { rows: [{ note_id: 'fake-note-id-1' }] };
          }
          if (sql.startsWith('select name, persona, scenario from characters')) {
            const [characterId, userId] = params;
            const character = characters.find((c) => c.character_id === characterId && c.user_id === userId);
            return { rows: character ? [{ name: character.name, persona: character.persona, scenario: character.scenario }] : [] };
          }
          // buildNarratorStackItems's wider read (per-turn narrator assembly) — same characters
          // array, just more columns (system_prompt/example_dialogue may be undefined for rows
          // this suite seeds with only the macro-relevant fields).
          if (sql.startsWith('select name, system_prompt, persona, scenario, example_dialogue from characters')) {
            const [characterId, userId] = params;
            const character = characters.find((c) => c.character_id === characterId && c.user_id === userId);
            return {
              rows: character
                ? [{ name: character.name, system_prompt: character.system_prompt, persona: character.persona, scenario: character.scenario, example_dialogue: character.example_dialogue }]
                : [],
            };
          }
          // buildNarratorStackItems's context_stack_slots read — see slotsByPreset above.
          if (sql.includes('from context_stack_slots where preset_id')) {
            return { rows: slotsByPreset.get(params[0]) ?? [] };
          }
          // bb_principles.md §14's gate (io/llm/llmGate.ts) logs every LLM call it makes,
          // 'chat'-kind included — every runTurn/generateChatTitle call this file drives goes
          // through it now (httpServer.ts wraps both the boot-time llm and any per-chat profile
          // override), so this fake pool needs to accept the log write even though nothing here
          // asserts on its contents (that's verify-llm-gate.mjs's job).
          if (sql.includes('insert into llm_calls')) {
            return { rows: [] };
          }
          // turn_metrics recording (db/migrations/0041_turn_metrics.sql) fires for every gated
          // complete() call too — its own recorder catches/logs failures, so the tests pass either
          // way, but the fake pool's catch-all would still spam ERROR lines per turn. Accept the
          // insert like llm_calls; nothing here asserts on its contents (verify-loop.mjs's job).
          if (sql.includes('insert into turn_metrics')) {
            return { rows: [] };
          }
          // docs/chat-memory.md: handleChatCompletions' buildChatMemorySystemPrompt reads both of
          // these on every persisted-session turn now — empty is a legitimate, common answer (no
          // household memory or per-chat digest yet), nothing here asserts on their contents.
          // 'from chat_memory_entries' (not the narrower 'select content from …') so the rp-lane
          // bridge read — `select topic_key, content from chat_memory_entries …` — matches too.
          if (sql.includes('select content from household_memory') || sql.includes('from chat_memory_entries')) {
            return { rows: [] };
          }
          // ...and the rp-lane's approved 'plot' canon-facts recall (httpServer.ts's
          // buildChatMemorySystemPrompt, the distinct-on-arc_tag query) — no approved plot facts
          // is a legitimate, common state; nothing here asserts on its contents either.
          if (sql.includes('from canon_facts')) {
            return { rows: [] };
          }
          // ...and the rp-lane's CNZ-style auto-recall (httpServer.ts's buildChatMemorySystemPrompt
          // -> io/chatMemory/recallForPrompt.ts): both its chat_chunks full-turn read and its
          // approved-canon-facts read (the `with candidates ... distinct on (coalesce(...))` CTE —
          // matches via the 'from canon_facts f' inside). No archived turns / no approved facts is
          // a legitimate, common state; nothing here asserts on their contents either.
          if (sql.includes('from chat_chunks')) {
            return { rows: [] };
          }
          // GET /v1/chats/:id/location-image (endpoint.md §6.4 + §5.1.8):
          //   resolveChatLocationImage's chat-state read — params: [chatId] -> the chat's scene
          //   pointers (current + previous). Empty = no scene state at all.
          if (sql.startsWith('select scene_id, previous_scene_id from chat_sessions where chat_id')) {
            const state = chatLocationState.get(params[0]);
            return { rows: state ? [state] : [] };
          }
          //   the scene-path reads — params: [userId, sceneId, chatId?] -> the scene's location.
          //   The previous-location read (endpoint.md §5.1.8) is the same join with
          //   `l.image_url is not null`: a historical pointer is only shown when it has an image.
          if (sql.includes('from scenes s') && sql.includes('select l.location_id, l.name')) {
            const row = sceneLocations.get(params[1]);
            if (sql.includes('l.image_url is not null')) {
              return { rows: row && row.image_url ? [row] : [] };
            }
            return { rows: row ? [row] : [] };
          }
          //   the active-swipe fallback (stale scene pointer on prev/next cycling) — params:
          //   [userId, chatId] -> the cycled-to swipe's own location.
          if (sql.includes('from locations l') && sql.includes('select l.location_id, l.name')) {
            const row = fallbackLocations.get(`${params[0]}:${params[1]}`);
            return { rows: row ? [row] : [] };
          }
          // GET /v1/admin/location-render-status: the users roster read (withSystemScope).
          if (sql.includes('select user_id from users')) {
            return { rows: renderStatusUsers };
          }
          //   each user's recent-locations read (withUserScope) — seeded rows are already
          //   shaped like the query's snake_case result columns.
          if (sql.startsWith('select location_id, name, status')) {
            return { rows: renderStatusLocations };
          }
          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

// --- Part 1: the loader against the real plugins/ directory ---
// startBackgroundJobs: false — this only tests loadPlugins/registerTools discovery, not
// background-job behavior. Without it, plugins/temporal's real setInterval poller would run
// against createFakePool() forever (it only recognizes a few query shapes), throwing on every
// tick and keeping the process alive indefinitely instead of letting this script finish.
const realPluginsDir = new URL('../../plugins', import.meta.url).pathname;
const realTools = await loadPlugins(
  realPluginsDir,
  {
    llm: createStubLlmProvider([]), // registerTools() itself makes no LLM calls, just wiring
    embeddings: createStubEmbeddingProvider(8),
    cipher: testCipher,
    db: createPostgresClient(createFakePool()),
    credentials: createFakeCredentialStore(),
    settings: createFakeSettingsStore(),
  },
  { startBackgroundJobs: false },
);
assert(
  realTools.some((t) => t.definition.name === 'ingest_note'),
  'loadPlugins discovers and dynamically imports the real document-ingestion plugin from disk',
);

// --- Part 2: a broken plugin is skipped, not fatal ---
{
  const scratchDir = mkdtempSync(join(tmpdir(), 'bigbrain-plugin-check-'));
  const badPluginDir = join(scratchDir, 'broken-plugin', 'dist');
  mkdirSync(badPluginDir, { recursive: true });
  writeFileSync(join(badPluginDir, 'index.js'), "throw new Error('boom at import time');\n");

  const goodPluginDir = join(scratchDir, 'good-plugin', 'dist');
  mkdirSync(goodPluginDir, { recursive: true });
  writeFileSync(
    join(goodPluginDir, 'index.js'),
    "export const info = { id: 'good-plugin', name: 'Good', description: 'x' };\n" +
      'export async function registerTools() { return [{ definition: { name: "noop", description: "x", parameters: {} }, handler: async () => ({}) }]; }\n',
  );

  const tools = await loadPlugins(scratchDir, { llm: null, embeddings: null, cipher: null });
  assert(
    tools.some((t) => t.definition.name === 'noop'),
    'a broken sibling plugin does not prevent a good plugin from loading',
  );
  assert(tools.length === 1, 'only the good plugin contributed tools — the broken one was skipped, not crashed past');

  rmSync(scratchDir, { recursive: true, force: true });
}

// --- Part 3: the HTTP server, end to end, including auth ---
// One full round (tool call + final answer) scripted per request that reaches runTurn below —
// two for the original non-streaming/streaming pair, two more for the Cloudflare-Access-auth
// requests added alongside them — sharing this one long-lived stub instance the same way a real
// server shares one LlmProvider across requests.
const llm = createStubLlmProvider([
  { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'c1', name: 'echo', arguments: { x: 1 } }] },
  { message: { role: 'assistant', content: 'final answer' }, toolCalls: [] },
  { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'c2', name: 'echo', arguments: { x: 2 } }] },
  { message: { role: 'assistant', content: 'final answer' }, toolCalls: [] },
  { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'c3', name: 'echo', arguments: { x: 3 } }] },
  { message: { role: 'assistant', content: 'final answer' }, toolCalls: [] },
  { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'c4', name: 'echo', arguments: { x: 4 } }] },
  { message: { role: 'assistant', content: 'final answer' }, toolCalls: [] },
]);
const echoTool = {
  definition: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } },
  handler: async (args) => args,
};
const pool = createFakePool();
const db = createPostgresClient(pool);
const tools = createToolRegistry([echoTool]);
const apiKeys = createApiKeyStore('good-key:11111111-1111-1111-1111-111111111111');
const credentials = createFakeCredentialStore();
const settings = createFakeSettingsStore();
const accessIdentity = createFakeAccessIdentityResolver();
const chats = createFakeChatSessionStore();
const restartCalls = [];
const llmConnections = createFakeLlmConnectionStore([
  {
    id: 'conn-deepseek',
    name: 'deepseek',
    kind: 'openai-compatible',
    model: 'deepseek-v4-flash',
    apiKey: 'sk-test-deepseek',
    baseUrl: 'https://example.invalid/deepseek',
    supportsVision: false,
    providerOrder: null,
    allowFallbacks: true,
    quantizations: null,
    isActive: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'conn-openrouter',
    name: 'openrouter',
    kind: 'openai-compatible',
    model: 'google/gemini-3.5-flash-lite',
    apiKey: 'sk-test-openrouter',
    baseUrl: 'https://example.invalid/openrouter',
    supportsVision: false,
    providerOrder: null,
    allowFallbacks: true,
    quantizations: null,
    isActive: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]);

const server = startHttpServer({
  llm,
  db,
  tools,
  apiKeys,
  accessIdentity,
  chats,
  adminApiKey: 'the-admin-key',
  credentials,
  settings,
  llmConnections,
  imageConnections: createFakeImageConnectionStore([
    {
      id: 'img-conn-pollinations',
      name: 'pollinations-flux',
      kind: 'pollinations',
      model: 'flux',
      apiKey: 'fake-poll-token',
      baseUrl: null,
      width: 1344,
      height: 768,
      samplingSteps: 30,
      cfgScale: 7,
      samplerName: null,
      masterPositiveStylePrefix: null,
      masterNegativePrompt: null,
      workflowParameters: null,
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]),
  modelName: 'bigbrain',
  port: 0,
  triggerRestart: () => restartCalls.push(Date.now()),
});
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const modelsRes = await fetch(`${base}/v1/models`);
const modelsBody = await modelsRes.json();
assert(modelsRes.status === 200 && modelsBody.data?.[0]?.id === 'bigbrain', 'GET /v1/models returns the bigbrain model entry');

const healthRes = await fetch(`${base}/healthz`);
assert(healthRes.status === 200, 'GET /healthz returns 200');

const noAuthRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
});
assert(noAuthRes.status === 401, 'POST /v1/chat/completions with no auth header returns 401');

const wrongKeyRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-key' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
});
assert(wrongKeyRes.status === 401, 'POST /v1/chat/completions with an unrecognized key returns 401');

// --- Cloudflare Access identity takes priority over, and can substitute for, a Bearer key ---
const accessNoKeyRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': 'valid-access-jwt' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'please echo' }] }),
});
assert(accessNoKeyRes.status === 200, 'a valid Cf-Access-Jwt-Assertion header authenticates with no Bearer key at all');
assert(accessIdentity.calls.includes('valid-access-jwt'), 'the Access header was actually passed to the resolver');

const accessInvalidFallsThroughRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'cf-access-jwt-assertion': 'not-a-real-jwt',
    authorization: 'Bearer good-key',
  },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'please echo' }] }),
});
assert(
  accessInvalidFallsThroughRes.status === 200,
  'an unresolvable Access header falls through to the Bearer key instead of hard-failing',
);

const whoamiNoAuthRes = await fetch(`${base}/v1/whoami`);
assert(whoamiNoAuthRes.status === 401, 'GET /v1/whoami with no auth at all returns 401');

const whoamiKeyRes = await fetch(`${base}/v1/whoami`, { headers: { authorization: 'Bearer good-key' } });
const whoamiKeyBody = await whoamiKeyRes.json();
assert(whoamiKeyRes.status === 200 && whoamiKeyBody.userId === '11111111-1111-1111-1111-111111111111', 'GET /v1/whoami resolves via a Bearer key');

const whoamiAccessRes = await fetch(`${base}/v1/whoami`, { headers: { 'cf-access-jwt-assertion': 'valid-access-jwt' } });
const whoamiAccessBody = await whoamiAccessRes.json();
assert(
  whoamiAccessRes.status === 200 && whoamiAccessBody.userId === '33333333-3333-3333-3333-333333333333',
  'GET /v1/whoami resolves via a Cloudflare Access identity with no key at all',
);

const badBodyRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer good-key' },
  body: JSON.stringify({ notMessages: true }),
});
assert(badBodyRes.status === 400, 'POST /v1/chat/completions with a malformed body returns 400');

const notFoundRes = await fetch(`${base}/not/a/real/route`);
assert(notFoundRes.status === 404, 'an unknown route returns 404');

const okRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer good-key' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'please echo' }] }),
});
const okBody = await okRes.json();
assert(okRes.status === 200, 'a correctly authenticated request returns 200');
assert(okBody.object === 'chat.completion' && okBody.choices?.[0]?.message?.content === 'final answer', 'the response is OpenAI chat.completion-shaped with the loop\'s real reply');
assert(
  pool.inserts.length === 0 && true, // no insert expected for the echo tool; presence check only guards against accidental cross-test pollution
  'no unrelated DB writes happened for this request',
);

const streamRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer good-key' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'please echo' }], stream: true }),
});
const streamText = await streamRes.text();
assert(streamRes.headers.get('content-type')?.includes('text/event-stream'), 'stream:true gets an SSE content-type');
assert(streamText.includes('"content":"final answer"'), 'the SSE payload carries the final reply');
assert(streamText.trim().endsWith('data: [DONE]'), 'the SSE stream ends with the [DONE] terminator');

// --- Frontend SPA static serving (frontend/dist, built by `npm run build --workspace=@bigbrain/frontend`) ---
const rootRes = await fetch(`${base}/`);
const rootBody = await rootRes.text();
assert(rootRes.status === 200, 'GET / serves the built frontend SPA unauthenticated');
assert(rootRes.headers.get('content-type')?.includes('text/html'), 'GET / returns text/html');
assert(rootBody.includes('<div id="root">'), 'GET / serves the SPA shell (index.html)');

// index.html references its real, content-hashed built assets — fetch whatever it actually
// references rather than hardcoding a filename that changes every build.
const assetPaths = [...new Set(rootBody.match(/\/assets\/[^"']+/g) ?? [])];
assert(assetPaths.length > 0, 'the built index.html references at least one /assets/ file');
for (const assetPath of assetPaths) {
  const assetRes = await fetch(`${base}${assetPath}`);
  const expectedType = assetPath.endsWith('.css') ? 'text/css' : 'application/javascript';
  assert(assetRes.status === 200, `GET ${assetPath} returns 200`);
  assert(assetRes.headers.get('content-type')?.includes(expectedType), `GET ${assetPath} has content-type ${expectedType}`);
}

const missingAssetRes = await fetch(`${base}/assets/does-not-exist.js`);
assert(missingAssetRes.status === 404, 'GET /assets/<missing file> returns 404');

const traversalRes = await fetch(`${base}/assets/..%2f..%2fpackage.json`);
assert(traversalRes.status === 404, 'GET /assets/<path traversal attempt> is rejected, not served');

// --- Admin credentials routes ---

const listNoAuthRes = await fetch(`${base}/v1/admin/credentials`);
assert(listNoAuthRes.status === 401, 'GET /v1/admin/credentials with no auth header returns 401');

const listWrongKeyRes = await fetch(`${base}/v1/admin/credentials`, {
  headers: { authorization: 'Bearer not-the-admin-key' },
});
assert(listWrongKeyRes.status === 401, 'GET /v1/admin/credentials with the wrong key returns 401');

const listOkRes = await fetch(`${base}/v1/admin/credentials`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
const listOkBody = await listOkRes.json();
assert(listOkRes.status === 200, 'GET /v1/admin/credentials with the correct admin key returns 200');
assert(
  listOkBody.credentials.length === CREDENTIAL_NAMES.length && listOkBody.credentials.every((c) => c.configured === false),
  'GET /v1/admin/credentials returns every credential name, none configured yet',
);

const setNoAuthRes = await fetch(`${base}/v1/admin/credentials`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'deepseek_api_key', value: 'sk-new' }),
});
assert(setNoAuthRes.status === 401, 'POST /v1/admin/credentials with no auth header returns 401');
assert(credentials.setCalls.length === 0, 'the unauthenticated POST never reached the credential store');

const setOkRes = await fetch(`${base}/v1/admin/credentials`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ name: 'deepseek_api_key', value: 'sk-new' }),
});
const setOkBody = await setOkRes.json();
assert(setOkRes.status === 202, 'an authenticated POST /v1/admin/credentials returns 202');
assert(setOkBody.status === 'restarting', 'the response body signals a restart is coming');
assert(
  credentials.setCalls.length === 1 && credentials.setCalls[0].name === 'deepseek_api_key' && credentials.setCalls[0].value === 'sk-new',
  'the credential store actually recorded the write',
);

await new Promise((resolve) => setTimeout(resolve, 250));
assert(restartCalls.length === 1, 'triggerRestart fired exactly once after the response flushed, instead of the real process.exit');

// --- Admin connections routes (io/llmConnections.ts, replacing the old settings/models/providers picker) ---

const connectionsNoAuthRes = await fetch(`${base}/v1/admin/connections`);
assert(connectionsNoAuthRes.status === 401, 'GET /v1/admin/connections with no auth header returns 401');

const connectionsListRes = await fetch(`${base}/v1/admin/connections`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
const connectionsListBody = await connectionsListRes.json();
assert(connectionsListRes.status === 200, 'GET /v1/admin/connections with the correct admin key returns 200');
assert(
  connectionsListBody.connections.length === 2 &&
    connectionsListBody.connections.some((c) => c.name === 'deepseek' && c.isActive === true) &&
    connectionsListBody.connections.some((c) => c.name === 'openrouter' && c.isActive === false),
  'GET /v1/admin/connections lists every seeded connection with its isActive flag',
);
assert(
  !JSON.stringify(connectionsListBody).includes('sk-test-deepseek') && !JSON.stringify(connectionsListBody).includes('sk-test-openrouter'),
  'GET /v1/admin/connections never leaks an apiKey value',
);

const createNoAuthRes = await fetch(`${base}/v1/admin/connections`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'new-conn', kind: 'anthropic', model: 'claude-x', apiKey: 'sk-x' }),
});
assert(createNoAuthRes.status === 401, 'POST /v1/admin/connections with no auth header returns 401');

const createMissingFieldRes = await fetch(`${base}/v1/admin/connections`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ name: 'new-conn', kind: 'anthropic', model: 'claude-x' }),
});
assert(createMissingFieldRes.status === 400, 'POST /v1/admin/connections rejects a body missing apiKey');

const createNoBaseUrlRes = await fetch(`${base}/v1/admin/connections`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ name: 'new-conn', kind: 'openai-compatible', model: 'x', apiKey: 'sk-x' }),
});
assert(createNoBaseUrlRes.status === 400, 'POST /v1/admin/connections rejects an openai-compatible connection with no baseUrl');

const createOkRes = await fetch(`${base}/v1/admin/connections`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ name: 'anthropic-direct', kind: 'anthropic', model: 'claude-x', apiKey: 'sk-anthropic' }),
});
const createOkBody = await createOkRes.json();
assert(createOkRes.status === 201 && createOkBody.name === 'anthropic-direct', 'POST /v1/admin/connections with a valid body creates a connection');
assert(!('apiKey' in createOkBody), 'the created connection response never echoes the apiKey back');

const createBothKeyFieldsRes = await fetch(`${base}/v1/admin/connections`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ name: 'bad-conn', kind: 'anthropic', model: 'claude-x', apiKey: 'sk-x', copyApiKeyFrom: 'conn-openrouter' }),
});
assert(createBothKeyFieldsRes.status === 400, 'POST /v1/admin/connections rejects a body giving both apiKey and copyApiKeyFrom');

const createNoKeyFieldRes = await fetch(`${base}/v1/admin/connections`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ name: 'bad-conn-2', kind: 'anthropic', model: 'claude-x' }),
});
assert(createNoKeyFieldRes.status === 400, 'POST /v1/admin/connections rejects a body giving neither apiKey nor copyApiKeyFrom');

// The named-connections-per-provider request this exists for: a second OpenRouter connection
// (different model) that reuses conn-openrouter's own key instead of re-pasting it.
const createCopyKeyRes = await fetch(`${base}/v1/admin/connections`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({
    name: 'openrouter-gemini',
    kind: 'openai-compatible',
    model: 'google/gemini-x',
    baseUrl: 'https://example.invalid/openrouter',
    copyApiKeyFrom: 'conn-openrouter',
  }),
});
const createCopyKeyBody = await createCopyKeyRes.json();
assert(
  createCopyKeyRes.status === 201 && createCopyKeyBody.name === 'openrouter-gemini',
  'POST /v1/admin/connections accepts copyApiKeyFrom in place of apiKey',
);
assert(
  llmConnections.rows.get(createCopyKeyBody.id).apiKey === llmConnections.rows.get('conn-openrouter').apiKey,
  "the new connection's key is copied from the source connection, not left unset",
);
await fetch(`${base}/v1/admin/connections/${createCopyKeyBody.id}`, {
  method: 'DELETE',
  headers: { authorization: 'Bearer the-admin-key' },
}); // cleanup — not the active connection, so this always succeeds

const patchRes = await fetch(`${base}/v1/admin/connections/${createOkBody.id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ model: 'claude-x-2' }),
});
const patchBody = await patchRes.json();
assert(
  patchRes.status === 200 && patchBody.model === 'claude-x-2' && patchBody.name === 'anthropic-direct',
  'PATCH /v1/admin/connections/:id updates only the given field, leaving name untouched',
);

const patchUnknownRes = await fetch(`${base}/v1/admin/connections/not-a-real-id`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
  body: JSON.stringify({ model: 'x' }),
});
assert(patchUnknownRes.status === 404, 'PATCH /v1/admin/connections/:id for an unknown id returns 404');

const deleteActiveRes = await fetch(`${base}/v1/admin/connections/conn-deepseek`, {
  method: 'DELETE',
  headers: { authorization: 'Bearer the-admin-key' },
});
assert(deleteActiveRes.status === 409, 'DELETE /v1/admin/connections/:id on the active connection returns 409');

const deleteOkRes = await fetch(`${base}/v1/admin/connections/${createOkBody.id}`, {
  method: 'DELETE',
  headers: { authorization: 'Bearer the-admin-key' },
});
const deleteOkBody = await deleteOkRes.json();
assert(deleteOkRes.status === 200 && deleteOkBody.deleted === true, 'DELETE /v1/admin/connections/:id on a non-active connection succeeds');

const deleteUnknownRes = await fetch(`${base}/v1/admin/connections/${createOkBody.id}`, {
  method: 'DELETE',
  headers: { authorization: 'Bearer the-admin-key' },
});
assert(deleteUnknownRes.status === 404, 'DELETE /v1/admin/connections/:id for an already-deleted id returns 404');

const activateNoAuthRes = await fetch(`${base}/v1/admin/connections/conn-openrouter/activate`, { method: 'POST' });
assert(activateNoAuthRes.status === 401, 'POST /v1/admin/connections/:id/activate with no auth header returns 401');

const activateOkRes = await fetch(`${base}/v1/admin/connections/conn-openrouter/activate`, {
  method: 'POST',
  headers: { authorization: 'Bearer the-admin-key' },
});
const activateOkBody = await activateOkRes.json();
assert(activateOkRes.status === 202 && activateOkBody.status === 'restarting', 'POST /v1/admin/connections/:id/activate returns 202 and signals a restart');

await new Promise((resolve) => setTimeout(resolve, 250));
assert(restartCalls.length === 2, 'triggerRestart fired again after the activate call flushed');

const afterActivateListBody = await (
  await fetch(`${base}/v1/admin/connections`, { headers: { authorization: 'Bearer the-admin-key' } })
).json();
assert(
  afterActivateListBody.connections.find((c) => c.id === 'conn-openrouter').isActive === true &&
    afterActivateListBody.connections.find((c) => c.id === 'conn-deepseek').isActive === false,
  'activating a connection flips it active and clears the previously active one',
);

// deepseek is no longer active, so it can be deleted now.
const deleteFormerlyActiveRes = await fetch(`${base}/v1/admin/connections/conn-deepseek`, {
  method: 'DELETE',
  headers: { authorization: 'Bearer the-admin-key' },
});
assert(deleteFormerlyActiveRes.status === 200, 'DELETE /v1/admin/connections/:id succeeds once the connection is no longer active');
llmConnections.rows.set('conn-deepseek', {
  id: 'conn-deepseek',
  name: 'deepseek',
  kind: 'openai-compatible',
  model: 'deepseek-v4-flash',
  apiKey: 'sk-test-deepseek',
  baseUrl: 'https://example.invalid/deepseek',
  supportsVision: false,
  providerOrder: null,
  allowFallbacks: true,
  quantizations: null,
  isActive: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
}); // restored for the routes exercised below

// --- Admin connections/:id/models route (the model dropdown within a chosen connection) ---

const modelsNoAuthRes = await fetch(`${base}/v1/admin/connections/conn-openrouter/models`);
assert(modelsNoAuthRes.status === 401, 'GET /v1/admin/connections/:id/models with no auth header returns 401');

const modelsUnknownConnRes = await fetch(`${base}/v1/admin/connections/not-a-real-id/models`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
assert(modelsUnknownConnRes.status === 404, 'GET /v1/admin/connections/:id/models for an unknown id returns 404');

// This mock has to coexist with the test's own outer fetch() calls to the local test server —
// both go through the same globalThis.fetch in this single process — so it only fakes the one
// URL it cares about and delegates everything else (including the loopback call below) to the
// real fetch.
const originalFetch = globalThis.fetch;
const calledUrls = [];
globalThis.fetch = async (url, init) => {
  if (url !== 'https://example.invalid/openrouter/models') return originalFetch(url, init);
  calledUrls.push(url);
  return {
    ok: true,
    json: async () => ({
      data: [
        { id: 'google/gemini-3.5-flash-lite', pricing: { prompt: '0.0000001', completion: '0.0000004' } },
        { id: 'anthropic/claude-4' },
      ],
    }),
    text: async () => '',
  };
};
try {
  const modelsOkRes = await fetch(`${base}/v1/admin/connections/conn-openrouter/models`, {
    headers: { authorization: 'Bearer the-admin-key' },
  });
  const modelsOkBody = await modelsOkRes.json();
  assert(calledUrls.length === 1, "the models route queried the requested connection's own baseUrl (openrouter)");
  assert(modelsOkRes.status === 200, 'GET /v1/admin/connections/:id/models for a known connection returns 200');
  assert(
    modelsOkBody.models.length === 2 && modelsOkBody.models.some((m) => m.id === 'anthropic/claude-4'),
    'the response carries the live model catalog fetched from that connection',
  );
  assert(
    modelsOkBody.defaultModel === 'google/gemini-3.5-flash-lite',
    "defaultModel is the connection's own static config model, not any override",
  );
  const priced = modelsOkBody.models.find((m) => m.id === 'google/gemini-3.5-flash-lite');
  assert(
    priced?.pricing?.prompt === '0.0000001' && priced?.pricing?.completion === '0.0000004',
    "a model with a pricing field (OpenRouter's own extension) carries it through to the response",
  );
  const unpriced = modelsOkBody.models.find((m) => m.id === 'anthropic/claude-4');
  assert(unpriced?.pricing === undefined, 'a model with no pricing field (e.g. DeepSeek-shaped entries) is left without one, not a fabricated default');
} finally {
  globalThis.fetch = originalFetch;
}

const modelsAccessRes = await fetch(`${base}/v1/admin/connections/conn-openrouter/models`, {
  headers: { 'cf-access-jwt-assertion': 'not-a-real-jwt' },
});
assert(
  modelsAccessRes.status === 401,
  'GET /v1/admin/connections/:id/models is gated by the same isAdminAuthorized check (an unresolvable Access header still 401s)',
);

// A valid Cloudflare Access identity authorizes admin routes with no admin key at all — the
// gate is Access itself now, not a second manually-typed secret (see isAdminAuthorized).
const accessAdminRes = await fetch(`${base}/v1/admin/connections`, {
  headers: { 'cf-access-jwt-assertion': 'valid-access-jwt' },
});
assert(accessAdminRes.status === 200, 'GET /v1/admin/connections with a valid Access identity and no admin key returns 200');

const accessAdminWrongJwtRes = await fetch(`${base}/v1/admin/connections`, {
  headers: { 'cf-access-jwt-assertion': 'not-a-real-jwt' },
});
assert(
  accessAdminWrongJwtRes.status === 401,
  'GET /v1/admin/connections with an unresolvable Access header and no admin key still returns 401',
);

// --- Admin connections/:id/test route (the "Test" button — a real, capped-tokens round trip) ---

const testNoAuthRes = await fetch(`${base}/v1/admin/connections/conn-openrouter/test`, { method: 'POST' });
assert(testNoAuthRes.status === 401, 'POST /v1/admin/connections/:id/test with no auth header returns 401');

const testUnknownConnRes = await fetch(`${base}/v1/admin/connections/not-a-real-id/test`, {
  method: 'POST',
  headers: { authorization: 'Bearer the-admin-key' },
});
assert(testUnknownConnRes.status === 404, 'POST /v1/admin/connections/:id/test for an unknown id returns 404');

const originalFetchTest = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (url !== 'https://example.invalid/openrouter/chat/completions') return originalFetchTest(url, init);
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
    text: async () => '',
  };
};
try {
  const testOkRes = await fetch(`${base}/v1/admin/connections/conn-openrouter/test`, {
    method: 'POST',
    headers: { authorization: 'Bearer the-admin-key' },
  });
  const testOkBody = await testOkRes.json();
  assert(testOkRes.status === 200 && testOkBody.ok === true, 'POST /v1/admin/connections/:id/test against a reachable connection returns { ok: true }');
  assert(testOkBody.reply === 'ok' && typeof testOkBody.latencyMs === 'number', 'a successful test reports the reply text and a latency');
} finally {
  globalThis.fetch = originalFetchTest;
}

const originalFetchTestFail = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (url !== 'https://example.invalid/openrouter/chat/completions') return originalFetchTestFail(url, init);
  throw new TypeError('fetch failed');
};
try {
  const testFailRes = await fetch(`${base}/v1/admin/connections/conn-openrouter/test`, {
    method: 'POST',
    headers: { authorization: 'Bearer the-admin-key' },
  });
  const testFailBody = await testFailRes.json();
  assert(
    testFailRes.status === 200 && testFailBody.ok === false && typeof testFailBody.error === 'string',
    'POST /v1/admin/connections/:id/test against an unreachable connection returns 200 with { ok: false, error } — not a thrown route error',
  );
} finally {
  globalThis.fetch = originalFetchTestFail;
}

// --- Admin image-connections routes (endpoint.md §3 — the Connections tab's image section) ---

const imgNoAuthRes = await fetch(`${base}/v1/admin/image-connections`);
assert(imgNoAuthRes.status === 401, 'GET /v1/admin/image-connections with no auth header returns 401');

const imgListRes = await fetch(`${base}/v1/admin/image-connections`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
const imgListBody = await imgListRes.json();
assert(imgListRes.status === 200, 'GET /v1/admin/image-connections with the correct admin key returns 200');
assert(
  imgListBody.connections.length === 1 && imgListBody.connections[0].name === 'pollinations-flux',
  'GET /v1/admin/image-connections lists every seeded image connection with its isActive flag',
);
assert(
  imgListBody.connections[0].apiKey === undefined && imgListBody.connections[0].hasApiKey === true,
  'GET /v1/admin/image-connections never leaks an apiKey value; hasApiKey reflects the stored key',
);

const imgCreateNoAuthRes = await fetch(`${base}/v1/admin/image-connections`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'runware-prod', kind: 'runware', model: 'runware:100@1', apiKey: 'sk-runware' }),
});
assert(imgCreateNoAuthRes.status === 401, 'POST /v1/admin/image-connections with no auth header returns 401');

const imgCreateBadKindRes = await fetch(`${base}/v1/admin/image-connections`, {
  method: 'POST',
  headers: { authorization: 'Bearer the-admin-key', 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'bad', kind: 'not-a-kind', model: 'x' }),
});
assert(imgCreateBadKindRes.status === 400, 'POST /v1/admin/image-connections rejects an unknown kind');

// A keyless create (a local comfyui endpoint) is valid — unlike llm_connections, apiKey is
// optional (endpoint.md §2.1); every cloud provider (Pollinations included) requires one,
// enforced at render time.
const imgCreateKeylessRes = await fetch(`${base}/v1/admin/image-connections`, {
  method: 'POST',
  headers: { authorization: 'Bearer the-admin-key', 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'local-comfyui', kind: 'comfyui', model: 'anything', baseUrl: 'http://127.0.0.1:8188' }),
});
const imgCreateKeylessBody = await imgCreateKeylessRes.json();
assert(
  imgCreateKeylessRes.status === 201 && imgCreateKeylessBody.name === 'local-comfyui' && imgCreateKeylessBody.hasApiKey === false,
  'POST /v1/admin/image-connections accepts a keyless connection (a local comfyui endpoint)',
);
assert(
  imgCreateKeylessBody.width === 1344 && imgCreateKeylessBody.height === 768,
  'POST /v1/admin/image-connections without width/height defaults to the 1344×768 connection default',
);

const imgCreateWithKeyRes = await fetch(`${base}/v1/admin/image-connections`, {
  method: 'POST',
  headers: { authorization: 'Bearer the-admin-key', 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'runware-prod', kind: 'runware', model: 'runware:100@1', apiKey: 'sk-runware' }),
});
const imgCreateWithKeyBody = await imgCreateWithKeyRes.json();
assert(
  imgCreateWithKeyRes.status === 201 && imgCreateWithKeyBody.hasApiKey === true,
  'POST /v1/admin/image-connections with a key reports hasApiKey: true and never the key itself',
);
assert(imgCreateWithKeyBody.apiKey === undefined, 'the created image connection response never leaks the apiKey');

const imgPatchRes = await fetch(`${base}/v1/admin/image-connections/${imgCreateWithKeyBody.id}`, {
  method: 'PATCH',
  headers: { authorization: 'Bearer the-admin-key', 'content-type': 'application/json' },
  body: JSON.stringify({ width: 1024, height: 1024, masterNegativePrompt: 'blurry' }),
});
const imgPatchBody = await imgPatchRes.json();
assert(
  imgPatchRes.status === 200 && imgPatchBody.width === 1024 && imgPatchBody.height === 1024 && imgPatchBody.masterNegativePrompt === 'blurry',
  'PATCH /v1/admin/image-connections/:id updates only the given fields',
);

const imgDeleteActiveRes = await fetch(`${base}/v1/admin/image-connections/img-conn-pollinations`, {
  method: 'DELETE',
  headers: { authorization: 'Bearer the-admin-key' },
});
assert(imgDeleteActiveRes.status === 409, 'DELETE /v1/admin/image-connections/:id on the active connection returns 409');

// Activation is a plain 200 — no restart (the active image connection is resolved live per
// generation, endpoint.md §5.1.3), unlike the LLM connections' 202+restart.
const imgActivateRes = await fetch(`${base}/v1/admin/image-connections/img-conn-pollinations/activate`, {
  method: 'POST',
  headers: { authorization: 'Bearer the-admin-key' },
});
assert(imgActivateRes.status === 200, 'POST /v1/admin/image-connections/:id/activate returns 200 (no restart)');

// Activating a nonexistent id must not clear the current active flag (the route 404s, and the
// previously-active connection stays active).
const imgActivateMissingRes = await fetch(`${base}/v1/admin/image-connections/not-a-real-id/activate`, {
  method: 'POST',
  headers: { authorization: 'Bearer the-admin-key' },
});
assert(imgActivateMissingRes.status === 404, 'POST /v1/admin/image-connections/:id/activate for an unknown id returns 404');
const imgStillActiveRes = await fetch(`${base}/v1/admin/image-connections`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
const imgStillActiveBody = await imgStillActiveRes.json();
assert(
  imgStillActiveBody.connections.find((c) => c.id === 'img-conn-pollinations')?.isActive === true,
  'a failed activation leaves the previously-active connection active (existence is probed before the active flag is cleared)',
);

const imgDeleteOkRes = await fetch(`${base}/v1/admin/image-connections/${imgCreateKeylessBody.id}`, {
  method: 'DELETE',
  headers: { authorization: 'Bearer the-admin-key' },
});
assert(imgDeleteOkRes.status === 200, 'DELETE /v1/admin/image-connections/:id on a non-active connection succeeds');

// The Test button (endpoint.md §3.3): pollinations needs no network (its URL *is* the render
// request), so the probe returns the constructed URL — with the connection's token baked in —
// synchronously.
const imgTestNoAuthRes = await fetch(`${base}/v1/admin/image-connections/img-conn-pollinations/test`, { method: 'POST' });
assert(imgTestNoAuthRes.status === 401, 'POST /v1/admin/image-connections/:id/test with no auth header returns 401');

const imgTestRes = await fetch(`${base}/v1/admin/image-connections/img-conn-pollinations/test`, {
  method: 'POST',
  headers: { authorization: 'Bearer the-admin-key' },
});
const imgTestBody = await imgTestRes.json();
assert(
  imgTestRes.status === 200 && imgTestBody.ok === true && typeof imgTestBody.imageUrl === 'string'
    && imgTestBody.imageUrl.includes('image.pollinations.ai') && imgTestBody.imageUrl.includes('token=fake-poll-token'),
  'POST /v1/admin/image-connections/:id/test for pollinations returns the constructed image URL carrying the token',
);

const imgTestUnknownRes = await fetch(`${base}/v1/admin/image-connections/not-a-real-id/test`, {
  method: 'POST',
  headers: { authorization: 'Bearer the-admin-key' },
});
assert(imgTestUnknownRes.status === 404, 'POST /v1/admin/image-connections/:id/test for an unknown id returns 404');

// --- Admin image-settings routes (endpoint.md §2.2, bi_principles.md §18) ---

const imgSettingsNoAuthRes = await fetch(`${base}/v1/admin/image-settings`);
assert(imgSettingsNoAuthRes.status === 401, 'GET /v1/admin/image-settings with no auth header returns 401');

const imgSettingsGetRes = await fetch(`${base}/v1/admin/image-settings`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
const imgSettingsGetBody = await imgSettingsGetRes.json();
assert(
  imgSettingsGetRes.status === 200 && imgSettingsGetBody.templateIsDefault === true,
  'GET /v1/admin/image-settings reports the default (empty template) on first read',
);

const imgSettingsSetRes = await fetch(`${base}/v1/admin/image-settings`, {
  method: 'POST',
  headers: { authorization: 'Bearer the-admin-key', 'content-type': 'application/json' },
  body: JSON.stringify({ template: '{{style_prefix}} {{visual_description}} at {{time_of_day}}' }),
});
const imgSettingsSetBody = await imgSettingsSetRes.json();
assert(
  imgSettingsSetRes.status === 200 && imgSettingsSetBody.template === '{{style_prefix}} {{visual_description}} at {{time_of_day}}' && imgSettingsSetBody.templateIsDefault === false,
  'POST /v1/admin/image-settings persists the template and reports it as non-default',
);

// --- Admin location-render-status route (adminServer.ts getLocationRenderStatus) ---
const rsNoAuthRes = await fetch(`${base}/v1/admin/location-render-status`);
assert(rsNoAuthRes.status === 401, 'GET /v1/admin/location-render-status with no auth header returns 401');

pool.setRenderStatusUsers([{ user_id: 'user-1' }]);
pool.setRenderStatusLocations([
  {
    location_id: 'loc-1',
    name: 'The Tavern',
    status: 'permanent',
    described: true,
    defined: true,
    rendered: true,
    has_render_hash: true,
    image_generated_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  },
]);
const rsRes = await fetch(`${base}/v1/admin/location-render-status`, {
  headers: { authorization: 'Bearer the-admin-key' },
});
const rsBody = await rsRes.json();
assert(
  rsRes.status === 200 &&
    rsBody.locations.length === 1 &&
    rsBody.locations[0].name === 'The Tavern' &&
    rsBody.locations[0].rendered === true &&
    rsBody.locations[0].hasRenderHash === true &&
    rsBody.locations[0].described === true,
  'GET /v1/admin/location-render-status returns the seeded per-stage render booleans',
);

// --- Chat/folder CRUD routes ---
for (const [method, path] of [
  ['GET', '/v1/chats'],
  ['POST', '/v1/chats'],
  ['GET', '/v1/chats/whatever'],
  ['POST', '/v1/chats/whatever'],
  ['DELETE', '/v1/chats/whatever'],
  ['GET', '/v1/folders'],
  ['POST', '/v1/folders'],
]) {
  const res = await fetch(`${base}${path}`, { method });
  assert(res.status === 401, `${method} ${path} with no auth returns 401`);
}

const auth = { authorization: 'Bearer good-key' };
const createChatRes = await fetch(`${base}/v1/chats`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Weekend trip' }),
});
const createdChat = await createChatRes.json();
assert(createChatRes.status === 201 && createdChat.title === 'Weekend trip', 'POST /v1/chats creates a session with the given title');

const listChatsRes = await fetch(`${base}/v1/chats`, { headers: auth });
const listChatsBody = await listChatsRes.json();
assert(
  listChatsRes.status === 200 && listChatsBody.chats.some((c) => c.chatId === createdChat.chatId),
  'GET /v1/chats lists the newly created chat',
);

const getChatRes = await fetch(`${base}/v1/chats/${createdChat.chatId}`, { headers: auth });
const getChatBody = await getChatRes.json();
assert(
  getChatRes.status === 200 && getChatBody.session.chatId === createdChat.chatId && Array.isArray(getChatBody.messages),
  'GET /v1/chats/:id returns the session and its (empty) message list',
);

const updateChatRes = await fetch(`${base}/v1/chats/${createdChat.chatId}`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ params: { system: 'Be terse.' }, tool_names: [] }),
});
const updateChatBody = await updateChatRes.json();
assert(
  updateChatRes.status === 200 && updateChatBody.params.system === 'Be terse.' && Array.isArray(updateChatBody.toolNames),
  'POST /v1/chats/:id updates params and tool_names',
);

const missingChatRes = await fetch(`${base}/v1/chats/does-not-exist`, { headers: auth });
assert(missingChatRes.status === 404, 'GET /v1/chats/:id for an unknown id returns 404');

// --- GET /v1/chats/:id/sync-status: the RP chat header menu's per-chat sync readout ---
// (io/chatSessions.ts getChatSyncStatus behind the route; user-scoped like every other chat
// route, unlike the admin-gated cross-user Review Panel endpoint.)
chats.syncStatusByChat.set(createdChat.chatId, {
  lastAttemptAt: '2026-08-07T12:00:00.000Z',
  lastStatus: 'ok',
  lastStep: null,
  lastError: null,
  lastSuccessAt: '2026-08-07T12:00:00.000Z',
  lastChunksAdded: 2,
  lastEntriesUpdated: 1,
  consecutiveErrors: 0,
  canonProposedCount: 3,
  canonApprovedCount: 2,
  canonLastProposedAt: '2026-08-07T11:00:00.000Z',
});
{
  const res = await fetch(`${base}/v1/chats/${createdChat.chatId}/sync-status`, { headers: auth });
  assert(res.status === 200, 'GET /v1/chats/:id/sync-status returns 200 for an existing chat');
  const body = await res.json();
  assert(body.sync.lastStatus === 'ok' && body.sync.lastChunksAdded === 2, 'the sync payload carries the stored status row');
  assert(
    body.sync.canonProposedCount === 3 && body.sync.canonApprovedCount === 2,
    'the sync payload carries the chat\'s canon fact counts',
  );
  assert(body.sync.unsyncedMessages === 0, 'a chat with no messages has nothing unsynced');
  assert(body.sync.dueAfterMessages === 32, 'dueAfterMessages defaults to (liveWindow+syncEvery pairs) × 2');
}
{
  const res = await fetch(`${base}/v1/chats/does-not-exist/sync-status`, { headers: auth });
  assert(res.status === 404, 'GET /v1/chats/:id/sync-status 404s for a nonexistent chat');
}
{
  // The per-sync inspection route (0079): full record on demand, 404 for a sync that isn't this
  // chat's.
  const syncId = 'sync-1';
  chats.syncInspections.set(syncId, {
    syncId,
    ordinal: 1,
    createdAt: '2026-08-07T12:00:00.000Z',
    lastMessageId: 'msg-1',
    bridgePrompt: 'SYSTEM: [TASK — NARRATIVE CHRONICLER]\n\nTRANSCRIPT:\nUser: hi',
    entries: [{ topicKey: 'scene', content: 'SCENE: A rainy square.', updatedAt: '2026-08-07T12:01:00.000Z' }],
    canonFacts: [],
  });
  const ok = await fetch(`${base}/v1/chats/${createdChat.chatId}/syncs/${syncId}`, { headers: auth });
  assert(ok.status === 200, 'GET /v1/chats/:id/syncs/:syncId returns 200 for the chat\'s own sync');
  const okBody = await ok.json();
  assert(
    okBody.sync.ordinal === 1 && okBody.sync.bridgePrompt.includes('NARRATIVE CHRONICLER'),
    'the inspection payload carries the sync\'s bridge prompt and ordinal',
  );
  assert(
    okBody.sync.entries.length === 1 && okBody.sync.entries[0].topicKey === 'scene',
    'the inspection payload carries the memories that sync created/changed',
  );
  const missing = await fetch(`${base}/v1/chats/${createdChat.chatId}/syncs/not-a-sync`, { headers: auth });
  assert(missing.status === 404, 'GET /v1/chats/:id/syncs/:syncId 404s for a sync that is not this chat\'s');
}
{
  // The two pair-settings are read live by the route, same keys the sync loop itself resolves
  // every tick — a Settings-tab change moves the "when is the next sync due" math with no restart.
  await settings.set('chat_memory_live_window_pairs', '12');
  await settings.set('chat_memory_sync_every_pairs', '4');
  const res = await fetch(`${base}/v1/chats/${createdChat.chatId}/sync-status`, { headers: auth });
  const body = await res.json();
  assert(body.sync.dueAfterMessages === 32, 'dueAfterMessages honors DB-backed settings live (12+4 pairs × 2)');
  // Leave the settings store as the suite found it.
  await settings.set('chat_memory_live_window_pairs', undefined);
  await settings.set('chat_memory_sync_every_pairs', undefined);
}
{
  const res = await fetch(`${base}/v1/chats/${createdChat.chatId}/sync-status`);
  assert(res.status === 401, 'GET /v1/chats/:id/sync-status requires auth');
}

const createFolderRes = await fetch(`${base}/v1/folders`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Travel' }),
});
const createdFolder = await createFolderRes.json();
assert(createFolderRes.status === 201 && createdFolder.name === 'Travel', 'POST /v1/folders creates a folder');

const listFoldersRes = await fetch(`${base}/v1/folders`, { headers: auth });
const listFoldersBody = await listFoldersRes.json();
assert(
  listFoldersRes.status === 200 && listFoldersBody.folders.some((f) => f.folderId === createdFolder.folderId),
  'GET /v1/folders lists the newly created folder',
);

const deleteChatRes = await fetch(`${base}/v1/chats/${createdChat.chatId}`, { method: 'DELETE', headers: auth });
const deleteChatBody = await deleteChatRes.json();
assert(deleteChatRes.status === 200 && deleteChatBody.deleted === true, 'DELETE /v1/chats/:id deletes the chat');

const getDeletedChatRes = await fetch(`${base}/v1/chats/${createdChat.chatId}`, { headers: auth });
assert(getDeletedChatRes.status === 404, 'a deleted chat 404s afterward');

server.close();

// --- Part 4: dynamic model catalog + per-request model override ---
{
  const capturedOptions = [];
  const dynamicLlm = {
    name: 'fake-with-catalog',
    async complete(_messages, _tools, options) {
      capturedOptions.push(options);
      return { message: { role: 'assistant', content: 'ok' }, toolCalls: [] };
    },
    async listModels() {
      return [{ id: 'vendor/model-a' }, { id: 'vendor/model-b' }];
    },
  };
  const db2 = createPostgresClient(createFakePool());
  const apiKeys2 = createApiKeyStore('good-key-2:22222222-2222-2222-2222-222222222222');
  const server2 = startHttpServer({
    llm: dynamicLlm,
    db: db2,
    tools: createToolRegistry([]),
    apiKeys: apiKeys2,
    accessIdentity: createFakeAccessIdentityResolver(),
    chats: createFakeChatSessionStore(),
    adminApiKey: 'unused-in-this-part',
    credentials: createFakeCredentialStore(),
    settings: createFakeSettingsStore(),
    llmConnections: createFakeLlmConnectionStore(),
    imageConnections: createFakeImageConnectionStore(),
    modelName: 'bigbrain',
    port: 0,
  });
  await new Promise((resolve) => server2.once('listening', resolve));
  const base2 = `http://127.0.0.1:${server2.address().port}`;

  const modelsRes2 = await fetch(`${base2}/v1/models`);
  const modelsBody2 = await modelsRes2.json();
  assert(
    modelsBody2.data.length === 2 && modelsBody2.data.some((m) => m.id === 'vendor/model-a'),
    'GET /v1/models returns the live catalog when the provider exposes listModels',
  );

  const withModelRes = await fetch(`${base2}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good-key-2' },
    body: JSON.stringify({ model: 'vendor/model-a', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const withModelBody = await withModelRes.json();
  assert(
    capturedOptions[0]?.model === 'vendor/model-a',
    'a request-specified model is passed through to llm.complete() as options.model',
  );
  assert(
    withModelBody.model === 'vendor/model-a',
    'the response echoes back the request-specified model, not the fixed modelName',
  );

  const withoutModelRes = await fetch(`${base2}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good-key-2' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  const withoutModelBody = await withoutModelRes.json();
  assert(
    capturedOptions[1]?.model === undefined,
    'omitting model in the request leaves options.model unset so the provider default applies',
  );
  assert(
    withoutModelBody.model === 'bigbrain',
    'the response falls back to the fixed modelName label when no model was requested',
  );

  server2.close();
}

// --- Part 5: chat_id ties a turn to a persisted session — its params/tools apply, exchange is stored ---
{
  const capturedCalls = [];
  const capturingLlm = {
    name: 'capturing',
    async complete(messages, toolDefs) {
      capturedCalls.push({ messages, toolDefs });
      return { message: { role: 'assistant', content: 'terse reply' }, toolCalls: [] };
    },
  };
  const db3 = createPostgresClient(createFakePool());
  const apiKeys3 = createApiKeyStore('good-key-3:33333333-3333-3333-3333-333333333333');
  const chats3 = createFakeChatSessionStore();
  const tools3 = createToolRegistry([echoTool]);
  const server3 = startHttpServer({
    llm: capturingLlm,
    db: db3,
    tools: tools3,
    apiKeys: apiKeys3,
    accessIdentity: createFakeAccessIdentityResolver(),
    chats: chats3,
    adminApiKey: 'unused-in-this-part',
    credentials: createFakeCredentialStore(),
    settings: createFakeSettingsStore(),
    // A chat's own params.profile override (below) names this connection by its name, resolved via
    // resolveByName — same shape as the boot-time active connection, just a different row.
    llmConnections: createFakeLlmConnectionStore([
      {
        id: 'conn-openrouter-3',
        name: 'openrouter',
        kind: 'openai-compatible',
        model: 'google/gemini-3.5-flash-lite',
        apiKey: 'sk-test-openrouter',
        baseUrl: 'https://example.invalid/openrouter',
        supportsVision: false,
        providerOrder: null,
        allowFallbacks: true,
        quantizations: null,
        isActive: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
    imageConnections: createFakeImageConnectionStore(),
    modelName: 'bigbrain',
    port: 0,
  });
  await new Promise((resolve) => server3.once('listening', resolve));
  const base3 = `http://127.0.0.1:${server3.address().port}`;
  const userId3 = '33333333-3333-3333-3333-333333333333';

  const chat = await chats3.createChat(userId3, {});
  await chats3.updateChat(userId3, chat.chatId, {
    params: { system: 'Be terse.', temperature: 0.3 },
    toolNames: [], // no tools allowed in this chat
  });

  const missingChatIdRes = await fetch(`${base3}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good-key-3' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello there' }], chat_id: 'no-such-chat' }),
  });
  assert(missingChatIdRes.status === 404, 'chat_id pointing at an unknown/inaccessible chat returns 404');

  const chatRes = await fetch(`${base3}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good-key-3' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello there' }], chat_id: chat.chatId }),
  });
  assert(chatRes.status === 200, 'a request with a valid chat_id succeeds');

  const call = capturedCalls[0];
  assert(
    call.messages[0].role === 'system' &&
      call.messages[0].content.startsWith('Today is') &&
      call.messages[0].content.endsWith('Be terse.'),
    "a current-date line is prepended ahead of the chat's own system prompt param, joined by a blank line",
  );
  assert(call.toolDefs.length === 0, "the chat's empty tool_names allow-list actually restricts what the model is offered (echo_tool exists but isn't sent)");

  const detail = await chats3.getChat(userId3, chat.chatId);
  assert(detail.messages.length === 2, 'both the user message and the reply were persisted');
  assert(
    detail.messages[0].role === 'user' && detail.messages[0].content === 'hello there' && detail.messages[1].content === 'terse reply',
    'persisted messages have the right role/content and order',
  );
  // Title generation is deliberately async now (httpServer.ts — a second LLM round-trip must
  // not hold up the reply), so the first exchange's auto-title lands in the background. Wait
  // for it before asserting, with a short timeout so a genuinely missing title fails loudly
  // rather than hanging the suite.
  const titleDeadline = Date.now() + 2000;
  let titled = detail;
  while (titled.session.title === 'New chat' && Date.now() < titleDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    titled = await chats3.getChat(userId3, chat.chatId);
  }
  assert(titled.session.title === 'hello there', "an untitled chat's first exchange auto-titles it from the user's message");

  const withoutChatIdRes = await fetch(`${base3}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good-key-3' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'no session here' }] }),
  });
  assert(withoutChatIdRes.status === 200, 'a request with no chat_id still works (Open WebUI-style stateless traffic)');
  const detailAfter = await chats3.getChat(userId3, chat.chatId);
  assert(detailAfter.messages.length === 2, 'a stateless request (no chat_id) does not touch any persisted session');

  // index 1 is generateChatTitle's own llm.complete() call, fired by the previous request's
  // first-exchange auto-titling (chat.chatId's session was still untitled) — the stateless
  // request's own turn is the one after that.
  const statelessCall = capturedCalls[2];
  assert(
    statelessCall.messages[0].role === 'system' && statelessCall.messages[0].content.startsWith('Today is'),
    'the date-context line is prepended even for a request with no chat_id and no custom system prompt at all',
  );

  // --- Message delete/truncate routes, and edit/rerun's dedup logic ---
  const auth3 = { authorization: 'Bearer good-key-3' };
  const chat2 = await chats3.createChat(userId3, {});
  await chats3.appendMessages(userId3, chat2.chatId, [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ]);
  const seeded = await chats3.getChat(userId3, chat2.chatId);
  const [seededUser, seededAssistant] = seeded.messages;

  const deleteMsgNoAuthRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${seededAssistant.messageId}`, {
    method: 'DELETE',
  });
  assert(deleteMsgNoAuthRes.status === 401, 'DELETE /v1/chats/:id/messages/:messageId with no auth returns 401');

  const deleteMsgUnknownRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/no-such-id`, {
    method: 'DELETE',
    headers: auth3,
  });
  assert(deleteMsgUnknownRes.status === 404, 'DELETE for an unknown message id returns 404');

  const deleteMsgOkRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${seededAssistant.messageId}`, {
    method: 'DELETE',
    headers: auth3,
  });
  const deleteMsgOkBody = await deleteMsgOkRes.json();
  assert(
    deleteMsgOkRes.status === 200 && deleteMsgOkBody.deleted === true,
    'DELETE /v1/chats/:id/messages/:messageId removes the message and returns 200',
  );
  const afterDeleteMsg = await chats3.getChat(userId3, chat2.chatId);
  assert(
    afterDeleteMsg.messages.length === 1 && afterDeleteMsg.messages[0].messageId === seededUser.messageId,
    'exactly the targeted message is gone, the rest of the chat is untouched',
  );

  // Re-seed a second exchange to prove truncate removes everything chronologically after the
  // target, not just the target itself.
  await chats3.appendMessages(userId3, chat2.chatId, [{ role: 'assistant', content: 'first answer again' }]);
  await chats3.appendMessages(userId3, chat2.chatId, [
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'second answer' },
  ]);
  const seeded2 = await chats3.getChat(userId3, chat2.chatId);
  const [u1, a1, u2] = seeded2.messages;

  const truncateNoAuthRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${u2.messageId}/truncate`, { method: 'POST' });
  assert(truncateNoAuthRes.status === 401, 'POST .../truncate with no auth returns 401');

  const truncateUnknownRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/no-such-id/truncate`, {
    method: 'POST',
    headers: auth3,
  });
  assert(truncateUnknownRes.status === 404, 'POST .../truncate for an unknown message id returns 404');

  const truncateOkRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${u2.messageId}/truncate`, {
    method: 'POST',
    headers: auth3,
  });
  const truncateOkBody = await truncateOkRes.json();
  assert(
    truncateOkRes.status === 200 && truncateOkBody.truncated === true,
    'POST .../truncate removes the message and everything after it, returns 200',
  );
  const afterTruncate = await chats3.getChat(userId3, chat2.chatId);
  assert(
    afterTruncate.messages.length === 2 &&
      afterTruncate.messages[0].messageId === u1.messageId &&
      afterTruncate.messages[1].messageId === a1.messageId,
    'truncating from the second question removes it and its answer, leaving only the first exchange',
  );

  // "rerun": truncate the last assistant reply, then resend the identical (now-shorter) history —
  // must NOT duplicate the user message that's already persisted.
  const rerunTruncateRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${a1.messageId}/truncate`, {
    method: 'POST',
    headers: auth3,
  });
  assert(rerunTruncateRes.status === 200, 'truncating the assistant reply to rerun it succeeds');
  const rerunHistory = await chats3.getChat(userId3, chat2.chatId);
  assert(rerunHistory.messages.length === 1, 'only the user message remains after truncating the reply being rerun');

  const rerunRes = await fetch(`${base3}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth3, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'first question' }], chat_id: chat2.chatId }),
  });
  assert(rerunRes.status === 200, 'the rerun-style resend succeeds');
  const afterRerun = await chats3.getChat(userId3, chat2.chatId);
  assert(
    afterRerun.messages.length === 2 && afterRerun.messages[0].content === 'first question' && afterRerun.messages[1].role === 'assistant',
    'a rerun resend (same message count as already persisted) appends only the new assistant reply, not a duplicate user message',
  );

  // "edit": truncate from the message being edited, then resend with new content plus one more
  // message than what's now persisted — a genuinely new turn, so both rows insert.
  const editTruncateRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${afterRerun.messages[0].messageId}/truncate`, {
    method: 'POST',
    headers: auth3,
  });
  assert(editTruncateRes.status === 200, 'truncating from the message being edited succeeds');
  const editHistory = await chats3.getChat(userId3, chat2.chatId);
  assert(editHistory.messages.length === 0, 'truncating from the very first message empties the chat');

  const editRes = await fetch(`${base3}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth3, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'first question, edited' }], chat_id: chat2.chatId }),
  });
  assert(editRes.status === 200, 'the edit-style resend succeeds');
  const afterEdit = await chats3.getChat(userId3, chat2.chatId);
  assert(
    afterEdit.messages.length === 2 && afterEdit.messages[0].content === 'first question, edited' && afterEdit.messages[1].role === 'assistant',
    'an edit resend (one more message than already persisted) appends both the edited user message and the new reply',
  );

  // "edit an LLM reply": POST .../edit rewrites the message's text in place — same message_id,
  // the pre-edit text preserved as a swipe, everything else in the conversation untouched.
  const editReplyNoAuthRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${afterEdit.messages[1].messageId}/edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'rewritten' }),
  });
  assert(editReplyNoAuthRes.status === 401, 'POST .../edit with no auth returns 401');

  const editReplyBadBodyRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${afterEdit.messages[1].messageId}/edit`, {
    method: 'POST',
    headers: { ...auth3, 'content-type': 'application/json' },
    body: JSON.stringify({ content: '   ' }),
  });
  assert(editReplyBadBodyRes.status === 400, 'POST .../edit with empty content returns 400');

  const editReplyUnknownRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/no-such-id/edit`, {
    method: 'POST',
    headers: { ...auth3, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'rewritten' }),
  });
  assert(editReplyUnknownRes.status === 404, 'POST .../edit for an unknown message id returns 404');

  const editReplyRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${afterEdit.messages[1].messageId}/edit`, {
    method: 'POST',
    headers: { ...auth3, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'reply, rewritten in place' }),
  });
  assert(editReplyRes.status === 200, 'POST .../edit succeeds');
  const editReplyBody = await editReplyRes.json();
  assert(
    editReplyBody.message &&
      editReplyBody.message.messageId === afterEdit.messages[1].messageId &&
      editReplyBody.message.content === 'reply, rewritten in place',
    '.../edit returns the rewritten message under its original message_id',
  );
  assert(
    editReplyBody.message.swipes && editReplyBody.message.swipes.count === 2 && editReplyBody.message.swipes.index === 1,
    'the pre-edit reply text is preserved as swipe #0 and the rewritten text is the active swipe',
  );
  const afterEditReply = await chats3.getChat(userId3, chat2.chatId);
  assert(
    afterEditReply.messages.length === 2 &&
      afterEditReply.messages[0].content === 'first question, edited' &&
      afterEditReply.messages[1].content === 'reply, rewritten in place',
    'an in-place edit rewrites the reply and leaves the conversation (including the user message before it) untouched',
  );

  // An identical-text edit is a no-op — it must not mint a junk swipe.
  const noopEditRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${afterEdit.messages[1].messageId}/edit`, {
    method: 'POST',
    headers: { ...auth3, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'reply, rewritten in place' }),
  });
  assert(noopEditRes.status === 200, 'POST .../edit with identical content succeeds as a no-op');
  const noopEditBody = await noopEditRes.json();
  assert(
    noopEditBody.message && noopEditBody.message.content === 'reply, rewritten in place',
    'the no-op edit response carries the unchanged message',
  );
  assert(
    (chats3.swipesByMessage.get(afterEdit.messages[1].messageId) ?? []).length === 2,
    'an identical-text edit does not mint a junk swipe',
  );

  // Editing a mid-conversation reply must not truncate anything after it (unlike the user-edit
  // flow) — the rewrite is purely in place, no "must be the last message" restriction.
  await chats3.appendMessages(userId3, chat2.chatId, [
    { role: 'user', content: 'third question' },
    { role: 'assistant', content: 'third answer' },
  ]);
  const withThird = await chats3.getChat(userId3, chat2.chatId);
  const midEditRes = await fetch(`${base3}/v1/chats/${chat2.chatId}/messages/${withThird.messages[1].messageId}/edit`, {
    method: 'POST',
    headers: { ...auth3, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'reply, edited mid-conversation' }),
  });
  assert(midEditRes.status === 200, 'POST .../edit on a mid-conversation reply succeeds');
  const afterMidEdit = await chats3.getChat(userId3, chat2.chatId);
  assert(
    afterMidEdit.messages.length === 4 &&
      afterMidEdit.messages[1].content === 'reply, edited mid-conversation' &&
      afterMidEdit.messages[2].content === 'third question' &&
      afterMidEdit.messages[3].content === 'third answer',
    'editing a mid-conversation reply leaves everything after it untouched (no truncation)',
  );

  // --- A chat's own profile override swaps in a throwaway provider for that turn, no restart ---
  const originalFetch3 = globalThis.fetch;
  const capturedProfileCalls = [];
  globalThis.fetch = async (url, init) => {
    if (url !== 'https://example.invalid/openrouter/chat/completions') return originalFetch3(url, init);
    capturedProfileCalls.push({ url, authorization: init.headers.authorization });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'from openrouter' } }] }),
      text: async () => '',
    };
  };
  try {
    const profileChat = await chats3.createChat(userId3, {});
    // title set away from the default so the auto-titling call (also routed through turnLlm) doesn't
    // fire and muddy capturedProfileCalls — that behavior is already covered in Part 5 above.
    await chats3.updateChat(userId3, profileChat.chatId, { params: { profile: 'openrouter' }, title: 'Already named' });

    const profileRes = await fetch(`${base3}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth3, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'which connection is this' }], chat_id: profileChat.chatId }),
    });
    const profileBody = await profileRes.json();
    assert(profileRes.status === 200, "a chat_id whose params name a valid profile still succeeds");
    assert(
      capturedProfileCalls.length === 1 && capturedProfileCalls[0].authorization === 'Bearer sk-test-openrouter',
      "the turn was routed through the chat's overridden profile (openrouter), not the boot-time llm",
    );
    assert(
      profileBody.choices[0].message.content === 'from openrouter',
      "the reply came back from the overridden connection's own response",
    );
    assert(
      profileBody.model === 'google/gemini-3.5-flash-lite',
      "the echoed model falls back to the overridden profile's own default model, not the boot-time modelName",
    );

    const capturedCallsBefore = capturedCalls.length;
    const unknownProfileChat = await chats3.createChat(userId3, {});
    await chats3.updateChat(userId3, unknownProfileChat.chatId, {
      params: { profile: 'not-a-real-profile' },
      title: 'Already named',
    });
    const unknownProfileRes = await fetch(`${base3}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth3, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], chat_id: unknownProfileChat.chatId }),
    });
    assert(unknownProfileRes.status === 200, 'a chat_id naming an unknown profile still succeeds (falls back, does not fail the turn)');
    assert(
      capturedCalls.length === capturedCallsBefore + 1 && capturedProfileCalls.length === 1,
      'an unknown profile override falls back to the boot-time llm rather than throwing or hitting any provider',
    );
  } finally {
    globalThis.fetch = originalFetch3;
  }

  server3.close();
}

// --- Part 5b: docs/prompt-macros.md's Stage 1 — {{...}} macros resolved fresh every turn ---
{
  const capturedRp = [];
  const capturingLlmRp = {
    name: 'capturing-rp',
    async complete(messages, toolDefs) {
      capturedRp.push({ messages, toolDefs });
      return { message: { role: 'assistant', content: 'reply' }, toolCalls: [] };
    },
  };
  const poolRp = createFakePool();
  const dbRp = createPostgresClient(poolRp);
  const settingsRp = createFakeSettingsStore();
  const chatsRp = createFakeChatSessionStore();
  const apiKeysRp = createApiKeyStore('good-key-rp:66666666-6666-6666-6666-666666666666');
  const userIdRp = '66666666-6666-6666-6666-666666666666';
  const serverRp = startHttpServer({
    llm: capturingLlmRp,
    db: dbRp,
    tools: createToolRegistry([echoTool]),
    apiKeys: apiKeysRp,
    accessIdentity: createFakeAccessIdentityResolver(),
    chats: chatsRp,
    adminApiKey: 'unused-in-this-part',
    credentials: createFakeCredentialStore(),
    settings: settingsRp,
    llmConnections: createFakeLlmConnectionStore(),
    imageConnections: createFakeImageConnectionStore(),
    modelName: 'bigbrain',
    port: 0,
  });
  await new Promise((resolve) => serverRp.once('listening', resolve));
  const baseRp = `http://127.0.0.1:${serverRp.address().port}`;
  const authRp = { authorization: 'Bearer good-key-rp' };

  poolRp.characters.push(
    { character_id: 'char-ava', user_id: userIdRp, name: 'Ava', persona: 'A grizzled tavern keeper.', scenario: 'A dusty roadside inn.' },
    { character_id: 'char-kess', user_id: userIdRp, name: 'Kess', persona: 'A wandering bard.', scenario: 'A moonlit forest camp.' },
  );
  await settingsRp.set('persona_name', 'Jeremy');
  await settingsRp.set('persona_description', 'A traveling merchant.');

  const macroTemplate =
    '{{char}} lives with {{user}}. {{persona}} {{description}} set in {{scenario}}. {{noop}}gone{{newline}}{{reverse::cba}}zzz{{trim}}   padded {{getvar::x}}';

  const rpChat = await chatsRp.createChat(userIdRp, {});
  await chatsRp.updateChat(userIdRp, rpChat.chatId, { kind: 'rp', characterId: 'char-ava', params: { system: macroTemplate } });

  // A chat's first exchange also fires generateChatTitle's own llm.complete() call (same instance,
  // Part 5's own note above) — capturedRp.length is snapshotted before each request rather than
  // hardcoding indices, so this suite doesn't have to hand-count how many extra calls each
  // first-exchange auto-title adds.
  let before = capturedRp.length;
  const rpRes = await fetch(`${baseRp}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authRp, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], chat_id: rpChat.chatId }),
  });
  assert(rpRes.status === 200, 'an RP chat with macro tokens in its system prompt succeeds');
  const rpSystem = capturedRp[before].messages[0].content;
  assert(rpSystem.includes('Ava lives with Jeremy.'), '{{char}} and {{user}} resolve to the linked character and household persona names');
  assert(rpSystem.includes('Jeremy: A traveling merchant.'), '{{persona}} resolves to the composed household persona');
  assert(rpSystem.includes('A grizzled tavern keeper.'), '{{description}} resolves to the linked character.persona field');
  assert(rpSystem.includes('set in A dusty roadside inn.'), '{{scenario}} resolves to the linked character.scenario field');
  assert(rpSystem.includes('gone\nabczzzpadded'), '{{noop}}/{{newline}}/{{reverse::cba}}/{{trim}} all resolve/collapse correctly in sequence');
  assert(rpSystem.includes('{{getvar::x}}'), 'an unrecognized macro token (a not-yet-built Stage 3 one) passes through unchanged rather than being deleted');

  // --- Staleness fix: a persona edit takes effect on the very next turn, no re-apply ---
  await settingsRp.set('persona_name', 'Sam');
  before = capturedRp.length;
  const rpRes2 = await fetch(`${baseRp}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authRp, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi again' }], chat_id: rpChat.chatId }),
  });
  assert(rpRes2.status === 200, 'a second turn on the same chat succeeds');
  const rpSystem2 = capturedRp[before].messages[0].content;
  assert(
    rpSystem2.includes('Ava lives with Sam.'),
    'a persona_name change is reflected on the very next turn with no re-apply — params.system itself was never rewritten between turns',
  );

  // --- Per-character correctness: {{char}} resolves to *this* chat's own linked character ---
  const rpChat2 = await chatsRp.createChat(userIdRp, {});
  await chatsRp.updateChat(userIdRp, rpChat2.chatId, { kind: 'rp', characterId: 'char-kess', params: { system: '{{char}} says hello.' } });
  before = capturedRp.length;
  const rpRes3 = await fetch(`${baseRp}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authRp, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], chat_id: rpChat2.chatId }),
  });
  assert(rpRes3.status === 200, 'a second RP chat, linked to a different character, succeeds');
  const rpSystem3 = capturedRp[before].messages[0].content;
  assert(
    rpSystem3.includes('Kess says hello.') && !rpSystem3.includes('Ava'),
    "{{char}} resolves per chat's own linked character, not a value shared across chats/characters",
  );

  // --- Scope guard: a non-'rp' chat's literal {{...}}-looking text is left alone ---
  const plainChat = await chatsRp.createChat(userIdRp, {});
  await chatsRp.updateChat(userIdRp, plainChat.chatId, { params: { system: 'Explain what {{char}} means in templating syntax.' } });
  before = capturedRp.length;
  const plainRes = await fetch(`${baseRp}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authRp, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], chat_id: plainChat.chatId }),
  });
  assert(plainRes.status === 200, "a 'chat'-kind session with literal {{...}}-looking text succeeds");
  const plainSystem = capturedRp[before].messages[0].content;
  assert(
    plainSystem.includes('{{char}} means in templating syntax'),
    "a 'chat'-kind (non-RP) session's system prompt is never scanned for macros — literal {{...}} text a household member typed stays untouched",
  );

  // --- Message-history resolution: a stored greeting's {{user}} resolves at turn time too ---
  // apply_character_to_chat/apply_prompt_stack_to_chat seed a character's first_mes verbatim into
  // chat_messages, and the frontend re-sends the full history each turn — so without this pass the
  // literal {{user}} (which ST cards put in greetings more than anywhere else) reached the LLM.
  {
    // The original Stage-1 tests above left persona_name at 'Sam' (their own staleness check) —
    // this block sets its own baseline so the assertions don't depend on earlier sub-tests' state.
    await settingsRp.set('persona_name', 'Jeremy');
    const greetingChat = await chatsRp.createChat(userIdRp, {});
    await chatsRp.updateChat(userIdRp, greetingChat.chatId, {
      kind: 'rp',
      characterId: 'char-ava',
      params: { system: '{{user}} is here.' },
    });
    const greeting = '{{user}}, welcome to my tavern!';
    await chatsRp.appendMessages(userIdRp, greetingChat.chatId, [{ role: 'assistant', content: greeting }]);

    const sendTurn = async () => {
      before = capturedRp.length;
      const res = await fetch(`${baseRp}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...authRp, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'assistant', content: greeting },
            { role: 'user', content: 'hi' },
          ],
          chat_id: greetingChat.chatId,
        }),
      });
      assert(res.status === 200, 'an RP chat whose stored greeting contains {{user}} succeeds');
      return capturedRp[before].messages;
    };

    let sent = await sendTurn();
    const greetingSent = sent.find((m) => m.role === 'assistant')?.content ?? '';
    assert(
      greetingSent.includes('Jeremy, welcome to my tavern!') && !greetingSent.includes('{{user}}'),
      'a stored greeting containing {{user}} resolves to the persona name in the history sent to the LLM',
    );

    // Same staleness guarantee as the system prompt: a persona edit re-resolves the greeting on
    // the very next turn, no re-apply.
    await settingsRp.set('persona_name', 'Sam');
    sent = await sendTurn();
    const greetingSent2 = sent.find((m) => m.role === 'assistant')?.content ?? '';
    assert(
      greetingSent2.includes('Sam, welcome to my tavern!'),
      'a persona_name change re-resolves the stored greeting on the very next turn',
    );
    await settingsRp.set('persona_name', 'Jeremy');

    // Display side: GET /v1/chats/:id carries the resolved copy as resolvedContent while the
    // canonical content stays verbatim (the client re-sends content, keeping resolution fresh).
    const detail = await (await fetch(`${baseRp}/v1/chats/${greetingChat.chatId}`, { headers: authRp })).json();
    const stored = detail.messages[0];
    assert(stored.content === greeting, 'the canonical stored greeting stays verbatim in GET /v1/chats/:id');
    assert(
      stored.resolvedContent === 'Jeremy, welcome to my tavern!',
      'GET /v1/chats/:id attaches the display-resolved copy as resolvedContent',
    );

    // And a 'chat'-kind chat's message history is never scanned, same scope guard as its system prompt.
    const plainChat2 = await chatsRp.createChat(userIdRp, {});
    const plainGreeting = 'Explain {{user}} as a template token, please.';
    await chatsRp.appendMessages(userIdRp, plainChat2.chatId, [{ role: 'assistant', content: plainGreeting }]);
    before = capturedRp.length;
    const plainRes2 = await fetch(`${baseRp}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...authRp, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'assistant', content: plainGreeting },
          { role: 'user', content: 'hi' },
        ],
        chat_id: plainChat2.chatId,
      }),
    });
    assert(plainRes2.status === 200, "a 'chat'-kind session with literal {{...}}-looking history succeeds");
    const plainSent = capturedRp[before].messages;
    assert(
      plainSent.some((m) => m.content.includes(plainGreeting)),
      "a 'chat'-kind session's message history is never scanned for macros — literal {{...}} text stays untouched",
    );
    const plainDetail = await (await fetch(`${baseRp}/v1/chats/${plainChat2.chatId}`, { headers: authRp })).json();
    assert(
      plainDetail.messages[0].resolvedContent === undefined,
      "a 'chat'-kind chat's GET response carries no resolvedContent — only 'rp' chats get display resolution",
    );
  }

  // --- Message-history resolution on the narrator path too (an RP chat with an applied preset) ---
  // assembleSessionTurnContext's 'rp' + preset branch (per-turn narrator assembly) must resolve
  // history macros the same way the legacy branch does — same snapshot, same gating.
  {
    poolRp.characters.push({
      character_id: 'char-lyn',
      user_id: userIdRp,
      name: 'Lyn',
      system_prompt: 'You are Lyn, a forest guide. {{user}} hired you.',
      persona: 'A quiet woods-woman.',
      scenario: 'A foggy forest trail.',
    });
    poolRp.slotsByPreset.set('preset-narr', [
      { slot_type: 'marker', marker_key: 'system', enabled: true, custom_role: null, custom_content: null, label: null },
      { slot_type: 'marker', marker_key: 'scenario', enabled: true, custom_role: null, custom_content: null, label: null },
      { slot_type: 'custom', marker_key: null, enabled: true, custom_role: 'system', custom_content: '{{user}} is the employer.', label: null },
    ]);
    const narrChat = await chatsRp.createChat(userIdRp, { kind: 'rp' });
    await chatsRp.updateChat(userIdRp, narrChat.chatId, {
      kind: 'rp',
      characterId: 'char-lyn',
      promptStackPresetId: 'preset-narr',
      params: { system: 'stale baked copy — the narrator path must ignore this' },
    });
    const narrGreeting = '{{user}}, the trail is wet today.';
    await chatsRp.appendMessages(userIdRp, narrChat.chatId, [{ role: 'assistant', content: narrGreeting }]);
    before = capturedRp.length;
    const narrRes = await fetch(`${baseRp}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...authRp, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'assistant', content: narrGreeting },
          { role: 'user', content: 'lead on' },
        ],
        chat_id: narrChat.chatId,
      }),
    });
    assert(narrRes.status === 200, 'an RP chat with an applied preset and a macro-bearing greeting succeeds');
    const narrSent = capturedRp[before].messages;
    const narrSystem = narrSent[0].content;
    assert(
      narrSystem.includes('Lyn, a forest guide') && narrSystem.includes('Jeremy hired you') && narrSystem.includes('Jeremy is the employer'),
      'narrator path: {{user}}/{{char}} resolve inside the per-turn assembled system prompt slots',
    );
    const narrGreetingSent = narrSent.find((m) => m.role === 'assistant')?.content ?? '';
    assert(
      narrGreetingSent.includes('Jeremy, the trail is wet today.') && !narrGreetingSent.includes('{{user}}'),
      'narrator path: a stored greeting containing {{user}} resolves in the history sent to the LLM',
    );
  }

  // --- recent_history as a LIVE marker: the active context moves into the stack ---
  // A preset that enables + orders the recent_history slot (the user's Comfy 2 arrangement:
  // wrapped in its own HTML tags) must render the live-window turns inside the system prompt and
  // NOT append them as messages afterwards — the stack alone carries the context (2026-08-10 user
  // direction: "I do not want the messages appended at the end" / "send it as it is"). The real
  // LLM adapters then emit a single empty user turn to keep the request shape valid.
  {
    poolRp.slotsByPreset.set('preset-recent', [
      { slot_type: 'marker', marker_key: 'system', enabled: true, custom_role: null, custom_content: null, label: null },
      { slot_type: 'marker', marker_key: 'scenario', enabled: true, custom_role: null, custom_content: null, label: null },
      { slot_type: 'custom', marker_key: null, enabled: true, custom_role: 'system', custom_content: '<narrative_execution>', label: null },
      { slot_type: 'marker', marker_key: 'recent_history', enabled: true, custom_role: null, custom_content: null, label: null },
      { slot_type: 'custom', marker_key: null, enabled: true, custom_role: 'system', custom_content: '</narrative_execution>', label: null },
    ]);
    const recentChat = await chatsRp.createChat(userIdRp, { kind: 'rp' });
    await chatsRp.updateChat(userIdRp, recentChat.chatId, {
      kind: 'rp',
      characterId: 'char-ava',
      promptStackPresetId: 'preset-recent',
    });
    const recentGreeting = 'The fog is lifting.';
    await chatsRp.appendMessages(userIdRp, recentChat.chatId, [{ role: 'assistant', content: recentGreeting }]);
    before = capturedRp.length;
    const recentRes = await fetch(`${baseRp}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...authRp, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'assistant', content: recentGreeting },
          { role: 'user', content: 'show me the way' },
        ],
        chat_id: recentChat.chatId,
      }),
    });
    assert(recentRes.status === 200, 'an RP chat whose preset wraps recent_history in its own tags succeeds');
    const recentSent = capturedRp[before].messages;
    // runTurn appends the provider's reply to the same array after capture, so the last message
    // is the fake's 'reply' — the point is that none of the live-window turns ride along.
    assert(
      recentSent[0]?.role === 'system' && !recentSent.some((m) => m.role === 'user'),
      'when recent_history renders, the live-window turns are NOT appended as messages — the system stack alone carries them',
    );
    const recentSystem = recentSent[0].content;
    assert(
      recentSystem.includes('<narrative_execution>') &&
        recentSystem.includes('Ava: The fog is lifting.') &&
        recentSystem.includes('Jeremy: show me the way') &&
        recentSystem.includes('</narrative_execution>'),
      'the live-window turns (last sent turn included) render inside the preset\'s own <narrative_execution> tags, per-speaker',
    );
  }

  // --- Slot groups (migration 0086): a contiguous run sharing group_name gets one tag pair ---
  // assemblePromptStack's groupRuns/groupTagsForRendered wrap the run's first/last RENDERED member
  // in <Name>…</Name>. buildNarratorStackItems (the per-turn narrator path) must load group_name
  // from context_stack_slots — it was missing from loadPromptStackSlots's SELECT/mapping, so
  // grouped slots silently lost their tags in the real fired prompt AND the prompt inspector.
  // Regression: the fired system prompt and the prompt-preview's captured Main Prompt both carry
  // the group tags.
  {
    poolRp.slotsByPreset.set('preset-group', [
      { slot_type: 'marker', marker_key: 'system', enabled: true, custom_role: null, custom_content: null, label: null, group_name: null },
      { slot_type: 'custom', marker_key: null, enabled: true, custom_role: 'system', custom_content: 'The world has three moons.', label: null, group_name: 'World Info' },
      { slot_type: 'custom', marker_key: null, enabled: true, custom_role: 'system', custom_content: 'Dragons are extinct.', label: null, group_name: 'World Info' },
    ]);
    const groupChat = await chatsRp.createChat(userIdRp, { kind: 'rp' });
    // Same fake-store id reuse caveat as Part 5c: earlier parts may have left a 'main' trace for
    // this chatId, which would make the preview show stale captured text instead of this turn's.
    clearPromptTrace(groupChat.chatId);
    await chatsRp.updateChat(userIdRp, groupChat.chatId, {
      kind: 'rp',
      characterId: 'char-ava',
      promptStackPresetId: 'preset-group',
    });
    const groupGreeting = 'The old maps are wrong.';
    await chatsRp.appendMessages(userIdRp, groupChat.chatId, [{ role: 'assistant', content: groupGreeting }]);
    before = capturedRp.length;
    const groupRes = await fetch(`${baseRp}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...authRp, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'assistant', content: groupGreeting },
          { role: 'user', content: 'what changed?' },
        ],
        chat_id: groupChat.chatId,
      }),
    });
    assert(groupRes.status === 200, 'an RP chat whose preset groups contiguous slots succeeds');
    const groupSent = capturedRp[before].messages;
    const groupSystem = groupSent[0]?.content ?? '';
    assert(
      groupSystem.includes('<World Info>') &&
        groupSystem.includes('The world has three moons.') &&
        groupSystem.includes('Dragons are extinct.') &&
        groupSystem.includes('</World Info>') &&
        groupSystem.indexOf('<World Info>') < groupSystem.indexOf('The world has three moons.') &&
        groupSystem.indexOf('</World Info>') > groupSystem.indexOf('Dragons are extinct.'),
      "narrator path: grouped slots render one <World Info>…</World Info> pair around the run's rendered content",
    );
    // The Prompt Inspector's captured Main Prompt is that same fired text — group tags included.
    const groupPreviewRes = await fetch(`${baseRp}/v1/chats/${groupChat.chatId}/prompt-preview`, { headers: authRp });
    const groupPreview = await groupPreviewRes.json();
    const groupMain = groupPreview.groups[0];
    assert(
      groupMain.kind === 'main' &&
        groupMain.captured === true &&
        groupMain.items.some((i) => i.content.includes('<World Info>') && i.content.includes('</World Info>')),
      'prompt-preview: the captured Main Prompt group carries the group tags',
    );
  }

  // --- The RP lane runs with NO tools at all (2026-08-10 user direction) ---
  // Whatever tool_names the session row carries (the legacy recall pair, null = all registered
  // tools, anything), an rp turn's LLM call must never receive a tool manifest — the model just
  // executes its prompt stack and can't create characters or call anything else. The worst case
  // here is toolNames: null (= all tools, the pre-allow-list behavior): the server's rp override
  // still has to collapse it to an empty registry.
  {
    const noToolsChat = await chatsRp.createChat(userIdRp, { kind: 'rp' });
    await chatsRp.updateChat(userIdRp, noToolsChat.chatId, {
      kind: 'rp',
      characterId: 'char-ava',
      toolNames: null, // the worst case: null = all registered tools
    });
    await chatsRp.appendMessages(userIdRp, noToolsChat.chatId, [{ role: 'assistant', content: 'Hello.' }]);
    before = capturedRp.length;
    const noToolsRes = await fetch(`${baseRp}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...authRp, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'go on' }],
        chat_id: noToolsChat.chatId,
      }),
    });
    assert(noToolsRes.status === 200, 'an rp chat with toolNames null (all tools) still succeeds');
    assert(
      Array.isArray(capturedRp[before].toolDefs) && capturedRp[before].toolDefs.length === 0,
      "the rp turn's LLM call carries zero tool definitions even when the session row allows all tools",
    );
  }

  // --- Swipe display decoration: alternate greetings carry resolvedContent too ---
  // The swipe routes return one message the client swaps into view in place (a card's alternate
  // greetings load in as that opening message's swipe history), so its display copy is resolved
  // against the live persona the same way GET /v1/chats/:id does.
  {
    const swipeChat = await chatsRp.createChat(userIdRp, { kind: 'rp' });
    await chatsRp.updateChat(userIdRp, swipeChat.chatId, { kind: 'rp', characterId: 'char-ava' });
    const greeting1 = '{{user}}, welcome to my tavern!';
    const greeting2 = '{{user}}, you again!';
    const [seeded] = await chatsRp.appendMessages(userIdRp, swipeChat.chatId, [{ role: 'assistant', content: greeting1 }]);
    chatsRp.swipesByMessage.set(seeded.messageId, [greeting1, greeting2]);
    const swipeRes = await fetch(`${baseRp}/v1/chats/${swipeChat.chatId}/messages/${seeded.messageId}/swipe`, {
      method: 'POST',
      headers: { ...authRp, 'content-type': 'application/json' },
      body: JSON.stringify({ direction: 'next' }),
    });
    assert(swipeRes.status === 200, 'swiping the greeting to a stored alternate succeeds');
    const swiped = (await swipeRes.json()).message;
    assert(
      swiped.content === greeting2,
      'the swiped alternate greeting keeps its verbatim content in the swipe response',
    );
    assert(
      swiped.resolvedContent === 'Jeremy, you again!',
      'the swipe response carries the display-resolved copy as resolvedContent',
    );
  }

  serverRp.close();
}

// --- Part 5c: the Prompt Inspector's "Main Prompt" is the exact text the last turn sent ----------
// io/promptTrace.ts kind 'main': handleChatCompletions records the prompt (system prompt + trimmed
// history, in send order) immediately before the llm call, and GET /v1/chats/:id/prompt-preview
// surfaces that capture as the first group — so the inspector always shows the last turn that was
// sent (the user's spec for the panel), never a live reconstruction of the next one. The live
// reconstruction is only the fallback before anything has fired.
{
  const capturedMain = [];
  const capturingMainLlm = {
    name: 'capturing-main',
    async complete(messages, toolDefs) {
      // Snapshot the content, not the array reference — runTurn pushes the assistant reply into
      // the same messages array after complete() returns, which would otherwise show up here as a
      // phantom 3rd/5th message and break the "exact text sent" comparison below.
      capturedMain.push({ messages: messages.map((m) => ({ role: m.role, content: m.content })), toolDefs });
      return { message: { role: 'assistant', content: 'reply' }, toolCalls: [] };
    },
  };
  const poolMain = createFakePool();
  const dbMain = createPostgresClient(poolMain);
  const settingsMain = createFakeSettingsStore();
  const chatsMain = createFakeChatSessionStore();
  const apiKeysMain = createApiKeyStore('good-key-main:77777777-7777-7777-7777-777777777777');
  const userIdMain = '77777777-7777-7777-7777-777777777777';
  const serverMain = startHttpServer({
    llm: capturingMainLlm,
    db: dbMain,
    tools: createToolRegistry([echoTool]),
    apiKeys: apiKeysMain,
    accessIdentity: createFakeAccessIdentityResolver(),
    chats: chatsMain,
    adminApiKey: 'unused-in-this-part',
    credentials: createFakeCredentialStore(),
    settings: settingsMain,
    llmConnections: createFakeLlmConnectionStore(),
    imageConnections: createFakeImageConnectionStore(),
    modelName: 'bigbrain',
    port: 0,
  });
  await new Promise((resolve) => serverMain.once('listening', resolve));
  const baseMain = `http://127.0.0.1:${serverMain.address().port}`;
  const authMain = { authorization: 'Bearer good-key-main' };

  const rpMain = await chatsMain.createChat(userIdMain, {});
  await chatsMain.updateChat(userIdMain, rpMain.chatId, { kind: 'rp', params: { system: 'You are the narrator.' } });

  // The prompt trace is module-level in-memory state keyed by chatId, and every fake store in this
  // suite hands out the same ids (chat-1, chat-2, …) — earlier parts already recorded traces for
  // these ids, which would leak into this part's assertions. Clear them so this part starts with a
  // blank trace, as a real freshly-restarted server would for a never-sent chat.
  clearPromptTrace(rpMain.chatId);

  // Fresh chat, nothing fired yet: the preview falls back to the live next-turn reconstruction.
  const freshPreviewRes = await fetch(`${baseMain}/v1/chats/${rpMain.chatId}/prompt-preview`, { headers: authMain });
  assert(freshPreviewRes.status === 200, 'GET /v1/chats/:id/prompt-preview works for an rp chat that has not sent a turn yet');
  const freshPreview = await freshPreviewRes.json();
  assert(
    freshPreview.groups[0].kind === 'main' &&
      freshPreview.groups[0].captured === false &&
      freshPreview.groups[0].items.length === 1 &&
      freshPreview.groups[0].items[0].role === 'system',
    "before anything is sent, the Main Prompt group is the live (uncaptured) reconstruction — here just the system prompt, no history",
  );

  // Turn 1: the trace captures the exact prompt before the call, and the preview reflects it.
  let before = capturedMain.length;
  const turn1Res = await fetch(`${baseMain}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authMain, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'first hello' }], chat_id: rpMain.chatId }),
  });
  assert(turn1Res.status === 200, 'an rp chat turn succeeds (Part 5c)');
  const turn1Sent = capturedMain[before].messages; // [system, user 'first hello'] — the exact array runTurn handed to the llm
  const preview1Res = await fetch(`${baseMain}/v1/chats/${rpMain.chatId}/prompt-preview`, { headers: authMain });
  const preview1 = await preview1Res.json();
  const main1 = preview1.groups[0];
  assert(
    main1.kind === 'main' &&
      main1.captured === true &&
      main1.items.length === turn1Sent.length &&
      main1.items.every((item, i) => item.role === turn1Sent[i].role && item.content === turn1Sent[i].content),
    "after a turn, the Main Prompt group is the captured exact text that turn sent (same roles, content, order as the llm call)",
  );
  assert(
    preview1.groups.filter((g) => g.kind === 'main').length === 1,
    "the trace's 'main' entry is surfaced once — as the first group, never duplicated among the background prompts",
  );

  // Turn 2, with the full history replayed the way the frontend sends it: the preview updates to
  // turn 2's exact prompt — including turn 1's reply — proving it always shows the last turn.
  before = capturedMain.length;
  const turn2Res = await fetch(`${baseMain}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authMain, 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'user', content: 'first hello' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second hello' },
      ],
      chat_id: rpMain.chatId,
    }),
  });
  assert(turn2Res.status === 200, 'a second turn on the same chat succeeds (Part 5c)');
  const turn2Sent = capturedMain[before].messages;
  const preview2Res = await fetch(`${baseMain}/v1/chats/${rpMain.chatId}/prompt-preview`, { headers: authMain });
  const preview2 = await preview2Res.json();
  const main2 = preview2.groups[0];
  assert(
    main2.kind === 'main' &&
      main2.captured === true &&
      main2.items.length === turn2Sent.length &&
      main2.items.every((item, i) => item.role === turn2Sent[i].role && item.content === turn2Sent[i].content) &&
      main2.items.at(-1).content === 'second hello',
    "every turn the preview updates: the Main Prompt group is now turn 2's exact sent text (history + new message), not turn 1's",
  );

  // A non-'rp' chat is still refused by the preview endpoint.
  const plainMain = await chatsMain.createChat(userIdMain, {});
  await chatsMain.updateChat(userIdMain, plainMain.chatId, { params: { system: 'household stuff' } });
  const plainPreviewRes = await fetch(`${baseMain}/v1/chats/${plainMain.chatId}/prompt-preview`, { headers: authMain });
  assert(plainPreviewRes.status === 422, "prompt-preview stays rp-only — a 'chat'-kind session 422s");

  serverMain.close();
}

// --- Part 6: Canvas — a tool call's focusHint persists as chat_sessions.canvas_note_id ---
{
  const focusingLlm = {
    name: 'focusing',
    calls: 0,
    async complete() {
      this.calls += 1;
      if (this.calls === 1) {
        return { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'c1', name: 'touch_note', arguments: {} }] };
      }
      return { message: { role: 'assistant', content: 'noted' }, toolCalls: [] };
    },
  };
  const focusingTool = {
    definition: { name: 'touch_note', description: 'test', parameters: { type: 'object', properties: {} } },
    handler: async () => ({ noteId: 'note-canvas-1' }),
    focusHint: (result) => result.noteId ?? null,
  };
  const db5 = createPostgresClient(createFakePool());
  const apiKeys5 = createApiKeyStore('good-key-5:55555555-5555-5555-5555-555555555555');
  const chats5 = createFakeChatSessionStore();
  const userId5 = '55555555-5555-5555-5555-555555555555';
  const server5 = startHttpServer({
    llm: focusingLlm,
    db: db5,
    tools: createToolRegistry([focusingTool]),
    apiKeys: apiKeys5,
    accessIdentity: createFakeAccessIdentityResolver(),
    chats: chats5,
    adminApiKey: 'unused-in-this-part',
    credentials: createFakeCredentialStore(),
    settings: createFakeSettingsStore(),
    llmConnections: createFakeLlmConnectionStore(),
    imageConnections: createFakeImageConnectionStore(),
    modelName: 'bigbrain',
    port: 0,
  });
  await new Promise((resolve) => server5.once('listening', resolve));
  const base5 = `http://127.0.0.1:${server5.address().port}`;
  const auth5 = { authorization: 'Bearer good-key-5' };

  const chat5 = await chats5.createChat(userId5, {});
  assert(chat5.canvasNoteId === null, 'a fresh chat starts with no canvas focus');

  const focusRes = await fetch(`${base5}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth5, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'draft me a note' }], chat_id: chat5.chatId }),
  });
  const focusBody = await focusRes.json();
  assert(focusRes.status === 200, 'a turn whose tool call declares a focusHint still succeeds');
  assert(
    Object.keys(focusBody).sort().join(',') === 'choices,created,id,model,object'.split(',').sort().join(','),
    'the OpenAI-shaped completion response carries no leaked canvas/focus field — Canvas is plumbed via chat_sessions, not this endpoint',
  );
  const afterFocus = await chats5.getChat(userId5, chat5.chatId);
  assert(afterFocus.session.canvasNoteId === 'note-canvas-1', "the turn's focusHint persisted as the chat's canvas_note_id");

  // A subsequent turn that doesn't call any focus-hinting tool must leave the existing focus alone.
  const noFocusRes = await fetch(`${base5}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth5, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'thanks' }], chat_id: chat5.chatId }),
  });
  assert(noFocusRes.status === 200, 'a follow-up turn succeeds');
  const afterNoFocus = await chats5.getChat(userId5, chat5.chatId);
  assert(
    afterNoFocus.session.canvasNoteId === 'note-canvas-1',
    "a turn that doesn't touch any note leaves the chat's existing canvas focus untouched",
  );

  // The manual close path: POST /v1/chats/:id with canvas_note_id: null clears it.
  const closeRes = await fetch(`${base5}/v1/chats/${chat5.chatId}`, {
    method: 'POST',
    headers: { ...auth5, 'content-type': 'application/json' },
    body: JSON.stringify({ canvas_note_id: null }),
  });
  const closeBody = await closeRes.json();
  assert(closeRes.status === 200 && closeBody.canvasNoteId === null, 'POST /v1/chats/:id with canvas_note_id: null clears the canvas focus');

  server5.close();
}

// --- Admin timezone route (feeds handleChatCompletions's date-context line) ---
{
  const settings4 = createFakeSettingsStore();
  const server4 = startHttpServer({
    llm,
    db: createPostgresClient(createFakePool()),
    tools: createToolRegistry([]),
    apiKeys: createApiKeyStore('good-key-4:44444444-4444-4444-4444-444444444444'),
    accessIdentity: createFakeAccessIdentityResolver(),
    chats: createFakeChatSessionStore(),
    adminApiKey: 'the-admin-key',
    credentials: createFakeCredentialStore(),
    settings: settings4,
    llmConnections: createFakeLlmConnectionStore(),
    imageConnections: createFakeImageConnectionStore(),
    modelName: 'bigbrain',
    port: 0,
    triggerRestart: () => {
      throw new Error('timezone changes must never trigger a restart');
    },
  });
  await new Promise((resolve) => server4.once('listening', resolve));
  const base4 = `http://127.0.0.1:${server4.address().port}`;

  const tzNoAuthRes = await fetch(`${base4}/v1/admin/timezone`);
  assert(tzNoAuthRes.status === 401, 'GET /v1/admin/timezone with no auth header returns 401');

  const tzDefaultRes = await fetch(`${base4}/v1/admin/timezone`, { headers: { authorization: 'Bearer the-admin-key' } });
  const tzDefaultBody = await tzDefaultRes.json();
  assert(
    tzDefaultRes.status === 200 && tzDefaultBody.timezone === 'UTC',
    'GET /v1/admin/timezone defaults to UTC before anything has been saved',
  );

  const tzBadRes = await fetch(`${base4}/v1/admin/timezone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
    body: JSON.stringify({ value: 'Not/A_Real_Zone' }),
  });
  assert(tzBadRes.status === 400, 'POST /v1/admin/timezone rejects a name Intl does not recognize as a timezone');

  const tzOkRes = await fetch(`${base4}/v1/admin/timezone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
    body: JSON.stringify({ value: 'America/New_York' }),
  });
  const tzOkBody = await tzOkRes.json();
  assert(
    tzOkRes.status === 200 && tzOkBody.timezone === 'America/New_York',
    'POST /v1/admin/timezone with a valid IANA name returns 200 immediately (not 202/restarting)',
  );
  assert(settings4.setCalls.some((c) => c.key === 'household_timezone' && c.value === 'America/New_York'), 'the settings store recorded the write');

  const tzAfterSaveRes = await fetch(`${base4}/v1/admin/timezone`, { headers: { authorization: 'Bearer the-admin-key' } });
  const tzAfterSaveBody = await tzAfterSaveRes.json();
  assert(tzAfterSaveBody.timezone === 'America/New_York', 'GET /v1/admin/timezone reflects the newly saved value with no restart required');

  // --- Chat background settings routes (parallax_fade_teststep.md §2.2 + migration 0073) ---
  // Same server4/settings4 — the user-scoped GET and the admin POST share the store.
  const bgUserNoAuthRes = await fetch(`${base4}/v1/chat-background-settings`);
  assert(bgUserNoAuthRes.status === 401, 'GET /v1/chat-background-settings with no auth header returns 401');

  const bgUserRes = await fetch(`${base4}/v1/chat-background-settings`, {
    headers: { authorization: 'Bearer good-key-4' },
  });
  const bgUserBody = await bgUserRes.json();
  assert(
    bgUserRes.status === 200 &&
      bgUserBody.parallaxEnabled === false &&
      bgUserBody.overlayOpacity === 0.5 &&
      bgUserBody.overlayShade === '#000000' &&
      bgUserBody.bubbleOpacity === 0.7 &&
      bgUserBody.bubbleUserShade === '#4f46e5' &&
      bgUserBody.bubbleAssistantShade === '#26272c',
    'GET /v1/chat-background-settings defaults (parallax off, veil 0.5 black, bubbles 0.7 dark-theme shades) before anything has been saved',
  );

  const bgAdminNoAuthRes = await fetch(`${base4}/v1/admin/chat-background-settings`);
  assert(bgAdminNoAuthRes.status === 401, 'GET /v1/admin/chat-background-settings with no auth header returns 401');

  const bgBadRes = await fetch(`${base4}/v1/admin/chat-background-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
    body: JSON.stringify({ parallaxEnabled: 'yes' }),
  });
  assert(bgBadRes.status === 400, 'POST /v1/admin/chat-background-settings rejects a non-boolean parallaxEnabled');

  const bgBadOpacityRes = await fetch(`${base4}/v1/admin/chat-background-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
    body: JSON.stringify({ overlayOpacity: 1.5 }),
  });
  assert(bgBadOpacityRes.status === 400, 'POST /v1/admin/chat-background-settings rejects an out-of-range overlayOpacity');

  const bgBadShadeRes = await fetch(`${base4}/v1/admin/chat-background-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
    body: JSON.stringify({ bubbleUserShade: 'indigo' }),
  });
  assert(bgBadShadeRes.status === 400, 'POST /v1/admin/chat-background-settings rejects a non-hex bubbleUserShade');

  const bgEmptyRes = await fetch(`${base4}/v1/admin/chat-background-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
    body: JSON.stringify({}),
  });
  assert(bgEmptyRes.status === 400, 'POST /v1/admin/chat-background-settings rejects an empty body');

  const bgOkRes = await fetch(`${base4}/v1/admin/chat-background-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
    body: JSON.stringify({
      parallaxEnabled: true,
      overlayOpacity: 0.35,
      overlayShade: '#1a1024',
      bubbleOpacity: 0.8,
      bubbleUserShade: '#7c3aed',
      bubbleAssistantShade: '#1f2937',
    }),
  });
  const bgOkBody = await bgOkRes.json();
  assert(
    bgOkRes.status === 200 &&
      bgOkBody.parallaxEnabled === true &&
      bgOkBody.overlayOpacity === 0.35 &&
      bgOkBody.overlayShade === '#1a1024' &&
      bgOkBody.bubbleOpacity === 0.8 &&
      bgOkBody.bubbleUserShade === '#7c3aed' &&
      bgOkBody.bubbleAssistantShade === '#1f2937',
    'POST /v1/admin/chat-background-settings returns 200 with every saved value (no restart)',
  );
  assert(
    settings4.setCalls.some((c) => c.key === 'chat_background_parallax' && c.value === 'true') &&
      settings4.setCalls.some((c) => c.key === 'chat_background_overlay_opacity' && c.value === '0.35') &&
      settings4.setCalls.some((c) => c.key === 'chat_background_overlay_shade' && c.value === '#1a1024') &&
      settings4.setCalls.some((c) => c.key === 'chat_background_bubble_opacity' && c.value === '0.8') &&
      settings4.setCalls.some((c) => c.key === 'chat_background_bubble_user_shade' && c.value === '#7c3aed') &&
      settings4.setCalls.some((c) => c.key === 'chat_background_bubble_assistant_shade' && c.value === '#1f2937'),
    'the settings store recorded every FX write as text',
  );

  const bgAfterSaveRes = await fetch(`${base4}/v1/chat-background-settings`, {
    headers: { authorization: 'Bearer good-key-4' },
  });
  const bgAfterSaveBody = await bgAfterSaveRes.json();
  assert(
    bgAfterSaveBody.parallaxEnabled === true && bgAfterSaveBody.bubbleUserShade === '#7c3aed',
    'the user-scoped GET reflects the newly saved values with no restart',
  );

  // --- Chat legibility settings routes (migration 0074, the ChatView "Text legibility" menu) ---
  // Same server4/settings4 — the user-scoped GET and the admin POST share the store. All five
  // toggles default off (opt-in look); each toggle POSTs its partial patch immediately.
  const legUserNoAuthRes = await fetch(`${base4}/v1/chat-legibility-settings`);
  assert(legUserNoAuthRes.status === 401, 'GET /v1/chat-legibility-settings with no auth header returns 401');

  const legUserRes = await fetch(`${base4}/v1/chat-legibility-settings`, {
    headers: { authorization: 'Bearer good-key-4' },
  });
  const legUserBody = await legUserRes.json();
  assert(
    legUserRes.status === 200 &&
      legUserBody.halo === false &&
      legUserBody.haloStrength === 0.6 &&
      legUserBody.outline === false &&
      legUserBody.solidCode === false &&
      legUserBody.weightBump === false &&
      legUserBody.hoverFocus === false,
    'GET /v1/chat-legibility-settings defaults to all five toggles off with halo strength 0.6 before anything has been saved',
  );

  const legAdminNoAuthRes = await fetch(`${base4}/v1/admin/chat-legibility-settings`);
  assert(legAdminNoAuthRes.status === 401, 'GET /v1/admin/chat-legibility-settings with no auth header returns 401');

  const legBadRes = await fetch(`${base4}/v1/admin/chat-legibility-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
    body: JSON.stringify({ halo: 'on' }),
  });
  assert(legBadRes.status === 400, 'POST /v1/admin/chat-legibility-settings rejects a non-boolean halo');

  const legBadStrengthRes = await fetch(`${base4}/v1/admin/chat-legibility-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
    body: JSON.stringify({ haloStrength: 1.5 }),
  });
  assert(legBadStrengthRes.status === 400, 'POST /v1/admin/chat-legibility-settings rejects an out-of-range haloStrength');

  const legEmptyRes = await fetch(`${base4}/v1/admin/chat-legibility-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
    body: JSON.stringify({}),
  });
  assert(legEmptyRes.status === 400, 'POST /v1/admin/chat-legibility-settings rejects an empty body');

  const legOkRes = await fetch(`${base4}/v1/admin/chat-legibility-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer the-admin-key' },
    body: JSON.stringify({ halo: true, haloStrength: 0.45, solidCode: true, hoverFocus: true }),
  });
  const legOkBody = await legOkRes.json();
  assert(
    legOkRes.status === 200 &&
      legOkBody.halo === true &&
      legOkBody.haloStrength === 0.45 &&
      legOkBody.outline === false &&
      legOkBody.solidCode === true &&
      legOkBody.weightBump === false &&
      legOkBody.hoverFocus === true,
    'POST /v1/admin/chat-legibility-settings accepts a partial patch and returns the full updated set (toggles left out stay as-is)',
  );
  assert(
    settings4.setCalls.some((c) => c.key === 'chat_legibility_halo' && c.value === 'true') &&
      settings4.setCalls.some((c) => c.key === 'chat_legibility_halo_strength' && c.value === '0.45') &&
      settings4.setCalls.some((c) => c.key === 'chat_legibility_solid_code' && c.value === 'true') &&
      settings4.setCalls.some((c) => c.key === 'chat_legibility_hover_focus' && c.value === 'true') &&
      !settings4.setCalls.some((c) => c.key === 'chat_legibility_outline') &&
      !settings4.setCalls.some((c) => c.key === 'chat_legibility_weight'),
    'the settings store recorded only the patched legibility writes as text',
  );

  const legAfterSaveRes = await fetch(`${base4}/v1/chat-legibility-settings`, {
    headers: { authorization: 'Bearer good-key-4' },
  });
  const legAfterSaveBody = await legAfterSaveRes.json();
  assert(
    legAfterSaveBody.halo === true &&
      legAfterSaveBody.haloStrength === 0.45 &&
      legAfterSaveBody.hoverFocus === true &&
      legAfterSaveBody.outline === false,
    'the user-scoped GET reflects the newly saved legibility toggles with no restart',
  );

  server4.close();
}

// --- Part 7: chat location-image contract (endpoint.md §6.4 + §5.1.8) ---
// The chat background layer resolves the current eligible location (scene_id pointer with an
// active-swipe fallback) plus the last settled location (previous_scene_id — the last-turn
// location state). A current location whose image hasn't rendered yet (the post-turn bg pass is
// still in flight, endpoint.md §5) must come back as current.imageUrl null — NOT blank — and the
// previous location stays available as the "some background is better than no background even if
// stale" fallback.
{
  const pool7 = createFakePool();
  const server7 = startHttpServer({
    llm,
    db: createPostgresClient(pool7),
    tools: createToolRegistry([]),
    apiKeys: createApiKeyStore('good-key-7:77777777-7777-7777-7777-777777777777'),
    accessIdentity: createFakeAccessIdentityResolver(),
    chats: createFakeChatSessionStore(),
    adminApiKey: 'unused-in-this-part',
    credentials: createFakeCredentialStore(),
    settings: createFakeSettingsStore(),
    llmConnections: createFakeLlmConnectionStore(),
    imageConnections: createFakeImageConnectionStore(),
    modelName: 'bigbrain',
    port: 0,
  });
  await new Promise((resolve) => server7.once('listening', resolve));
  const base7 = `http://127.0.0.1:${server7.address().port}`;
  const auth7 = { authorization: 'Bearer good-key-7' };
  const userId7 = '77777777-7777-7777-7777-777777777777';
  const chats7 = createFakeChatSessionStore();
  const chat7 = await chats7.createChat(userId7, {});

  // No scene/location at all -> both sides null.
  const noLocRes = await fetch(`${base7}/v1/chats/${chat7.chatId}/location-image`, { headers: auth7 });
  const noLocBody = await noLocRes.json();
  assert(
    noLocRes.status === 200 && noLocBody.current?.locationId === null && noLocBody.previous?.locationId === null,
    'a chat with no scene/location reads back current null and previous null',
  );

  // Eligible location, render still in flight -> current present with imageUrl null (the
  // persistence contract), previous null (nothing settled before it).
  pool7.setChatLocationState(chat7.chatId, { scene_id: 'scene-1', previous_scene_id: null });
  pool7.setSceneLocation('scene-1', { location_id: 'loc-1', name: 'The Crossroads', image_url: null });
  const pendingRes = await fetch(`${base7}/v1/chats/${chat7.chatId}/location-image`, { headers: auth7 });
  const pendingBody = await pendingRes.json();
  assert(
    pendingRes.status === 200 &&
      pendingBody.current?.locationId === 'loc-1' &&
      pendingBody.current?.name === 'The Crossroads' &&
      pendingBody.current?.imageUrl === null &&
      pendingBody.previous?.locationId === null,
    'an eligible location whose image has not rendered yet returns current with imageUrl null',
  );

  // Render lands -> imageUrl present on the same location row.
  pool7.setSceneLocation('scene-1', { location_id: 'loc-1', name: 'The Crossroads', image_url: 'https://cdn.example.invalid/bg.png' });
  const readyRes = await fetch(`${base7}/v1/chats/${chat7.chatId}/location-image`, { headers: auth7 });
  const readyBody = await readyRes.json();
  assert(
    readyRes.status === 200 &&
      readyBody.current?.locationId === 'loc-1' &&
      readyBody.current?.imageUrl === 'https://cdn.example.invalid/bg.png' &&
      readyBody.previous?.locationId === null,
    'once the render lands the endpoint returns the image URL on the same location row',
  );

  // A settled previous location comes back alongside the current — the last-turn location state
  // (endpoint.md §5.1.8) the client reverts to on a swipe and falls back to while a render is
  // pending. definition rides along (describer.md's "Definition:" half) so the canvas caption
  // stays complete on the previous background, mirroring the current path.
  pool7.setChatLocationState(chat7.chatId, { scene_id: 'scene-1', previous_scene_id: 'scene-0' });
  pool7.setSceneLocation('scene-0', { location_id: 'loc-0', name: 'The Old Mill', definition: 'A weathered mill by the river.', image_url: 'https://cdn.example.invalid/prev.png' });
  const prevRes = await fetch(`${base7}/v1/chats/${chat7.chatId}/location-image`, { headers: auth7 });
  const prevBody = await prevRes.json();
  assert(
    prevRes.status === 200 &&
      prevBody.current?.locationId === 'loc-1' &&
      prevBody.previous?.locationId === 'loc-0' &&
      prevBody.previous?.name === 'The Old Mill' &&
      prevBody.previous?.definition === 'A weathered mill by the river.' &&
      prevBody.previous?.imageUrl === 'https://cdn.example.invalid/prev.png',
    'a settled previous location comes back alongside the current as the last-turn location state',
  );

  // Pending current + settled previous -> previous still returned (the client never blanks the
  // background layer).
  pool7.setSceneLocation('scene-1', { location_id: 'loc-1', name: 'The Crossroads', image_url: null });
  const pendingPrevRes = await fetch(`${base7}/v1/chats/${chat7.chatId}/location-image`, { headers: auth7 });
  const pendingPrevBody = await pendingPrevRes.json();
  assert(
    pendingPrevRes.status === 200 &&
      pendingPrevBody.current?.imageUrl === null &&
      pendingPrevBody.previous?.imageUrl === 'https://cdn.example.invalid/prev.png',
    'a pending render keeps the previous location available so the client never blanks the background',
  );

  // Stale scene pointer (prev/next cycling flipped the active swipe, not the scene) -> the
  // active-swipe fallback resolves the cycled-to variant's own location (endpoint.md §5.1.8's
  // per-swipe reuse).
  pool7.setChatLocationState(chat7.chatId, { scene_id: 'scene-1', previous_scene_id: 'scene-0' });
  pool7.setSceneLocation('scene-1', undefined); // the scene path resolves nothing (ineligible)
  pool7.setFallbackLocation(userId7, chat7.chatId, { location_id: 'loc-2', name: 'The Harbor', image_url: 'https://cdn.example.invalid/cycle.png' });
  const cycleRes = await fetch(`${base7}/v1/chats/${chat7.chatId}/location-image`, { headers: auth7 });
  const cycleBody = await cycleRes.json();
  assert(
    cycleRes.status === 200 &&
      cycleBody.current?.locationId === 'loc-2' &&
      cycleBody.current?.imageUrl === 'https://cdn.example.invalid/cycle.png',
    'a stale scene pointer falls back to the active swipe\u2019s own location (cycle-back)',
  );

  server7.close();
}

if (process.exitCode) {
  console.error('\nserver verification FAILED');
  process.exit(1);
}
console.log('\nserver verification passed');
