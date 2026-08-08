// Proves io/chatSessions.ts's CRUD/search/append logic against a fake in-memory pool (no real
// Postgres), mirroring verify-provider-credentials.mjs's style, plus toolRegistry.ts's
// filterToolRegistry wrapper.

import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../dist/io/postgres.js';
import { createChatSessionStore, DEFAULT_RP_TOOLS } from '../dist/io/chatSessions.js';
import { createToolRegistry, filterToolRegistry } from '../dist/orchestrator/toolRegistry.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake pool: in-memory chat_sessions / chat_messages / folders / chat_message_swipes /
// locations / characters tables ---
function createFakePool() {
  const sessions = new Map(); // chat_id -> row
  const messages = []; // {message_id, chat_id, user_id, role, content, created_at, active_swipe_id}
  const swipes = []; // {swipe_id, message_id, content, created_at}
  const folders = new Map(); // folder_id -> row
  const locations = []; // {location_id, user_id, name, status, anchor_chat_id, anchor_swipe_id, ...}
  const characters = []; // {character_id, user_id, name, status, anchor_chat_id, anchor_swipe_id}
  const syncStatus = new Map(); // chat_id -> {user_id, last_attempt_at, last_status, last_step, last_error, last_success_at, last_chunks_added, last_entries_updated, consecutive_errors}
  const canonCounts = new Map(); // chat_id -> {proposed, approved, last_proposed_at}
  let clock = 1000;
  const now = () => new Date((clock += 1000)).toISOString();

  return {
    sessions,
    messages,
    swipes,
    folders,
    locations,
    characters,
    syncStatus,
    canonCounts,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          // getChatSyncStatus (chatSessions.ts) — the per-chat slice of the rolling sync loop's
          // status record. Branches sit here, before the generic chat_sessions/canon_facts/
          // chat_sync_points stubs below, because the status query embeds a `from canon_facts
          // where chat_id` subquery and the unsynced query embeds a `from chat_sync_points where
          // chat_id` subquery that those empty-rows stubs would otherwise swallow.
          if (sql.includes('from chat_memory_sync_status s')) {
            const chatId = params[0];
            const row = syncStatus.get(chatId);
            if (!row || row.user_id !== scopedUserId) return { rows: [] };
            const canon = canonCounts.get(chatId) ?? { proposed: 0, approved: 0, last_proposed_at: null };
            return {
              rows: [
                {
                  last_attempt_at: row.last_attempt_at,
                  last_status: row.last_status,
                  last_step: row.last_step,
                  last_error: row.last_error,
                  last_success_at: row.last_success_at,
                  last_chunks_added: row.last_chunks_added,
                  last_entries_updated: row.last_entries_updated,
                  consecutive_errors: row.consecutive_errors,
                  canon_proposed_count: String(canon.proposed),
                  canon_approved_count: String(canon.approved),
                  canon_last_proposed_at: canon.last_proposed_at,
                },
              ],
            };
          }
          if (sql.includes('select count(*)::text as unsynced')) {
            const chatId = params[0];
            // No chat_sync_points rows exist in this pool (the stub below returns []), so the
            // anchor is always null and every message counts — exactly what real Postgres returns
            // for a never-synced chat, which is all these tests exercise.
            const count = messages.filter((m) => m.chat_id === chatId && m.user_id === scopedUserId).length;
            return { rows: [{ unsynced: String(count) }] };
          }

          // chat_sessions
          // Discriminated by param count, not sql.includes('parent_chat_id') — SESSION_COLUMNS
          // (used in every `returning` clause here, including createChat's) already contains that
          // substring, so a text match alone can't tell the two inserts apart.
          if (sql.includes('insert into chat_sessions') && params.length === 12) {
            // forkChat's insert — column order per chatSessions.ts:
            // (user_id, title, folder_id, params, tool_names, parent_chat_id, fork_message_id, kind,
            //  character_id, prompt_stack_preset_id, cleanup_preset_id, cleanup_enabled_at)
            const [userId, title, folderId, paramsJson, toolNames, parentChatId, forkMessageId, kind, characterId, promptStackPresetId, cleanupPresetId, cleanupEnabledAt] =
              params;
            const row = {
              chat_id: randomUUID(),
              user_id: userId,
              title: title ?? 'New chat',
              folder_id: folderId ?? null,
              params: paramsJson ? JSON.parse(paramsJson) : {},
              tool_names: toolNames ?? null,
              canvas_note_id: null,
              parent_chat_id: parentChatId ?? null,
              fork_message_id: forkMessageId ?? null,
              archived_at: null,
              kind: kind ?? 'chat',
              character_id: characterId ?? null,
              prompt_stack_preset_id: promptStackPresetId ?? null,
              cleanup_preset_id: cleanupPresetId ?? null,
              cleanup_enabled_at: cleanupEnabledAt ?? null,
              created_at: now(),
              updated_at: now(),
            };
            sessions.set(row.chat_id, row);
            return { rows: [row] };
          }
          if (sql.includes('insert into chat_sessions')) {
            const [userId, title, folderId, kind, toolNames] = params;
            const row = {
              chat_id: randomUUID(),
              user_id: userId,
              title: title ?? 'New chat',
              folder_id: folderId ?? null,
              params: {},
              tool_names: toolNames ?? null,
              canvas_note_id: null,
              parent_chat_id: null,
              fork_message_id: null,
              archived_at: null,
              kind: kind ?? 'chat',
              character_id: null,
              prompt_stack_preset_id: null,
              cleanup_preset_id: null,
              cleanup_enabled_at: null,
              created_at: now(),
              updated_at: now(),
            };
            sessions.set(row.chat_id, row);
            return { rows: [row] };
          }
          // getLineage: walk parent_chat_id up to the root (RLS-scoped at every hop, same as real
          // Postgres would enforce on the recursive join).
          if (sql.startsWith('with recursive up')) {
            const owned = (id) => {
              const s = sessions.get(id);
              return s && s.user_id === scopedUserId ? s : undefined;
            };
            let current = owned(params[0]);
            if (!current) return { rows: [] };
            const seen = new Set([current.chat_id]);
            while (current.parent_chat_id) {
              const parent = owned(current.parent_chat_id);
              if (!parent || seen.has(parent.chat_id)) break;
              current = parent;
              seen.add(current.chat_id);
            }
            return { rows: [{ chat_id: current.chat_id }] };
          }
          // getLineage: every descendant of the given root, root included, oldest first.
          if (sql.startsWith('with recursive down')) {
            const root = sessions.get(params[0]);
            if (!root || root.user_id !== scopedUserId) return { rows: [] };
            const family = [...sessions.values()].filter((s) => s.user_id === scopedUserId);
            const byParent = new Map();
            for (const s of family) {
              if (!byParent.has(s.parent_chat_id)) byParent.set(s.parent_chat_id, []);
              byParent.get(s.parent_chat_id).push(s);
            }
            const rows = [];
            const queue = [root];
            while (queue.length > 0) {
              const node = queue.shift();
              rows.push(node);
              queue.push(...(byParent.get(node.chat_id) ?? []));
            }
            rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
            return { rows };
          }
          if (sql.includes('from chat_sync_points where chat_id')) {
            return { rows: [] };
          }
          if (sql.includes('from canon_facts where chat_id')) {
            return { rows: [] };
          }
          // getChat's swipe-metadata lookup (chatSessions.ts) — previously a stub that always
          // returned empty (no test exercised swipes); now backed by the in-memory swipes table
          // so ensureActiveSwipe's canonical swipe row reads back as {index: 0, count: 1}.
          if (sql.includes('from chat_message_swipes where message_id')) {
            const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
            const rows = swipes
              .filter((s) => ids.includes(s.message_id))
              .map((s) => ({ message_id: s.message_id, swipe_id: s.swipe_id }));
            return { rows };
          }
          if (sql.includes('select chat_id, title, folder_id, updated_at from chat_sessions')) {
            let rows = [...sessions.values()].filter((s) => s.user_id === scopedUserId);
            if (sql.includes('title ilike')) {
              const q = params[0].replaceAll('%', '').toLowerCase();
              rows = rows.filter(
                (s) =>
                  s.title.toLowerCase().includes(q) ||
                  messages.some((m) => m.chat_id === s.chat_id && m.content.toLowerCase().includes(q)),
              );
            }
            if (sql.includes('folder_id = $')) {
              const folderId = params[params.length - 1];
              rows = rows.filter((s) => s.folder_id === folderId);
            }
            rows = [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
            return { rows };
          }
          if (sql.includes('delete from chat_sessions')) {
            const row = sessions.get(params[0]);
            if (!row || row.user_id !== scopedUserId) return { rows: [] };
            sessions.delete(params[0]);
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].chat_id === params[0]) messages.splice(i, 1);
            }
            return { rows: [{ chat_id: params[0] }] };
          }
          if (sql.includes('from chat_sessions where chat_id')) {
            const row = sessions.get(params[0]);
            return { rows: row && row.user_id === scopedUserId ? [row] : [] };
          }
          if (sql.startsWith('update chat_sessions set')) {
            const row = sessions.get(params[0]);
            if (!row || row.user_id !== scopedUserId) return { rows: [] };
            row.updated_at = now();
            // Positional mapping mirrors the SET clause construction order in chatSessions.ts.
            const setParts = sql.slice(sql.indexOf('set ') + 4, sql.includes('where') ? sql.indexOf(' where') : undefined);
            let idx = 1;
            if (setParts.includes('title =')) row.title = params[idx++];
            if (setParts.includes('folder_id =')) row.folder_id = params[idx++];
            if (setParts.includes('params =')) row.params = JSON.parse(params[idx++]);
            if (setParts.includes('tool_names =')) row.tool_names = params[idx++];
            if (setParts.includes('canvas_note_id =')) row.canvas_note_id = params[idx++];
            if (setParts.includes('cleanup_preset_id =')) row.cleanup_preset_id = params[idx++];
            if (setParts.includes('cleanup_enabled_at =')) row.cleanup_enabled_at = params[idx++];
            return { rows: sql.includes('returning') ? [row] : [] };
          }
          // chat_messages — always returns the inserted row (real Postgres only does with
          // `returning message_id`, but appendMessages always asks for it now, so this stays simple).
          if (sql.includes('insert into chat_messages')) {
            const [chatId, userId, role, content] = params;
            const row = {
              message_id: randomUUID(),
              chat_id: chatId,
              user_id: userId,
              role,
              content,
              created_at: now(),
              active_swipe_id: null,
            };
            messages.push(row);
            return { rows: [row] };
          }
          // ensureActiveSwipe's and forkChat-resurrection's single-message read — anchored on
          // 'select' (a plain includes() would also swallow `delete from chat_messages where
          // message_id`, which the deleteMessage branch below owns) and discriminated from the
          // getChat select-all by the `where message_id` predicate.
          if (sql.startsWith('select') && sql.includes('from chat_messages where message_id')) {
            const row = messages.find((m) => m.message_id === params[0] && m.chat_id === params[1]);
            return { rows: row ? [row] : [] };
          }
          // ensureActiveSwipe / forkChat mirroring: give a message its own swipe row.
          if (sql.includes('insert into chat_message_swipes')) {
            const [messageId, content, createdAt] = params;
            const row = { swipe_id: randomUUID(), message_id: messageId, content, created_at: createdAt ?? now() };
            swipes.push(row);
            return { rows: [{ swipe_id: row.swipe_id }] };
          }
          if (sql.includes('update chat_messages set active_swipe_id')) {
            const [swipeId, messageId] = params;
            const row = messages.find((m) => m.message_id === messageId);
            if (row) row.active_swipe_id = swipeId;
            return { rows: [] };
          }
          // forkChat resurrection (§2.7): transient/inactive rows anchored to the fork swipe.
          // The `from locations`/`from characters` predicates live on different lines from the
          // `where user_id` in the real SQL, so the matchers don't require adjacency.
          if (sql.includes('from locations') && sql.includes('anchor_swipe_id')) {
            const [userId, anchorSwipeId] = params;
            const rows = locations.filter(
              (l) => l.user_id === userId && l.anchor_swipe_id === anchorSwipeId && (l.status === 'transient' || l.status === 'inactive'),
            );
            // endpoint.md §6.2: the resurrection clone now carries the visual cache columns too.
            return {
              rows: rows.map((l) => ({
                name: l.name,
                visual_description: l.visual_description,
                environment: JSON.stringify(l.environment ?? {}),
                seed: l.seed ?? null,
                image_url: l.image_url ?? null,
                image_generated_at: l.image_generated_at ?? null,
                image_rendered_input: l.image_rendered_input ? JSON.stringify(l.image_rendered_input) : null,
                image_render_hash: l.image_render_hash ?? null,
              })),
            };
          }
          if (sql.includes('from characters') && sql.includes('anchor_swipe_id')) {
            const [userId, anchorSwipeId] = params;
            const rows = characters.filter(
              (c) => c.user_id === userId && c.anchor_swipe_id === anchorSwipeId && (c.status === 'transient' || c.status === 'inactive'),
            );
            return { rows: rows.map((c) => ({ name: c.name })) };
          }
          if (sql.includes('insert into locations') && params.length >= 10) {
            const [userId, name, visualDescription, environmentJson, seed, imageUrl, imageGeneratedAt, renderedInputJson, renderHash, chatId, anchorSwipeId] = params;
            const row = {
              location_id: randomUUID(),
              user_id: userId,
              name,
              visual_description: visualDescription,
              environment: JSON.parse(environmentJson ?? '{}'),
              seed: seed ?? null,
              image_url: imageUrl ?? null,
              image_generated_at: imageGeneratedAt ?? null,
              image_rendered_input: renderedInputJson ? JSON.parse(renderedInputJson) : null,
              image_render_hash: renderHash ?? null,
              status: 'transient',
              anchor_chat_id: chatId,
              anchor_swipe_id: anchorSwipeId,
            };
            locations.push(row);
            return { rows: [] };
          }
          if (sql.includes('insert into characters') && params.length >= 4) {
            const [userId, name, chatId, anchorSwipeId] = params;
            const row = { character_id: randomUUID(), user_id: userId, name, status: 'transient', anchor_chat_id: chatId, anchor_swipe_id: anchorSwipeId };
            characters.push(row);
            return { rows: [] };
          }
          // Anchored with startsWith, checked before the generic select-all branch below —
          // 'delete from chat_messages where chat_id' is itself a substring match for the old
          // (unanchored) select query's includes() check, the exact class of bug this file's
          // history already hit once with folders/chat_sessions.
          if (sql.startsWith('delete from chat_messages where message_id')) {
            const idx = messages.findIndex(
              (m) => m.message_id === params[0] && m.chat_id === params[1] && m.user_id === scopedUserId,
            );
            if (idx === -1) return { rows: [] };
            const [deleted] = messages.splice(idx, 1);
            return { rows: [{ message_id: deleted.message_id }] };
          }
          if (sql.startsWith('delete from chat_messages where chat_id')) {
            const [chatId, messageId] = params;
            const target = messages.find(
              (m) => m.message_id === messageId && m.chat_id === chatId && m.user_id === scopedUserId,
            );
            if (!target) return { rows: [] };
            const toDelete = messages.filter(
              (m) => m.chat_id === chatId && m.user_id === scopedUserId && m.created_at >= target.created_at,
            );
            for (const m of toDelete) {
              const idx = messages.indexOf(m);
              messages.splice(idx, 1);
            }
            return { rows: toDelete.map((m) => ({ message_id: m.message_id })) };
          }
          if (sql.includes('from chat_messages where chat_id')) {
            const rows = messages
              .filter((m) => m.chat_id === params[0] && m.user_id === scopedUserId)
              .sort((a, b) => a.created_at.localeCompare(b.created_at));
            return { rows };
          }

          // folders
          if (sql.includes('insert into folders')) {
            const [userId, name, parentId] = params;
            const row = { folder_id: randomUUID(), user_id: userId, name, parent_id: parentId, created_at: now() };
            folders.set(row.folder_id, row);
            return { rows: [row] };
          }
          if (sql.startsWith('delete from folders')) {
            const row = folders.get(params[0]);
            if (!row || row.user_id !== scopedUserId) return { rows: [] };
            folders.delete(params[0]);
            // emulate on delete set null for chats
            for (const s of sessions.values()) {
              if (s.folder_id === params[0]) s.folder_id = null;
            }
            return { rows: [{ folder_id: params[0] }] };
          }
          if (sql.startsWith('update folders set')) {
            const row = folders.get(params[0]);
            if (!row || row.user_id !== scopedUserId) return { rows: [] };
            let idx = 1;
            if (sql.includes('name =')) row.name = params[idx++];
            if (sql.includes('parent_id =')) row.parent_id = params[idx++];
            return { rows: [row] };
          }
          if (sql.startsWith('select folder_id, name, parent_id from folders where folder_id')) {
            const row = folders.get(params[0]);
            return { rows: row && row.user_id === scopedUserId ? [row] : [] };
          }
          if (sql.includes('select folder_id, name, parent_id from folders')) {
            const rows = [...folders.values()]
              .filter((f) => f.user_id === scopedUserId)
              .sort((a, b) => a.name.localeCompare(b.name));
            return { rows };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

const pool = createFakePool();
const db = createPostgresClient(pool);
const store = createChatSessionStore(db);

// --- create / list / get round trip ---
const created = await store.createChat(USER_A, { title: 'Groceries planning' });
assert(created.chatId.length > 0, 'createChat returns a session with an id');
assert(created.title === 'Groceries planning', 'createChat honors the given title');
assert(created.toolNames === null, 'a new chat allows all tools (toolNames null)');

{
  const rpChat = await store.createChat(USER_A, { title: 'An RP', kind: 'rp' });
  assert(
    JSON.stringify(rpChat.toolNames) === JSON.stringify(DEFAULT_RP_TOOLS),
    "an rp chat defaults to DEFAULT_RP_TOOLS (the recall pair), not null/all and not []",
  );
  const explicitRp = await store.createChat(USER_A, { title: 'RP no tools', kind: 'rp', toolNames: [] });
  assert(JSON.stringify(explicitRp.toolNames) === '[]', 'an explicit toolNames overrides the rp default');
}

const defaultTitled = await store.createChat(USER_A);
assert(defaultTitled.title === 'New chat', 'createChat defaults the title');

{
  const list = await store.listChats(USER_A);
  assert(list.length === 4, 'listChats returns every chat (2 general + 2 rp)');
}
{
  const list = await store.listChats(USER_B);
  assert(list.length === 0, 'another user sees no chats (RLS scoping via the session user)');
}

// --- appendMessages + getChat ---
await store.appendMessages(USER_A, created.chatId, [
  { role: 'user', content: 'what is on the shopping list?' },
  { role: 'assistant', content: 'You have carrots and milk pending.' },
]);
{
  const detail = await store.getChat(USER_A, created.chatId);
  assert(detail !== undefined, 'getChat finds the session');
  assert(detail.messages.length === 2, 'both appended messages come back');
  assert(detail.messages[0].role === 'user' && detail.messages[1].role === 'assistant', 'messages keep their order');
}
{
  const detail = await store.getChat(USER_B, created.chatId);
  assert(detail === undefined, "another user's getChat can't see the session");
}

// --- appendMessages bumps updated_at so the chat sorts to the top ---
{
  await store.appendMessages(USER_A, defaultTitled.chatId, [{ role: 'user', content: 'newer activity' }]);
  const list = await store.listChats(USER_A);
  assert(list[0].chatId === defaultTitled.chatId, 'the most recently active chat sorts first');
}

// --- search hits title and message content ---
{
  const byTitle = await store.listChats(USER_A, { search: 'groceries' });
  assert(byTitle.length === 1 && byTitle[0].chatId === created.chatId, 'search matches a chat title');
  const byContent = await store.listChats(USER_A, { search: 'carrots' });
  assert(byContent.length === 1 && byContent[0].chatId === created.chatId, "search matches a message's content");
  const noHit = await store.listChats(USER_A, { search: 'zebra' });
  assert(noHit.length === 0, 'search with no match returns nothing');
}

// --- updateChat: params + toolNames round trip ---
{
  const updated = await store.updateChat(USER_A, created.chatId, {
    params: { system: 'Answer tersely.', temperature: 0.2, max_tokens: 500 },
    toolNames: ['get_list_items'],
  });
  assert(updated.params.system === 'Answer tersely.', 'params.system round-trips');
  assert(updated.params.temperature === 0.2, 'params.temperature round-trips');
  assert(updated.toolNames.length === 1 && updated.toolNames[0] === 'get_list_items', 'toolNames round-trips');
}

// --- updateChat: canvasNoteId (Canvas) round trip ---
{
  assert(created.canvasNoteId === null, 'a new chat starts with no canvas focus');
  const focused = await store.updateChat(USER_A, created.chatId, { canvasNoteId: 'note-123' });
  assert(focused.canvasNoteId === 'note-123', 'canvasNoteId round-trips through updateChat');

  const untouched = await store.updateChat(USER_A, created.chatId, { title: 'Groceries planning (renamed)' });
  assert(untouched.canvasNoteId === 'note-123', 'a patch that omits canvasNoteId leaves the existing focus alone');

  const cleared = await store.updateChat(USER_A, created.chatId, { canvasNoteId: null });
  assert(cleared.canvasNoteId === null, 'canvasNoteId can be explicitly cleared back to null');
}

// --- updateChat: cleanup_enabled_at (async cleanup subloop toggle, migration 0072) round trip ---
{
  assert(created.cleanupEnabledAt === null, 'a new chat starts with cleanup disabled');
  const enabled = await store.updateChat(USER_A, created.chatId, { cleanupEnabledAt: '2026-08-07T00:00:00.000Z' });
  assert(enabled.cleanupEnabledAt === '2026-08-07T00:00:00.000Z', 'cleanup_enabled_at round-trips through updateChat');

  const untouched = await store.updateChat(USER_A, created.chatId, { title: 'Groceries planning (renamed)' });
  assert(untouched.cleanupEnabledAt === '2026-08-07T00:00:00.000Z', 'a patch that omits cleanup_enabled_at leaves the toggle alone');

  const off = await store.updateChat(USER_A, created.chatId, { cleanupEnabledAt: null });
  assert(off.cleanupEnabledAt === null, 'cleanup_enabled_at can be explicitly cleared back to null (turning cleanup off)');
}

// --- folders ---
const folder = await store.createFolder(USER_A, { name: 'Meal planning' });
assert(folder.name === 'Meal planning', 'createFolder returns the folder');
{
  await store.updateChat(USER_A, created.chatId, { folderId: folder.folderId });
  const inFolder = await store.listChats(USER_A, { folderId: folder.folderId });
  assert(inFolder.length === 1 && inFolder[0].chatId === created.chatId, 'a chat can be filed into a folder');
}
{
  const folderList = await store.listFolders(USER_A);
  assert(folderList.length === 1, 'listFolders returns the folder');
  const otherUserFolders = await store.listFolders(USER_B);
  assert(otherUserFolders.length === 0, "another user sees no folders");
}
{
  await store.deleteFolder(USER_A, folder.folderId);
  const detail = await store.getChat(USER_A, created.chatId);
  assert(detail.session.folderId === null, 'deleting a folder releases its chats to no-folder');
}

// --- deleteMessage / truncateMessagesFrom (edit/rerun's shared primitive) ---
{
  const chat = await store.createChat(USER_A, { title: 'Delete/truncate scratch' });
  await store.appendMessages(USER_A, chat.chatId, [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
  ]);
  await store.appendMessages(USER_A, chat.chatId, [
    { role: 'user', content: 'U2' },
    { role: 'assistant', content: 'A2' },
  ]);
  const before = await store.getChat(USER_A, chat.chatId);
  const [u1, a1, u2, a2] = before.messages;

  const otherUserDeleted = await store.deleteMessage(USER_B, chat.chatId, a1.messageId);
  assert(otherUserDeleted === false, "another user can't delete a message in someone else's chat (RLS scoping)");

  const deletedMissing = await store.deleteMessage(USER_A, chat.chatId, 'no-such-message-id');
  assert(deletedMissing === false, 'deleting a missing message reports false, does not throw');

  const deletedA1 = await store.deleteMessage(USER_A, chat.chatId, a1.messageId);
  assert(deletedA1 === true, 'deleteMessage reports success');
  const afterDelete = await store.getChat(USER_A, chat.chatId);
  assert(
    afterDelete.messages.length === 3 && afterDelete.messages.every((m) => m.messageId !== a1.messageId),
    'exactly the one targeted message is gone, everything else (including messages after it) survives',
  );
  assert(
    afterDelete.messages.map((m) => m.content).join(',') === 'U1,U2,A2',
    'a standalone delete does not touch message order or any other message',
  );

  const otherUserTruncated = await store.truncateMessagesFrom(USER_B, chat.chatId, u2.messageId);
  assert(otherUserTruncated === false, "another user can't truncate someone else's chat (RLS scoping)");

  const truncatedMissing = await store.truncateMessagesFrom(USER_A, chat.chatId, 'no-such-message-id');
  assert(truncatedMissing === false, 'truncating from a missing message reports false, does not throw');

  const truncated = await store.truncateMessagesFrom(USER_A, chat.chatId, u2.messageId);
  assert(truncated === true, 'truncateMessagesFrom reports success');
  const afterTruncate = await store.getChat(USER_A, chat.chatId);
  assert(
    afterTruncate.messages.length === 1 && afterTruncate.messages[0].messageId === u1.messageId,
    'truncating from U2 removes U2 and everything chronologically after it (A2), leaving only U1',
  );
}

// --- forkChat: copies settings + messages up to the fork point, tracks lineage ---
{
  const forkFolder = await store.createFolder(USER_A, { name: 'Fork test folder' });
  const parent = await store.createChat(USER_A, { title: 'Fork parent', folderId: forkFolder.folderId });
  await store.updateChat(USER_A, parent.chatId, {
    params: { system: 'Stay in character.', temperature: 0.7 },
    toolNames: ['roll_dice'],
  });
  await store.appendMessages(USER_A, parent.chatId, [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
  ]);
  const midDetail = await store.getChat(USER_A, parent.chatId);
  const forkPoint = midDetail.messages[1]; // A1
  await store.appendMessages(USER_A, parent.chatId, [
    { role: 'user', content: 'U2' },
    { role: 'assistant', content: 'A2' },
  ]);

  const forked = await store.forkChat(USER_A, parent.chatId, forkPoint.messageId);
  assert(forked !== undefined, 'forkChat succeeds at a valid message id');
  assert(forked.title === 'Fork of Fork parent', 'a fork with no explicit title defaults to "Fork of {parent title}"');
  assert(forked.folderId === forkFolder.folderId, "a fork inherits the parent's folder");
  assert(forked.params.system === 'Stay in character.', "a fork inherits the parent's params");
  assert(forked.toolNames.length === 1 && forked.toolNames[0] === 'roll_dice', "a fork inherits the parent's toolNames");
  assert(forked.parentChatId === parent.chatId, 'a fork records its parent chat id');
  assert(forked.forkMessageId === forkPoint.messageId, 'a fork records the message it branched from');

  const forkedDetail = await store.getChat(USER_A, forked.chatId);
  assert(
    forkedDetail.messages.length === 2 && forkedDetail.messages.map((m) => m.content).join(',') === 'U1,A1',
    'a fork copies messages up to (and including) the fork point, not anything after it',
  );

  const missingFork = await store.forkChat(USER_A, parent.chatId, 'no-such-message-id');
  assert(missingFork === undefined, "forking from a message id that doesn't exist in the chat returns undefined");

  // --- getLineage: the whole family, root first, reachable from any member ---
  const fromParent = await store.getLineage(USER_A, parent.chatId);
  const fromFork = await store.getLineage(USER_A, forked.chatId);
  assert(
    fromParent.length === 2 && fromFork.length === 2,
    'getLineage returns the whole two-chat family whether asked from the parent or the fork',
  );
  assert(fromParent[0].chatId === parent.chatId, 'getLineage orders the root first');
  assert(
    JSON.stringify(fromParent.map((n) => n.chatId).sort()) === JSON.stringify(fromFork.map((n) => n.chatId).sort()),
    'the family is identical regardless of which member getLineage is asked about',
  );

  const soloChat = await store.createChat(USER_A, { title: 'Never forked' });
  const soloLineage = await store.getLineage(USER_A, soloChat.chatId);
  assert(
    soloLineage.length === 1 && soloLineage[0].chatId === soloChat.chatId,
    'a chat with no forks still returns its own single-node family',
  );

  const missingLineage = await store.getLineage(USER_A, 'no-such-chat-id');
  assert(missingLineage === undefined, 'getLineage on a nonexistent chat id returns undefined');
}

// --- deleteChat ---
{
  const deleted = await store.deleteChat(USER_A, created.chatId);
  assert(deleted === true, 'deleteChat reports success');
  const detail = await store.getChat(USER_A, created.chatId);
  assert(detail === undefined, 'a deleted chat is gone');
  const deletedAgain = await store.deleteChat(USER_A, created.chatId);
  assert(deletedAgain === false, 'deleting a missing chat reports false, does not throw');
}

// --- filterToolRegistry ---
{
  const full = createToolRegistry([
    { definition: { name: 'alpha', description: 'a', parameters: {} }, handler: async () => 'a' },
    { definition: { name: 'beta', description: 'b', parameters: {} }, handler: async () => 'b' },
  ]);
  const filtered = filterToolRegistry(full, ['beta']);
  assert(filtered.definitions().length === 1 && filtered.definitions()[0].name === 'beta', 'filterToolRegistry restricts definitions()');
  assert(filtered.get('beta') !== undefined, 'an allowed tool still resolves');
  assert(filtered.get('alpha') === undefined, 'a non-allowed tool no longer resolves, even though it exists underneath');
  const none = filterToolRegistry(full, []);
  assert(none.definitions().length === 0, 'an empty allow-list yields no tools at all');
}

// --- ensureActiveSwipe: a never-regenerated assistant message gets its own anchorable swipe ---
{
  const chat = await store.createChat(USER_A, { title: 'ensureActiveSwipe scratch' });
  const [msg] = await store.appendMessages(USER_A, chat.chatId, [{ role: 'assistant', content: 'A1' }]);

  const swipeId = await store.ensureActiveSwipe(USER_A, chat.chatId, msg.messageId);
  assert(typeof swipeId === 'string' && swipeId.length > 0, 'ensureActiveSwipe returns a swipe id for a swipe-less message');

  const again = await store.ensureActiveSwipe(USER_A, chat.chatId, msg.messageId);
  assert(again === swipeId, 'ensureActiveSwipe is idempotent — the message\'s own active swipe is returned unchanged on repeat');

  const missing = await store.ensureActiveSwipe(USER_A, chat.chatId, 'no-such-message');
  assert(missing === undefined, 'ensureActiveSwipe returns undefined for a message that is not in the chat');

  const detail = await store.getChat(USER_A, chat.chatId);
  assert(detail.messages[0].swipes.index === 0 && detail.messages[0].swipes.count === 1, 'a single canonical swipe row reads back as {index: 0, count: 1}');
}

// --- forkChat resurrection (§2.7): the fork point's transient/inactive rows come along, cloned
// as fresh transient rows anchored to the branch's own swipe; permanent rows do not ---
{
  const parent = await store.createChat(USER_A, { title: 'Resurrection parent' });
  await store.appendMessages(USER_A, parent.chatId, [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
  ]);
  const detail = await store.getChat(USER_A, parent.chatId);
  const forkPoint = detail.messages[1]; // A1

  // Simulate a scraped turn: the fork-point message has an active swipe, with a transient
  // location + an inactive character anchored to it, plus a permanent location that must not
  // come along.
  const forkSwipeId = randomUUID();
  const parentMsg = pool.messages.find((m) => m.message_id === forkPoint.messageId);
  parentMsg.active_swipe_id = forkSwipeId;
  pool.locations.push({
    location_id: randomUUID(),
    user_id: USER_A,
    name: 'The Dark Cave',
    visual_description: 'Stalactites.',
    environment: { time_of_day: 'night' },
    seed: 42,
    image_url: 'https://cdn.example.invalid/dark-cave.png',
    image_generated_at: '2026-08-13T00:00:00.000Z',
    image_rendered_input: { visual_description: 'Stalactites.', environment: { time_of_day: 'night' }, seed: 42 },
    image_render_hash: 'render-hash-abc',
    status: 'transient',
    anchor_chat_id: parent.chatId,
    anchor_swipe_id: forkSwipeId,
  });
  pool.locations.push({
    location_id: randomUUID(),
    user_id: USER_A,
    name: 'The Forest Clearing',
    visual_description: 'Sunlight.',
    environment: {},
    status: 'permanent',
    anchor_chat_id: null,
    anchor_swipe_id: null,
  });
  pool.characters.push({
    character_id: randomUUID(),
    user_id: USER_A,
    name: 'Goblin Merchant',
    status: 'inactive',
    anchor_chat_id: parent.chatId,
    anchor_swipe_id: forkSwipeId,
  });

  const branch = await store.forkChat(USER_A, parent.chatId, forkPoint.messageId);
  assert(branch !== undefined, 'forkChat succeeds at the swiped fork point');

  const branchMsg = pool.messages.find((m) => m.chat_id === branch.chatId && m.message_id !== undefined && m.content === 'A1');
  assert(branchMsg && branchMsg.active_swipe_id !== forkSwipeId, 'the branch\'s copied fork-point message has its own fresh active swipe (never the parent\'s id)');

  const branchLocations = pool.locations.filter((l) => l.anchor_chat_id === branch.chatId);
  assert(
    branchLocations.length === 1 && branchLocations[0].name === 'The Dark Cave' && branchLocations[0].status === 'transient',
    'the fork point\'s transient location is cloned into the branch as a fresh transient row',
  );
  assert(branchLocations[0].anchor_swipe_id === branchMsg.active_swipe_id, 'the cloned location is anchored to the branch\'s corresponding swipe');
  assert(
    branchLocations[0].seed === 42 && branchLocations[0].image_url === 'https://cdn.example.invalid/dark-cave.png',
    'endpoint.md §6.2: the cloned location carries seed/image_url/image_generated_at forward, so a fork does not force a fresh render',
  );
  assert(
    JSON.stringify(branchLocations[0].image_rendered_input) === JSON.stringify({ visual_description: 'Stalactites.', environment: { time_of_day: 'night' }, seed: 42 }),
    'the cloned location carries the render-input snapshot too, so its cache check (endpoint.md §5.1.2) hits on the branch',
  );
  assert(
    branchLocations[0].image_render_hash === 'render-hash-abc',
    'the cloned location carries the prompt render hash (migration 0076) so its cache check hits on the branch',
  );
  assert(pool.locations.some((l) => l.name === 'The Forest Clearing' && l.anchor_chat_id === null), 'a permanent location is world canon — never cloned into the branch');

  const branchCharacters = pool.characters.filter((c) => c.anchor_chat_id === branch.chatId);
  assert(
    branchCharacters.length === 1 && branchCharacters[0].name === 'Goblin Merchant' && branchCharacters[0].status === 'transient',
    'the fork point\'s inactive character is resurrected into the branch as transient',
  );
}

// --- getChatSyncStatus: the per-chat slice of the rolling sync loop's status record ---
// (chatSessions.ts's getChatSyncStatus, read side of the RP chat header menu's Sync Status
// panel — same columns as server/adminServer.ts's cross-user table, narrowed to one chat and
// scoped by the owner's RLS, no admin key involved. Uses its own dedicated chat — `created` was
// deleted by the deleteChat tests above.)
const syncChat = await store.createChat(USER_A, { title: 'Sync status chat' });
await store.appendMessages(USER_A, syncChat.chatId, [
  { role: 'user', content: 'first unsynced message' },
  { role: 'assistant', content: 'second unsynced message' },
]);
pool.syncStatus.set(syncChat.chatId, {
  user_id: USER_A,
  last_attempt_at: '2026-08-07T12:00:00.000Z',
  last_status: 'ok',
  last_step: null,
  last_error: null,
  last_success_at: '2026-08-07T12:00:00.000Z',
  last_chunks_added: 2,
  last_entries_updated: 1,
  consecutive_errors: 0,
});
pool.canonCounts.set(syncChat.chatId, { proposed: 3, approved: 2, last_proposed_at: '2026-08-07T11:00:00.000Z' });
{
  const sync = await store.getChatSyncStatus(USER_A, syncChat.chatId, 32);
  assert(sync !== undefined, 'getChatSyncStatus finds an existing chat');
  assert(sync.lastStatus === 'ok', 'an ok status row reads back as ok');
  assert(sync.lastChunksAdded === 2 && sync.lastEntriesUpdated === 1, 'last run chunk/entry counts round-trip');
  assert(sync.consecutiveErrors === 0, 'a healthy chat carries zero consecutive errors');
  assert(sync.canonProposedCount === 3 && sync.canonApprovedCount === 2, 'canon proposed/approved counts round-trip');
  assert(sync.canonLastProposedAt === '2026-08-07T11:00:00.000Z', 'last canon proposal timestamp round-trips');
  assert(sync.unsyncedMessages === 2, 'unsynced counts the chat\'s messages past its last sync point');
  assert(sync.dueAfterMessages === 32, 'the caller-supplied due threshold is echoed through');
}
{
  const sync = await store.getChatSyncStatus(USER_B, syncChat.chatId, 32);
  assert(sync === undefined, "another user's getChatSyncStatus can't see the chat (RLS scoping)");
}
{
  const sync = await store.getChatSyncStatus(USER_A, defaultTitled.chatId, 32);
  assert(sync !== undefined, 'a chat that never synced still gets a status read');
  assert(sync.lastStatus === null, 'a never-synced chat has a null last status, not a fabricated one');
  assert(sync.lastAttemptAt === null && sync.lastSuccessAt === null, 'a never-synced chat has no attempt/success timestamps');
  assert(
    sync.consecutiveErrors === 0 && sync.canonProposedCount === 0 && sync.canonApprovedCount === 0,
    'a never-synced chat carries zero errors and zero canon facts',
  );
  assert(sync.unsyncedMessages === 1, 'a never-synced chat counts all its messages as unsynced');
}
{
  pool.syncStatus.set(defaultTitled.chatId, {
    user_id: USER_A,
    last_attempt_at: '2026-08-07T12:30:00.000Z',
    last_status: 'error',
    last_step: 'summarize_embed',
    last_error: 'embeddings provider unreachable',
    last_success_at: '2026-08-07T12:00:00.000Z',
    last_chunks_added: null,
    last_entries_updated: null,
    consecutive_errors: 3,
  });
  const sync = await store.getChatSyncStatus(USER_A, defaultTitled.chatId, 32);
  assert(sync.lastStatus === 'error' && sync.lastStep === 'summarize_embed', 'an error row names the exact step that failed');
  assert(sync.lastError === 'embeddings provider unreachable', 'an error row carries the underlying error message');
  assert(sync.consecutiveErrors === 3, 'consecutive failures round-trip');
  assert(sync.lastSuccessAt === '2026-08-07T12:00:00.000Z', 'the last success timestamp survives an error status');
}
{
  const sync = await store.getChatSyncStatus(USER_A, 'nonexistent-chat', 32);
  assert(sync === undefined, 'getChatSyncStatus on a nonexistent chat returns undefined');
}

if (process.exitCode) {
  console.error('\nchat sessions verification FAILED');
  process.exit(1);
}
console.log('\nchat sessions verification passed');
