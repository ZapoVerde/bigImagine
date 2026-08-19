// Proves the portrait reflection-learning contract (docs/plans/portrait-studio-vision-review-
// harness-plan.md, plan §Verification) against fake Postgres + fake settings + fake LLM gates —
// no server, no network, no real provider (verify-location-presence-scraper.mjs's convention).
// The suite exercises:
//   - pure contract (portraits/reflection.ts): validateLessonCall (enums, conclusion requires
//     lesson/evidence/next_change/confidence, preserve/next-change disjointness, malformed args),
//     computeCandidateDiff (before→after, added/removed slots, unchanged), and
//     buildReflectionUserPrompt (the compact record — goal, parent, server-computed diffs, human
//     assessment, winner, prior lessons, bounded wiki; NO composed prompts);
//   - submitPortraitFeedback truthfulness: rationale required for a winner; a no-winner
//     submission stays awaiting_feedback and never triggers reflection; "no acceptable candidate"
//     produces insufficient_evidence without an LLM call; a conclusion creates exactly one
//     provisional lesson and concludes the episode; insufficient_evidence and failed states are
//     honest and visible; the immutable attempt row (visual_episode_learning) is persisted BEFORE
//     the episode's learning state changes; retrying an episode re-runs reflection as attempt N+1
//     (idempotent retries);
//   - the bounded wiki context: the reflection input_snapshot records exactly the revision ids of
//     the bounded context it was shown;
//   - the lesson-to-mutation link: runPortraitGenerationRound with a lessonId injects it as a hard
//     requirement, records a visual_lesson_uses row, and marks the candidates lesson_id; without
//     one the round is explicitly exploratory (no lesson-use row, lesson: null); a missing or
//     rejected lesson stays exploratory.

import { DEFAULT_LAYER_MANIFEST } from '../dist/portraits/layerStack.js';
import { computeCandidateDiff, validateLessonCall, buildReflectionUserPrompt, SUBMIT_LESSON_TOOL } from '../dist/portraits/reflection.js';
import { submitPortraitFeedback } from '../dist/orchestrator/portraitFeedback.js';
import { runPortraitGenerationRound } from '../dist/orchestrator/portraitGeneration.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const USER = '11111111-1111-1111-1111-111111111111';

// ============================================================================
// Pure contract (portraits/reflection.ts)
// ============================================================================

// --- validateLessonCall: strict, every enum + the preserve/next_change disjointness rule. ---
function lessonCall(args) {
  return { id: 'call-1', name: 'submit_lesson', arguments: args };
}
const validConclusion = lessonCall({
  status: 'conclusion',
  lesson: 'Keep coats above the knee.',
  evidence: 'The shortened red coat won with the calm expression.',
  next_change: { layer: 'outfit', instruction: 'End the coat above the knee.' },
  preserve: ['expression'],
  confidence: 'medium',
});
const v1 = validateLessonCall(validConclusion);
assert(v1.ok && v1.output.status === 'conclusion' && v1.output.lesson === 'Keep coats above the knee.', 'reflection: a valid conclusion validates');
assert(v1.ok && v1.output.preserve.length === 1 && v1.output.preserve[0] === 'expression', 'reflection: preserve array normalizes through');

const v2 = validateLessonCall(lessonCall({ status: 'insufficient_evidence' }));
assert(v2.ok && v2.output.status === 'insufficient_evidence', 'reflection: insufficient_evidence validates with no lesson fields');

assert(!validateLessonCall(lessonCall({ status: 'nonsense' })).ok, 'reflection: an unknown status is rejected');
assert(!validateLessonCall(lessonCall({ status: 'conclusion' })).ok, 'reflection: a conclusion missing lesson/evidence/next_change/confidence is rejected');
assert(!validateLessonCall(lessonCall({ status: 'conclusion', lesson: 'L', evidence: 'E', next_change: { layer: 'x', instruction: 'i' }, confidence: 'certain' })).ok, 'reflection: confidence outside low/medium/high is rejected');
assert(
  !validateLessonCall(
    lessonCall({
      status: 'conclusion',
      lesson: 'L',
      evidence: 'E',
      next_change: { layer: 'outfit', instruction: 'Shorten' },
      preserve: ['outfit'],
      confidence: 'high',
    }),
  ).ok,
  'reflection: a layer in both next_change and preserve is rejected',
);
assert(!validateLessonCall(lessonCall({ status: 'conclusion', lesson: 'L', evidence: 'E', next_change: { layer: 'x', instruction: 'i' }, preserve: 'not-an-array', confidence: 'high' })).ok, 'reflection: preserve must be an array of strings');
assert(!validateLessonCall({ id: 'c', name: 'submit_lesson', arguments: '{not json' }).ok, 'reflection: malformed arguments JSON is rejected');

// --- computeCandidateDiff: server-computed, never "rediscovered". ---
const parent = { outfit: { outfit_style: 'long coat', color: 'red' }, expression: { emotion: 'calm' } };
const child = { outfit: { outfit_style: 'short coat', color: 'red' }, style: { lighting: 'warm' } };
const diff = computeCandidateDiff(parent, child);
assert(diff.changed.some((c) => c.layer === 'outfit' && c.slot === 'outfit_style' && c.before === 'long coat' && c.after === 'short coat'), 'reflection: computeCandidateDiff reports the changed slot before→after');
assert(diff.changed.some((c) => c.layer === 'expression' && c.before === 'calm' && c.after === ''), 'reflection: a removed slot shows as before → (empty)');
assert(diff.changed.some((c) => c.layer === 'style' && c.before === '' && c.after === 'warm'), 'reflection: an added slot shows as (empty) → after');
assert(diff.unchanged.includes('outfit.color'), 'reflection: identical non-empty slots are reported unchanged');
const noDiff = computeCandidateDiff({ a: { x: '1' } }, { a: { x: '1' } });
assert(noDiff.changed.length === 0 && noDiff.unchanged.includes('a.x'), 'reflection: identical chromosomes produce no changes');

// --- buildReflectionUserPrompt: the compact episode record, no composed prompts. ---
const prompt = buildReflectionUserPrompt({
  goal: 'A calmer evening variant of Rin.',
  parentSlots: { outfit: { outfit_style: 'long coat' } },
  candidates: [
    {
      candidateId: 'c1',
      isWinner: true,
      rating: 5,
      note: 'keep the pose',
      diff: { changed: [{ layer: 'outfit', slot: 'outfit_style', before: 'long coat', after: 'short coat' }], unchanged: [] },
    },
  ],
  rationale: 'The shorter coat reads better for evening.',
  layerAssessments: [{ layer: 'outfit', assessment: 'improved' }],
  priorLessonIds: ['lesson-1'],
  wikiContext: '## Keep coats short\nCoats read bulky below the knee.',
  wikiRevisionIds: ['rev-1'],
  existingLessonsIndex: '- lesson-9 [outfit, provisional]: Shorter coats read better for evening scenes.',
});
assert(prompt.includes('Round goal: A calmer evening variant of Rin.'), 'reflection: prompt carries the goal');
assert(
  prompt.includes('Existing lessons') && prompt.includes('lesson-9 [outfit, provisional]: Shorter coats read better for evening scenes.'),
  'reflection: prompt surfaces the existing-lessons index so the model can amend instead of duplicate',
);
assert(prompt.includes('Parent chromosome:') && prompt.includes('- outfit: outfit_style: long coat'), 'reflection: prompt carries the parent chromosome');
assert(prompt.includes('outfit.outfit_style: long coat -> short coat'), 'reflection: prompt carries the server-computed diff, not composed prompts');
assert(!prompt.toLowerCase().includes('prompt: portrait'), 'reflection: prompt never includes composed image prompts');
assert(prompt.includes('rationale: The shorter coat reads better for evening.'), 'reflection: prompt carries the human rationale');
assert(prompt.includes('- outfit: improved'), 'reflection: prompt carries the layer assessments');
assert(prompt.includes('c1 (winner)'), 'reflection: prompt marks the winner');
assert(prompt.includes('Prior lessons used: lesson-1'), 'reflection: prompt lists prior lesson ids');
assert(prompt.includes('Wiki context (current lessons, bounded — 1 revision(s)):') && prompt.includes('## Keep coats short'), 'reflection: prompt carries the bounded wiki context');

// ============================================================================
// Integration fakes
// ============================================================================

function makeSettings(overrides = {}) {
  const map = new Map([
    ['visual_layer_stack', JSON.stringify(DEFAULT_LAYER_MANIFEST)],
    ['visual_mutation_candidate_count', '2'],
    ['visual_reflection_system_prompt_override', ''],
    ['visual_wiki_context_budget', '2400'],
    ...Object.entries(overrides),
  ]);
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value);
    },
  };
}

function makeDb({ seedWiki = true } = {}) {
  const state = {
    entities: [],
    candidates: [],
    episodes: [],
    wikiEntries: [],
    revisions: [],
    wikiRevisions: [],
    learning: [],
    lessons: [],
    lessonUses: [],
    rounds: [],
    imageCalls: [],
    events: [],
    counters: { entity: 0, candidate: 0, episode: 0, learning: 0, lesson: 0, use: 0, round: 0, imageCall: 0, wiki: 0, revision: 0 },
    promoWrites: [],
    ratingWrites: [],
  };
  if (seedWiki) {
    state.wikiEntries.push(
      {
        entry_id: 'w1',
        title: 'Keep coats short',
        body: 'Coats read bulky below the knee.',
        tags: ['outfit'],
        subscriptions: [{ layerType: 'outfit', layerEntityId: null }],
      },
      {
        entry_id: 'w2',
        title: 'Amber eyes carry',
        body: 'Amber reads warmest under teahouse light.',
        tags: ['style'],
        subscriptions: [{ layerType: 'style', layerEntityId: null }],
      },
    );
    state.revisions.push(
      { entry_id: 'w1', revision_id: 'rev-w1' },
      { entry_id: 'w2', revision_id: 'rev-w2' },
    );
  }
  const query = (sql, params = []) => {
    const s = sql;
    // Generation: per-subject attempt counter.
    if (s.includes('coalesce(max(generation), 0) + 1')) {
      const subject = params[1];
      const gens = state.candidates.filter((c) => c.entity_ids?.subject === subject).map((c) => c.generation);
      return [{ attempt: String((gens.length ? Math.max(...gens) : 0) + 1) }];
    }
    // Feedback: loadCandidates by ids, grid order.
    if (s.includes('from visual_candidates') && s.includes('candidate_id = any')) {
      const ids = params[1];
      return ids.map((id) => state.candidates.find((c) => c.candidate_id === id)).filter(Boolean);
    }
    // Generation: named-entity resolution (hard contract) or most-recently-used fallback.
    if (s.includes('from visual_entities where entity_id = $1')) {
      return state.entities.filter((e) => e.entity_id === params[0] && e.user_id === params[1]);
    }
    // insertLesson's entity-name lookup (feedback reflection lesson ledger, commit e8f0d3e).
    if (s.startsWith('select name from visual_entities')) {
      const row = state.entities.find((e) => e.entity_id === params[0] && e.user_id === params[1]);
      return row ? [{ name: row.name }] : [];
    }
    if (s.includes('from visual_entities where user_id = $1 and layer_id = $2')) {
      return state.entities.filter((e) => e.user_id === params[0] && e.layer_id === params[1]).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, 1);
    }
    if (s.startsWith('insert into visual_entities (user_id, layer_id, name)')) {
      state.counters.entity += 1;
      const row = { entity_id: `ent-${state.counters.entity}`, user_id: params[0], layer_id: params[1], slots: {}, template: null, name: params[2], updated_at: 0 };
      state.entities.push(row);
      return [row];
    }
    // Feedback: insertLesson's supersedes_lesson_id target lookup (amend path) and mark-superseded
    // write — checked BEFORE the generic visual_wiki_entries/visual_wiki_revisions/visual_lessons
    // reads below, since several of these SQL strings are substrings of the generic ones.
    if (s.startsWith('select lesson_id from visual_lessons where lesson_id = $1') && s.includes('state in')) {
      return state.lessons.filter((l) => l.lesson_id === params[0] && l.user_id === params[1] && (l.state === 'provisional' || l.state === 'supported'));
    }
    if (s.startsWith("update visual_lessons set state = 'superseded'")) {
      const row = state.lessons.find((l) => l.lesson_id === params[0] && l.user_id === params[1]);
      if (row) row.state = 'superseded';
      return [];
    }
    // Feedback: buildReflectionSnapshot's existing-lessons index (portrait-studio-lesson-amend-plan.md).
    if (s.startsWith('select l.lesson_id, l.statement')) {
      return state.wikiEntries
        .filter((w) => w.lesson_id && w.user_id === params[0])
        .map((w) => {
          const lesson = state.lessons.find((l) => l.lesson_id === w.lesson_id);
          return lesson && (lesson.state === 'provisional' || lesson.state === 'supported')
            ? { lesson_id: lesson.lesson_id, statement: lesson.statement, layer: lesson.next_change?.layer, state: lesson.state, subscriptions: w.subscriptions }
            : null;
        })
        .filter(Boolean);
    }
    // Feedback: insertLesson's amend-target entry lookup.
    if (s.startsWith('select entry_id from visual_wiki_entries where lesson_id = $1')) {
      const row = state.wikiEntries.find((w) => w.lesson_id === params[0] && w.user_id === params[1]);
      return row ? [{ entry_id: row.entry_id }] : [];
    }
    if (s.startsWith('update visual_wiki_entries set title = $2')) {
      const row = state.wikiEntries.find((w) => w.entry_id === params[0] && w.user_id === params[6]);
      if (row) {
        row.title = params[1];
        row.body = params[2];
        row.tags = params[3];
        row.subscriptions = JSON.parse(params[4]);
        row.lesson_id = params[5];
      }
      return [];
    }
    // Feedback: insertLesson's create/amend revision counter and history write — kind is a SQL
    // literal, never a param, so the create/amend shapes are told apart from the query text.
    if (s.startsWith('select coalesce(max(revision_number), 0) + 1 as n from visual_wiki_revisions')) {
      const nums = state.wikiRevisions.filter((r) => r.entry_id === params[0] && r.user_id === params[1]).map((r) => r.revision_number);
      return [{ n: (nums.length ? Math.max(...nums) : 0) + 1 }];
    }
    if (s.startsWith('insert into visual_wiki_revisions')) {
      state.counters.revision = (state.counters.revision ?? 0) + 1;
      const kind = s.includes("'amended'") ? 'amended' : 'created';
      const revisionNumber = kind === 'amended' ? params[2] : 1;
      const lessonIds = kind === 'amended' ? params[4] : params[3];
      const episodeIds = kind === 'amended' ? params[5] : params[4];
      state.wikiRevisions.push({
        revision_id: `rev-${state.counters.revision}`,
        user_id: params[0],
        entry_id: params[1],
        revision_number: revisionNumber,
        kind,
        lesson_ids: lessonIds,
        episode_ids: episodeIds,
      });
      return [];
    }
    // Wiki universe (loadAllWikiEntries) + revision map.
    if (s.includes('from visual_wiki_entries')) {
      return state.wikiEntries;
    }
    if (s.includes('from visual_wiki_revisions')) {
      return state.revisions;
    }
    // Generation: lesson-for-use.
    if (s.includes('from visual_lessons where lesson_id = $1')) {
      return state.lessons.filter((l) => l.lesson_id === params[0] && l.user_id === params[1]);
    }
    // Feedback: episode load.
    if (s.includes('from visual_episodes where episode_id = $1')) {
      return state.episodes.filter((e) => e.episode_id === params[0] && e.user_id === params[1]);
    }
    // Feedback: attempt counter.
    if (s.includes('from visual_episode_learning')) {
      return [{ n: String(state.learning.length) }];
    }
    // Feedback: episode insert (the primary write — happens first). params[7] is the round_id the
    // feedback closes (portrait-studio-telemetry-plan.md) — null for historical/un-correlated rounds.
    if (s.startsWith('insert into visual_episodes')) {
      state.counters.episode += 1;
      const row = {
        episode_id: `ep-${state.counters.episode}`,
        user_id: params[0],
        entity_ids: JSON.parse(params[1]),
        goal: params[2],
        rationale: params[3],
        selected_candidate_id: params[4],
        candidate_ids: params[5],
        reflection_status: params[6],
        round_id: params[7] ?? null,
      };
      state.episodes.push(row);
      return [{ episode_id: row.episode_id }];
    }
    // Feedback: ratings/notes.
    if (s.includes('update visual_candidates set rating')) {
      const row = state.candidates.find((c) => c.candidate_id === params[0]);
      if (row) row.rating = params[1];
      state.ratingWrites.push({ candidateId: params[0], rating: params[1] });
      return [];
    }
    if (s.includes('update visual_candidates set note')) {
      const row = state.candidates.find((c) => c.candidate_id === params[0]);
      if (row) row.note = params[1];
      return [];
    }
    // Feedback: winner promotion (with or without the slots write).
    if (s.startsWith('update visual_entities set last_image_url')) {
      const withSlots = params.length === 5;
      const entityId = params[withSlots ? 4 : 3];
      state.promoWrites.push({ entityId, imageUrl: params[0], candidateId: params[1] });
      const row = state.entities.find((e) => e.entity_id === entityId);
      if (row) {
        row.last_image_url = params[0];
        row.current_best_candidate_id = params[1];
        if (withSlots) row.slots = JSON.parse(params[2]);
      }
      return [];
    }
    // Feedback: events / learning / lessons.
    if (s.startsWith('insert into visual_episode_events')) {
      // event_type is a SQL literal (never a param): params = [userId, episodeId, payloadJson].
      const eventType = s.match(/'(winner_applied|reflection_started|reflection_failed|lesson_created|insufficient_evidence)'/)?.[1];
      state.events.push({ episodeId: params[1], eventType, payload: JSON.parse(params[2]) });
      return [];
    }
    if (s.startsWith('insert into visual_episode_learning')) {
      state.counters.learning += 1;
      const row = {
        learning_id: `learn-${state.counters.learning}`,
        episode_id: params[1],
        attempt: params[2],
        status: params[3],
        input_snapshot: JSON.parse(params[4]),
        output_snapshot: JSON.parse(params[5]),
      };
      state.learning.push(row);
      return [{ learning_id: row.learning_id }];
    }
    if (s.startsWith('insert into visual_lessons')) {
      // state is the 'provisional' literal; params = [userId, episodeId, learningId, statement,
      // evidence, nextChangeJson, preserve, confidence].
      state.counters.lesson += 1;
      const row = {
        lesson_id: `lesson-${state.counters.lesson}`,
        user_id: params[0],
        source_episode_id: params[1],
        source_learning_id: params[2],
        statement: params[3],
        next_change: JSON.parse(params[5]),
        preserve: params[6],
        confidence: params[7],
        state: 'provisional',
      };
      state.lessons.push(row);
      return [{ lesson_id: row.lesson_id }];
    }
    if (s.startsWith('insert into visual_wiki_entries')) {
      // Provisional-lesson persistence: params = [userId, title, body, tags, subscriptionsJson,
      // episodeId, lessonId], returning entry_id.
      state.counters.wiki = (state.counters.wiki ?? 0) + 1;
      const row = {
        entry_id: `wiki-${state.counters.wiki}`,
        user_id: params[0],
        title: params[1],
        body: params[2],
        tags: params[3],
        subscriptions: JSON.parse(params[4]),
        origin_episode_id: params[5],
        lesson_id: params[6],
      };
      state.wikiEntries.push(row);
      return [{ entry_id: row.entry_id }];
    }
    if (s.startsWith('update visual_episodes set reflection_status')) {
      const row = state.episodes.find((e) => e.episode_id === params[0]);
      if (row) row.reflection_status = params[1];
      return [];
    }
    // Generation: candidate insert + lesson-use record.
    if (s.startsWith('insert into visual_candidates')) {
      state.counters.candidate += 1;
      const candidateId = `cand-${state.counters.candidate}`;
      state.candidates.push({
        candidate_id: candidateId,
        user_id: params[0],
        entity_ids: JSON.parse(params[1]),
        generation: params[2],
        chromosome: JSON.parse(params[3]),
        image_url: params[4],
        parent_chromosome: JSON.parse(params[5]),
        composed_prompt: params[6],
        render_metadata: JSON.parse(params[7]),
        wiki_revision_ids: params[8],
        lesson_id: params[9],
      });
      return [{ candidate_id: candidateId }];
    }
    if (s.startsWith('insert into visual_lesson_uses')) {
      // episode_id is the SQL literal null here; params = [userId, lessonId, mutationCall, appliedChange, resultCandidates].
      state.counters.use += 1;
      state.lessonUses.push({
        use_id: `use-${state.counters.use}`,
        user_id: params[0],
        lesson_id: params[1],
        episode_id: null,
        mutation_call: JSON.parse(params[2]),
        applied_change: JSON.parse(params[3]),
        result_candidates: JSON.parse(params[4]),
      });
      return [];
    }
    // Round telemetry (portrait-studio-telemetry-plan.md): visual_rounds create/terminal write and
    // one visual_round_image_calls row per render (running → succeeded/failed, candidate_id
    // backfilled after the candidate insert).
    if (s.startsWith('insert into visual_rounds')) {
      state.counters.round += 1;
      const roundId = `round-${state.counters.round}`;
      state.rounds.push({ round_id: roundId, user_id: params[0], goal: params[1], status: 'running', started_at: 0 });
      return [{ round_id: roundId }];
    }
    if (s.startsWith('update visual_rounds set status')) {
      const row = state.rounds.find((r) => r.round_id === params[0]);
      if (row) {
        row.status = params[1];
        row.completed_at = 0;
      }
      return [];
    }
    if (s.startsWith('insert into visual_round_image_calls')) {
      state.counters.imageCall += 1;
      const callId = `img-${state.counters.imageCall}`;
      state.imageCalls.push({
        call_id: callId,
        user_id: params[0],
        round_id: params[1],
        status: 'running',
        provider_kind: params[2],
        model: params[3],
        candidate_id: null,
      });
      return [{ call_id: callId }];
    }
    if (s.startsWith('update visual_round_image_calls set status')) {
      const row = state.imageCalls.find((c) => c.call_id === params[0]);
      if (row) {
        row.status = params[1];
        row.duration_ms = params[2];
        row.error_message = params[3];
      }
      return [];
    }
    if (s.startsWith('update visual_round_image_calls set candidate_id')) {
      const row = state.imageCalls.find((c) => c.call_id === params[0]);
      if (row) row.candidate_id = params[1];
      return [];
    }
    throw new Error(`fake pool got an unexpected query: ${s.slice(0, 120)}`);
  };
  return {
    state,
    withUserScope: async (_userId, fn) => fn({ query }),
  };
}

function seedRoundCandidates(db, { count = 3, winnerId = 'c1' } = {}) {
  const ids = Array.from({ length: count }, (_, i) => `c${i + 1}`);
  ids.forEach((id, i) => {
    db.state.candidates.push({
      candidate_id: id,
      entity_ids: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
      image_url: `https://img/${id}.png`,
      chromosome: {
        slots: {
          subject: { subject_identity: `Rin V${i + 1}` },
          outfit: { outfit_style: i === 0 ? 'short coat' : 'long coat' },
          style: { style_style: 'VLZ hybrid' },
          expression: { expression_emotion: 'calm' },
        },
      },
      parent_chromosome: {
        slots: {
          subject: { subject_identity: 'Rin V1' },
          outfit: { outfit_style: 'long coat' },
          style: { style_style: 'VLZ hybrid' },
          expression: { expression_emotion: 'calm' },
        },
      },
      composed_prompt: 'PORTRAIT Rin / long coat / VLZ hybrid / calm',
      render_metadata: { model: 'fake' },
      wiki_revision_ids: ['rev-w1', 'rev-w2'],
      lesson_id: null,
    });
  });
  return ids;
}

function conclusionTurn(overrides = {}) {
  return {
    message: { role: 'assistant', content: '' },
    toolCalls: [
      {
        id: 'less-1',
        name: 'submit_lesson',
        arguments: {
          status: 'conclusion',
          lesson: 'End coats above the knee for evening.',
          evidence: 'The shortened coat won with the calm expression and the human picked it.',
          next_change: { layer: 'outfit', instruction: 'End the coat above the knee.' },
          preserve: ['expression'],
          confidence: 'medium',
          ...overrides,
        },
      },
    ],
  };
}

const noCallGate = {
  name: 'noop',
  complete: async () => {
    throw new Error('the reflection gate must not be called');
  },
};

const baseInput = {
  entityIds: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
  goal: 'A calmer evening variant of Rin.',
  candidateIds: ['c1', 'c2', 'c3'],
  winnerId: 'c1',
  rationale: 'The quiet pose wins; coats still too long.',
};

// ============================================================================
// Feedback truthfulness
// ============================================================================

// --- Rationale is required when marking a winner. ---
{
  const db = makeDb();
  seedRoundCandidates(db);
  const r = await submitPortraitFeedback({ db, settings: makeSettings() }, noCallGate, USER, { ...baseInput, rationale: undefined });
  assert(r.ok === false && r.error === 'rationale_required_for_winner', 'feedback: a winner without episode-level rationale is rejected');
  assert(db.state.episodes.length === 0, 'feedback: the rejected round writes no episode');
}

// --- No-winner submission: episode in awaiting_feedback, ratings stored, NO reflection call. ---
{
  const db = makeDb();
  seedRoundCandidates(db);
  const r = await submitPortraitFeedback({ db, settings: makeSettings() }, noCallGate, USER, { ...baseInput, winnerId: undefined, ratings: { c1: 4 }, rationale: undefined });
  assert(r.ok && r.reflection?.action === 'awaiting_feedback', 'feedback: a no-winner submission reports awaiting_feedback');
  assert(db.state.episodes.length === 1 && db.state.episodes[0].reflection_status === 'awaiting_feedback', 'feedback: the episode row is recorded awaiting_feedback');
  assert(db.state.events.length === 0 && db.state.learning.length === 0, 'feedback: a no-winner submission triggers no reflection events or attempts');
  assert(db.state.ratingWrites.some((w) => w.candidateId === 'c1' && w.rating === 4), 'feedback: ratings are still stored');
}

// --- "No acceptable candidate": insufficient_evidence, no LLM call. ---
{
  const db = makeDb();
  seedRoundCandidates(db);
  const r = await submitPortraitFeedback({ db, settings: makeSettings() }, noCallGate, USER, { ...baseInput, winnerId: undefined, noAcceptableCandidate: true, rationale: undefined });
  assert(r.ok && r.reflection?.action === 'insufficient_evidence', 'feedback: operator "no acceptable candidate" → insufficient_evidence');
  assert(db.state.episodes[0].reflection_status === 'insufficient_evidence', 'feedback: the episode is honestly marked insufficient_evidence');
  assert(db.state.learning.length === 1 && db.state.learning[0].status === 'insufficient_evidence', 'feedback: the no-acceptable attempt is persisted');
  assert(db.state.events.some((e) => e.eventType === 'insufficient_evidence'), 'feedback: an insufficient_evidence event is recorded');
}

// --- Winner + conclusion: one provisional lesson, truthful episode, immutable attempt first. ---
{
  const db = makeDb();
  seedRoundCandidates(db);
  const calls = [];
  const gate = {
    name: 'fake-gate',
    async complete(messages, tools, options) {
      calls.push({ tools, options });
      return conclusionTurn();
    },
  };
  const r = await submitPortraitFeedback({ db, settings: makeSettings() }, gate, USER, baseInput);
  assert(r.ok && r.reflection?.action === 'concluded' && r.reflection.lessonId === 'lesson-1', 'feedback: a conclusion returns the created lesson id');
  assert(calls.length === 1, `feedback: exactly ONE bounded reflection call -> ${calls.length}`);
  assert(calls[0].tools.length === 1 && calls[0].tools[0].name === 'submit_lesson', 'feedback: the reflection call offers only submit_lesson');
  assert(calls[0].options?.forceTool === 'submit_lesson', 'feedback: submit_lesson is forced');
  assert(db.state.episodes[0].reflection_status === 'concluded', 'feedback: the episode honestly reaches concluded');
  assert(db.state.lessons.length === 1 && db.state.lessons[0].state === 'provisional', 'feedback: exactly one provisional lesson is created');
  assert(db.state.learning.length === 1 && db.state.learning[0].status === 'concluded', 'feedback: one immutable attempt row, status concluded');
  const eventTypes = db.state.events.map((e) => e.eventType);
  assert(eventTypes.includes('winner_applied') && eventTypes.includes('reflection_started') && eventTypes.includes('lesson_created'), 'feedback: winner_applied / reflection_started / lesson_created events recorded');
  assert(db.state.promoWrites.some((p) => p.entityId === 'e-out' && p.imageUrl === 'https://img/c1.png'), 'feedback: the winner image promotes each winning entity');
  const snapshot = db.state.learning[0].input_snapshot;
  assert(snapshot.priorLessonIds.length === 0, 'feedback: an exploratory round records no prior lessons');
  assert(snapshot.wikiRevisionIds.length === 2 && snapshot.wikiRevisionIds.includes('rev-w1'), 'feedback: the snapshot records the bounded wiki revision ids shown');
}

// --- Amend (docs/plans/portrait-studio-lesson-amend-plan.md): a conclusion naming
// supersedes_lesson_id revises an existing lesson instead of creating a near-duplicate — the old
// lesson is marked superseded, its wiki entry is updated in place (same entry_id, not a new row),
// and a visual_wiki_revisions row records the amendment against both lesson ids. ---
{
  const db = makeDb();
  seedRoundCandidates(db);
  db.state.lessons.push({
    lesson_id: 'lesson-old',
    user_id: USER,
    statement: 'Shorter coats read better for evening.',
    next_change: { layer: 'outfit', instruction: 'Shorten hemlines.' },
    state: 'provisional',
  });
  db.state.wikiEntries.push({
    entry_id: 'wiki-old',
    user_id: USER,
    title: 'Provisional lesson: Shorter coats read better for evening.',
    body: 'Shorter coats read better for evening.\n\nEvidence: earlier round.',
    tags: ['provisional', 'outfit'],
    subscriptions: [{ layerType: 'outfit', layerEntityId: 'e-out' }],
    origin_episode_id: 'ep-old',
    lesson_id: 'lesson-old',
  });

  const gate = {
    name: 'fake-amend',
    async complete(messages) {
      // Prove the model actually saw the existing lesson available to reference, not just that
      // the server happens to accept the id if supplied blind.
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      if (!userContent.includes('lesson-old')) throw new Error('existing lesson id missing from the reflection prompt');
      return conclusionTurn({ supersedes_lesson_id: 'lesson-old' });
    },
  };
  const r = await submitPortraitFeedback({ db, settings: makeSettings() }, gate, USER, baseInput);
  assert(r.ok && r.reflection?.action === 'concluded' && r.reflection.supersedesLessonId === 'lesson-old', 'amend: the outcome reports which lesson was superseded');
  assert(db.state.lessons.find((l) => l.lesson_id === 'lesson-old').state === 'superseded', 'amend: the old lesson is marked superseded, not deleted');
  const newLesson = db.state.lessons.find((l) => l.lesson_id !== 'lesson-old');
  assert(newLesson && newLesson.state === 'provisional', 'amend: a new lesson row is still created — the ledger stays append-only');
  assert(db.state.wikiEntries.length === 3, 'amend: no new wiki entry is created — the existing one is amended in place (w1 + w2 seed + wiki-old)');
  const entry = db.state.wikiEntries.find((w) => w.entry_id === 'wiki-old');
  assert(entry.lesson_id === newLesson.lesson_id, 'amend: the amended entry now points at the new lesson');
  assert(entry.title.includes('End coats above the knee'), 'amend: the amended entry carries the new lesson text, not the old');
  const rev = db.state.wikiRevisions.find((rv) => rv.entry_id === 'wiki-old');
  assert(
    rev && rev.kind === 'amended' && rev.lesson_ids.includes('lesson-old') && rev.lesson_ids.includes(newLesson.lesson_id),
    'amend: a visual_wiki_revisions row records the amendment, referencing both the old and new lesson id',
  );
}

// --- A create-path conclusion (no supersedes_lesson_id) also writes a visual_wiki_revisions row
// (kind='created') — previously only the legacy backfill ever populated that table. ---
{
  const db = makeDb();
  seedRoundCandidates(db);
  const gate = { name: 'fake-create', async complete() { return conclusionTurn(); } };
  const r = await submitPortraitFeedback({ db, settings: makeSettings() }, gate, USER, baseInput);
  const newEntry = db.state.wikiEntries.find((w) => w.lesson_id === r.reflection.lessonId);
  const rev = db.state.wikiRevisions.find((rv) => rv.entry_id === newEntry.entry_id);
  assert(rev && rev.kind === 'created' && rev.revision_number === 1, 'create: a fresh wiki entry gets its own revision_number 1, kind created');
}

// --- Insufficient evidence from the model: honest terminal state, no lesson. ---
{
  const db = makeDb();
  seedRoundCandidates(db);
  const gate = {
    name: 'fake-insufficient',
    async complete() {
      return { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'i1', name: 'submit_lesson', arguments: { status: 'insufficient_evidence' } }] };
    },
  };
  const r = await submitPortraitFeedback({ db, settings: makeSettings() }, gate, USER, baseInput);
  assert(r.ok && r.reflection?.action === 'insufficient_evidence', 'feedback: a model insufficient_evidence lands honestly');
  assert(db.state.episodes[0].reflection_status === 'insufficient_evidence', 'feedback: the episode is marked insufficient_evidence');
  assert(db.state.lessons.length === 0, 'feedback: insufficient_evidence creates no lesson');
}

// --- Invalid conclusion (preserve overlaps next_change): failed, no lesson, retryable. ---
{
  const db = makeDb();
  seedRoundCandidates(db);
  const gate = {
    name: 'fake-invalid',
    async complete() {
      return conclusionTurn({ preserve: ['outfit'] });
    },
  };
  const r = await submitPortraitFeedback({ db, settings: makeSettings() }, gate, USER, baseInput);
  assert(r.ok && r.reflection?.action === 'failed' && /both next_change and preserve/.test(r.reflection.reason ?? ''), 'feedback: a disjointness violation becomes failed');
  assert(db.state.episodes[0].reflection_status === 'failed', 'feedback: the episode is honestly marked failed (never silently learned)');
  assert(db.state.lessons.length === 0, 'feedback: an invalid conclusion creates no lesson');
  assert(db.state.events.some((e) => e.eventType === 'reflection_failed'), 'feedback: a reflection_failed event is recorded');
}

// --- Provider error / no tool call: failed. ---
{
  const db = makeDb();
  seedRoundCandidates(db);
  const r = await submitPortraitFeedback(
    { db, settings: makeSettings() },
    { name: 'boom', async complete() { throw new Error('provider timed out'); } },
    USER,
    baseInput,
  );
  assert(r.ok && r.reflection?.action === 'failed' && r.reflection.reason === 'provider timed out', 'feedback: a provider error becomes a failed attempt');
  assert(db.state.episodes[0].reflection_status === 'failed', 'feedback: the episode is marked failed after a provider error');

  const db2 = makeDb();
  seedRoundCandidates(db2);
  const r2 = await submitPortraitFeedback(
    { db: db2, settings: makeSettings() },
    { name: 'text-only', async complete() { return { message: { role: 'assistant', content: 'no tool call' }, toolCalls: [] }; } },
    USER,
    baseInput,
  );
  assert(r2.ok && r2.reflection?.action === 'failed' && /no submit_lesson tool call/.test(r2.reflection.reason ?? ''), 'feedback: a text-only reply is a failed attempt');
}

// --- Idempotent retry: a failed episode re-runs reflection as attempt N+1. ---
{
  const db = makeDb();
  seedRoundCandidates(db);
  let calls = 0;
  const failingGate = { name: 'fail-once', async complete() { calls += 1; throw new Error('timeout'); } };
  const first = await submitPortraitFeedback({ db, settings: makeSettings() }, failingGate, USER, baseInput);
  assert(first.ok && first.reflection?.action === 'failed', 'retry: the first attempt fails');
  assert(db.state.episodes[0].reflection_status === 'failed', 'retry: episode is failed after attempt 1');
  assert(db.state.learning.length === 1 && db.state.learning[0].attempt === 1, 'retry: attempt 1 is persisted');

  const goodGate = { name: 'good', async complete() { return conclusionTurn(); } };
  const second = await submitPortraitFeedback({ db, settings: makeSettings() }, goodGate, USER, { episodeId: 'ep-1' });
  assert(second.ok && second.reflection?.action === 'concluded', 'retry: the retry re-runs reflection and concludes');
  assert(db.state.learning.length === 2 && db.state.learning.map((l) => l.attempt).sort().join(',') === '1,2', 'retry: each attempt is its own immutable row (attempt 1 + 2)');
  assert(db.state.episodes[0].reflection_status === 'concluded', 'retry: the episode reaches concluded on the retry');
}

// ============================================================================
// Lesson-to-mutation linkage (plan §API step 6)
// ============================================================================

const pollinationsProfile = {
  kind: 'pollinations',
  apiKey: 'fake-key',
  model: 'flux',
  baseUrl: null,
  masterNegativePrompt: null,
  width: 832,
  height: 1216,
  samplingSteps: 1,
  cfgScale: 1,
  samplerName: null,
  workflowParameters: null,
};
const imageConnections = { resolveActive: async (purpose) => (purpose === 'portrait' ? pollinationsProfile : null) };

function mutationTurn() {
  return {
    message: {
      role: 'assistant',
      content: [
        '### Candidate 1',
        '[outfit]',
        'outfit_style: short coat',
        '### Candidate 2',
        '[outfit]',
        'outfit_style: long coat',
      ].join('\n'),
    },
    toolCalls: [],
  };
}

const generationInput = {
  entityIds: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
  goal: 'A calmer evening variant of Rin.',
};

// --- Lesson-driven round: lessonId injects a hard requirement, records the use, marks candidates. ---
{
  const db = makeDb({ seedWiki: false });
  db.state.lessons.push({
    lesson_id: 'lesson-drive',
    user_id: USER,
    statement: 'End coats above the knee for evening.',
    evidence: 'Evidence.',
    next_change: { layer: 'outfit', instruction: 'End the coat above the knee.' },
    preserve: ['expression'],
    confidence: 'medium',
    state: 'provisional',
  });
  db.state.entities.push(
    { entity_id: 'e-sub', user_id: USER, layer_id: 'subject', slots: { subject_identity: 'Rin' }, template: null, updated_at: 0 },
    { entity_id: 'e-out', user_id: USER, layer_id: 'outfit', slots: { outfit_style: 'long coat' }, template: null, updated_at: 0 },
    { entity_id: 'e-style', user_id: USER, layer_id: 'style', slots: { style_style: 'VLZ hybrid' }, template: null, updated_at: 0 },
    { entity_id: 'e-expr', user_id: USER, layer_id: 'expression', slots: { expression_emotion: 'calm' }, template: null, updated_at: 0 },
  );
  let userContent = '';
  const gate = {
    name: 'mut',
    async complete(messages, tools) {
      if (tools.length === 0) {
        userContent = messages[messages.length - 1].content;
        return mutationTurn();
      }
      throw new Error('unexpected tool offer with an empty wiki');
    },
  };
  const r = await runPortraitGenerationRound({ db, settings: makeSettings(), imageConnections }, gate, USER, { ...generationInput, lessonId: 'lesson-drive' });
  assert(r.ok === true, 'generation: a lesson-driven round succeeds');
  assert(r.lesson && r.lesson.lessonId === 'lesson-drive', 'generation: the round reports the lesson that drove it');
  assert(userContent.includes('Guiding lesson (from the last concluded reflection — treat as a hard requirement):') && userContent.includes('End coats above the knee for evening.') && userContent.includes('outfit: End the coat above the knee.') && userContent.includes('keep unchanged: expression'), 'generation: the guiding lesson is injected as a hard requirement');
  assert(db.state.lessonUses.length === 1 && db.state.lessonUses[0].lesson_id === 'lesson-drive', 'generation: a visual_lesson_uses row is recorded');
  assert(db.state.lessonUses[0].applied_change.next_change.layer === 'outfit', 'generation: the applied change is recorded');
  assert(db.state.candidates.length === 2 && db.state.candidates.every((c) => c.lesson_id === 'lesson-drive'), 'generation: every candidate carries the lesson_id provenance');
  assert(r.candidates?.length === 2 && r.candidates.every((c) => c.imageUrl), 'generation: candidates render through the fake provider');
}

// --- Exploratory round: no lesson, no use, no crash. ---
{
  const db = makeDb({ seedWiki: false });
  db.state.entities.push(
    { entity_id: 'e-sub', user_id: USER, layer_id: 'subject', slots: { subject_identity: 'Rin' }, template: null, updated_at: 0 },
    { entity_id: 'e-out', user_id: USER, layer_id: 'outfit', slots: { outfit_style: 'long coat' }, template: null, updated_at: 0 },
    { entity_id: 'e-style', user_id: USER, layer_id: 'style', slots: { style_style: 'VLZ hybrid' }, template: null, updated_at: 0 },
    { entity_id: 'e-expr', user_id: USER, layer_id: 'expression', slots: { expression_emotion: 'calm' }, template: null, updated_at: 0 },
  );
  const gate = { name: 'mut', async complete() { return mutationTurn(); } };
  const r = await runPortraitGenerationRound({ db, settings: makeSettings(), imageConnections }, gate, USER, generationInput);
  assert(r.ok === true && r.lesson === null, 'generation: an exploratory round reports lesson null');
  assert(db.state.lessonUses.length === 0, 'generation: an exploratory round records no lesson use');
  assert(db.state.candidates.every((c) => c.lesson_id === null), 'generation: exploratory candidates carry no lesson_id');
}

// --- Missing / rejected lesson: stays exploratory, never crashes. ---
{
  const db = makeDb({ seedWiki: false });
  db.state.entities.push(
    { entity_id: 'e-sub', user_id: USER, layer_id: 'subject', slots: { subject_identity: 'Rin' }, template: null, updated_at: 0 },
    { entity_id: 'e-out', user_id: USER, layer_id: 'outfit', slots: { outfit_style: 'long coat' }, template: null, updated_at: 0 },
    { entity_id: 'e-style', user_id: USER, layer_id: 'style', slots: { style_style: 'VLZ hybrid' }, template: null, updated_at: 0 },
    { entity_id: 'e-expr', user_id: USER, layer_id: 'expression', slots: { expression_emotion: 'calm' }, template: null, updated_at: 0 },
  );
  const gate = { name: 'mut', async complete() { return mutationTurn(); } };
  const missing = await runPortraitGenerationRound({ db, settings: makeSettings(), imageConnections }, gate, USER, { ...generationInput, lessonId: 'no-such-lesson' });
  assert(missing.ok === true && missing.lesson === null, 'generation: a missing lesson keeps the round exploratory');
  assert(db.state.lessonUses.length === 0, 'generation: a missing lesson records no use');

  const db2 = makeDb({ seedWiki: false });
  db2.state.lessons.push({ lesson_id: 'lesson-rejected', user_id: USER, statement: 'S', evidence: 'E', next_change: { layer: 'outfit', instruction: 'i' }, preserve: [], confidence: 'low', state: 'rejected' });
  db2.state.entities.push(
    { entity_id: 'e-sub', user_id: USER, layer_id: 'subject', slots: { subject_identity: 'Rin' }, template: null, updated_at: 0 },
    { entity_id: 'e-out', user_id: USER, layer_id: 'outfit', slots: { outfit_style: 'long coat' }, template: null, updated_at: 0 },
    { entity_id: 'e-style', user_id: USER, layer_id: 'style', slots: { style_style: 'VLZ hybrid' }, template: null, updated_at: 0 },
    { entity_id: 'e-expr', user_id: USER, layer_id: 'expression', slots: { expression_emotion: 'calm' }, template: null, updated_at: 0 },
  );
  const rejected = await runPortraitGenerationRound({ db: db2, settings: makeSettings(), imageConnections }, gate, USER, { ...generationInput, lessonId: 'lesson-rejected' });
  assert(rejected.ok === true && rejected.lesson === null, 'generation: a rejected lesson keeps the round exploratory');
  assert(db2.state.lessonUses.length === 0, 'generation: a rejected lesson records no use');
}

// --- SUBMIT_LESSON_TOOL shape: the parameters schema is the strict gate the migration's CHECK
//     mirrors — spot-check the forced tool's schema surface. ---
assert(SUBMIT_LESSON_TOOL.name === 'submit_lesson', 'reflection: the forced tool is submit_lesson');
assert(SUBMIT_LESSON_TOOL.parameters.required.includes('status'), 'reflection: submit_lesson requires status');
const props = SUBMIT_LESSON_TOOL.parameters.properties;
assert(props.status.enum.includes('conclusion') && props.status.enum.includes('insufficient_evidence'), 'reflection: status enum covers conclusion/insufficient_evidence');
assert(props.confidence.enum.join(',') === 'low,medium,high', 'reflection: confidence enum is low/medium/high');
assert(props.next_change.properties.layer && props.next_change.properties.instruction, 'reflection: next_change requires layer + instruction');