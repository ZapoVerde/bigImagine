// Proves orchestrator/resolveLorebook.ts — the §4/§7 turn-loop lorebook step of the Lorebook
// plan (docs/lorebook-plan.md): the sequencing contract (mode gate → recall → timed-effect state
// → gate → format), the default-off posture, deterministic seeding, and fail-open. The fake db
// stubs withUserScope and dispatches canned rows by SQL fragment; the whole chain is driven with
// no Postgres and no live embedding provider.
//   1. lorebook_mode must be 'on' — unset/other returns undefined with zero DB reads.
//   2. The recall query is issued with the caller's characterId (all-zero uuid when null), and
//      topK/budget fall back to sane defaults when the settings are unset.
//   3. Timed-effect state + message count feed the gate (cooldown/delay skips show up as
//      absent bullets, not errors).
//   4. The formatted block is deterministic given the same inputs (no Math.random) and has the
//      fixed header + one bullet per activated entry shape.
//   5. Fail-open: any DB/embedding error resolves to undefined, never rejects.

import { createStubEmbeddingProvider } from '../dist/io/embeddings/stub.js';
import { resolveLorebook, formatLorebookBlock } from '../dist/orchestrator/resolveLorebook.js';
import { DEFAULT_LOREBOOK_RECALL_TOP_K } from '../dist/io/lorebook/recallLorebookEntries.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

function candidate(overrides = {}) {
  return {
    entry_id: overrides.entry_id ?? 'e1',
    lorebook_id: 'b1',
    uid: 1,
    key: [],
    comment: '',
    content: overrides.content ?? 'castle lore',
    constant: overrides.constant ?? false,
    order_value: 0,
    probability: 100,
    use_probability: false,
    group_name: '',
    group_weight: 1,
    group_override: false,
    sticky: overrides.sticky ?? 0,
    cooldown: overrides.cooldown ?? 0,
    delay: overrides.delay ?? 0,
  };
}

function fakeDeps({ settings = {}, candidates = [], state = [], messageCount = '12', throwOn = null } = {}) {
  const values = new Map(Object.entries(settings));
  const session = {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      if (throwOn && sql.includes(throwOn)) throw new Error(`${throwOn} boom`);
      if (sql.includes('from constants c')) return candidates;
      if (sql.includes('select distinct on (lal.entry_id)')) return state;
      if (sql.includes('count(*) as n')) return [{ n: messageCount }];
      return [];
    },
  };
  return {
    db: { withUserScope: async (_userId, fn) => fn(session) },
    settings: { get: (k) => Promise.resolve(values.get(k)) },
    embeddings: createStubEmbeddingProvider(4),
    session,
  };
}

const depsFor = (d) => ({
  db: d.db,
  settings: d.settings,
  embeddings: d.embeddings,
  userId: 'u1',
  chatId: 'ch1',
  characterId: 'c1',
  queryText: 'User: recent turns Assistant: replies',
  assistantMessageId: 'msg-abc',
});

// --- 1. Default-off posture ---
{
  const d = fakeDeps({ settings: { lorebook_mode: 'off' } });
  const out = await resolveLorebook(depsFor(d));
  assert(out === undefined, 'lorebook_mode off -> undefined');
  assert(d.session.calls.length === 0, 'mode off performs zero DB reads');
}
{
  const d = fakeDeps({ settings: {} });
  const out = await resolveLorebook(depsFor(d));
  assert(out === undefined, 'unset lorebook_mode -> undefined (default off, §2)');
}

// --- 2. Sequencing + formatting ---
{
  const d = fakeDeps({
    settings: { lorebook_mode: 'on' },
    candidates: [candidate({ entry_id: 'e1', content: 'castle lore' }), candidate({ entry_id: 'e2', content: 'the red moon' })],
  });
  const out = await resolveLorebook(depsFor(d));
  assert(out !== undefined, 'mode on with candidates resolves a block');
  assert(out.text.startsWith('Lorebook — active entries:'), 'block has the fixed header');
  assert(out.text.includes('- castle lore') && out.text.includes('- the red moon'), 'one bullet per activated entry in gate order');
  assert(out.text.split('\n').length === 3, 'header + 2 bullets, nothing else');
  const sqls = d.session.calls.map((c) => c.sql);
  assert(sqls.some((s) => s.includes('from constants c')), 'recall ran');
  assert(sqls.some((s) => s.includes('select distinct on (lal.entry_id)')), 'timed-effect state fetch ran');
  assert(sqls.some((s) => s.includes('count(*) as n')), 'chat message count read ran');
}
{
  // Determinism: identical inputs -> identical bytes (the §4/§17 reproducibility contract).
  const d1 = fakeDeps({ settings: { lorebook_mode: 'on' }, candidates: [candidate({})] });
  const d2 = fakeDeps({ settings: { lorebook_mode: 'on' }, candidates: [candidate({})] });
  const a = await resolveLorebook(depsFor(d1));
  const b = await resolveLorebook(depsFor(d2));
  assert(a.text === b.text && a.activatedEntryIds.join() === b.activatedEntryIds.join(), 'same inputs -> identical block (no Math.random)');
}

// --- 3. Gate inputs flow through (cooldown, delay, budget) ---
{
  // cooldown: the state fetch returns a recent activation -> entry is gate-skipped.
  const d = fakeDeps({
    settings: { lorebook_mode: 'on' },
    candidates: [candidate({ entry_id: 'e1', cooldown: 3 })],
    state: [{ entry_id: 'e1', message_id: 'm', activated_at: 't', turns_since_activation: 1 }],
  });
  const out = await resolveLorebook(depsFor(d));
  assert(out === undefined, 'a cooldown-blocked candidate leaves the block empty -> undefined');
}
{
  // delay: chat has 12 messages, delay demands 100 -> skipped.
  const d = fakeDeps({
    settings: { lorebook_mode: 'on' },
    candidates: [candidate({ entry_id: 'e1', delay: 100 })],
  });
  const out = await resolveLorebook(depsFor(d));
  assert(out === undefined, 'a delay-blocked candidate leaves the block empty');
}
{
  // budget: two 1-token entries, budget 1 -> only the first (array order) survives.
  const d = fakeDeps({
    settings: { lorebook_mode: 'on', lorebook_token_budget: '1' },
    candidates: [candidate({ entry_id: 'e1', content: 'aaaa' }), candidate({ entry_id: 'e2', content: 'bbbb' })],
  });
  const out = await resolveLorebook(depsFor(d));
  assert(out.text.includes('- aaaa') && !out.text.includes('- bbbb'), 'budget cuts later entries in array order');
  assert(out.activatedEntryIds.join() === 'e1', 'activatedEntryIds carries exactly the surviving entries for the post-turn log write');
}

// --- 4. Defaults + characterId null path ---
{
  const d = fakeDeps({ settings: { lorebook_mode: 'on' }, candidates: [candidate({})] });
  await resolveLorebook(depsFor(d));
  const recallCall = d.session.calls.find((c) => c.sql.includes('from constants c'));
  assert(recallCall.params[4] === DEFAULT_LOREBOOK_RECALL_TOP_K && DEFAULT_LOREBOOK_RECALL_TOP_K === 8, 'unset lorebook_recall_top_k defaults to 8');
  assert(recallCall.params[3].startsWith('['), 'the embedded query lands as the pgvector literal');
}
{
  const d = fakeDeps({ settings: { lorebook_mode: 'on' }, candidates: [candidate({})] });
  await resolveLorebook({ ...depsFor(d), characterId: null });
  const recallCall = d.session.calls.find((c) => c.sql.includes('from constants c'));
  assert(recallCall.params[1] === ZERO_UUID, 'a null characterId binds the all-zero uuid (scope simply never matches)');
}

// --- 5. Fail-open ---
{
  const d = fakeDeps({ settings: { lorebook_mode: 'on' }, candidates: [candidate({})], throwOn: 'from constants c' });
  const out = await resolveLorebook(depsFor(d));
  assert(out === undefined, 'a recall failure resolves to undefined, never rejects');
}
{
  // The state wrapper fails open by itself (returns []), so the chain continues without
  // timed-effect state — the entry fires, and the turn is never broken.
  const d = fakeDeps({ settings: { lorebook_mode: 'on' }, candidates: [candidate({})], throwOn: 'select distinct on (lal.entry_id)' });
  const out = await resolveLorebook(depsFor(d));
  assert(out !== undefined && out.text.includes('- castle lore'), 'a timed-effect state failure fails open: the entry still resolves');
}

// --- 6. formatLorebookBlock shape ---
{
  assert(formatLorebookBlock([]) === 'Lorebook — active entries:', 'empty activated set formats to just the header');
  assert(
    formatLorebookBlock([{ content: 'a' }, { content: 'b' }]) === 'Lorebook — active entries:\n- a\n- b',
    'bullets follow the header in order',
  );
}

if (process.exitCode) {
  console.error('\nresolve-lorebook verify FAILED');
} else {
  console.log('\nresolve-lorebook verify passed');
}
