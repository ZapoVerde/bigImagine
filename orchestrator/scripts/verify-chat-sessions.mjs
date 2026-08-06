// Proves io/chatSessions.ts's CRUD/search/append logic against a fake in-memory pool (no real
// Postgres), mirroring verify-provider-credentials.mjs's style, plus toolRegistry.ts's
// filterToolRegistry wrapper.

import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../dist/io/postgres.js';
import { createChatSessionStore } from '../dist/io/chatSessions.js';
import { createToolRegistry, filterToolRegistry } from '../dist/orchestrator/toolRegistry.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake pool: in-memory chat_sessions / chat_messages / folders tables ---
function createFakePool() {
  const sessions = new Map(); // chat_id -> row
  const messages = []; // {message_id, chat_id, user_id, role, content, created_at}
  const folders = new Map(); // folder_id -> row
  let clock = 1000;
  const now = () => new Date((clock += 1000)).toISOString();

  return {
    sessions,
    messages,
    folders,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          // chat_sessions
          if (sql.includes('insert into chat_sessions')) {
            const [userId, title, folderId] = params;
            const row = {
              chat_id: randomUUID(),
              user_id: userId,
              title: title ?? 'New chat',
              folder_id: folderId,
              params: {},
              tool_names: null,
              canvas_note_id: null,
              created_at: now(),
              updated_at: now(),
            };
            sessions.set(row.chat_id, row);
            return { rows: [row] };
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
            };
            messages.push(row);
            return { rows: [row] };
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

const defaultTitled = await store.createChat(USER_A);
assert(defaultTitled.title === 'New chat', 'createChat defaults the title');

{
  const list = await store.listChats(USER_A);
  assert(list.length === 2, 'listChats returns both chats');
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

if (process.exitCode) {
  console.error('\nchat sessions verification FAILED');
  process.exit(1);
}
console.log('\nchat sessions verification passed');
