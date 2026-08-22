// Proves io/lorebook/ — the three §4 IO wrappers of the Lorebook plan (docs/lorebook-plan.md):
//   1. recallLorebookEntries — scoped vector-discovery. The fake session cannot run real SQL, so
//      the scope/ordering contract is pinned by asserting the generated query's shape (every
//      §3b scope path present, no keyword-match evaluation, constants-before-ranked union,
//      top-K limit on ranked only) plus the wrapper's behavior around it: clean-and-skip on
//      empty query, topK clamping, and the fail-open contract on embed/DB errors.
//   2. fetchLorebookTimedEffectState — most-recent-activation-per-entry read with
//      turns_since_activation coerced to a number; [] on empty input or DB error.
//   3. writeLorebookActivationLog — deduped INSERT..RETURNING; 0 on empty input or DB error.

import { createStubEmbeddingProvider } from '../dist/io/embeddings/stub.js';
import { recallLorebookEntries, DEFAULT_LOREBOOK_RECALL_TOP_K } from '../dist/io/lorebook/recallLorebookEntries.js';
import { fetchLorebookTimedEffectState } from '../dist/io/lorebook/fetchLorebookTimedEffectState.js';
import { writeLorebookActivationLog } from '../dist/io/lorebook/writeLorebookActivationLog.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// DbSession.query returns T[] directly (postgres.ts), NOT pg's {rows} shape. The fake records
// every (sql, params) call so the wrapper's generated query can be pinned down by shape, and
// dispatches canned rows by SQL fragment.
function createFakeSession({ rows = [], throwOn = null } = {}) {
  return {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      if (throwOn && sql.includes(throwOn)) throw new Error(`${throwOn} boom`);
      if (sql.includes('insert into lorebook_activation_log')) return [{ activation_id: 'a1' }, { activation_id: 'a2' }];
      if (sql.includes('from constants c')) return rows; // the recall union's outer select
      if (sql.includes('lorebook_activation_log')) return rows;
      return [];
    },
  };
}

const embeddings = createStubEmbeddingProvider(4);
const USER = 'u1';
const CHAR = 'c1';
const CHAT = 'ch1';

// --- 1. recallLorebookEntries: query shape ---
{
  const session = createFakeSession({
    rows: [{ entry_id: 'e1', constant: false }],
  });
  await recallLorebookEntries(session, embeddings, USER, CHAR, CHAT, 'some query text', 8);
  const sql = session.calls[0].sql;
  assert(sql.includes('join lorebooks b on b.lorebook_id = e.lorebook_id'), 'candidates join their book');
  assert(sql.includes('b.global_scope'), 'global-scope books are in scope');
   assert(sql.includes('lorebook_character_links') && sql.includes('lcl.character_id = $2'), 'character links bring a book into scope');
   assert(sql.includes('character_chat_links') && sql.includes('ccl.chat_id = $3'), 'runtime Character links are scoped to the current chat');
   assert(sql.includes('lorebook_card_links') && sql.includes('lcard.card_id = $6'), 'Card links bring a book into scope');
  assert(sql.includes('lorebook_chat_overrides') && sql.includes('lco.enabled'), 'enabled chat overrides bring a book into scope');
  assert(sql.includes('not lco.enabled'), 'an explicit disabled chat override beats the in-scope paths');
  assert(sql.includes('lorebook_entry_overrides') && sql.includes('not leo.enabled'), 'an entry override can remove a single entry');
  assert(sql.includes('not e.disable'), 'disabled entries never fire');
  assert(!/e\.key\s*=|keysecondary|selective|scan_depth|case_sensitive|match_whole_words/.test(sql), 'no keyword-match discovery in the query');
  assert(sql.includes('where constant') && sql.includes('where not constant and vector_embed is not null'), 'constant entries are always candidates; ranked needs an embedding');
  assert(sql.includes('select 0 as _sort') && sql.includes('select 1 as _sort'), 'constants and ranked are unioned with a sort column');
  assert(sql.includes('order by t._sort, t.vector_embed <-> $4 nulls last, t.order_value'), 'result order is constants first, then similarity, order_value tiebreak');
  const limitIdx = sql.indexOf('limit $5');
  assert(limitIdx > sql.indexOf('ranked as (') && limitIdx < sql.indexOf('select 0 as _sort'), 'the top-K limit applies to the ranked set only, never to constants');
   assert(session.calls[0].params[3].startsWith('['), 'the embedded query is passed as a pgvector literal');
   assert(session.calls[0].params[5] === '00000000-0000-0000-0000-000000000000', 'missing Card scope binds the all-zero uuid');
}
{
  const session = createFakeSession({ rows: [] });
  await recallLorebookEntries(session, embeddings, USER, CHAR, CHAT, 'x', 8, 'card-1');
  assert(session.calls[0].params[5] === 'card-1', 'explicit Card scope is passed to the recall query');
}

// --- 1b. topK clamping + default ---
{
  const session = createFakeSession({ rows: [] });
  await recallLorebookEntries(session, embeddings, USER, CHAR, CHAT, 'x', 9999);
  assert(session.calls[0].params[4] === 50, 'topK is clamped to MAX_LOREBOOK_RECALL_TOP_K (50)');
}
{
  const session = createFakeSession({ rows: [] });
  await recallLorebookEntries(session, embeddings, USER, CHAR, CHAT, 'x', 0);
  assert(session.calls[0].params[4] === 1, 'topK of 0 is floored to 1');
}
{
  const session = createFakeSession({ rows: [] });
  await recallLorebookEntries(session, embeddings, USER, CHAR, CHAT, 'x');
  assert(session.calls[0].params[4] === DEFAULT_LOREBOOK_RECALL_TOP_K && DEFAULT_LOREBOOK_RECALL_TOP_K === 8, 'topK defaults to 8, mirroring canon_recall_top_k');
}

// --- 1c. empty query / fail-open ---
{
  const session = createFakeSession({ rows: [{ entry_id: 'e1' }] });
  const out = await recallLorebookEntries(session, embeddings, USER, CHAR, CHAT, '   ');
  assert(out.length === 0 && session.calls.length === 0, 'an all-whitespace query returns [] without embedding or querying');
}
{
  const session = createFakeSession({ rows: [{ entry_id: 'e1' }] });
  const emptyEmbeddings = { name: 'empty', dimension: 4, embed: async () => [] };
  const out = await recallLorebookEntries(session, emptyEmbeddings, USER, CHAR, CHAT, 'x');
  assert(out.length === 0 && session.calls.length === 0, 'an embedding provider returning no vector yields [] (fail-open)');
}
{
  const session = createFakeSession({ rows: [{ entry_id: 'e1' }], throwOn: 'from constants c' });
  const out = await recallLorebookEntries(session, embeddings, USER, CHAR, CHAT, 'x');
  assert(out.length === 0, 'a DB throw resolves to [] (fail-open), never rejects');
}

// --- 2. fetchLorebookTimedEffectState ---
{
  const session = createFakeSession({
    rows: [{ entry_id: 'e1', message_id: 'm9', activated_at: '2026-08-11T00:00:00Z', turns_since_activation: '3' }],
  });
  const out = await fetchLorebookTimedEffectState(session, USER, CHAT, ['e1', 'e1', 'e2']);
  assert(session.calls[0].sql.includes('distinct on (lal.entry_id)'), 'one row per entry (most recent activation)');
  assert(
    session.calls[0].sql.includes("m.role = 'assistant'") && session.calls[0].sql.includes('> (cm.created_at, cm.message_id)'),
    'turns_since_activation counts completed assistant turns after the activation message',
  );
  assert(session.calls[0].params[2].length === 2, 'entryIds are deduped before the query');
  assert(out[0].turns_since_activation === 3, 'turns_since_activation is coerced to a number');
}
{
  const session = createFakeSession({ rows: [] });
  const out = await fetchLorebookTimedEffectState(session, USER, CHAT, []);
  assert(out.length === 0 && session.calls.length === 0, 'an empty entryIds set returns [] without querying');
}
{
  const session = createFakeSession({ rows: [], throwOn: 'lorebook_activation_log' });
  const out = await fetchLorebookTimedEffectState(session, USER, CHAT, ['e1']);
  assert(out.length === 0, 'a DB throw resolves to [] (fail-open), never rejects');
}

// --- 3. writeLorebookActivationLog ---
{
  const session = createFakeSession({ rows: [] });
  const n = await writeLorebookActivationLog(session, USER, CHAT, 'm1', ['e1', 'e1', 'e2', 'e2']);
  assert(session.calls[0].sql.includes('insert into lorebook_activation_log') && session.calls[0].sql.includes('returning activation_id'), 'insert returns the inserted activation ids for a count');
  assert(n === 2, 'the returned count is the number of rows actually inserted (deduped)');
  assert(session.calls[0].params[2].length === 2, 'entryIds are deduped before insert');
  assert(session.calls[0].params[1] === 'm1' && session.calls[0].params[3] === USER, 'message_id and user_id land in the right params');
}
{
  const session = createFakeSession({ rows: [] });
  const n = await writeLorebookActivationLog(session, USER, CHAT, 'm1', []);
  assert(n === 0 && session.calls.length === 0, 'an empty entryIds set returns 0 without querying');
}
{
  const session = createFakeSession({ rows: [], throwOn: 'insert into lorebook_activation_log' });
  const n = await writeLorebookActivationLog(session, USER, CHAT, 'm1', ['e1']);
  assert(n === 0, 'a DB throw resolves to 0 (fail-open), never rejects');
}

if (process.exitCode) {
  console.error('\nlorebook-io verify FAILED');
} else {
  console.log('\nlorebook-io verify passed');
}
