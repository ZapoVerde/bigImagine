// Proves orchestrator/lorebookGate.ts — the §4/§5 pure evaluator of the Lorebook plan
// (docs/lorebook-plan.md), ported from SillyTavern's world-info.js gating fields. The plan calls
// this "the highest-value place for tests" — probability rolls, inclusion groups, sticky/
// cooldown/delay, and the budget trim are all branching semantics pinned here:
//   1. Probability: seeded roll within `probability`%, ST's `roll*100 > probability` skip;
//      use_probability=false and probability=100 always pass; sticky-active skips the re-roll.
//   2. Timed effects: sticky keeps an entry active for N further turns (no re-roll, no
//      cooldown while active); cooldown blocks reactivation for N turns; delay blocks until the
//      chat has ≥N messages.
//   3. Inclusion groups: one winner per group, group_override always wins, sticky-active
//      members bypass the competition, group_weight biases the roll, single-member groups pass.
//   4. Budget: array order is the add order (constants first, then similarity rank), budget-cut
//      entries are reported not silently dropped, tokenCount is the consumed budget.
//   5. Determinism: same inputs -> identical result; deriveTurnSeed is stable per message_id.

import {
  gateLorebookCandidates,
  deriveTurnSeed,
  estimateLorebookTokens,
} from '../dist/orchestrator/lorebookGate.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// A candidate with sane defaults; override the gating fields per test.
function entry(overrides = {}) {
  return {
    entry_id: overrides.entry_id ?? 'e-default',
    lorebook_id: 'b1',
    uid: 1,
    key: [],
    comment: '',
    content: overrides.content ?? 'a'.repeat(overrides.uid ?? 1) + ' entry content',
    constant: overrides.constant ?? false,
    order_value: overrides.order_value ?? 0,
    probability: overrides.probability ?? 100,
    use_probability: overrides.use_probability ?? false,
    group_name: overrides.group_name ?? '',
    group_weight: overrides.group_weight ?? 1,
    group_override: overrides.group_override ?? false,
    sticky: overrides.sticky ?? 0,
    cooldown: overrides.cooldown ?? 0,
    delay: overrides.delay ?? 0,
  };
}

const noState = [];
const opts = (o = {}) => ({
  turnSeed: o.turnSeed ?? 12345,
  tokenBudget: o.tokenBudget ?? 1000,
  chatMessageCount: o.chatMessageCount ?? 20,
});
const ids = (result, key = 'activated') => result[key].map((e) => e.entry_id);
const skippedOf = (result, reason) => result.skipped.filter((s) => s.reason === reason).map((s) => s.entry_id);

// --- 0. deriveTurnSeed + token estimate ---
{
  assert(deriveTurnSeed('msg-abc') === deriveTurnSeed('msg-abc'), 'deriveTurnSeed is stable for the same message_id');
  assert(deriveTurnSeed('msg-abc') !== deriveTurnSeed('msg-abd'), 'deriveTurnSeed differs across message_ids');
  assert(deriveTurnSeed('msg-abc') >= 0 && deriveTurnSeed('msg-abc') < 4294967296, 'deriveTurnSeed returns a uint32');
  assert(estimateLorebookTokens('aaaa') === 1 && estimateLorebookTokens('aaaaa') === 2, 'token estimate is ceil(len/4), the repo heuristic');
}

// --- 1. Probability ---
{
  const r = gateLorebookCandidates([entry({ entry_id: 'a', probability: 100, use_probability: true })], noState, opts());
  assert(ids(r).includes('a'), 'probability=100 always fires, no roll needed');
}
{
  const r = gateLorebookCandidates([entry({ entry_id: 'a', probability: 0, use_probability: false })], noState, opts());
  assert(ids(r).includes('a'), 'use_probability=false never rolls, always fires');
}
{
  // probability=0 + use_probability: fires only if the roll lands exactly 0 — find a failing seed,
  // then assert the skip. This pins ST's `roll > probability` skip boundary.
  let skippedSeed = null;
  for (let s = 0; s < 200; s++) {
    const r = gateLorebookCandidates([entry({ entry_id: 'a', probability: 0, use_probability: true })], noState, opts({ turnSeed: s }));
    if (!ids(r).includes('a')) {
      skippedSeed = s;
      break;
    }
  }
  assert(skippedSeed !== null, 'a 0% probability entry is skipped for some seed (roll > 0)');
  const pass = gateLorebookCandidates([entry({ entry_id: 'a', probability: 0, use_probability: true })], noState, opts({ turnSeed: skippedSeed }));
  assert(!ids(pass).includes('a') && skippedOf(pass, 'probability').includes('a'), 'the skip is reported as reason probability');
}
{
  // Sweep: a 50% entry should pass roughly half the time across seeds — determinism sanity that
  // the roll is well-distributed, not a degenerate constant.
  let passes = 0;
  for (let s = 0; s < 100; s++) {
    const r = gateLorebookCandidates([entry({ entry_id: 'a', probability: 50, use_probability: true })], noState, opts({ turnSeed: s }));
    if (ids(r).includes('a')) passes++;
  }
  assert(passes > 30 && passes < 70, `a 50% entry passes ${passes}/100 seeds — plausibly random, not constant`);
}

// --- 2. Timed effects: sticky / cooldown / delay ---
{
  // sticky skips the re-roll: probability=0 would fail every non-zero roll, but sticky keeps it in.
  const state = [{ entry_id: 'a', message_id: 'm', activated_at: 't', turns_since_activation: 1 }];
  let failingSeed = null;
  for (let s = 0; s < 200; s++) {
    const r = gateLorebookCandidates([entry({ entry_id: 'a', probability: 0, use_probability: true, sticky: 0 })], state, opts({ turnSeed: s }));
    if (!ids(r).includes('a')) {
      failingSeed = s;
      break;
    }
  }
  const withoutSticky = gateLorebookCandidates(
    [entry({ entry_id: 'a', probability: 0, use_probability: true, sticky: 0 })],
    state,
    opts({ turnSeed: failingSeed }),
  );
  const withSticky = gateLorebookCandidates(
    [entry({ entry_id: 'a', probability: 0, use_probability: true, sticky: 5 })],
    state,
    opts({ turnSeed: failingSeed }),
  );
  assert(!ids(withoutSticky).includes('a'), 'same entry without sticky loses the probability roll');
  assert(ids(withSticky).includes('a') && skippedOf(withSticky, 'probability').length === 0, 'sticky-active skips the re-roll (ST: entry.sticky ? skip : roll)');
}
{
  const state = [{ entry_id: 'a', message_id: 'm', activated_at: 't', turns_since_activation: 1 }];
  const blocked = gateLorebookCandidates([entry({ entry_id: 'a', cooldown: 3 })], state, opts());
  assert(!ids(blocked).includes('a') && skippedOf(blocked, 'cooldown').includes('a'), 'cooldown=3 blocks an entry activated last turn');
  const expired = gateLorebookCandidates([entry({ entry_id: 'a', cooldown: 3 })], [{ ...state[0], turns_since_activation: 4 }], opts());
  assert(ids(expired).includes('a'), 'cooldown expires once turns_since exceeds N');
  const noCool = gateLorebookCandidates([entry({ entry_id: 'a', cooldown: 0 })], state, opts());
  assert(ids(noCool).includes('a'), 'cooldown=0 never blocks');
}
{
  const state = [{ entry_id: 'a', message_id: 'm', activated_at: 't', turns_since_activation: 1 }];
  const r = gateLorebookCandidates([entry({ entry_id: 'a', sticky: 3, cooldown: 3 })], state, opts());
  assert(ids(r).includes('a'), 'a sticky-active entry is not cooldown-blocked (it is not deactivated yet)');
}
{
  const r = gateLorebookCandidates([entry({ entry_id: 'a', delay: 10 })], noState, opts({ chatMessageCount: 5 }));
  assert(!ids(r).includes('a') && skippedOf(r, 'delay').includes('a'), 'delay=10 blocks a 5-message chat');
  const ok = gateLorebookCandidates([entry({ entry_id: 'a', delay: 10 })], noState, opts({ chatMessageCount: 10 }));
  assert(ids(ok).includes('a'), 'delay passes once the chat has ≥N messages');
  const noDelay = gateLorebookCandidates([entry({ entry_id: 'a', delay: 0 })], noState, opts({ chatMessageCount: 0 }));
  assert(ids(noDelay).includes('a'), 'delay=0 never blocks');
}

// --- 3. Inclusion groups ---
{
  const two = [
    entry({ entry_id: 'a', group_name: 'g', content: 'aa' }),
    entry({ entry_id: 'b', group_name: 'g', content: 'bb' }),
  ];
  const r = gateLorebookCandidates(two, noState, opts());
  assert(ids(r).length === 1, 'a two-member group activates exactly one entry');
  assert(skippedOf(r, 'group').length === 1, 'the losing member is reported as reason group');
}
{
  const withOverride = [
    entry({ entry_id: 'a', group_name: 'g', group_override: true }),
    entry({ entry_id: 'b', group_name: 'g' }),
  ];
  for (let s = 0; s < 20; s++) {
    const r = gateLorebookCandidates(withOverride, noState, opts({ turnSeed: s }));
    assert(ids(r).includes('a') && !ids(r).includes('b'), `group_override wins its group for every seed (seed ${s})`);
  }
}
{
  const single = [entry({ entry_id: 'a', group_name: 'only' })];
  const r = gateLorebookCandidates(single, noState, opts());
  assert(ids(r).includes('a'), 'a single-member group has nothing to compete for and passes');
}
{
  // A sticky-active member is already in and bypasses the competition — both it and the newly
  // rolled group member can be active the same turn.
  const state = [{ entry_id: 'a', message_id: 'm', activated_at: 't', turns_since_activation: 1 }];
  const mixed = [
    entry({ entry_id: 'a', group_name: 'g', sticky: 5 }),
    entry({ entry_id: 'b', group_name: 'g' }),
  ];
  const r = gateLorebookCandidates(mixed, state, opts());
  assert(ids(r).includes('a') && ids(r).includes('b'), 'sticky-active member bypasses group competition; one new member still rolls in');
}
{
  // Weighted roll: weight 9 vs 1 must favor the heavy member across many seeds, and never pick
  // a weight-0 member unless the roll lands exactly on its zero-width slice.
  const weighted = [
    entry({ entry_id: 'heavy', group_name: 'g', group_weight: 9 }),
    entry({ entry_id: 'light', group_name: 'g', group_weight: 1 }),
  ];
  let heavy = 0;
  for (let s = 0; s < 200; s++) {
    const r = gateLorebookCandidates(weighted, noState, opts({ turnSeed: s }));
    if (ids(r).includes('heavy')) heavy++;
  }
  assert(heavy > 150, `group_weight 9:1 wins ${heavy}/200 seeds — weighted, not uniform`);
}
{
  const zeroWeight = [
    entry({ entry_id: 'a', group_name: 'g', group_weight: 0 }),
    entry({ entry_id: 'b', group_name: 'g', group_weight: 0 }),
  ];
  const r = gateLorebookCandidates(zeroWeight, noState, opts());
  assert(ids(r).length === 1, 'all-zero weights still pick exactly one winner (uniform roll)');
}

// --- 4. Budget ---
{
  // 'aaaa' = 1 token each. Budget 2 of three 1-token entries: first two (array order) in, third cut.
  const three = [
    entry({ entry_id: 'c1', content: 'aaaa' }),
    entry({ entry_id: 'c2', content: 'aaaa' }),
    entry({ entry_id: 'c3', content: 'aaaa' }),
  ];
  const r = gateLorebookCandidates(three, noState, opts({ tokenBudget: 2 }));
  assert(ids(r).join() === 'c1,c2' && skippedOf(r, 'budget').join() === 'c3', 'budget adds in array order until spent, cuts the rest');
  assert(r.tokenCount === 2, 'tokenCount reports the consumed budget');
}
{
  const r = gateLorebookCandidates([entry({ entry_id: 'c1', content: 'aaaa' })], noState, opts({ tokenBudget: 0 }));
  assert(ids(r).length === 0 && skippedOf(r, 'budget').includes('c1'), 'budget=0 cuts everything, constants included');
}
{
  // Constants come first in the recall array order — they eat the budget before ranked entries.
  const ordered = [
    entry({ entry_id: 'const', constant: true, content: 'aaaa' }),
    entry({ entry_id: 'rank1', content: 'aaaa' }),
  ];
  const r = gateLorebookCandidates(ordered, noState, opts({ tokenBudget: 1 }));
  assert(ids(r).join() === 'const' && skippedOf(r, 'budget').includes('rank1'), 'constant entries are included first within the budget (array order is the add order)');
}

// --- 5. Determinism ---
{
  const inputs = {
    candidates: [
      entry({ entry_id: 'a', probability: 30, use_probability: true, group_name: 'g', group_weight: 2 }),
      entry({ entry_id: 'b', probability: 30, use_probability: true, group_name: 'g', group_weight: 1 }),
      entry({ entry_id: 'c', sticky: 2 }),
    ],
    state: [{ entry_id: 'c', message_id: 'm', activated_at: 't', turns_since_activation: 1 }],
    options: opts({ turnSeed: 999, tokenBudget: 4 }),
  };
  const r1 = gateLorebookCandidates(inputs.candidates, inputs.state, { ...inputs.options });
  const r2 = gateLorebookCandidates(inputs.candidates, inputs.state, { ...inputs.options });
  assert(JSON.stringify(r1) === JSON.stringify(r2), 'identical inputs -> identical result (no Math.random)');
}

if (process.exitCode) {
  console.error('\nlorebook-gate verify FAILED');
} else {
  console.log('\nlorebook-gate verify passed');
}
