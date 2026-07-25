// Proves all five tools end to end through info/registerTools (the real loader contract) using a
// small stateful fake Postgres pool that simulates the notes table across a sequence of calls —
// same style as lists/shopping-analytics's verify scripts.

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { info, registerTools } from '../dist/index.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakePool() {
  const notes = [];
  let counter = 0;

  return {
    notes,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          if (sql.startsWith('insert into notes')) {
            const [userId, title, content] = params;
            assert(scopedUserId === userId, 'create_note is scoped to the requesting user');
            const note = {
              note_id: `note-${++counter}`,
              user_id: userId,
              title: title ?? 'Untitled note',
              content,
              tags: [],
              created_at: `2026-07-24T00:00:${String(counter).padStart(2, '0')}Z`,
              updated_at: `2026-07-24T00:00:${String(counter).padStart(2, '0')}Z`,
            };
            notes.push(note);
            return { rows: [{ note_id: note.note_id, title: note.title, content: note.content }] };
          }

          if (sql.startsWith('select note_id, title, updated_at from notes')) {
            const [userId, like] = params;
            assert(scopedUserId === userId, 'get_notes is scoped to the requesting user');
            const matches = notes
              .filter((n) => n.user_id === userId)
              .filter((n) => {
                if (!like) return true;
                const term = like.slice(1, -1).toLowerCase();
                return n.title.toLowerCase().includes(term) || n.content.toLowerCase().includes(term);
              })
              .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
            return { rows: matches.map((n) => ({ note_id: n.note_id, title: n.title, updated_at: n.updated_at })) };
          }

          if (sql.startsWith('select note_id, title, content, tags, created_at, updated_at from notes')) {
            const [noteId, userId] = params;
            assert(scopedUserId === userId, 'get_note is scoped to the requesting user');
            const note = notes.find((n) => n.note_id === noteId && n.user_id === userId);
            return { rows: note ? [note] : [] };
          }

          if (sql.startsWith('update notes set')) {
            const [noteId, userId, ...rest] = params;
            assert(scopedUserId === userId, 'update_note is scoped to the requesting user');
            const note = notes.find((n) => n.note_id === noteId && n.user_id === userId);
            if (!note) return { rows: [] };
            // sets order matches updateNoteTool.ts: title?, content?, tags? — walk whichever were included
            let i = 0;
            if (sql.includes('title = $')) note.title = rest[i++];
            if (sql.includes('content = $')) note.content = rest[i++];
            if (sql.includes('tags = $')) note.tags = rest[i++];
            note.updated_at = `2026-07-24T01:00:${String(++counter).padStart(2, '0')}Z`;
            return { rows: [{ note_id: note.note_id, title: note.title, content: note.content, tags: note.tags, updated_at: note.updated_at }] };
          }

          if (sql.startsWith('delete from notes')) {
            const [noteId, userId] = params;
            assert(scopedUserId === userId, 'delete_note is scoped to the requesting user');
            const idx = notes.findIndex((n) => n.note_id === noteId && n.user_id === userId);
            if (idx === -1) return { rows: [] };
            const [deleted] = notes.splice(idx, 1);
            return { rows: [{ note_id: deleted.note_id }] };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

assert(info.id === 'notes' && /^[a-z0-9_-]+$/.test(info.id), 'info.id is present and matches the required format');

const pluginTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion: undefined });
assert(pluginTools.length === 5, 'registerTools returns exactly five tools');

const registry = createToolRegistry(pluginTools);
for (const name of ['create_note', 'get_notes', 'get_note', 'update_note', 'delete_note']) {
  assert(registry.definitions().some((d) => d.name === name), `${name} is registered`);
}

const pool = createFakePool();
const db = createPostgresClient(pool);
const userId = '11111111-1111-1111-1111-111111111111';
const otherUserId = '22222222-2222-2222-2222-222222222222';

const createTool = registry.get('create_note');
const getNotesTool = registry.get('get_notes');
const getNoteTool = registry.get('get_note');
const updateTool = registry.get('update_note');
const deleteTool = registry.get('delete_note');

// --- create_note ---
const withTitle = await db.withUserScope(userId, (session) =>
  createTool.handler({ title: 'Trip plan', content: 'Pack sunscreen' }, { userId, db: session }),
);
assert(withTitle.title === 'Trip plan' && withTitle.content === 'Pack sunscreen', 'create_note stores the given title/content');

const untitled = await db.withUserScope(userId, (session) =>
  createTool.handler({ content: 'Buy milk' }, { userId, db: session }),
);
assert(untitled.title === 'Untitled note', 'create_note defaults the title when omitted');

const otherUsersNote = await db.withUserScope(otherUserId, (session) =>
  createTool.handler({ content: 'Not yours' }, { userId: otherUserId, db: session }),
);

// --- get_notes ---
const all = await db.withUserScope(userId, (session) => getNotesTool.handler({}, { userId, db: session }));
assert(all.length === 2, 'get_notes only returns the requesting user\'s notes');
assert(!('content' in all[0]), 'get_notes summaries omit content');
assert(all[0].title === 'Untitled note', 'get_notes orders by updated_at desc (most recently created first)');

const searched = await db.withUserScope(userId, (session) =>
  getNotesTool.handler({ search: 'sunscreen' }, { userId, db: session }),
);
assert(searched.length === 1 && searched[0].title === 'Trip plan', 'get_notes search matches content, not just title');

// --- get_note ---
const found = await db.withUserScope(userId, (session) =>
  getNoteTool.handler({ note_id: withTitle.noteId }, { userId, db: session }),
);
assert(found.found === true && found.content === 'Pack sunscreen', 'get_note returns full content for an owned note');

const crossUser = await db.withUserScope(userId, (session) =>
  getNoteTool.handler({ note_id: otherUsersNote.noteId }, { userId, db: session }),
);
assert(crossUser.found === false, 'get_note cannot see another user\'s note');

// --- update_note ---
const updated = await db.withUserScope(userId, (session) =>
  updateTool.handler({ note_id: withTitle.noteId, content: 'Pack sunscreen and passports' }, { userId, db: session }),
);
assert(updated.found === true && updated.content === 'Pack sunscreen and passports', 'update_note changes only the given field');
assert(updated.title === 'Trip plan', 'update_note leaves an unspecified field untouched');

const updateMissing = await db.withUserScope(userId, (session) =>
  updateTool.handler({ note_id: 'does-not-exist', title: 'x' }, { userId, db: session }),
);
assert(updateMissing.found === false, 'update_note reports not-found for a missing note rather than throwing');

// --- delete_note ---
const deleted = await db.withUserScope(userId, (session) =>
  deleteTool.handler({ note_id: withTitle.noteId }, { userId, db: session }),
);
assert(deleted.deleted === true, 'delete_note reports success for an owned note');

const afterDelete = await db.withUserScope(userId, (session) => getNotesTool.handler({}, { userId, db: session }));
assert(afterDelete.length === 1, 'the deleted note no longer appears in get_notes');

const deleteMissing = await db.withUserScope(userId, (session) =>
  deleteTool.handler({ note_id: 'does-not-exist' }, { userId, db: session }),
);
assert(deleteMissing.deleted === false, 'delete_note reports failure for a missing note rather than throwing');

if (process.exitCode) {
  console.error('\nnotes verification FAILED');
  process.exit(1);
}
console.log('\nnotes verification passed');
