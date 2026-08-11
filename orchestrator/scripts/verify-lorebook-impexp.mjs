// Proves the step-7 import/export hub (docs/lorebook-plan.md §8a, bi_principles.md §7,
// adminServer.ts importLorebookWorldInfo / exportLorebookWorldInfo) against a fake db — no
// Postgres, no live embedding provider.
//   1. Import: an ST world-info export `{ name, entries: { [uid]: entryObject } }` (0051's
//      format) creates the book + one row per entry with the mapped columns, uid from the object
//      key, source_json = the verbatim entryObject, and a batched `${bookName}\n${content}`
//      embed. Blank name / non-integer uid / non-object entry / unknown user all reject.
//   2. Export reverses it losslessly: a non-empty source_json round-trips byte-for-byte; a
//      UI-created entry (source_json '{}') reconstructs an ST-shaped object using ST's own field
//      names so the export is still a valid ST import. Missing book -> undefined.

import { createStubEmbeddingProvider } from '../dist/io/embeddings/stub.js';
import { exportLorebookWorldInfo, importLorebookWorldInfo } from '../dist/server/adminServer.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// Captures every embed call's input so the `${bookName}\n${content}` target can be asserted.
function capturingEmbed(dim = 4) {
  const calls = [];
  return {
    provider: { name: 'capture', dimension: dim, embed: async (texts) => { calls.push(...texts); return texts.map(() => Array(dim).fill(0.25)); } },
    calls,
  };
}

function makeDb({ user = 'u1', book = 'b1', entryRows = [], throwOn = null } = {}) {
  const calls = [];
  const session = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (throwOn && sql.includes(throwOn)) throw new Error(`${throwOn} boom`);
      if (sql.includes('select user_id from users')) return user ? [{ user_id: user }] : [];
      if (sql.includes('insert into lorebooks')) return [{ lorebook_id: book }];
      if (sql.includes('insert into lorebook_entries')) return [{ entry_id: 'e-new' }];
      if (sql.includes('select name from lorebooks')) return book ? [{ name: 'World' }] : [];
      if (sql.includes('from lorebook_entries')) return entryRows;
      return [];
    },
  };
  return { db: { withSystemScope: (fn) => fn(session), withUserScope: (_u, fn) => fn(session) }, session, calls };
}

const ST_ENTRY = {
  key: ['castle', 'keep'],
  keysecondary: ['tower'],
  comment: 'the seat of power',
  content: 'Castle Blackwatch stands on the cliff.',
  constant: false,
  selective: true,
  selectiveLogic: 2,
  addMemo: true,
  order: 50,
  position: 1,
  disable: false,
  excludeRecursion: true,
  probability: 80,
  useProbability: true,
  depth: 3,
  group: 'Locations',
  groupOverride: false,
  groupWeight: 2,
  scanDepth: 1,
  caseSensitive: false,
  matchWholeWords: false,
  automationId: 'wi-123',
  role: 0,
  sticky: 1,
  cooldown: 2,
  delay: 0,
};

// --- 1. Import ---
{
  const { db, calls } = makeDb();
  const { provider, calls: embedCalls } = capturingEmbed();
  const result = await importLorebookWorldInfo(
    db,
    provider,
    'u1',
    '  Blackwatch  ',
    { 0: ST_ENTRY, 7: { content: 'A second entry.', key: ['gate'] } },
  );
  assert(result?.name === 'Blackwatch' && result?.entryCount === 2 && result?.lorebookId === 'b1', 'import trims the name and reports the entry count');
  const inserts = calls.filter((c) => c.sql.includes('insert into lorebook_entries'));
  assert(inserts.length === 2, 'one insert per imported entry');
  const first = inserts.find((c) => c.params[2] === 0);
  assert(first !== undefined, 'the ST uid (object key) becomes the uid column');
  assert(first.params[3].join() === 'castle,keep' && first.params[4].join() === 'tower', 'key/keysecondary map to text[] columns');
  assert(first.params[6] === 'Castle Blackwatch stands on the cliff.', 'content maps through');
  assert(first.params[10] === 50 && first.params[11] === 1 && first.params[12] === 80 && first.params[13] === 3, 'order/position/probability/depth map to their columns');
  assert(first.params[14] === 'Locations' && first.params[15] === true && first.params[16] === 2 && first.params[17] === false, 'group/useProbability/groupWeight/groupOverride map through');
  assert(first.params[18] === 1 && first.params[19] === 2 && first.params[20] === 0, 'sticky/cooldown/delay map through');
  assert(JSON.parse(first.params[21]).selectiveLogic === 2, 'source_json holds the verbatim entryObject (rarer fields preserved)');
  assert(JSON.parse(first.params[21]).automationId === 'wi-123', 'automationId survives in source_json (round-trip only, §9)');
  assert(first.params[22] !== null, 'import embeds content (batched) — vector literal bound');
  assert(embedCalls.length === 2, 'one batched embed call covers every entry');
  assert(embedCalls[0] === 'Blackwatch\nCastle Blackwatch stands on the cliff.', 'embed text = `${bookName}\\n${content}`');
}
{
  const { db } = makeDb();
  assert((await importLorebookWorldInfo(db, createStubEmbeddingProvider(4), 'u1', '   ', { 0: ST_ENTRY })) === undefined, 'blank name -> undefined');
  assert((await importLorebookWorldInfo(db, createStubEmbeddingProvider(4), 'u1', 'World', { 'x': ST_ENTRY })) === undefined, 'non-integer uid key -> undefined');
  assert((await importLorebookWorldInfo(db, createStubEmbeddingProvider(4), 'u1', 'World', { 0: 'not an object' })) === undefined, 'non-object entry value -> undefined');
  assert((await importLorebookWorldInfo(db, createStubEmbeddingProvider(4), 'u1', 'World', 'nope')) === undefined, 'non-object entries -> undefined');
}
{
  const { db } = makeDb({ user: null });
  assert((await importLorebookWorldInfo(db, createStubEmbeddingProvider(4), 'ghost', 'World', { 0: ST_ENTRY })) === undefined, 'unknown user -> undefined');
}
{
  const throwing = { embed: async () => { throw new Error('embed boom'); } };
  const { db, calls } = makeDb();
  const result = await importLorebookWorldInfo(db, throwing, 'u1', 'World', { 0: { content: 'x' } });
  assert(result?.entryCount === 1, 'embed failure fails open -> entries still import');
  const insert = calls.find((c) => c.sql.includes('insert into lorebook_entries'));
  assert(insert.params[22] === null, 'the failed embed binds null vectors');
}

// --- 2. Export ---
function exportRow(overrides = {}) {
  return {
    uid: 0,
    key: [],
    keysecondary: [],
    comment: '',
    content: 'content',
    constant: false,
    selective: true,
    disable: false,
    order_value: 100,
    position: 0,
    probability: 100,
    depth: null,
    group_name: '',
    use_probability: false,
    group_weight: 1,
    group_override: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    source_json: {},
    ...overrides,
  };
}
{
  // Verbatim round-trip: the imported entry's source_json comes back untouched, keyed by uid.
  const { db } = makeDb({ entryRows: [exportRow({ uid: 7, source_json: ST_ENTRY })] });
  const exported = await exportLorebookWorldInfo(db, 'u1', 'b1');
  assert(exported?.name === 'World', 'export surfaces the book name');
  assert(exported.entries['7'] === ST_ENTRY, 'a non-empty source_json round-trips byte-for-byte (same object reference)');
  assert(Object.keys(exported.entries).length === 1, 'each exported entry is keyed by its uid');
}
{
  // Reconstruction: UI-created entries (source_json '{}') come out as an ST-shaped object with
  // ST's own field names, so the export is still a valid ST import.
  const { db } = makeDb({
    entryRows: [
      exportRow({ uid: 3, content: 'c', key: ['a'], order_value: 40, group_name: 'G', sticky: 2, delay: 1 }),
    ],
  });
  const exported = await exportLorebookWorldInfo(db, 'u1', 'b1');
  const e = exported.entries['3'];
  assert(e.key.join() === 'a' && e.content === 'c', 'reconstructed entry carries the modeled fields');
  assert(e.order === 40 && e.group === 'G', 'reconstruction uses ST field names (order/group, not order_value/group_name)');
  assert(e.sticky === 2 && e.delay === 1, 'timed-effect fields reconstruct');
  assert(e.useProbability === false && e.groupWeight === 1 && e.groupOverride === false, 'defaulted gate fields reconstruct');
}
{
  const { db } = makeDb({ book: null });
  assert((await exportLorebookWorldInfo(db, 'u1', 'missing')) === undefined, 'a missing/hidden book -> undefined');
}

if (process.exitCode) {
  console.error('\nlorebook-impexp verify FAILED');
} else {
  console.log('\nlorebook-impexp verify passed');
}
