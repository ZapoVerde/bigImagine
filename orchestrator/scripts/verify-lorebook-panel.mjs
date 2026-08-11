// Proves the step-6 chat-sidebar backend (docs/lorebook-plan.md §8b, io/lorebook/panelData.ts):
// the per-chat panel read and the quick toggles/quick-add, all against a fake db/settings store
// — no Postgres, no live embedding provider.
//   1. Read: resolved mode (off + isDefault when unset, on when stored); the §3b scope rules
//      (global_scope, character link, enabled chat override; an explicit enabled=false override
//      beats every in-scope path); per-book characterLinked/chatOverrideEnabled; all entries with
//      their gate fields; per-entry chat override state; the §8b live activation badge (entry in
//      lorebook_activation_log for the chat's latest assistant message); empty-panel fail-open.
//   2. Override writes: probe-first — a foreign/hidden id returns false, a visible one upserts
//      (on conflict update) and returns true.
//   3. Quick-add: blank content → undefined; finds the existing chat-scoped book (the one whose
//      only link is one enabled chat override); creates it lazily on first add (book + override +
//      entry, named from the chat title); embeds `${bookName}\n${content}`; fails open when the
//      embedding provider throws (row still inserted with a null vector).

import { createStubEmbeddingProvider } from '../dist/io/embeddings/stub.js';
import {
  getLorebookPanelData,
  quickAddLorebookEntry,
  setLorebookChatOverride,
  setLorebookEntryOverride,
} from '../dist/io/lorebook/panelData.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function settingsStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    store: {
      get: (k) => Promise.resolve(map.get(k)),
      set: async (k, v) => void map.set(k, v),
    },
  };
}

const BOOK_ROW = (lorebook_id, name, global_scope, character_linked, chat_override_enabled) => ({
  lorebook_id,
  name,
  global_scope,
  character_linked,
  chat_override_enabled,
});
const ENTRY_ROW = (entry_id, lorebook_id, overrides = {}) => ({
  entry_id,
  lorebook_id,
  uid: 1,
  key: [],
  comment: '',
  content: `content ${entry_id}`,
  constant: false,
  disable: false,
  order_value: 100,
  probability: 100,
  use_probability: false,
  group_name: '',
  group_weight: 1,
  group_override: false,
  sticky: 0,
  cooldown: 0,
  delay: 0,
  ...overrides,
});

function makeDb({ books = [], entries = [], entryOverrides = [], activation = [], chatBook = null, probe = [{ n: 1 }], throwOn = null } = {}) {
  const calls = [];
  const session = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (throwOn && sql.includes(throwOn)) throw new Error(`${throwOn} boom`);
      if (sql.includes('select b.lorebook_id, b.name from lorebooks b')) return chatBook ? [chatBook] : [];
      if (sql.includes('insert into lorebook_chat_overrides')) return [];
      if (sql.includes('insert into lorebooks')) return [{ lorebook_id: 'new-book' }];
      if (sql.includes('insert into lorebook_entries')) return [{ entry_id: 'new-entry' }];
      if (sql.includes('select 1 as n')) return probe;
      if (sql.includes('b.global_scope')) return books; // panel books-in-scope
      if (sql.includes('from lorebook_entries')) return entries; // panel entries (newline between table and WHERE)
      if (sql.includes('select entry_id, enabled from lorebook_entry_overrides')) return entryOverrides;
      if (sql.includes('select entry_id from lorebook_activation_log')) return activation;
      return [];
    },
  };
  return { db: { withSystemScope: (fn) => fn(session), withUserScope: (_u, fn) => fn(session) }, session, calls };
}

const INPUT = { userId: 'u1', chatId: 'c1', characterId: 'char-1', latestAssistantMessageId: 'm-latest' };

// --- 1a. Mode resolution ---
{
  const { db } = makeDb();
  const data = await getLorebookPanelData(db, settingsStore().store, INPUT);
  assert(data.mode === 'off' && data.modeIsDefault === true, 'unset lorebook_mode -> off with isDefault');
}
{
  const { db } = makeDb();
  const data = await getLorebookPanelData(db, settingsStore({ lorebook_mode: 'on' }).store, INPUT);
  assert(data.mode === 'on' && data.modeIsDefault === false, 'stored on -> on without isDefault');
}

// --- 1b. Scope rules + book surface ---
{
  const { db, calls } = makeDb({
    // The fake returns rows post-WHERE (the scope filter lives in SQL, asserted below) — the
    // disabled-override book is already gone, exactly as the query would drop it.
    books: [
      BOOK_ROW('b-global', 'Global', true, false, null),
      BOOK_ROW('b-char', 'Character', false, true, null),
      BOOK_ROW('b-override', 'Override-on', false, false, true),
    ],
  });
  const data = await getLorebookPanelData(db, settingsStore({ lorebook_mode: 'on' }).store, INPUT);
  assert(data.books.length === 3, 'global/character/override books all surface');
  const names = data.books.map((b) => b.name).sort();
  assert(names.join() === 'Character,Global,Override-on', 'the three in-scope books surface');
  const over = data.books.find((b) => b.lorebookId === 'b-override');
  assert(over?.chatOverrideEnabled === true && over?.globalScope === false, 'override-enabled book carries its chat-override state');
  const charBook = data.books.find((b) => b.lorebookId === 'b-char');
  assert(charBook?.characterLinked === true, 'character-linked book surfaces characterLinked');
  const scopeSql = calls.find((c) => c.sql.includes('b.global_scope'))?.sql ?? '';
  assert(scopeSql.includes('coalesce(lco.enabled, true)'), 'a disabled chat override beats every in-scope path (coalesce filter in SQL)');
  assert(scopeSql.includes('b.global_scope') && scopeSql.includes('lcl.character_id = $2') && scopeSql.includes('lco.enabled'), 'scope union: global_scope or character link or enabled chat override');
  assert(calls.some((c) => c.sql.includes('b.global_scope') && c.params[1] === 'char-1'), 'scope query runs against the chat\'s character id');
}

// --- 1c. Entries + overrides + activation badge + fail-open ---
{
  const { db } = makeDb({
    books: [BOOK_ROW('b1', 'World', true, false, null)],
    entries: [ENTRY_ROW('e1', 'b1'), ENTRY_ROW('e2', 'b1', { constant: true })],
    entryOverrides: [{ entry_id: 'e1', enabled: false }],
    activation: [{ entry_id: 'e2' }],
  });
  const data = await getLorebookPanelData(db, settingsStore().store, INPUT);
  assert(data.books[0].entries.length === 2, 'all entries of an in-scope book surface');
  const e1 = data.books[0].entries.find((e) => e.entryId === 'e1');
  const e2 = data.books[0].entries.find((e) => e.entryId === 'e2');
  assert(e1?.entryOverrideEnabled === false, 'per-entry chat override state surfaces');
  assert(e1?.activatedInLatestTurn === false && e2?.activatedInLatestTurn === true, 'activation badge = present in the latest message\'s log rows');
  assert(e2?.constant === true, 'gate fields (constant) ride through');
}
{
  const { db } = makeDb({ throwOn: 'b.global_scope' });
  const data = await getLorebookPanelData(db, settingsStore().store, INPUT);
  assert(data.mode === 'off' && data.books.length === 0, 'a DB error fails open to an empty, mode-correct panel');
}

// --- 2. Override writes ---
{
  const { db, calls } = makeDb();
  const ok = await setLorebookChatOverride(db, 'u1', 'c1', 'b1', false);
  assert(ok === true, 'book override returns true when the book is visible');
  const upsert = calls.find((c) => c.sql.includes('insert into lorebook_chat_overrides'));
  assert(upsert && upsert.params.join() === 'u1,c1,b1,false', 'book override upserts (user, chat, book, enabled)');
  assert(upsert.sql.includes('on conflict (user_id, chat_id, lorebook_id)'), 'book override uses upsert, not a blind insert');
}
{
  const { db } = makeDb({ probe: [] });
  const missing = await setLorebookChatOverride(db, 'u1', 'c1', 'foreign', true);
  assert(missing === false, 'a hidden/foreign book id returns false (no FK violation)');
}
{
  const { db, calls } = makeDb();
  const ok = await setLorebookEntryOverride(db, 'u1', 'c1', 'e1', true);
  assert(ok === true, 'entry override returns true when the entry is visible');
  const upsert = calls.find((c) => c.sql.includes('insert into lorebook_entry_overrides'));
  assert(upsert && upsert.sql.includes('on conflict (user_id, chat_id, entry_id)'), 'entry override upserts');
}
{
  const { db } = makeDb({ probe: [] });
  assert((await setLorebookEntryOverride(db, 'u1', 'c1', 'foreign', true)) === false, 'a hidden entry id returns false');
}

// --- 3. Quick-add ---
{
  const { db } = makeDb();
  assert((await quickAddLorebookEntry(db, createStubEmbeddingProvider(4), 'u1', 'c1', 'Chat title', '   ')) === undefined, 'blank content -> undefined');
}
{
  const { db, calls } = makeDb({ chatBook: { lorebook_id: 'chat-book', name: 'Chat title' } });
  const result = await quickAddLorebookEntry(db, createStubEmbeddingProvider(4), 'u1', 'c1', 'Chat title', 'red moon');
  assert(result?.bookId === 'chat-book' && result?.entryId === 'new-entry', 'quick-add reuses the existing chat-scoped book');
  const insert = calls.find((c) => c.sql.includes('insert into lorebook_entries'));
  assert(insert && insert.params[3] !== null, 'quick-add embeds the entry (vector literal bound)');
  const embedTarget = insert.params[2]; // content
  assert(embedTarget === 'red moon', 'quick-add trims content before insert');
}
{
  const { db, calls } = makeDb();
  const result = await quickAddLorebookEntry(db, createStubEmbeddingProvider(4), 'u1', 'c1', '  My Chat  ', 'note');
  assert(result?.bookId === 'new-book' && result?.entryId === 'new-entry', 'first quick-add lazily creates the book');
  const bookInsert = calls.find((c) => c.sql.includes('insert into lorebooks'));
  assert(bookInsert && bookInsert.params[1] === 'My Chat', 'the created book is named after the chat title (trimmed)');
  const overrideInsert = calls.find((c) => c.sql.includes('insert into lorebook_chat_overrides'));
  assert(overrideInsert && overrideInsert.sql.includes('$3, true'), 'the created book is linked via an enabled chat override');
}
{
  // Embedding fail-open: the row still lands, with a null vector.
  const throwing = { embed: async () => { throw new Error('embed boom'); } };
  const { db, calls } = makeDb({ chatBook: { lorebook_id: 'chat-book', name: 'Chat title' } });
  const result = await quickAddLorebookEntry(db, throwing, 'u1', 'c1', 'Chat title', 'x');
  assert(result?.entryId === 'new-entry', 'embedding failure fails open -> entry still created');
  const insert = calls.find((c) => c.sql.includes('insert into lorebook_entries'));
  assert(insert && insert.params[3] === null, 'the failed embed binds a null vector');
}

if (process.exitCode) {
  console.error('\nlorebook-panel verify FAILED');
} else {
  console.log('\nlorebook-panel verify passed');
}
