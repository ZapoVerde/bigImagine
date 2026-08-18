// Proves the portrait wiki read paths (orchestrator/src/portraits/wiki.ts, plan §Tests + the
// vision-review-harness plan's §Wiki policy — "Send mutation a bounded selected set of current
// revisions, never the entire wiki"):
//   - Path 1 (formatSubscribedEntries): subscribed entries only, full title+body, whole-layer-type
//     subscriptions reaching every entity of that type;
//   - Path 1 bounded (formatBoundedSubscribedEntries): the same subscription selection UNDER a
//     character budget — accumulating in row order, truncating a lone oversized block rather than
//     dropping it, and returning the entry ids that made the cut (the caller's attributable
//     revision provenance);
//   - Path 1c (formatUnsubscribedTagIndex): the tag-catch-all — every entry Path 1 (a)/(b) did
//     NOT already reach, title+tags+id, so mutation can pull one on demand;
//   - Path 2 (buildWikiIndex): title+tags only, grouped by layer type, across the whole manifest;
//   - subscriptionsFor: the create-conclusion subscription constructor.
// Pure formatting only — the reflection pass that used to drive wiki writes here now runs through
// the lesson ledger (verify-visual-reflection-learning.mjs drives it against a fake gate; the
// wiki itself is a separate operator-approved projection).
// All pure — no server, no provider.

import { DEFAULT_LAYER_MANIFEST } from '../dist/portraits/layerStack.js';
import { buildWikiIndex, formatBoundedSubscribedEntries, formatSubscribedEntries, formatUnsubscribedTagIndex, subscriptionsFor } from '../dist/portraits/wiki.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const layers = DEFAULT_LAYER_MANIFEST.layers; // subject/outfit/style/expression (manifest order)

// --- Path 1 fixtures: entries subscribed at entity level, whole-layer-type level, and not at
//     all (a row with no matching subscription must never reach the mutation prompt). ---
const SUBJECT_ENTITY = 'e-subject-1';
const STYLE_ENTITY = 'e-style-1';
const entries = [
  {
    entry_id: 'w1',
    title: 'Keep coats short',
    body: 'Coats read bulky below the knee; shorten them.',
    tags: ['outfit'],
    subscriptions: [{ layerType: 'outfit', layerEntityId: null }], // whole-layer-type
  },
  {
    entry_id: 'w2',
    title: 'Rin prefers teal',
    body: 'The subject entity reads most true with the teal streak.',
    tags: ['subject', 'color'],
    subscriptions: [{ layerType: 'subject', layerEntityId: SUBJECT_ENTITY }], // entity-specific
  },
  {
    entry_id: 'w3',
    title: 'Amber eyes carry',
    body: 'Amber reads warmest under teahouse light.',
    tags: ['style'],
    subscriptions: [{ layerType: 'style', layerEntityId: null }], // whole-layer-type for style
  },
  {
    entry_id: 'w4',
    title: 'Draft entry',
    body: 'Not subscribed to anything yet.',
    tags: [],
    subscriptions: [],
  },
];

// --- Path 1: subscribed only, full body, uncapped (the function remains the full-form path). ---
const path1 = formatSubscribedEntries(entries, [SUBJECT_ENTITY], ['outfit', 'style']);
assert(path1.includes('## Keep coats short\nCoats read bulky below the knee; shorten them.'), 'wiki: Path 1 includes full title+body for subscribed entries');
assert(path1.includes('## Rin prefers teal\n'), 'wiki: Path 1 entity-specific subscription matches the active entity');
assert(path1.includes('## Amber eyes carry'), 'wiki: Path 1 whole-layer-type subscription reaches the round via its layer type');
assert(!path1.includes('## Draft entry'), 'wiki: Path 1 excludes unsubscribed entries');
assert(!path1.includes('w1') && !path1.includes('w2'), 'wiki: Path 1 leaks no ids — titles and bodies only');

// Whole-layer-type reaching EVERY entity of that type: a round with a different subject entity
// still sees the outfit/whole-layer lesson.
const path1OtherEntity = formatSubscribedEntries(entries, ['e-subject-9'], ['outfit']);
assert(path1OtherEntity.includes('Keep coats short') && !path1OtherEntity.includes('Rin prefers teal'), 'wiki: whole-layer-type entry reaches every entity of that type');

// Uncapped: every matching entry lands, in row order.
const manyEntries = Array.from({ length: 8 }, (_, i) => ({
  entry_id: `w-many-${i}`,
  title: `Lesson ${i}`,
  body: `Body ${i}`,
  tags: [],
  subscriptions: [{ layerType: 'outfit', layerEntityId: null }],
}));
const path1Many = formatSubscribedEntries(manyEntries, [], ['outfit']);
assert((path1Many.match(/^## /gm) ?? []).length === 8, `wiki: Path 1 uncapped — all ${8} matching entries present`);

// Dedup: an entry subscribed both ways appears once.
const dedupEntries = [
  {
    entry_id: 'w-d',
    title: 'Both ways',
    body: 'B',
    tags: [],
    subscriptions: [
      { layerType: 'subject', layerEntityId: SUBJECT_ENTITY },
      { layerType: 'subject', layerEntityId: null },
    ],
  },
];
assert((formatSubscribedEntries(dedupEntries, [SUBJECT_ENTITY], ['subject']).match(/^## Both ways/gm) ?? []).length === 1, 'wiki: Path 1 deduplicates doubly-subscribed entries');

// Empty when nothing matches.
assert(formatSubscribedEntries(entries, ['e-nowhere'], ['nowhere']) === '', 'wiki: Path 1 returns "" when nothing matches');

// --- Path 1 bounded (formatBoundedSubscribedEntries): same subscription selection, capped at a
//     character budget — the vision-review-harness plan's "never the entire wiki". ---
const bounded = formatBoundedSubscribedEntries(entries, [SUBJECT_ENTITY], ['outfit', 'style'], 150);
assert(bounded.text.includes('## Keep coats short') && bounded.text.includes('## Rin prefers teal'), 'wiki: bounded Path 1 still reaches subscribed entries');
assert(bounded.entryIds.includes('w1') && bounded.entryIds.includes('w2'), 'wiki: bounded Path 1 returns the entry ids that made the cut (revision provenance)');
assert(!bounded.text.includes('## Amber eyes carry') && !bounded.entryIds.includes('w3'), 'wiki: bounded Path 1 stops before the block that would blow the remaining budget');
assert(!bounded.entryIds.includes('w4'), 'wiki: bounded Path 1 excludes unsubscribed entries');
const notCut = formatBoundedSubscribedEntries(entries, [SUBJECT_ENTITY], ['outfit', 'style'], 1);
assert(notCut.text.length === 1 && notCut.text.startsWith('#'), 'wiki: bounded Path 1 truncates a lone oversized block rather than dropping it');

// The budget is inclusive of every block up to the cap — an entry whose block would exceed the
// remaining budget is skipped (later entries), never partially appended after others.
const budgetBlock = formatBoundedSubscribedEntries(entries, [SUBJECT_ENTITY], ['outfit', 'style'], 80);
assert(budgetBlock.text.includes('## Keep coats short') && !budgetBlock.text.includes('## Rin prefers teal'), 'wiki: bounded Path 1 stops before an entry whose block would blow the remaining budget');

// Zero/negative budget = no full-body wiki context at all (the caller's "no wiki" posture).
assert(formatBoundedSubscribedEntries(entries, [SUBJECT_ENTITY], ['outfit', 'style'], 0).text === '', 'wiki: bounded Path 1 with budget 0 sends no context');

// --- Path 2: title+tags only, grouped by layer type in manifest order, whole manifest. ---
const index = buildWikiIndex(entries, layers);
assert(!index.includes('Coats read bulky'), 'wiki: Path 2 omits bodies — title+tags only');
assert(index.includes('## Outfit (outfit)\n- Keep coats short [outfit]'), 'wiki: Path 2 groups by layer type with tag suffix');
assert(index.includes('## Subject (subject)\n- Rin prefers teal [subject, color]'), 'wiki: Path 2 subject group with multi-tag suffix');
assert(index.indexOf('## Subject') < index.indexOf('## Outfit'), 'wiki: Path 2 groups in manifest layer order');
const noTagEntry = [{ entry_id: 'w-nt', title: 'Untagged lesson', body: 'B', tags: [], subscriptions: [{ layerType: 'style', layerEntityId: null }] }];
assert(buildWikiIndex(noTagEntry, layers).includes('- Untagged lesson'), 'wiki: Path 2 entry without tags gets no suffix');
const multiGroup = [
  {
    entry_id: 'w-mg',
    title: 'Cross-layer lesson',
    body: 'B',
    tags: ['a'],
    subscriptions: [
      { layerType: 'outfit', layerEntityId: null },
      { layerType: 'expression', layerEntityId: null },
    ],
  },
];
const multiIndex = buildWikiIndex(multiGroup, layers);
assert(multiIndex.includes('## Outfit (outfit)\n- Cross-layer lesson [a]') && multiIndex.includes('## Expression (expression)\n- Cross-layer lesson [a]'), 'wiki: Path 2 entry subscribed to several layers appears under each');
assert(!multiIndex.includes('## Subject'), 'wiki: Path 2 omits layers with no subscribed entries');
assert(buildWikiIndex([], layers) === '', 'wiki: Path 2 returns "" for an empty wiki');
// Title order within a group is alphabetical.
const alphaEntries = [
  { entry_id: 'z', title: 'Zebra lesson', body: 'B', tags: [], subscriptions: [{ layerType: 'style', layerEntityId: null }] },
  { entry_id: 'a', title: 'Apple lesson', body: 'B', tags: [], subscriptions: [{ layerType: 'style', layerEntityId: null }] },
];
const alphaIndex = buildWikiIndex(alphaEntries, layers);
assert(alphaIndex.indexOf('Apple lesson') < alphaIndex.indexOf('Zebra lesson'), 'wiki: Path 2 sorts titles alphabetically within a group');

// --- Path 1c (formatUnsubscribedTagIndex): the complement of Path 1 (a)/(b), title+tags+id. ---
// Reuses the Path 1 fixtures: w1 (outfit whole-layer), w2 (subject entity-specific), w3 (style
// whole-layer), w4 (no subscriptions at all).
const unsub = formatUnsubscribedTagIndex(entries, [SUBJECT_ENTITY], ['outfit', 'style']);
assert(!unsub.includes('Keep coats short') && !unsub.includes('Rin prefers teal') && !unsub.includes('Amber eyes carry'), 'wiki: Path 1c excludes everything Path 1 (a)/(b) already reached');
assert(unsub.includes('w4: Draft entry'), 'wiki: Path 1c includes an entry with no matching subscription at all, with its id');

// A round that doesn't touch 'subject' at all sees w2 (entity-specific, entity not active) fall
// into the catch-all too — the subscription model is structural, not semantic.
const unsubNoSubject = formatUnsubscribedTagIndex(entries, [], ['outfit', 'style']);
assert(unsubNoSubject.includes('w2: Rin prefers teal [subject, color]'), 'wiki: Path 1c catches an entity-specific entry whose entity isn\'t active this round');

// Once every entry's subscription is satisfied, only the truly-unsubscribed entry remains.
const unsubAllActive = formatUnsubscribedTagIndex(entries, [SUBJECT_ENTITY, STYLE_ENTITY], ['outfit', 'subject', 'style']);
assert(unsubAllActive.includes('w4') && !unsubAllActive.includes('w1') && !unsubAllActive.includes('w2') && !unsubAllActive.includes('w3'), 'wiki: Path 1c shrinks to just the truly-unsubscribed entry once everything else is active');

assert(formatUnsubscribedTagIndex([], [], layers.map((l) => l.id)) === '', 'wiki: Path 1c returns "" for an empty wiki');

// Title order, alphabetical (same convention as Path 2).
const unsubAlpha = formatUnsubscribedTagIndex(alphaEntries, [], []);
assert(unsubAlpha.indexOf('Apple lesson') < unsubAlpha.indexOf('Zebra lesson'), 'wiki: Path 1c sorts titles alphabetically');

// --- subscriptionsFor: the create-conclusion subscription constructor. ---
const sub1 = subscriptionsFor('style', STYLE_ENTITY);
assert(sub1.length === 1 && sub1[0].layerType === 'style' && sub1[0].layerEntityId === STYLE_ENTITY, 'wiki: subscriptionsFor with entity → entity-specific subscription');
const sub2 = subscriptionsFor('style', null);
assert(sub2.length === 1 && sub2[0].layerType === 'style' && sub2[0].layerEntityId === null, 'wiki: subscriptionsFor without entity → whole-layer-type subscription');