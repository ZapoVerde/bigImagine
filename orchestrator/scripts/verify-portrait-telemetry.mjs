// Proves docs/plans/portrait-studio-telemetry-plan.md §Testing and verification against fake
// Postgres + fake settings + fake LLM/image providers — no server, no network, no real provider
// (orchestrator/scripts/verify-location-presence-scraper.mjs's convention). The suite exercises:
//   - the pure aggregation module (portraits/portraitTelemetry.ts): phase/label derivation,
//     chronological merge across llm_calls + visual_round_image_calls, image rows with null token
//     fields, cache-hit accounting, partial provider usage on failure, failed calls in duration
//     totals, parallel image durations vs wall-clock, empty/all-failed rounds, exact error-message
//     preservation;
//   - a full generation round THROUGH the real gated LLM provider (so llm_calls rows are actually
//     written): the visual_rounds row is created before the first mutation call; the mutation call
//     carries the round's round_id labeled 'portrait:mutation'; a pull_wiki_entry round-trip is a
//     distinct 'portrait:wiki-pull' llm_calls row sharing the round_id; each render writes its own
//     visual_round_image_calls row with candidate_id backfilled; a provider failure persists its
//     exact message in llm_calls.reason and marks the round failed;
//   - feedback + reflection correlation: the reflection llm_calls row carries the episode's
//     round_id; a reflection retry appends a new llm_calls row under the same round_id preserving
//     the failed attempt and visual_episode_learning's attempt numbering; a historical episode
//     without round_id stays fully readable and makes an un-correlated call (never invents a round);
//   - the endpoint (server/portraitTelemetryRoutes.ts): ownership via the user-scoped visual_rounds
//     read (a foreign round is a 404 before anything else runs), the llm_calls query carried by
//     withSystemScope carries the explicit round_id AND user_id filter (llm_calls is RLS-exempt —
//     the plan's proof that round_id alone never scopes it), and calls return in chronological
//     order across both sources.

import { randomUUID } from 'node:crypto';

const { DEFAULT_LAYER_MANIFEST } = await import('../dist/portraits/layerStack.js');
const { buildRoundTelemetry, computeRoundTotals, mergeRoundCalls } = await import('../dist/portraits/portraitTelemetry.js');
const { createGatedLlmProvider } = await import('../dist/io/llm/llmGate.js');
const { createPostgresClient } = await import('../dist/io/postgres.js');
const { runPortraitGenerationRound, retryPortraitCandidateRender, renderPortraitPreview } = await import('../dist/orchestrator/portraitGeneration.js');
const { submitPortraitFeedback } = await import('../dist/orchestrator/portraitFeedback.js');
const { handlePortraitRoundTelemetry } = await import('../dist/server/portraitTelemetryRoutes.js');

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
// Pure aggregation (portraits/portraitTelemetry.ts)
// ============================================================================

function llmRow(overrides = {}) {
  return {
    call_id: randomUUID(),
    user_id: USER,
    outcome: 'ok',
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    cache_read_tokens: null,
    duration_ms: 4800,
    reason: null,
    created_at: '2026-08-19T10:00:01.000Z',
    provider_kind: 'openai-compatible',
    model: 'fake-model',
    call_label: 'portrait:mutation',
    ...overrides,
  };
}

function imageRow(overrides = {}) {
  return {
    call_id: randomUUID(),
    round_id: 'round-1',
    candidate_id: null,
    status: 'succeeded',
    provider_kind: 'pollinations',
    model: 'flux',
    duration_ms: 9200,
    error_code: null,
    error_message: null,
    started_at: '2026-08-19T10:00:02.000Z',
    ...overrides,
  };
}

const roundRow = {
  round_id: 'round-1',
  goal: 'A calmer evening variant of Rin.',
  started_at: '2026-08-19T10:00:00.000Z',
  completed_at: '2026-08-19T10:00:20.000Z',
  status: 'succeeded',
};

// --- Phase/label derivation + merging into one chronological list across both sources. ---
{
  const merged = mergeRoundCalls(
    [
      llmRow({ created_at: '2026-08-19T10:00:01.000Z' }),
      llmRow({ call_label: 'portrait:wiki-pull', created_at: '2026-08-19T10:00:03.000Z' }),
      llmRow({ call_label: 'portrait:reflection', created_at: '2026-08-19T10:00:04.000Z' }),
    ],
    [imageRow({ started_at: '2026-08-19T10:00:02.000Z' })],
  );
  assert(
    merged.map((c) => c.phase).join(',') === 'mutation,image_render,wiki_pull,reflection',
    'merge: llm_calls rows (by created_at) and image rows (by started_at) merge into one chronological list',
  );
  assert(
    merged.map((c) => c.label).join(',') === 'portrait:mutation,image_render,portrait:wiki-pull,portrait:reflection',
    'merge: every row carries its label — LLM rows their call_label, image rows image_render',
  );
}

// --- An unrecognized call_label is skipped (no 5th phase to represent); unknown statuses become
// failed on image rows; token fields are omitted, never zeroed. ---
{
  const merged = mergeRoundCalls(
    [llmRow({ call_label: 'chat:main' }), llmRow({ call_label: 'portrait:mutation', prompt_tokens: null, completion_tokens: null, total_tokens: null })],
    [imageRow({ status: 'failed', error_code: 'E123', error_message: 'boom' })],
  );
  assert(merged.length === 2, 'merge: a row with a non-portrait label is skipped entirely');
  const llm = merged.find((c) => c.phase === 'mutation');
  assert(llm && llm.promptTokens === undefined && llm.completionTokens === undefined && llm.totalTokens === undefined, 'merge: an LLM row with null token fields omits them (never zero)');
  const img = merged.find((c) => c.phase === 'image_render');
  assert(
    img && img.status === 'failed' && img.errorCode === 'E123' && img.errorMessage === 'boom' && img.durationMs === 9200,
    'merge: an image row carries its exact provider error + duration and no token fields',
  );
  assert(!('candidateId' in (merged.find((c) => c.phase === 'mutation') ?? {})), 'merge: an LLM row never carries a candidateId');
}

// --- Cache-hit accounting: cacheReadTokens appears only when a call reported cache; totals sum
// non-null only, failed calls included in durations; wall-clock is completed_at - started_at. ---
{
  const totals = computeRoundTotals(
    [
      llmRow({ prompt_tokens: 900, completion_tokens: 400, total_tokens: 1300, cache_read_tokens: 800, duration_ms: 4800 }),
      llmRow({ outcome: 'error', prompt_tokens: null, completion_tokens: null, total_tokens: null, cache_read_tokens: null, duration_ms: 1200, reason: 'upstream exploded' }),
    ],
    [imageRow({ duration_ms: 9200 }), imageRow({ duration_ms: 4100, status: 'failed' })],
    roundRow,
  );
  assert(totals.promptTokens === 900 && totals.completionTokens === 400 && totals.totalTokens === 1300, 'totals: token sums count only non-null values');
  assert(totals.cacheReadTokens === 800, 'totals: cacheReadTokens sums the cache-hit count when any call reported it');
  assert(totals.llmDurationMs === 6000, 'totals: LLM duration includes the failed call');
  assert(totals.imageDurationMs === 13300, 'totals: image duration SUMS the parallel calls (9200 + 4100)');
  assert(totals.wallClockDurationMs === 20000, 'totals: wall-clock = completed_at − started_at (never the sum of parallel image work)');
  assert(
    computeRoundTotals([llmRow({ cache_read_tokens: null })], [], roundRow).cacheReadTokens === undefined,
    'totals: cacheReadTokens is omitted when no call reported cache accounting',
  );
}

// --- Empty and all-failed rounds; exact error text preserved (markup stays text, never HTML). ---
{
  const empty = buildRoundTelemetry({ ...roundRow, status: 'failed' }, [], []);
  assert(empty.calls.length === 0 && empty.totals.totalTokens === 0 && empty.status === 'failed', 'buildRoundTelemetry: an empty round yields zero calls, honest failed status, zero totals');

  const markdown = '<script>alert(1)</script> provider said 429';
  const all = buildRoundTelemetry(
    roundRow,
    [llmRow({ outcome: 'error', call_label: 'portrait:mutation', prompt_tokens: null, completion_tokens: null, total_tokens: null, reason: markdown })],
    [imageRow({ status: 'failed', error_message: 'image provider: <b>overloaded</b>' })],
  );
  assert(all.calls.every((c) => c.status === 'failed'), 'buildRoundTelemetry: an all-failed round reports every call failed');
  const llm = all.calls.find((c) => c.phase === 'mutation');
  assert(llm && llm.errorMessage === markdown, 'buildRoundTelemetry: the exact llm_calls.reason text is preserved byte-for-byte');
  const img = all.calls.find((c) => c.phase === 'image_render');
  assert(img && img.errorMessage === 'image provider: <b>overloaded</b>', 'buildRoundTelemetry: the exact image error_message is preserved byte-for-byte');
}

// ============================================================================
// Integration fakes
// ============================================================================

function makeSettings(overrides = {}) {
  const map = new Map([
    ['visual_layer_stack', JSON.stringify(DEFAULT_LAYER_MANIFEST)],
    ['visual_mutation_candidate_count', '2'],
    ['visual_reflection_system_prompt_override', ''],
    ['visual_wiki_context_budget', '2400'],
    ['visual_portraits_enabled', 'true'],
    // Deterministic single-attempt gate behavior for every test below.
    ['llm_gate_max_retries', '0'],
    ...Object.entries(overrides),
  ]);
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value);
    },
  };
}

function makeFakeProfile() {
  return {
    kind: 'pollinations',
    model: 'flux',
    apiKey: 'fake-key',
    baseUrl: null,
    masterNegativePrompt: null,
    width: 832,
    height: 1216,
    samplingSteps: 1,
    cfgScale: 1,
    samplerName: null,
    workflowParameters: null,
    seed: null, // migration 0123 default — random; overridden per-test below where relevant
    priceInputPerMillion: 1,
    priceOutputPerMillion: 2,
    priceCacheHitPerMillion: 0.5,
    pricePeakInputPerMillion: 1,
    pricePeakOutputPerMillion: 2,
    pricePeakCacheHitPerMillion: 0.5,
  };
}

const PROFILE = makeFakeProfile();
const imageConnections = { resolveActive: async (purpose) => (purpose === 'portrait' ? PROFILE : null) };

/** One fake pool serving both the orchestrators (via createPostgresClient) and the real gated
 *  LLM provider — so a full generation/feedback round writes REAL llm_calls rows with the round's
 *  round_id/label, exactly as production does. writeLog records every round- vs llm-meter write
 *  order for the "round created before the first mutation call" assertion. */
function makeFakePool() {
  const state = {
    entities: [],
    candidates: [],
    episodes: [],
    wikiEntries: [],
    wikiRevisions: [],
    revisions: [],
    learning: [],
    lessons: [],
    events: [],
    rounds: [],
    imageCalls: [],
    llmCalls: [],
    writeLog: [],
    counters: { entity: 0, candidate: 0, episode: 0, learning: 0, lesson: 0, round: 0, imageCall: 0, wiki: 0, revision: 0 },
  };
  // One subscribed entry (outfit layer — full-body Path-1 context) and one unsubscribed entry
  // (lands in the pull tool's tag index — drives the wiki-pull round-trip test).
  state.wikiEntries.push(
    { entry_id: 'w1', title: 'Keep coats short', body: 'Coats read bulky below the knee.', tags: ['outfit'], subscriptions: [{ layerType: 'outfit', layerEntityId: null }] },
    { entry_id: 'w2', title: 'Amber eyes carry', body: 'Amber reads warmest under teahouse light.', tags: ['style'], subscriptions: [] },
  );
  state.revisions.push({ entry_id: 'w1', revision_id: 'rev-w1' }, { entry_id: 'w2', revision_id: 'rev-w2' });

  async function query(sql, params = []) {
    const s = sql;
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
    if (s.startsWith("select set_config('app.current_user_id'")) return { rows: [] };

    // The gated provider's meter (docs/llm-gate-plan.md): round_id is the 18th parameter.
    if (s.includes('insert into llm_calls')) {
      const [
        userId, kind, taskId, jobId, outcome, promptTokens, completionTokens, totalTokens, durationMs, reason, requestId, attempt,
        providerKind, model, cacheReadTokens, costUsd, callLabel, roundId,
      ] = params;
      state.llmCalls.push({
        userId, kind, taskId, jobId, outcome, promptTokens, completionTokens, totalTokens, durationMs, reason, requestId, attempt,
        providerKind, model, cacheReadTokens, costUsd, callLabel, roundId,
      });
      state.writeLog.push('llm_calls');
      return { rows: [] };
    }

    // ---- Generation queries ----
    if (s.includes('from visual_entities where entity_id = $1')) {
      return { rows: state.entities.filter((e) => e.entity_id === params[0] && e.user_id === params[1]) };
    }
    if (s.includes('from visual_entities where user_id = $1 and layer_id = $2')) {
      const rows = state.entities.filter((e) => e.user_id === params[0] && e.layer_id === params[1]).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, 1);
      return { rows };
    }
    // The retry path's batched current-details read (retryPortraitCandidateRender) — ALL of a
    // candidate's entity_ids in one query, not just the style layer's template.
    if (s.includes('select layer_id, details from visual_entities where entity_id = any')) {
      const ids = params[0];
      return { rows: state.entities.filter((e) => ids.includes(e.entity_id) && e.user_id === params[1]) };
    }
    if (s.startsWith('select name from visual_entities')) {
      const row = state.entities.find((e) => e.entity_id === params[0] && e.user_id === params[1]);
      return { rows: row ? [{ name: row.name }] : [] };
    }
    if (s.startsWith('insert into visual_entities')) {
      state.counters.entity += 1;
      const row = { entity_id: `ent-${state.counters.entity}`, user_id: params[0], layer_id: params[1], name: params[2], slots: {}, template: null, details: '', updated_at: 0 };
      state.entities.push(row);
      return { rows: [row] };
    }
    // insertLesson's supersedes_lesson_id target lookup/write and buildReflectionSnapshot's
    // existing-lessons index (docs/plans/portrait-studio-lesson-amend-plan.md) — checked BEFORE
    // the generic visual_lessons/visual_wiki_entries/visual_wiki_revisions reads below, since
    // several of these SQL strings are substrings of the generic ones.
    if (s.startsWith('select lesson_id from visual_lessons where lesson_id = $1') && s.includes('state in')) {
      return { rows: state.lessons.filter((l) => l.lesson_id === params[0] && l.user_id === params[1] && (l.state === 'provisional' || l.state === 'supported')) };
    }
    if (s.startsWith("update visual_lessons set state = 'superseded'")) {
      const row = state.lessons.find((l) => l.lesson_id === params[0] && l.user_id === params[1]);
      if (row) row.state = 'superseded';
      return { rows: [] };
    }
    if (s.startsWith('select l.lesson_id, l.statement')) {
      const rows = state.wikiEntries
        .filter((w) => w.lesson_id && w.user_id === params[0])
        .map((w) => {
          const lesson = state.lessons.find((l) => l.lesson_id === w.lesson_id);
          return lesson && (lesson.state === 'provisional' || lesson.state === 'supported')
            ? { lesson_id: lesson.lesson_id, statement: lesson.statement, layer: lesson.next_change?.layer, state: lesson.state, subscriptions: w.subscriptions }
            : null;
        })
        .filter(Boolean);
      return { rows };
    }
    if (s.startsWith('select entry_id from visual_wiki_entries where lesson_id = $1')) {
      const row = state.wikiEntries.find((w) => w.lesson_id === params[0] && w.user_id === params[1]);
      return { rows: row ? [{ entry_id: row.entry_id }] : [] };
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
      return { rows: [] };
    }
    if (s.startsWith('select coalesce(max(revision_number), 0) + 1 as n from visual_wiki_revisions')) {
      const nums = state.wikiRevisions.filter((r) => r.entry_id === params[0] && r.user_id === params[1]).map((r) => r.revision_number);
      return { rows: [{ n: (nums.length ? Math.max(...nums) : 0) + 1 }] };
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
      return { rows: [] };
    }
    if (s.includes('from visual_lessons where lesson_id = $1')) {
      return { rows: state.lessons.filter((l) => l.lesson_id === params[0] && l.user_id === params[1]) };
    }
    if (s.includes('from visual_wiki_entries')) {
      return { rows: state.wikiEntries };
    }
    if (s.includes('from visual_wiki_revisions')) {
      return { rows: state.revisions };
    }
    if (s.includes('coalesce(max(generation), 0) + 1')) {
      const subject = params[1];
      const gens = state.candidates.filter((c) => c.entity_ids?.subject === subject).map((c) => c.generation);
      return { rows: [{ attempt: String((gens.length ? Math.max(...gens) : 0) + 1) }] };
    }
    if (s.includes('from visual_episode_learning')) {
      return { rows: [{ n: String(state.learning.length) }] };
    }
    if (s.startsWith('insert into visual_rounds')) {
      state.counters.round += 1;
      const roundId = `round-${state.counters.round}`;
      state.rounds.push({ round_id: roundId, user_id: params[0], goal: params[1], status: 'running', started_at: 0 });
      state.writeLog.push('round');
      return { rows: [{ round_id: roundId }] };
    }
    if (s.startsWith('update visual_rounds set status')) {
      const row = state.rounds.find((r) => r.round_id === params[0]);
      if (row) {
        row.status = params[1];
        row.completed_at = 0;
      }
      return { rows: [] };
    }
    if (s.startsWith('insert into visual_round_image_calls')) {
      state.counters.imageCall += 1;
      const callId = `img-${state.counters.imageCall}`;
      state.imageCalls.push({ call_id: callId, user_id: params[0], round_id: params[1], status: 'running', provider_kind: params[2], model: params[3], candidate_id: null });
      return { rows: [{ call_id: callId }] };
    }
    if (s.includes('update visual_round_image_calls') && s.includes('set status')) {
      const row = state.imageCalls.find((c) => c.call_id === params[0]);
      if (row) {
        row.status = params[1];
        row.duration_ms = params[2];
        row.error_message = params[3];
      }
      return { rows: [] };
    }
    if (s.startsWith('update visual_round_image_calls set candidate_id')) {
      const row = state.imageCalls.find((c) => c.call_id === params[0]);
      if (row) row.candidate_id = params[1];
      return { rows: [] };
    }
    if (s.includes('from visual_round_image_calls where candidate_id = $1')) {
      const row = state.imageCalls.find((c) => c.candidate_id === params[0] && c.user_id === params[1]);
      return { rows: row ? [{ round_id: row.round_id }] : [] };
    }
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
        rating: null,
        note: null,
      });
      return { rows: [{ candidate_id: candidateId }] };
    }
    if (s.startsWith('insert into visual_lesson_uses')) {
      return { rows: [] };
    }

    // ---- Feedback queries ----
    if (s.startsWith('select episode_id, entity_ids, goal, rationale, selected_candidate_id')) {
      return { rows: state.episodes.filter((e) => e.episode_id === params[0] && e.user_id === params[1]) };
    }
    if (s.includes('from visual_candidates') && s.includes('candidate_id = any')) {
      const ids = params[1];
      return { rows: ids.map((id) => state.candidates.find((c) => c.candidate_id === id)).filter(Boolean) };
    }
    // The retry path's single-candidate read (candidate_id = $1, NOT `= any`) — the original
    // render's row, re-rendered in place.
    if (s.includes('from visual_candidates') && s.includes('candidate_id = $1')) {
      return { rows: state.candidates.filter((c) => c.candidate_id === params[0] && c.user_id === params[1]) };
    }
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
      return { rows: [{ episode_id: row.episode_id }] };
    }
    if (s.includes('update visual_candidates set rating')) {
      return { rows: [] };
    }
    if (s.includes('update visual_candidates set note')) {
      return { rows: [] };
    }
    if (s.startsWith('update visual_candidates set image_url')) {
      const row = state.candidates.find((c) => c.candidate_id === params[1] && c.user_id === params[2]);
      if (row) row.image_url = params[0];
      return { rows: [] };
    }
    if (s.startsWith('update visual_entities set last_image_url')) {
      return { rows: [] };
    }
    if (s.includes('update visual_episodes set rationale')) {
      return { rows: [] };
    }
    if (s.includes('update visual_episodes set selected_candidate_id')) {
      return { rows: [] };
    }
    if (s.startsWith('update visual_episodes set reflection_status')) {
      const row = state.episodes.find((e) => e.episode_id === params[0]);
      if (row) row.reflection_status = params[1];
      return { rows: [] };
    }
    if (s.startsWith('insert into visual_episode_events')) {
      const eventType = s.match(/'(winner_applied|reflection_started|reflection_failed|lesson_created|insufficient_evidence)'/)?.[1];
      state.events.push({ episodeId: params[1], eventType, payload: JSON.parse(params[2]) });
      return { rows: [] };
    }
    if (s.startsWith('insert into visual_episode_learning')) {
      state.counters.learning += 1;
      const row = { learning_id: `learn-${state.counters.learning}`, episode_id: params[1], attempt: params[2], status: params[3] };
      state.learning.push(row);
      return { rows: [{ learning_id: row.learning_id }] };
    }
    if (s.startsWith('insert into visual_lessons')) {
      state.counters.lesson += 1;
      const lessonId = `lesson-${state.counters.lesson}`;
      state.lessons.push({ lesson_id: lessonId, user_id: params[0], source_episode_id: params[1], statement: params[3], next_change: JSON.parse(params[5]), state: 'provisional' });
      return { rows: [{ lesson_id: lessonId }] };
    }
    if (s.startsWith('insert into visual_wiki_entries')) {
      state.counters.wiki += 1;
      const entryId = `wiki-${state.counters.wiki}`;
      state.wikiEntries.push({
        entry_id: entryId,
        user_id: params[0],
        title: params[1],
        body: params[2],
        tags: params[3],
        subscriptions: JSON.parse(params[4]),
        origin_episode_id: params[5],
        lesson_id: params[6],
      });
      return { rows: [{ entry_id: entryId }] };
    }

    throw new Error(`fake pool got an unexpected query: ${s.slice(0, 160)}`);
  }

  return {
    state,
    async connect() {
      return { query, release() {} };
    },
  };
}

function seedEntities(state) {
  state.entities.push(
    { entity_id: 'e-sub', user_id: USER, layer_id: 'subject', name: 'Rin', slots: { subject_identity: 'Rin V1' }, template: null, details: '', updated_at: 1 },
    { entity_id: 'e-out', user_id: USER, layer_id: 'outfit', name: 'Coat', slots: { outfit_style: 'long coat' }, template: null, details: '', updated_at: 2 },
    { entity_id: 'e-style', user_id: USER, layer_id: 'style', name: 'Style', slots: { style_style: 'VLZ hybrid' }, template: null, details: '', updated_at: 3 },
    { entity_id: 'e-expr', user_id: USER, layer_id: 'expression', name: 'Expr', slots: { expression_emotion: 'calm' }, template: null, details: '', updated_at: 4 },
  );
}

function seedCandidates(state, winnerId) {
  state.candidates.push(
    {
      candidate_id: 'c1',
      user_id: USER,
      entity_ids: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
      image_url: 'https://img/c1.png',
      chromosome: { slots: { subject: { subject_identity: 'Rin V1' }, outfit: { outfit_style: 'short coat' }, style: { style_style: 'VLZ hybrid' }, expression: { expression_emotion: 'calm' } } },
      parent_chromosome: { slots: { subject: { subject_identity: 'Rin V1' }, outfit: { outfit_style: 'long coat' }, style: { style_style: 'VLZ hybrid' }, expression: { expression_emotion: 'calm' } } },
      composed_prompt: 'PORTRAIT short coat / calm',
      render_metadata: { model: 'flux' },
      wiki_revision_ids: ['rev-w1'],
      lesson_id: null,
      rating: null,
      note: null,
    },
    {
      candidate_id: 'c2',
      user_id: USER,
      entity_ids: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
      image_url: 'https://img/c2.png',
      chromosome: { slots: { subject: { subject_identity: 'Rin V1' }, outfit: { outfit_style: 'long coat' }, style: { style_style: 'VLZ hybrid' }, expression: { expression_emotion: 'calm' } } },
      parent_chromosome: { slots: { subject: { subject_identity: 'Rin V1' }, outfit: { outfit_style: 'long coat' }, style: { style_style: 'VLZ hybrid' }, expression: { expression_emotion: 'calm' } } },
      composed_prompt: 'PORTRAIT long coat / calm',
      render_metadata: { model: 'flux' },
      wiki_revision_ids: ['rev-w1'],
      lesson_id: null,
      rating: null,
      note: null,
    },
  );
  return winnerId ?? 'c1';
}

function candidateMarkdownTurn() {
  return {
    message: {
      role: 'assistant',
      content: ['### Candidate 1', '[outfit]', 'outfit_style: short coat', '### Candidate 2', '[outfit]', 'outfit_style: long coat'].join('\n'),
    },
    toolCalls: [],
  };
}

function conclusionTurn() {
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
        },
      },
    ],
  };
}

// ============================================================================
// Generation round, end-to-end through the real gated provider (plan verify 1-4)
// ============================================================================

// --- Round created before the first mutation call; mutation call carries round_id labeled
// 'portrait:mutation'; a pull round-trip is a distinct 'portrait:wiki-pull' row sharing the
// round_id; image renders each get their own visual_round_image_calls row with candidate_id. ---
{
  const pool = makeFakePool();
  const db = createPostgresClient(pool);
  const settings = makeSettings();
  let call = 0;
  const base = {
    name: 'fake-base',
    supportsVision: false,
    async complete(messages, tools) {
      call += 1;
      if (call === 1) {
        assert(tools.length === 1 && tools[0].name === 'pull_wiki_entry', 'generation: the mutation call offers the pull tool (unsubscribed wiki entries exist)');
        return { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'pull-1', name: 'pull_wiki_entry', arguments: { id: 'w2' } }] };
      }
      if (call === 2) {
        return candidateMarkdownTurn();
      }
      throw new Error(`fake base called ${call} times`);
    },
  };
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);
  seedEntities(pool.state);

  const r = await runPortraitGenerationRound(
    { db, settings, imageConnections },
    gated,
    USER,
    { entityIds: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' }, goal: 'A calmer evening variant of Rin.' },
  );
  assert(r.ok === true && r.roundId === pool.state.rounds[0].round_id, 'generation: the round reports its round_id');

  const round = pool.state.rounds[0];
  assert(round && round.status === 'succeeded' && round.goal === 'A calmer evening variant of Rin.', 'generation: a visual_rounds row is created and reaches succeeded');

  const roundWrite = pool.state.writeLog.indexOf('round');
  const firstLlmWrite = pool.state.writeLog.indexOf('llm_calls');
  assert(roundWrite !== -1 && firstLlmWrite !== -1 && roundWrite < firstLlmWrite, 'generation: the visual_rounds row is created BEFORE the first mutation llm_calls write');

  assert(pool.state.llmCalls.length === 2, 'generation: exactly two llm_calls rows (mutation + wiki-pull)');
  assert(
    pool.state.llmCalls[0].callLabel === 'portrait:mutation' && pool.state.llmCalls[0].roundId === round.round_id,
    'generation: the mutation call is labeled portrait:mutation and carries the round_id',
  );
  assert(
    pool.state.llmCalls[1].callLabel === 'portrait:wiki-pull' && pool.state.llmCalls[1].roundId === round.round_id,
    'generation: the post-pull round-trip call is labeled portrait:wiki-pull (not portrait:mutation) and shares the round_id',
  );
  assert(pool.state.llmCalls.every((c) => c.kind === 'system'), 'generation: portrait calls meter as kind system (never refused by any agent_routine cap)');

  assert(pool.state.imageCalls.length === 2, 'generation: each candidate render writes its own visual_round_image_calls row');
  assert(
    pool.state.imageCalls.every((c) => c.round_id === round.round_id && c.candidate_id !== null && c.status === 'succeeded'),
    'generation: every image call carries the round_id and has its candidate_id backfilled after the candidate insert',
  );
  assert(new Set(pool.state.imageCalls.map((c) => c.candidate_id)).size === 2, 'generation: the two image calls link to two distinct candidates');
}

// --- Parallel pull_wiki_entry calls in ONE turn (some providers batch tool calls) each get their
// own tool response. Production regression: resolving only the first call and leaving a second
// tool_call_id dangling in the next request caused a real 400 ("No tool output found for function
// call <id>") from an OpenAI-compatible/Azure backend. ---
{
  const pool = makeFakePool();
  const db = createPostgresClient(pool);
  const settings = makeSettings();
  let call = 0;
  let secondCallMessages = null;
  const base = {
    name: 'fake-parallel-pull',
    supportsVision: false,
    async complete(messages) {
      call += 1;
      if (call === 1) {
        return {
          message: { role: 'assistant', content: '' },
          toolCalls: [
            { id: 'pull-a', name: 'pull_wiki_entry', arguments: { id: 'w2' } },
            { id: 'pull-b', name: 'pull_wiki_entry', arguments: { id: 'w2' } },
          ],
        };
      }
      if (call === 2) {
        secondCallMessages = messages;
        return candidateMarkdownTurn();
      }
      throw new Error(`fake base called ${call} times`);
    },
  };
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);
  seedEntities(pool.state);

  const r = await runPortraitGenerationRound(
    { db, settings, imageConnections },
    gated,
    USER,
    { entityIds: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' }, goal: 'A calmer evening variant of Rin.' },
  );
  assert(r.ok === true, 'parallel pulls: the round still succeeds when a turn returns two pull_wiki_entry calls at once');
  const toolResponses = secondCallMessages.filter((m) => m.role === 'tool');
  assert(toolResponses.length === 2, 'parallel pulls: every tool_call_id from the turn gets its own tool response before the next call');
  assert(
    new Set(toolResponses.map((m) => m.toolCallId)).size === 2 &&
      toolResponses.every((m) => m.toolCallId === 'pull-a' || m.toolCallId === 'pull-b'),
    'parallel pulls: the tool responses match the exact call ids the assistant turn declared, not just the first',
  );
}

// --- A provider failure on the mutation call persists its exact message in llm_calls.reason and
// marks the round failed (plan verify 5). ---
{
  const pool = makeFakePool();
  const db = createPostgresClient(pool);
  const settings = makeSettings();
  const base = {
    name: 'fake-boom',
    supportsVision: false,
    async complete() {
      throw new Error('upstream API exploded: 429 too many requests');
    },
  };
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);
  seedEntities(pool.state);

  const r = await runPortraitGenerationRound(
    { db, settings, imageConnections },
    gated,
    USER,
    { entityIds: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' }, goal: 'x' },
  );
  assert(r.ok === false && r.error.startsWith('mutation_failed:'), 'generation: a mutation provider failure aborts the round with mutation_failed');
  assert(pool.state.rounds[0]?.status === 'failed', 'generation: the round is honestly marked failed');
  assert(pool.state.llmCalls.length === 1 && pool.state.llmCalls[0].outcome === 'error', 'generation: the failed mutation call is still metered');
  assert(
    pool.state.llmCalls[0].reason === 'upstream API exploded: 429 too many requests',
    'generation: llm_calls.reason persists the exact provider message',
  );
}

// ============================================================================
// The round's composed prompts carry each layer's authored details prose (migration
// 0122, portrait-studio-layer-details-plan.md §7) + the retry path's current-state re-read
// ============================================================================

// --- End-to-end details round: one entity per layer with a DISTINCT details value, composed
// through a manifest whose template carries _details tokens (seeded via the fake settings, so the
// assertion never depends on any deployment's stored template). The candidate's composedPrompt
// proves buildParentDetails + the threaded compileTemplate call work together, not just
// compileTemplate in isolation. ---
{
  const pool = makeFakePool();
  const db = createPostgresClient(pool);
  const settings = makeSettings({
    visual_layer_stack: JSON.stringify({
      ...DEFAULT_LAYER_MANIFEST,
      template:
        'Subject: {{subject_details}} | {{subject_overflow}}. ' +
        'Outfit: {{outfit_details}} | {{outfit_overflow}}. ' +
        'Style: {{style_details}} | {{style_overflow}}. ' +
        'Expression: {{expression_details}} | {{expression_overflow}}.',
    }),
  });
  const base = {
    name: 'fake-details-base',
    supportsVision: false,
    async complete() {
      // One mutation call, no wiki pull — the candidates map slots over the parent.
      return candidateMarkdownTurn();
    },
  };
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);
  seedEntities(pool.state);
  pool.state.entities.find((e) => e.entity_id === 'e-sub').details = 'an Italian woman in her 30s';
  pool.state.entities.find((e) => e.entity_id === 'e-out').details = 'a red knee-length coat';
  pool.state.entities.find((e) => e.entity_id === 'e-style').details = 'moody rim light';
  pool.state.entities.find((e) => e.entity_id === 'e-expr').details = 'quiet resolve';

  const r = await runPortraitGenerationRound(
    { db, settings, imageConnections },
    gated,
    USER,
    { entityIds: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' }, goal: 'A calmer evening variant of Rin.' },
  );
  assert(r.ok === true, 'details round: a round over entities with authored details succeeds');
  assert(r.candidates.length === 2, 'details round: two candidates as configured');
  for (const c of r.candidates) {
    assert(c.composedPrompt.includes('Subject: an Italian woman in her 30s'), 'details round: the subject\'s details land in the composed prompt');
    assert(c.composedPrompt.includes('Outfit: a red knee-length coat'), 'details round: the outfit\'s details land in the composed prompt');
    assert(c.composedPrompt.includes('Style: moody rim light'), 'details round: the style\'s details land in the composed prompt');
    assert(c.composedPrompt.includes('Expression: quiet resolve'), 'details round: the expression\'s details land in the composed prompt');
    assert(!c.imageUrl?.includes('seed='), 'details round: PROFILE.seed null (the default) puts no seed param on the URL — provider stays random');
  }
}

// --- retryPortraitCandidateRender (plan §7 — previously zero coverage): recompiles against
// CURRENT state — the batched details re-read spans ALL of a candidate's entity_ids (not just
// the style layer's template), so a details edit made after the original render is reflected in
// the retried candidate's composedPrompt, and the image_url updates in place. The pollinations
// provider here is URL-only (no network), so the re-render is safe in the fake. ---
{
  const pool = makeFakePool();
  const db = createPostgresClient(pool);
  const settings = makeSettings();
  seedEntities(pool.state);
  pool.state.candidates.push({
    candidate_id: 'c-retry',
    user_id: USER,
    entity_ids: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
    image_url: 'https://img/c-retry-old.png',
    chromosome: {
      slots: {
        subject: { subject_identity: 'Rin V1' },
        outfit: { outfit_style: 'long coat' },
        style: { style_style: 'VLZ hybrid' },
        expression: { expression_emotion: 'calm' },
      },
    },
    parent_chromosome: {},
    composed_prompt: 'PORTRAIT long coat / calm',
    render_metadata: {},
    wiki_revision_ids: [],
    lesson_id: null,
    rating: null,
    note: null,
  });
  // Details edited AFTER the original render — the retry must re-read them.
  pool.state.entities.find((e) => e.entity_id === 'e-sub').details = 'edited: a Venetian glassblower';
  pool.state.entities.find((e) => e.entity_id === 'e-out').details = 'edited: a teal velvet coat';

  const retry = await retryPortraitCandidateRender({ db, settings, imageConnections }, USER, 'c-retry');
  assert(retry.ok === true && retry.imageUrl && retry.composedPrompt, 'retry: a candidate with current authored details re-renders ok');
  assert(
    retry.composedPrompt.includes('edited: a Venetian glassblower'),
    'retry: the SUBJECT details edited after the original render are re-read and composed',
  );
  assert(
    retry.composedPrompt.includes('edited: a teal velvet coat'),
    'retry: the OUTFIT details edited after the original render are re-read and composed — the batched read spans all entity_ids, not just style',
  );
  assert(pool.state.candidates[0].image_url === retry.imageUrl, 'retry: the candidate row\'s image_url is updated in place');
}

// --- Connection-level seed (migration 0123, db/migrations/0123_image_connections_seed.sql):
// PROFILE.seed defaults to null (random) above — every prior assertion in this file already
// covers that default implicitly. This block proves the opt-in: a connection with a non-null
// seed puts it on every candidate's pollinations URL (no network — the URL IS the request), and
// a retry re-reads the same connection-level seed rather than inventing its own. ---
{
  const pool = makeFakePool();
  const db = createPostgresClient(pool);
  const settings = makeSettings();
  const seededProfile = { ...PROFILE, seed: 20260819 };
  const imageConnectionsSeeded = { resolveActive: async (purpose) => (purpose === 'portrait' ? seededProfile : null) };
  const base = {
    name: 'fake-seed-base',
    supportsVision: false,
    async complete() {
      return candidateMarkdownTurn();
    },
  };
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);
  seedEntities(pool.state);

  const r = await runPortraitGenerationRound(
    { db, settings, imageConnections: imageConnectionsSeeded },
    gated,
    USER,
    { entityIds: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' }, goal: 'A seeded round.' },
  );
  assert(r.ok === true, 'seeded round: succeeds with a connection-level seed set');
  for (const c of r.candidates) {
    assert(c.imageUrl?.includes('seed=20260819'), `seeded round: the connection's seed lands on the pollinations URL -> "${c.imageUrl}"`);
  }

  pool.state.candidates.push({
    candidate_id: 'c-retry-seed',
    user_id: USER,
    entity_ids: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
    image_url: 'https://img/c-retry-seed-old.png',
    chromosome: { slots: { subject: { subject_identity: 'Rin V1' }, outfit: {}, style: {}, expression: {} } },
    parent_chromosome: {},
    composed_prompt: 'PORTRAIT seeded retry',
    render_metadata: {},
    wiki_revision_ids: [],
    lesson_id: null,
    rating: null,
    note: null,
  });
  const retrySeeded = await retryPortraitCandidateRender({ db, settings, imageConnections: imageConnectionsSeeded }, USER, 'c-retry-seed');
  assert(retrySeeded.ok === true, 'seeded retry: succeeds with a connection-level seed set');
  assert(retrySeeded.imageUrl?.includes('seed=20260819'), `seeded retry: the retry re-reads the connection's seed too -> "${retrySeeded.imageUrl}"`);
}

// ============================================================================
// renderPortraitPreview — the Studio's mutation-free single render (no goal, no candidate row,
// no round/telemetry ledger; "as they are in the wrapper" is exactly the parent chromosome the
// round loop's own reconciliation baseline already is — buildParentChromosome/buildParentDetails
// reused verbatim, just never handed to the mutation call).
// ============================================================================

// --- Composes straight from the named entities' persisted slots/details, renders once, and
// writes NOTHING durable — no visual_candidates row, no llm_calls row, no visual_rounds row. ---
{
  const pool = makeFakePool();
  const db = createPostgresClient(pool);
  const settings = makeSettings();
  seedEntities(pool.state);
  pool.state.entities.push({ entity_id: 'e-fmt', user_id: USER, layer_id: 'format', name: 'Format', slots: { format_shot: 'bust' }, template: null, details: '', updated_at: 5 });
  pool.state.entities.find((e) => e.entity_id === 'e-sub').details = 'an Italian woman in her 30s';

  const preview = await renderPortraitPreview(
    { db, settings, imageConnections },
    USER,
    { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr', format: 'e-fmt' },
  );
  assert(preview.ok === true && !!preview.imageUrl, 'preview: renders successfully from the named entities\' current state');
  assert(preview.composedPrompt.includes('an Italian woman in her 30s'), 'preview: the composed prompt carries the entity\'s authored details, unmutated');
  assert(preview.composedPrompt.includes('outfit_style: long coat'), 'preview: the composed prompt carries the entity\'s own slots, unmutated');
  assert(pool.state.candidates.length === 0, 'preview: writes no visual_candidates row — a preview is disposable, not a training record');
  assert(pool.state.llmCalls.length === 0, 'preview: makes no LLM call — no mutation step at all');
  assert(pool.state.rounds.length === 0, 'preview: creates no visual_rounds row — no telemetry ledger entry');
}

// --- A named-but-missing entity is a caller bug, not a fallback case — the preview fails with a
// structured error instead of silently substituting a placeholder or most-recently-used entity. ---
{
  const pool = makeFakePool();
  const db = createPostgresClient(pool);
  const settings = makeSettings();
  seedEntities(pool.state);

  const preview = await renderPortraitPreview(
    { db, settings, imageConnections },
    USER,
    { subject: 'does-not-exist', outfit: 'e-out', style: 'e-style', expression: 'e-expr', format: 'e-fmt' },
  );
  assert(preview.ok === false && preview.error === 'entity_not_found', 'preview: a named-but-missing entity fails with a structured error, never a silent substitution');
  assert(pool.state.candidates.length === 0 && pool.state.llmCalls.length === 0, 'preview: a failed entity resolution writes nothing');
}

// --- No active portrait connection aborts before any render is attempted. ---
{
  const pool = makeFakePool();
  const db = createPostgresClient(pool);
  const settings = makeSettings();
  seedEntities(pool.state);
  pool.state.entities.push({ entity_id: 'e-fmt', user_id: USER, layer_id: 'format', name: 'Format', slots: {}, template: null, details: '', updated_at: 5 });
  const noConnection = { resolveActive: async () => null };

  const preview = await renderPortraitPreview(
    { db, settings, imageConnections: noConnection },
    USER,
    { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr', format: 'e-fmt' },
  );
  assert(preview.ok === false && preview.error === 'no_active_connection', 'preview: no active portrait connection aborts with no_active_connection');
}

// --- A provider failure is still a 200-shaped result (ok: true, imageUrl null, failed set) —
// same fail-open contract as the round loop and retry: the render was attempted, only the
// provider call itself failed. Pollinations throws synchronously when the connection has no
// apiKey (its own documented failure mode) — no network needed to exercise this path. ---
{
  const pool = makeFakePool();
  const db = createPostgresClient(pool);
  const settings = makeSettings();
  seedEntities(pool.state);
  pool.state.entities.push({ entity_id: 'e-fmt', user_id: USER, layer_id: 'format', name: 'Format', slots: {}, template: null, details: '', updated_at: 5 });
  const keylessProfile = { ...PROFILE, apiKey: null };
  const keylessConnections = { resolveActive: async (purpose) => (purpose === 'portrait' ? keylessProfile : null) };

  const preview = await renderPortraitPreview(
    { db, settings, imageConnections: keylessConnections },
    USER,
    { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr', format: 'e-fmt' },
  );
  assert(preview.ok === true && preview.imageUrl === null && !!preview.failed, 'preview: a provider failure stays fail-open — ok true, imageUrl null, failed set');
  assert(pool.state.candidates.length === 0, 'preview: a failed render still writes nothing durable');
}

// ============================================================================
// Feedback + reflection correlation (plan verify 6-7, 11)
// ============================================================================

const feedbackInput = (roundId) => ({
  entityIds: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
  goal: 'A calmer evening variant of Rin.',
  candidateIds: ['c1', 'c2'],
  winnerId: 'c1',
  rationale: 'The quiet pose wins; coats still too long.',
  roundId,
});

// --- Reflection's llm_calls row carries the episode's round_id, labeled portrait:reflection. ---
{
  const pool = makeFakePool();
  const db = createPostgresClient(pool);
  const settings = makeSettings();
  const base = { name: 'fake-reflect', supportsVision: false, async complete() { return conclusionTurn(); } };
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);
  seedEntities(pool.state);
  seedCandidates(pool.state);

  const r = await submitPortraitFeedback({ db, settings }, gated, USER, feedbackInput('round-fb'));
  assert(r.ok === true && r.roundId === 'round-fb' && r.reflection?.action === 'concluded', 'feedback: a fresh round echoes its round_id and concludes');
  assert(pool.state.episodes[0].round_id === 'round-fb', 'feedback: the episode row persists the round_id');
  assert(pool.state.llmCalls.length === 1, 'feedback: exactly one reflection llm_calls row');
  assert(
    pool.state.llmCalls[0].callLabel === 'portrait:reflection' && pool.state.llmCalls[0].roundId === 'round-fb',
    'feedback: the reflection call is labeled portrait:reflection and carries the round_id',
  );
  assert(pool.state.learning.length === 1 && pool.state.learning[0].status === 'concluded', 'feedback: the attempt is persisted');
}

// --- A reflection retry appends a NEW llm_calls row under the same round_id, preserving the
// failed attempt and visual_episode_learning's attempt numbering (plan verify 7). ---
{
  const pool = makeFakePool();
  const db = createPostgresClient(pool);
  const settings = makeSettings();
  let reflectCalls = 0;
  const failingBase = {
    name: 'fake-fail-once',
    supportsVision: false,
    async complete() {
      reflectCalls += 1;
      throw new Error('reflection timeout: upstream stalled');
    },
  };
  const gated = createGatedLlmProvider(failingBase, db, settings, PROFILE);
  seedEntities(pool.state);
  seedCandidates(pool.state);

  const first = await submitPortraitFeedback({ db, settings }, gated, USER, feedbackInput('round-r'));
  assert(first.ok === true && first.reflection?.action === 'failed' && first.reflection.reason === 'reflection timeout: upstream stalled', 'retry: the first reflection attempt fails truthfully');
  assert(pool.state.episodes[0].round_id === 'round-r' && pool.state.episodes[0].reflection_status === 'failed', 'retry: the episode keeps its round_id and is marked failed');
  assert(pool.state.llmCalls.length === 1 && pool.state.llmCalls[0].roundId === 'round-r' && pool.state.llmCalls[0].outcome === 'error', 'retry: the failed attempt is metered under the round_id');
  assert(pool.state.learning.length === 1 && pool.state.learning[0].attempt === 1, 'retry: attempt 1 is persisted');

  const goodBase = { name: 'fake-good', supportsVision: false, async complete() { return conclusionTurn(); } };
  const goodGate = createGatedLlmProvider(goodBase, db, settings, PROFILE);
  const second = await submitPortraitFeedback({ db, settings }, goodGate, USER, { episodeId: 'ep-1' });
  assert(second.ok === true && second.roundId === 'round-r' && second.reflection?.action === 'concluded', 'retry: the retry re-runs reflection under the same round_id');
  assert(pool.state.llmCalls.length === 2 && pool.state.llmCalls[1].roundId === 'round-r' && pool.state.llmCalls[1].outcome === 'ok', 'retry: a NEW llm_calls row joins the same round_id, preserving the failed one');
  assert(pool.state.learning.length === 2 && pool.state.learning.map((l) => l.attempt).sort().join(',') === '1,2', 'retry: each attempt is its own immutable row — attempt numbering untouched by telemetry');
}

// --- A historical episode without round_id remains fully readable and makes an un-correlated
// call (plan verify 11: never invent telemetry). ---
{
  const pool = makeFakePool();
  const db = createPostgresClient(pool);
  const settings = makeSettings();
  const base = { name: 'fake-historical', supportsVision: false, async complete() { return conclusionTurn(); } };
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);
  seedEntities(pool.state);
  seedCandidates(pool.state);

  // A historical episode — created without a round (round_id null).
  pool.state.episodes.push({
    episode_id: 'ep-historical',
    user_id: USER,
    entity_ids: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
    goal: 'x',
    rationale: 'The quiet pose wins.',
    selected_candidate_id: 'c1',
    candidate_ids: ['c1', 'c2'],
    reflection_status: 'failed',
    round_id: null,
  });
  const r = await submitPortraitFeedback({ db, settings }, gated, USER, { episodeId: 'ep-historical' });
  assert(r.ok === true && r.roundId === undefined && r.reflection?.action === 'concluded', 'historical: a no-round episode retries fine, with no invented round id');
  assert(pool.state.llmCalls.length === 1 && pool.state.llmCalls[0].roundId === null, 'historical: the reflection call is metered with round_id null — un-correlated, never invented');
}

// ============================================================================
// The endpoint (plan verify 9-10)
// ============================================================================

// --- Fake ServerResponse for sendJson. ---
function fakeRes() {
  const res = {
    responses: [],
    writeHead(status) {
      this.statusCode = status;
    },
    end(payload) {
      this.responses.push({ status: this.statusCode, body: payload ? JSON.parse(payload) : undefined });
    },
  };
  return res;
}

// --- The route reads the visual_rounds row through the normal user-scoped path first (the
// ownership check); only then does it query llm_calls through withSystemScope — carrying the
// explicit round_id AND user_id filter, never round_id alone — then the image rows through
// withUserScope. A foreign round 404s before llm_calls is ever touched. ---
{
  const ownerRound = { round_id: 'round-owned', goal: 'g', started_at: '2026-08-19T10:00:00.000Z', completed_at: '2026-08-19T10:00:20.000Z', status: 'succeeded' };
  const llmRows = [
    { call_id: 'llm-a', user_id: USER, outcome: 'ok', prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cache_read_tokens: null, duration_ms: 4800, reason: null, created_at: '2026-08-19T10:00:01.000Z', provider_kind: 'openai-compatible', model: 'm', call_label: 'portrait:mutation' },
    { call_id: 'llm-c', user_id: USER, outcome: 'ok', prompt_tokens: 90, completion_tokens: 60, total_tokens: 150, cache_read_tokens: null, duration_ms: 1900, reason: null, created_at: '2026-08-19T10:00:03.000Z', provider_kind: 'openai-compatible', model: 'm', call_label: 'portrait:wiki-pull' },
  ];
  const imageRows = [
    { call_id: 'img-b', round_id: 'round-owned', candidate_id: 'c1', status: 'succeeded', provider_kind: 'pollinations', model: 'flux', duration_ms: 9200, error_code: null, error_message: null, started_at: '2026-08-19T10:00:02.000Z' },
  ];

  const systemScopeSqls = [];
  let lastScope = null;
  const routeDb = {
    async withUserScope(userId, fn) {
      lastScope = `user:${userId}`;
      return fn({
        async query(sql, params = []) {
          if (sql.includes('from visual_rounds')) {
            const [roundId, requestedUser] = params;
            if (requestedUser !== USER || roundId !== 'round-owned') return [];
            return [ownerRound];
          }
          if (sql.includes('from visual_round_image_calls')) {
            return imageRows;
          }
          throw new Error(`route fake: unexpected user-scoped query: ${sql.slice(0, 120)}`);
        },
      });
    },
    async withSystemScope(fn) {
      lastScope = 'system';
      return fn({
        async query(sql) {
          if (sql.includes('from llm_calls')) {
            systemScopeSqls.push(sql);
            return llmRows;
          }
          throw new Error(`route fake: unexpected system-scoped query: ${sql.slice(0, 120)}`);
        },
      });
    },
  };

  const res = fakeRes();
  await handlePortraitRoundTelemetry(
    { method: 'GET' },
    res,
    { db: routeDb, settings: makeSettings() },
    USER,
    new URL('http://x/v1/portraits/rounds/round-owned/telemetry'),
  );
  assert(res.responses[0].status === 200, 'route: an owned round → 200');
  assert(res.responses[0].body.roundId === 'round-owned', 'route: the response echoes the round id');
  assert(
    res.responses[0].body.calls.map((c) => c.phase).join(',') === 'mutation,image_render,wiki_pull',
    'route: calls return in chronological order across both sources (mutation → image_render → wiki_pull)',
  );
  assert(res.responses[0].body.totals.llmDurationMs === 6700 && res.responses[0].body.totals.imageDurationMs === 9200 && res.responses[0].body.totals.wallClockDurationMs === 20000, 'route: the totals split LLM from image from wall-clock');
  assert(
    systemScopeSqls.length === 1 && /round_id = \$1 and user_id = \$2/.test(systemScopeSqls[0]),
    'route: the llm_calls query runs under withSystemScope with the EXPLICIT round_id AND user_id filter — round_id alone never scopes the RLS-exempt table',
  );

  // A foreign round — the ownership read returns nothing, the endpoint 404s, and the
  // llm_calls/system query is never reached.
  const foreignDb = {
    async withUserScope(userId, fn) {
      return fn({
        async query(sql, params) {
          if (sql.includes('from visual_rounds')) return []; // not your round
          throw new Error('route fake: no query should run after an empty ownership read');
        },
      });
    },
    async withSystemScope() {
      throw new Error('route: withSystemScope must never run for a foreign round');
    },
  };
  const foreignRes = fakeRes();
  await handlePortraitRoundTelemetry(
    { method: 'GET' },
    foreignRes,
    { db: foreignDb, settings: makeSettings() },
    '99999999-9999-9999-9999-999999999999',
    new URL('http://x/v1/portraits/rounds/round-owned/telemetry'),
  );
  assert(foreignRes.responses[0].status === 404, 'route: a foreign roundId 404s the same not-found shape — never reveals the round exists');

  // A wrong-method request is a 404 before any DB read.
  const methodDb = {
    async withUserScope() {
      throw new Error('route: no DB read for a non-GET request');
    },
    async withSystemScope() {
      throw new Error('route: no DB read for a non-GET request');
    },
  };
  const methodRes = fakeRes();
  await handlePortraitRoundTelemetry(
    { method: 'POST' },
    methodRes,
    { db: methodDb, settings: makeSettings() },
    USER,
    new URL('http://x/v1/portraits/rounds/round-owned/telemetry'),
  );
  assert(methodRes.responses[0].status === 404, 'route: a non-GET request is a 404 with no DB touched');
}

if (process.exitCode) {
  console.error('\nportrait telemetry verification FAILED');
  process.exit(1);
}
console.log('\nportrait telemetry verification passed');
