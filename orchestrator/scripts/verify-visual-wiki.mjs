// Proves the portrait wiki read paths + the Reflection Investigation loop's turn-cap forcing
// (orchestrator/src/portraits/wiki.ts + orchestrator/orchestrator/portraitFeedback.ts, plan
// §Tests):
//   - Path 1 (formatSubscribedEntries): subscribed entries only, full title+body, uncapped,
//     whole-layer-type subscriptions reaching every entity of that type;
//   - Path 2 (buildWikiIndex): title+tags only, grouped by layer type, across the whole manifest;
//   - subscriptionsFor: the create-conclusion subscription constructor;
//   - the investigation loop's cap-forcing behavior driven through submitPortraitFeedback with a
//     fake gate that never calls submit_conclusion on its own — the forced final call must land
//     the conclusion (plan §Edge Cases), and an amend-miss must fall back to create (§Edge Cases).
// The loop test runs against a fake Postgres pool + fake settings + fake LLM gate — no server,
// no real provider.

import { DEFAULT_LAYER_MANIFEST } from '../dist/portraits/layerStack.js';
import { buildWikiIndex, formatSubscribedEntries, subscriptionsFor } from '../dist/portraits/wiki.js';
import { submitPortraitFeedback } from '../dist/orchestrator/portraitFeedback.js';

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

// --- Path 1: subscribed only, full body, uncapped. ---
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

// --- subscriptionsFor: the create-conclusion subscription constructor. ---
const sub1 = subscriptionsFor('style', STYLE_ENTITY);
assert(sub1.length === 1 && sub1[0].layerType === 'style' && sub1[0].layerEntityId === STYLE_ENTITY, 'wiki: subscriptionsFor with entity → entity-specific subscription');
const sub2 = subscriptionsFor('style', null);
assert(sub2.length === 1 && sub2[0].layerType === 'style' && sub2[0].layerEntityId === null, 'wiki: subscriptionsFor without entity → whole-layer-type subscription');

// ============================================================================
// Reflection Investigation loop — turn-cap forcing through submitPortraitFeedback.
// ============================================================================

const USER = 'u1';
const WINNER = 'c1';
const CANDIDATE_IDS = ['c1', 'c2', 'c3'];

function makeSettings(overrides = {}) {
  const map = new Map([
    ['visual_layer_stack', JSON.stringify(DEFAULT_LAYER_MANIFEST)],
    ['visual_wiki_investigation_max_turns', '3'],
    ['visual_reflection_system_prompt_override', ''],
    ...Object.entries(overrides),
  ]);
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => { map.set(key, value); },
  };
}

function makeDb() {
  const state = {
    candidates: CANDIDATE_IDS.map((id, i) => ({
      candidate_id: id,
      entity_ids: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
      image_url: `https://img/${id}.png`,
      chromosome: {
        slots: {
          subject: { subject_identity: `Rin V${i + 1}` },
          outfit: { outfit_style: 'red coat' },
          style: { style_style: 'VLZ hybrid' },
          expression: { expression_emotion: 'calm' },
        },
      },
    })),
    // The style entity's custom template — reflection must read it off the WINNER's
    // entity_ids (the round's resolved map), so composed prompts recompute like generation did.
    styleTemplates: [{ entity_id: 'e-style', template: 'PORTRAIT {{subject_overflow}} / {{style_overflow}}' }],
    wikiEntries: [
      {
        entry_id: 'w-existing',
        title: 'Keep coats short',
        body: 'Coats read bulky below the knee.',
        tags: ['outfit'],
        subscriptions: [{ layerType: 'outfit', layerEntityId: null }],
      },
    ],
    episodes: 0,
    wikiWrites: [], // { action, entry_id?, origin_episode_id?, title, body, tags, subscriptions }
    promoted: [], // entity ids promoted with last_image_url
    ratingWrites: [],
    episodeCounter: 0,
    wikiCounter: 0,
  };
  const db = {
    state,
    withUserScope: async (_userId, fn) => fn({ query }),
  };
  function query(sql, params = []) {
    const s = sql;
    if (s.includes('from visual_candidates')) {
      const ids = params[1];
      return state.candidates.filter((c) => ids.includes(c.candidate_id));
    }
    if (s.startsWith('insert into visual_episodes')) {
      state.episodeCounter += 1;
      const episodeId = `ep-${state.episodeCounter}`;
      state.episodes = episodeId;
      return [{ episode_id: episodeId }];
    }
    if (s.startsWith('update visual_entities')) {
      state.promoted.push({ entityIds: params[4], imageUrl: params[1], candidateId: params[2] });
      return [];
    }
    if (s.includes('update visual_candidates set rating')) {
      state.ratingWrites.push({ candidateId: params[0], rating: params[1] });
      return [];
    }
    if (s.includes('update visual_candidates set note')) {
      return [];
    }
    if (s.includes('from visual_entities')) {
      // style template resolution: select template from visual_entities where ... entity_id = $2
      return state.styleTemplates.filter((r) => r.entity_id === params[1]);
    }
    if (s.includes('from visual_wiki_entries') && s.includes('order by created_at')) {
      return [...state.wikiEntries];
    }
    if (s.includes('select entry_id, title, body') && s.includes('from visual_wiki_entries')) {
      return state.wikiEntries.filter((e) => e.entry_id === params[0]);
    }
    if (s.includes('select entry_id from visual_wiki_entries')) {
      return state.wikiEntries.filter((e) => e.entry_id === params[0]);
    }
    if (s.startsWith('update visual_wiki_entries')) {
      return [];
    }
    if (s.startsWith('insert into visual_wiki_entries')) {
      state.wikiCounter += 1;
      const entryId = `wiki-new-${state.wikiCounter}`;
      state.wikiWrites.push({
        action: 'create',
        entryId,
        originEpisodeId: params[5],
        title: params[1],
        body: params[2],
        tags: params[3],
        subscriptions: params[4],
      });
      state.wikiEntries.push({
        entry_id: entryId,
        title: params[1],
        body: params[2],
        tags: params[3],
        subscriptions: JSON.parse(params[4]),
      });
      return [{ entry_id: entryId }];
    }
    throw new Error(`unexpected SQL: ${s.slice(0, 80)}`);
  }
  return db;
}

function conclusionCall(args) {
  return {
    message: { role: 'assistant', content: '' },
    toolCalls: [{ id: 'concl-1', name: 'submit_conclusion', arguments: args }],
  };
}
function emptyTurn() {
  return { message: { role: 'assistant', content: 'still thinking' }, toolCalls: [] };
}

const input = {
  entityIds: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
  goal: 'A calmer evening variant of Rin.',
  candidateIds: CANDIDATE_IDS,
  winnerId: WINNER,
  ratings: { c1: 5, c2: 3 },
  notes: { c1: 'keep the pose' },
  rationale: 'The quiet pose wins; coats still too long.',
};

// --- The fake gate: never calls submit_conclusion on its own (text-only turns) — only the
//     forced final call lands the conclusion. That must cap the loop and conclude. ---
{
  const db = makeDb();
  const calls = [];
  const gateLlm = {
    name: 'fake-gate',
    async complete(_messages, tools, options) {
      calls.push({ tools, options });
      if (options?.forceTool === 'submit_conclusion') {
        return conclusionCall({ action: 'create', title: 'Coats end above the knee', body: 'Shorten coats.', tags: ['outfit'], layerId: 'outfit' });
      }
      return emptyTurn(); // never concludes on its own
    },
  };
  const result = await submitPortraitFeedback({ db, settings: makeSettings() }, gateLlm, USER, input);

  assert(result.ok === true && result.episodeId === 'ep-1', `feedback: round records an episode -> ${result.episodeId}`);
  assert(result.reflection?.action === 'created' && result.reflection.entryId === 'wiki-new-1', 'feedback: forced final conclusion lands a created entry');
  assert(calls.length === 3, `feedback: loop ran exactly the cap's ${3} turns -> ${calls.length}`);
  const finalCall = calls[calls.length - 1];
  assert(finalCall.tools.length === 1 && finalCall.tools[0].name === 'submit_conclusion', 'feedback: final call sees submit_conclusion as the ONLY tool');
  assert(finalCall.options?.forceTool === 'submit_conclusion', 'feedback: final call is forced onto submit_conclusion');
  assert(calls[0].tools.length === 2 && !calls[0].options?.forceTool, 'feedback: pre-cap calls see both tools and no forceTool');
  assert(
    db.state.promoted.length === 1 && db.state.promoted[0].entityIds.length === 4 && db.state.promoted[0].imageUrl === 'https://img/c1.png',
    'feedback: winner entity ids promoted with the winner image',
  );
  assert(db.state.ratingWrites.length === 2 && db.state.ratingWrites.some((w) => w.candidateId === 'c1' && w.rating === 5), 'feedback: ratings written through');
  const wikiWrite = db.state.wikiWrites[0];
  assert(wikiWrite && wikiWrite.originEpisodeId === 'ep-1', 'feedback: created entry carries origin_episode_id');
  assert(wikiWrite && wikiWrite.subscriptions.includes('"layerEntityId":null') && wikiWrite.subscriptions.includes('"layerType":"outfit"'), 'feedback: whole-layer-type subscription written for a layer-only lesson');
}

// Same loop, but the gate captures messages so we can prove the winner-resolved template.
{
  const db = makeDb();
  let firstUserContent = '';
  const gateLlm = {
    name: 'fake-gate-capture',
    async complete(messages, _tools, options) {
      if (messages[1]?.role === 'user' && !firstUserContent) firstUserContent = messages[1].content;
      if (options?.forceTool === 'submit_conclusion') {
        return conclusionCall({ action: 'create', title: 'T', body: 'B', tags: [], layerId: 'style' });
      }
      return emptyTurn();
    },
  };
  await submitPortraitFeedback({ db, settings: makeSettings() }, gateLlm, USER, input);
  assert(
    firstUserContent.includes('prompt: PORTRAIT subject_identity: Rin V1 / style_style: VLZ hybrid'),
    'feedback: composed prompts recomputed with the WINNER-resolved style template',
  );
  assert(firstUserContent.includes('Existing wiki entries (title + tags only'), 'feedback: first reflection call receives the Path-2 index');
}

// --- Fail-open gates: winner not in candidates / unknown candidate id. ---
{
  const db = makeDb();
  const r1 = await submitPortraitFeedback({ db, settings: makeSettings() }, { name: 'x', complete: async () => emptyTurn() }, USER, {
    ...input,
    winnerId: 'nope',
  });
  assert(r1.ok === false && r1.error === 'winner_not_in_candidates', 'feedback: winner outside candidateIds → winner_not_in_candidates');
  const r2 = await submitPortraitFeedback({ db, settings: makeSettings() }, { name: 'x', complete: async () => emptyTurn() }, USER, {
    ...input,
    candidateIds: ['c1', 'ghost'],
  });
  assert(r2.ok === false && r2.error === 'unknown_candidate_id', 'feedback: candidate id missing from the store → unknown_candidate_id');
}

// --- Amend-miss → create fallback (plan §Edge Cases): the gate concludes amend with an id that
//     matches no existing entry; the write falls back to create and is logged. ---
{
  const db = makeDb();
  const amendMissLlm = {
    name: 'fake-amend-miss',
    async complete() {
      return conclusionCall({ action: 'amend', id: 'no-such-entry', title: 'Lesson', body: 'Body', tags: ['a'], layerId: 'style' });
    },
  };
  const result = await submitPortraitFeedback({ db, settings: makeSettings() }, amendMissLlm, USER, input);
  assert(result.ok === true && result.reflection?.action === 'created', `feedback: amend-miss falls back to create -> ${result.reflection?.action}`);
  assert(result.reflection?.entryId === 'wiki-new-1', 'feedback: fallback create returns the new entry id');
}
