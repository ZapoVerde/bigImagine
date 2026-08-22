// Proves the step-5 admin surface for the Lorebooks page (docs/lorebook-plan.md §8a): the
// settings trio (get/parse/set over the §3d keys, defaults mirroring resolveLorebook.ts) and the
// library/entry CRUD wrappers (cross-user read, per-user-scope writes, cascade-friendly deletes,
// embed-on-write for vector_embed). All against a fake db/settings store — no Postgres, no live
// embedding provider.
//   1. Settings: unset keys resolve to the documented defaults (mode off, topK 8, budget
//      unlimited → null, recursion off) with isDefault flags; a stored 'Infinity' budget reads
//      back as null; set writes the canonical spellings (null budget → 'Infinity').
//   2. Parse: empty object / bad shapes → undefined; null budget and all four valid fields pass.
//   3. CRUD: the roster-then-per-user read assembles books with entries, coalesced character ids,
//      and chat-override counts; writes run under the owning user's scope and detect absence via
//      the exists-probe; entry create/update re-embeds `${bookName}\n${content}` and fails open
//      when the embedding provider throws.

import { createStubEmbeddingProvider } from '../dist/io/embeddings/stub.js';
import {
  createLorebookAdmin,
  createLorebookEntryAdmin,
  deleteLorebookAdmin,
  deleteLorebookEntryAdmin,
  getLorebookSettings,
  getLorebooksAdmin,
  parseSetLorebookSettingsBody,
  setLorebookSettings,
  updateLorebookAdmin,
  updateLorebookEntryAdmin,
} from '../dist/server/adminServer.js';

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
    map,
    store: {
      get: (k) => Promise.resolve(map.get(k)),
      set: async (k, v) => void map.set(k, v),
    },
  };
}

function makeDb({ users = [], books = [], entries = [], probe = [{ n: 1 }], throwOn = null } = {}) {
  const calls = [];
  const session = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (throwOn && sql.includes(throwOn)) throw new Error(`${throwOn} boom`);
      if (sql.includes('insert into lorebooks')) {
        return [{ lorebook_id: 'new-book', name: params[1], global_scope: false, created_at: 't', updated_at: 't' }];
      }
      if (sql.includes('insert into lorebook_entries')) {
        return [
          {
            entry_id: 'new-entry',
            uid: 1,
            key: [],
            comment: '',
            content: params[4],
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
            updated_at: 't',
          },
        ];
      }
      if (sql.includes('from lorebook_entries where entry_id')) return [{ lorebook_id: 'b1', content: 'old content' }];
      if (sql.includes('select 1 as n')) return probe;
      if (sql.includes('select user_id from users')) return users;
      if (sql.includes('from lorebooks b')) return books;
      if (sql.includes('from lorebook_entries where lorebook_id')) return entries;
      if (sql.includes('select name from lorebooks')) return [{ name: 'Book' }];
      return [];
    },
  };
  return { db: { withSystemScope: (fn) => fn(session), withUserScope: (_u, fn) => fn(session) }, session, calls };
}

// --- 1. Settings read defaults + overrides ---
{
  const { store } = settingsStore();
  const s = await getLorebookSettings(store);
  assert(s.lorebookMode === 'off' && s.lorebookModeIsDefault, 'unset mode -> off with isDefault');
  assert(s.lorebookTokenBudget === null && s.lorebookTokenBudgetIsDefault, 'unset budget -> null (unlimited) with isDefault');
  assert(s.lorebookRecallTopK === 8 && s.lorebookRecallTopKIsDefault, 'unset recall top-K -> 8 with isDefault');
  assert(s.lorebookRecursionEnabled === false && s.lorebookRecursionEnabledIsDefault, 'unset recursion -> false with isDefault');
}
{
  const { store } = settingsStore({
    lorebook_mode: 'on',
    lorebook_token_budget: '250',
    lorebook_recall_top_k: '12',
    lorebook_recursion_enabled: 'true',
  });
  const s = await getLorebookSettings(store);
  assert(s.lorebookMode === 'on' && !s.lorebookModeIsDefault, 'stored mode on is read through');
  assert(s.lorebookTokenBudget === 250 && !s.lorebookTokenBudgetIsDefault, 'stored budget 250 is read through');
  assert(s.lorebookRecallTopK === 12 && !s.lorebookRecallTopKIsDefault, 'stored top-K 12 is read through');
  assert(s.lorebookRecursionEnabled === true && !s.lorebookRecursionEnabledIsDefault, 'stored recursion true is read through');
}
{
  const { store } = settingsStore({ lorebook_token_budget: 'Infinity' });
  const s = await getLorebookSettings(store);
  assert(s.lorebookTokenBudget === null, "a stored 'Infinity' budget reads back as null (unlimited)");
}

// --- 2. Parse + write ---
{
  assert(parseSetLorebookSettingsBody({}) === undefined, 'empty body -> undefined');
  assert(parseSetLorebookSettingsBody({ lorebook_mode: 'sometimes' }) === undefined, 'bad mode -> undefined');
  assert(parseSetLorebookSettingsBody({ lorebook_token_budget: -5 }) === undefined, 'negative budget -> undefined');
  assert(parseSetLorebookSettingsBody({ lorebook_recall_top_k: 1.5 }) === undefined, 'non-integer top-K -> undefined');
  const parsed = parseSetLorebookSettingsBody({
    lorebook_mode: 'on',
    lorebook_token_budget: null,
    lorebook_recall_top_k: 10,
    lorebook_recursion_enabled: true,
  });
  assert(
    parsed !== undefined && parsed.lorebookMode === 'on' && parsed.lorebookTokenBudget === null && parsed.lorebookRecallTopK === 10 && parsed.lorebookRecursionEnabled === true,
    'all four valid fields parse (null budget included)',
  );
}
{
  const { store, map } = settingsStore();
  await setLorebookSettings(store, { lorebookMode: 'on', lorebookTokenBudget: null, lorebookRecallTopK: 10, lorebookRecursionEnabled: true });
  assert(map.get('lorebook_mode') === 'on', 'set writes mode');
  assert(map.get('lorebook_token_budget') === 'Infinity', 'a null budget is stored as Infinity');
  assert(map.get('lorebook_recall_top_k') === '10', 'set writes top-K as string');
  assert(map.get('lorebook_recursion_enabled') === 'true', 'set writes recursion as string');
}

// --- 3. Library read (roster + per-user scan) ---
{
  const { db } = makeDb({
    users: [{ user_id: 'u1' }],
    books: [
      {
        lorebook_id: 'b1',
        name: 'World',
        global_scope: true,
        created_at: 't',
        updated_at: 't',
        chat_override_count: 2,
         character_ids: ['c1', 'c2'],
         card_ids: ['card-1'],
      },
    ],
    entries: [
      {
        entry_id: 'e1',
        uid: 1,
        key: ['castle'],
        comment: '',
        content: 'castle lore',
        constant: true,
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
        updated_at: 't',
      },
    ],
  });
  const rows = await getLorebooksAdmin(db);
  assert(rows.length === 1 && rows[0].lorebookId === 'b1' && rows[0].userId === 'u1', 'one book surfaced with its owner');
  assert(rows[0].globalScope === true && rows[0].chatOverrideCount === 2, 'global-scope flag + chat-override count surface');
   assert(rows[0].characterIds.join() === 'c1,c2', 'character links surface as id list');
   assert(rows[0].cardIds.join() === 'card-1', 'Card links surface as id list');
  assert(rows[0].entries.length === 1 && rows[0].entries[0].content === 'castle lore' && rows[0].entries[0].constant === true, 'entries surface with gate fields');
}

// --- 4. CRUD writes ---
{
  const { db, calls } = makeDb();
  const created = await createLorebookAdmin(db, 'u1', 'World');
  assert(created?.name === 'World' && created?.userId === 'u1', 'create returns the row (route-level trim, wrapper verbatim)');
  assert(calls.some((c) => c.sql.includes('insert into lorebooks')), 'create issued the insert');
}
{
  const { db } = makeDb();
  const updated = await updateLorebookAdmin(db, 'u1', 'b1', { globalScope: true, characterIds: ['c1'] });
  assert(updated === true, 'update returns true when the row existed (probe row present)');
  const missing = await updateLorebookAdmin(makeDb({ probe: [] }).db, 'u1', 'nope', { name: 'X' });
  assert(missing === false, 'update of a foreign/missing row returns false');
  const deleted = await deleteLorebookAdmin(makeDb({ probe: [] }).db, 'u1', 'b1');
  assert(deleted === true, 'delete returns true (row gone after probe)');
}
{
  const { db, calls } = makeDb();
  const entry = await createLorebookEntryAdmin(db, createStubEmbeddingProvider(4), 'u1', { lorebookId: 'b1', content: 'red moon' });
  assert(entry?.entryId === 'new-entry' && entry?.content === 'red moon', 'entry create returns the inserted row');
  const insertCall = calls.find((c) => c.sql.includes('insert into lorebook_entries'));
  assert(insertCall && insertCall.params[16] !== null, 'entry create embeds content -> vector literal bound');
}
{
  const { db, calls } = makeDb();
  const ok = await updateLorebookEntryAdmin(db, createStubEmbeddingProvider(4), 'u1', 'e1', { content: 'new text' });
  assert(ok === true, 'entry update returns true');
  const updateCall = calls.find((c) => c.sql.includes('update lorebook_entries set'));
  assert(updateCall && updateCall.sql.includes('vector_embed'), 'content change re-embeds (vector_embed in the SET list)');
}
{
  const { db } = makeDb({ throwOn: 'insert into lorebook_entries' });
  let rejected = false;
  try {
    await createLorebookEntryAdmin(db, createStubEmbeddingProvider(4), 'u1', { lorebookId: 'b1', content: 'x' });
  } catch {
    rejected = true;
  }
  assert(rejected, "a DB insert failure rejects — the route layer's try/catch turns it into a 500");
}
{
  // Embedding fail-open: a throwing provider still creates the row with a null vector.
  const throwing = { embed: async () => { throw new Error('embed boom'); } };
  const { db, calls } = makeDb();
  const entry = await createLorebookEntryAdmin(db, throwing, 'u1', { lorebookId: 'b1', content: 'y' });
  assert(entry?.entryId === 'new-entry', 'embedding failure fails open -> entry still created');
  const insertCall = calls.find((c) => c.sql.includes('insert into lorebook_entries'));
  assert(insertCall && insertCall.params[16] === null, 'the failed embed binds a null vector');
}

if (process.exitCode) {
  console.error('\nlorebook-admin verify FAILED');
} else {
  console.log('\nlorebook-admin verify passed');
}
