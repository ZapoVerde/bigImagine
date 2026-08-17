// Proves portrait-studio-standalone-subjects-plan.md Parts B-D's route/service logic against a
// fake Postgres pool + fake settings + fake LLM gates — no server, no network, no real provider
// (orchestrator/scripts/verify-location-presence-scraper.mjs's convention). The suite exercises:
//   - create-entity describer (Part B): a subject created with no standingInstructions gets them
//     described from the optional seed (describeStudioSubject fires, its reply becomes
//     standing_instructions); a subject created WITH standingInstructions (seed present or not)
//     never invokes the describer and keeps exactly what was supplied (bi_principles.md §3 —
//     explicit outranks inferred); a describer LLM failure still creates the entity (201) with
//     blank instructions (fail-open, §11); a stray characterId in the body is accepted-and-ignored
//     (never written — entities are standalone); a stray seed on a non-subject layer is silently
//     unused;
//   - from-cast-character (Part C): ALWAYS inserts a brand-new, unlinked subject entity seeded
//     from the character's appearance (preferred over persona when present; blank appearance falls
//     back to the persona); unknown characterId → 404; both appearance and persona blank → 409
//     with nothing created; two consecutive calls with the same characterId produce two distinct
//     entity_ids, both character_id null; a legacy linked entity from the old bridge is never
//     touched or re-pointed (no refresh-in-place, no per-character dedup);
//   - set-as-avatar (Part C): the route is removed — the CRUD family 404s it instead of the old
//     always-overwrite promotion;
//   - submitPortraitFeedback (Part B/D): the winning chromosome's per-layer slots land on the
//     winning entities; an entity only a losing candidate referenced is left untouched; NO
//     characters row is ever touched — zero queries against the characters table, no avatar_path
//     write, no writeAvatar call (Part D, promotion retired);
//   - the kill switch (portrait-chain-hardening-plan.md): visual_portraits_enabled = 'false'
//     makes every gated handler 403 with the pinned error body before touching the DB or
//     issuing a fetch, while the layer-manifest pair stays reachable either way;
//   - the switch's own handlers: readPortraitsEnabled unset → true, handlePortraitsEnabledGet/
//     Set round-trip the boolean, and a missing/non-boolean body is a 400.

import { randomUUID } from 'node:crypto';

const { DEFAULT_LAYER_MANIFEST } = await import('../dist/portraits/layerStack.js');
const {
  handlePortraitEntities,
  handlePortraitEntityFromCastCharacter,
  handlePortraitFeedback,
  handlePortraitGenerate,
  handlePortraitLayersGet,
  handlePortraitsEnabledGet,
  handlePortraitsEnabledSet,
  handlePortraitWiki,
  readPortraitsEnabled,
} = await import('../dist/server/portraitRoutes.js');

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake ServerResponse: sendJson writes status + body; we capture the pair. ---------------
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

function jsonReq(body) {
  const payload = JSON.stringify(body);
  return {
    method: 'POST',
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(payload, 'utf8');
    },
  };
}

const USER = '11111111-1111-1111-1111-111111111111';
const SUBJECT_CHAR = '22222222-2222-2222-2222-222222222222';
const now = () => new Date().toISOString();

// --- Fake settings store: visual_layer_stack seeded, the kill switch on by default. ----------
function makeSettings(overrides = {}) {
  const map = new Map([
    ['visual_layer_stack', JSON.stringify(DEFAULT_LAYER_MANIFEST)],
    ['visual_wiki_investigation_max_turns', '6'],
    ['visual_reflection_system_prompt_override', ''],
    ['visual_portraits_enabled', 'true'],
    ...Object.entries(overrides),
  ]);
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value);
    },
  };
}

// --- Fake pool: in-memory characters / visual_entities / visual_candidates / visual_episodes /
// visual_wiki_entries, covering exactly the queries portraitRoutes.ts + portraitFeedback.ts
// issue for these surfaces. charQueries counts every query whose SQL mentions the characters
// table — the Part D "promotion is retired" assertion reads zero after a feedback round. ---
function makeDb() {
  const state = {
    entities: [],
    characters: [],
    candidates: [],
    wikiEntries: [],
    episodes: 0,
    episodeCounter: 0,
    wikiCounter: 0,
    charQueries: 0,
    promoted: [], // { entityId, imageUrl, candidateId, slotsJson? }
    ratingWrites: [],
    noteWrites: [],
  };
  const query = (sql, params = []) => {
    const s = sql;
    if (/characters/.test(s)) state.charQueries += 1;
    if (s.includes('from visual_candidates')) {
      const ids = params[1];
      return ids.map((id) => state.candidates.find((c) => c.candidate_id === id)).filter(Boolean);
    }
    if (s.startsWith('insert into visual_episodes')) {
      state.episodeCounter += 1;
      state.episodes = `ep-${state.episodeCounter}`;
      return [{ episode_id: state.episodes }];
    }
    if (s.startsWith('update visual_entities set last_image_url')) {
      // Winner promotion — two shapes: with slots (6 params) and without (5, a layer absent
      // from the winning chromosome leaves that entity's slots untouched).
      const withSlots = params.length === 6;
      const entityId = params[withSlots ? 5 : 4];
      state.promoted.push({
        entityId,
        imageUrl: params[1],
        candidateId: params[2],
        ...(withSlots ? { slotsJson: params[3] } : {}),
      });
      const row = state.entities.find((e) => e.entity_id === entityId && e.user_id === params[0]);
      if (row) {
        row.last_image_url = params[1];
        row.current_best_candidate_id = params[2];
        if (withSlots) row.slots = JSON.parse(params[3]);
      }
      return [];
    }
    if (s.includes('select template from visual_entities')) {
      const row = state.entities.find((e) => e.user_id === params[0] && e.entity_id === params[1]);
      return [{ template: row?.template ?? null }];
    }
    if (s.startsWith('select entity_id, layer_id, character_id, name, slots') && s.includes('from visual_entities where entity_id')) {
      const row = state.entities.find((e) => e.entity_id === params[0] && e.user_id === params[1]);
      return row ? [row] : [];
    }
    if (s.startsWith('select character_id, name, persona, appearance from characters')) {
      const row = state.characters.find((c) => c.character_id === params[0] && c.user_id === params[1]);
      return row ? [{ character_id: row.character_id, name: row.name, persona: row.persona, appearance: row.appearance }] : [];
    }
    if (s.startsWith('insert into visual_entities')) {
      if (params.length === 3) {
        // from-cast-character (Part C): [userId, name, seedText] — always unlinked.
        const [userId, name, seedText] = params;
        const row = {
          entity_id: randomUUID(),
          user_id: userId,
          layer_id: 'subject',
          character_id: null,
          name,
          slots: {},
          standing_instructions: seedText,
          template: null,
          last_image_url: null,
          current_best_candidate_id: null,
          created_at: now(),
          updated_at: now(),
        };
        state.entities.push(row);
        return [row];
      }
      // Create-entity: [userId, layerId, name, slotsJson, standingInstructions, template] —
      // character_id is hardcoded null server-side, never a param.
      const [userId, layerId, name, slotsJson, standingInstructions, template] = params;
      const row = {
        entity_id: randomUUID(),
        user_id: userId,
        layer_id: layerId,
        character_id: null,
        name,
        slots: JSON.parse(slotsJson),
        standing_instructions: standingInstructions,
        template,
        last_image_url: null,
        current_best_candidate_id: null,
        created_at: now(),
        updated_at: now(),
      };
      state.entities.push(row);
      return [row];
    }
    if (s.includes('update visual_candidates set rating')) {
      state.ratingWrites.push({ candidateId: params[0], rating: params[1] });
      return [];
    }
    if (s.includes('update visual_candidates set note')) {
      state.noteWrites.push({ candidateId: params[0], note: params[1] });
      return [];
    }
    if (s.includes('from visual_wiki_entries')) {
      return state.wikiEntries;
    }
    if (s.startsWith('insert into visual_wiki_entries')) {
      state.wikiCounter += 1;
      const entryId = `wiki-${state.wikiCounter}`;
      state.wikiEntries.push({
        entry_id: entryId,
        title: params[1],
        body: params[2],
        tags: params[3],
        subscriptions: JSON.parse(params[4]),
      });
      return [{ entry_id: entryId }];
    }
    throw new Error(`fake pool got an unexpected query: ${s.slice(0, 120)}`);
  };
  return {
    state,
    withUserScope: async (_userId, fn) => fn({ query }),
  };
}

function seedSubjectEntity(db, { entityId, characterId = SUBJECT_CHAR, lastImageUrl = null, slots = {}, instructions = '' }) {
  const row = {
    entity_id: entityId,
    user_id: USER,
    layer_id: 'subject',
    character_id: characterId,
    name: 'Subject',
    slots,
    standing_instructions: instructions,
    template: null,
    last_image_url: lastImageUrl,
    current_best_candidate_id: null,
    created_at: now(),
    updated_at: now(),
  };
  db.state.entities.push(row);
  return row;
}

// --- Fake LLM gates for describeStudioSubject (Part B). --------------------------------------
// The describer gate records the request and answers with an Appearance-markered reply, so the
// tests can assert both "the describer fired with the seed" and "its reply became the
// instructions." The throw gate simulates the fail-open LLM crash. The never gate fails the
// suite if the describer is (wrongly) invoked.
function makeDescribeGate(reply) {
  const gate = {
    calls: [],
    name: 'fake-describe-gate',
    async complete(messages) {
      gate.calls.push(messages);
      return { message: { role: 'assistant', content: reply }, toolCalls: [] };
    },
  };
  return gate;
}

const makeThrowingGate = () => ({
  name: 'fake-throwing-gate',
  async complete() {
    throw new Error('simulated describer crash');
  },
});

const makeNeverGate = () => ({
  name: 'fake-never-gate',
  async complete() {
    throw new Error('describer must NOT be invoked for this create');
  },
});

// ============================================================================
// create-entity describer (Part B)
// ============================================================================

// --- Subject create with a seed and no standingInstructions: the describer fires and its reply
// becomes standing_instructions. ---
{
  const db = makeDb();
  const gate = makeDescribeGate('Appearance: Tall and stooped, with calloused hands and a beard shot through with grey.');
  const res = fakeRes();
  await handlePortraitEntities(
    jsonReq({ layerId: 'subject', name: 'Talfryn', seed: 'an Italian woman in her 30s' }),
    res,
    { db, settings: makeSettings(), llm: gate },
    USER,
    new URL('http://x/v1/portraits/entities'),
  );

  assert(res.responses[0].status === 201, 'create-entity: a subject create → 201');
  assert(gate.calls.length === 1, 'create-entity: the subject describer fires on the seed path');
  assert(
    gate.calls[0][0].content.includes('an Italian woman in her 30s') && gate.calls[0][0].content.includes('Talfryn'),
    'create-entity: the describer prompt interpolates both {{name}} and {{seed}}',
  );
  const created = db.state.entities.find((e) => e.name === 'Talfryn');
  assert(
    created.standing_instructions === 'Tall and stooped, with calloused hands and a beard shot through with grey.',
    'create-entity: the describer reply becomes the entity\'s standing_instructions',
  );
  assert(res.responses[0].body.entity_id === created.entity_id, 'create-entity: the response returns the created entity');
}

// --- A subject created WITH standingInstructions never invokes the describer, seed or no seed
// (§3 — explicit outranks inferred). ---
{
  const db = makeDb();
  const gate = makeNeverGate();
  const res = fakeRes();
  await handlePortraitEntities(
    jsonReq({ layerId: 'subject', name: 'Mair', standingInstructions: 'A sharp-eyed harbormaster.', seed: 'ignored seed' }),
    res,
    { db, settings: makeSettings(), llm: gate },
    USER,
    new URL('http://x/v1/portraits/entities'),
  );

  assert(res.responses[0].status === 201, 'create-entity: a subject create with explicit instructions → 201');
  const created = db.state.entities.find((e) => e.name === 'Mair');
  assert(
    created.standing_instructions === 'A sharp-eyed harbormaster.',
    'create-entity: standingInstructions are kept exactly as supplied when present',
  );
}

// --- A describer LLM failure still creates the entity with blank instructions (fail-open §11). ---
{
  const db = makeDb();
  const res = fakeRes();
  await handlePortraitEntities(
    jsonReq({ layerId: 'subject', name: 'Ghost', seed: 'a faceless wanderer' }),
    res,
    { db, settings: makeSettings(), llm: makeThrowingGate() },
    USER,
    new URL('http://x/v1/portraits/entities'),
  );

  assert(res.responses[0].status === 201, 'create-entity: a describer crash still creates the entity → 201 (fail-open)');
  const created = db.state.entities.find((e) => e.name === 'Ghost');
  assert(created.standing_instructions === '', 'create-entity: a describer crash leaves standing_instructions blank');
}

// --- A stray characterId in the body is accepted-and-ignored: never written (standalone). ---
{
  const db = makeDb();
  const gate = makeNeverGate();
  const res = fakeRes();
  await handlePortraitEntities(
    jsonReq({ layerId: 'subject', name: 'Rin', characterId: 'legacy-linked-char', standingInstructions: 'hand-typed instructions' }),
    res,
    { db, settings: makeSettings(), llm: gate },
    USER,
    new URL('http://x/v1/portraits/entities'),
  );

  assert(res.responses[0].status === 201, 'create-entity: a characterId in the body is accepted, not an error');
  const created = db.state.entities.find((e) => e.name === 'Rin');
  assert(created.character_id === null, 'create-entity: a body characterId is never written — character_id stays null');
}

// --- A stray seed on a non-subject layer is silently unused (the describer never fires). ---
{
  const db = makeDb();
  const gate = makeNeverGate();
  const res = fakeRes();
  await handlePortraitEntities(
    jsonReq({ layerId: 'style', name: 'VLZ hybrid', seed: 'this must be ignored' }),
    res,
    { db, settings: makeSettings(), llm: gate },
    USER,
    new URL('http://x/v1/portraits/entities'),
  );

  assert(res.responses[0].status === 201, 'create-entity: a seed on a style layer is accepted, not an error');
  const created = db.state.entities.find((e) => e.name === 'VLZ hybrid');
  assert(created.standing_instructions === '', 'create-entity: a non-subject layer never gets described instructions');
}

// ============================================================================
// from-cast-character (Part C)
// ============================================================================

// --- Creates a subject entity from a character's appearance — appearance preferred over
// persona when both are present (character-appearance-field-plan.md). Always unlinked. ---
{
  const db = makeDb();
  db.state.characters.push({
    character_id: 'char-new',
    user_id: USER,
    name: 'Talfryn',
    persona: 'A dour shipwright with a lantern jaw.',
    appearance: 'Tall and stooped, with calloused hands and a beard shot through with grey.',
    avatar_path: null,
  });
  const res = fakeRes();
  await handlePortraitEntityFromCastCharacter(jsonReq({ characterId: 'char-new' }), res, { db, settings: makeSettings() }, USER);

  assert(res.responses[0].status === 200, 'from-cast-character: a known character returns 200');
  assert(res.responses[0].body.entity?.entity_id, 'from-cast-character: the response carries { entity } — no action field');
  assert(res.responses[0].body.action === undefined, 'from-cast-character: the action field is dropped');
  const created = db.state.entities.find((e) => e.name === 'Talfryn');
  assert(created.layer_id === 'subject' && created.character_id === null, 'from-cast-character: the new entity is a subject layer, always unlinked');
  assert(
    created.standing_instructions === 'Tall and stooped, with calloused hands and a beard shot through with grey.',
    'from-cast-character: standing_instructions is seeded from the APPEARANCE when present, not the persona',
  );
  assert(res.responses[0].body.entity.entity_id === created.entity_id, 'from-cast-character: the response returns the created entity');
}

// --- A character with a persona but no appearance still seeds — the fallback to persona. ---
{
  const db = makeDb();
  db.state.characters.push({ character_id: 'char-fallback', user_id: USER, name: 'Mair', persona: 'A sharp-eyed harbormaster.', appearance: '', avatar_path: null });
  const res = fakeRes();
  await handlePortraitEntityFromCastCharacter(jsonReq({ characterId: 'char-fallback' }), res, { db, settings: makeSettings() }, USER);
  const created = db.state.entities.find((e) => e.name === 'Mair');
  assert(
    created?.standing_instructions === 'A sharp-eyed harbormaster.' && created.character_id === null,
    'from-cast-character: a blank appearance falls back to the persona for seeding (still unlinked)',
  );
}

// --- Two consecutive calls with the same characterId create two distinct, unlinked entities —
// no dedup, no refresh-in-place (the plan's Edge Cases). A legacy linked entity from the old
// bridge is left exactly as it was. ---
{
  const db = makeDb();
  db.state.characters.push({
    character_id: 'char-twice',
    user_id: USER,
    name: 'Mair',
    persona: 'A sharp-eyed harbormaster.',
    appearance: 'An old salt with a weather-lined face.',
    avatar_path: null,
  });
  // The old bridge (studio-character-bridge-plan.md Part A) left a linked subject behind. This
  // plan never touches it — inert legacy data, still returned on reads, never re-pointed.
  seedSubjectEntity(db, { entityId: 'e-legacy', characterId: 'char-twice', instructions: 'legacy linked instructions' });

  const first = fakeRes();
  await handlePortraitEntityFromCastCharacter(jsonReq({ characterId: 'char-twice' }), first, { db, settings: makeSettings() }, USER);
  const second = fakeRes();
  await handlePortraitEntityFromCastCharacter(jsonReq({ characterId: 'char-twice' }), second, { db, settings: makeSettings() }, USER);

  const ids = db.state.entities.filter((e) => e.name === 'Mair');
  assert(ids.length === 2 && ids[0].entity_id !== ids[1].entity_id, 'from-cast-character: two clicks → two DISTINCT entity_ids');
  assert(ids.every((e) => e.character_id === null), 'from-cast-character: both new entities are unlinked (character_id null)');
  assert(
    ids.every((e) => e.standing_instructions === 'An old salt with a weather-lined face.'),
    'from-cast-character: both entities are seeded from the same appearance',
  );
  const legacy = db.state.entities.find((e) => e.entity_id === 'e-legacy');
  assert(
    legacy.character_id === 'char-twice' && legacy.standing_instructions === 'legacy linked instructions',
    'from-cast-character: a legacy linked entity is left untouched — no re-pointing, no refresh-in-place',
  );
}

// --- Unknown characterId → 404, nothing created. ---
{
  const db = makeDb();
  const res = fakeRes();
  await handlePortraitEntityFromCastCharacter(jsonReq({ characterId: 'no-such-character' }), res, { db, settings: makeSettings() }, USER);
  assert(res.responses[0].status === 404 && res.responses[0].body.error === 'character not found', 'from-cast-character: unknown characterId → 404 "character not found"');
  assert(db.state.entities.length === 0, 'from-cast-character: a 404 creates no entity');
}

// --- Both appearance and persona blank → 409, no entity created. ---
{
  const db = makeDb();
  db.state.characters.push({ character_id: 'char-blank', user_id: USER, name: 'Ghost', persona: '   ', appearance: '', avatar_path: null });
  const res = fakeRes();
  await handlePortraitEntityFromCastCharacter(jsonReq({ characterId: 'char-blank' }), res, { db, settings: makeSettings() }, USER);
  assert(
    res.responses[0].status === 409 && res.responses[0].body.error === 'character has no appearance or persona',
    'from-cast-character: both appearance and persona blank → 409 "character has no appearance or persona"',
  );
  assert(db.state.entities.length === 0, 'from-cast-character: a 409 creates nothing');
}

// ============================================================================
// set-as-avatar (Part C) — the route is removed
// ============================================================================

// --- The dedicated route is gone; the CRUD family now 404s the old URL instead of promoting. ---
{
  const db = makeDb();
  seedSubjectEntity(db, { entityId: 'e-winner', characterId: SUBJECT_CHAR, lastImageUrl: 'https://img/winner.png' });
  const res = fakeRes();
  await handlePortraitEntities({}, res, { db, settings: makeSettings() }, USER, new URL('http://x/v1/portraits/entities/e-winner/set-as-avatar'));
  assert(
    res.responses[0].status === 404 && res.responses[0].body.error === 'not found',
    'set-as-avatar: the removed route 404s through the CRUD family (no more avatar promotion)',
  );
}

// ============================================================================
// submitPortraitFeedback (Part B/D)
// ============================================================================

const WINNER = 'c-winner';
const LOSER = 'c-loser';

function seedFeedbackRound(db, { avatarPath = null, characterId = SUBJECT_CHAR } = {}) {
  db.state.entities.push(
    { entity_id: 'e-sub', user_id: USER, layer_id: 'subject', character_id: characterId, name: 'Rin', slots: {}, standing_instructions: '', template: null, last_image_url: null, current_best_candidate_id: null, created_at: now(), updated_at: now() },
    { entity_id: 'e-out', user_id: USER, layer_id: 'outfit', character_id: null, name: 'Coat', slots: {}, standing_instructions: '', template: null, last_image_url: null, current_best_candidate_id: null, created_at: now(), updated_at: now() },
    { entity_id: 'e-style', user_id: USER, layer_id: 'style', character_id: null, name: 'Style', slots: {}, standing_instructions: '', template: null, last_image_url: null, current_best_candidate_id: null, created_at: now(), updated_at: now() },
    { entity_id: 'e-expr', user_id: USER, layer_id: 'expression', character_id: null, name: 'Expr', slots: {}, standing_instructions: '', template: null, last_image_url: null, current_best_candidate_id: null, created_at: now(), updated_at: now() },
    // An entity only the losing candidate referenced — must come through untouched.
    { entity_id: 'e-other-out', user_id: USER, layer_id: 'outfit', character_id: null, name: 'Old coat', slots: { outfit_style: 'old wool' }, standing_instructions: '', template: null, last_image_url: 'https://img/old.png', current_best_candidate_id: 'c-old', created_at: now(), updated_at: now() },
  );
  db.state.characters.push({ character_id: characterId, user_id: USER, name: 'Rin', persona: 'x', avatar_path: avatarPath });
  db.state.candidates.push(
    {
      candidate_id: WINNER,
      entity_ids: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
      image_url: 'https://img/winner.png',
      chromosome: {
        slots: {
          subject: { subject_identity: 'Rin V1' },
          outfit: { outfit_style: 'red coat' },
          style: { style_style: 'VLZ hybrid' },
          expression: { expression_emotion: 'calm' },
        },
      },
    },
    {
      candidate_id: LOSER,
      entity_ids: { subject: 'e-sub', outfit: 'e-other-out' },
      image_url: 'https://img/loser.png',
      chromosome: {
        slots: {
          subject: { subject_identity: 'Wrong Rin' },
          outfit: { outfit_style: 'green coat' },
        },
      },
    },
  );
}

const concludeLlm = {
  name: 'fake-gate',
  async complete() {
    return {
      message: { role: 'assistant', content: '' },
      toolCalls: [
        { id: 'concl-1', name: 'submit_conclusion', arguments: { action: 'create', title: 'Lesson', body: 'Body', tags: ['outfit'], layerId: 'outfit' } },
      ],
    };
  },
};

const feedbackInput = {
  entityIds: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
  goal: 'A calmer evening variant of Rin.',
  candidateIds: [WINNER, LOSER],
  winnerId: WINNER,
};

// --- Winner promotion happens; the characters table is NEVER touched (Part D). ---
{
  const db = makeDb();
  seedFeedbackRound(db, { avatarPath: null });
  const res = fakeRes();
  await handlePortraitFeedback(jsonReq(feedbackInput), res, { db, settings: makeSettings(), llm: concludeLlm, imageConnections: undefined }, USER);
  assert(res.responses[0].status === 200, 'feedback: a well-formed round → 200');
  assert(res.responses[0].body.episodeId === 'ep-1', 'feedback: an episode row is recorded and returned');

  const sub = db.state.entities.find((e) => e.entity_id === 'e-sub');
  const out = db.state.entities.find((e) => e.entity_id === 'e-out');
  assert(sub.last_image_url === 'https://img/winner.png' && sub.current_best_candidate_id === WINNER, 'feedback: the winning entity gets the winner image + candidate id');
  assert(sub.slots.subject_identity === 'Rin V1' && out.slots.outfit_style === 'red coat', 'feedback: each winning entity gets ITS OWN layer\'s slots from the winning chromosome');
  const other = db.state.entities.find((e) => e.entity_id === 'e-other-out');
  assert(other.last_image_url === 'https://img/old.png' && other.slots.outfit_style === 'old wool', 'feedback: an entity only a losing candidate referenced is left untouched');

  assert(db.state.charQueries === 0, 'feedback: NO characters-table query fires — avatar promotion is retired (Part D)');
  assert(res.responses[0].body.reflection?.action === 'created', 'feedback: the reflection investigation concludes and reports the wiki write');
}

// ============================================================================
// The kill switch (portrait-chain-hardening-plan.md)
// ============================================================================

// --- readPortraitsEnabled: unset behaves as 'true'. ---
{
  const unset = { get: async () => null, set: async () => {} };
  assert((await readPortraitsEnabled(unset)) === true, 'kill switch: unset visual_portraits_enabled reads as enabled (opt-out, fail-open-to-current-behavior)');
  const off = { get: async () => 'false', set: async () => {} };
  assert((await readPortraitsEnabled(off)) === false, 'kill switch: "false" reads as disabled');
}

// --- handlePortraitsEnabledGet / Set round-trip the boolean; strict body validation. ---
{
  const settings = makeSettings();
  const getRes = fakeRes();
  await handlePortraitsEnabledGet(getRes, { settings });
  assert(getRes.responses[0].status === 200 && getRes.responses[0].body.enabled === true, 'kill switch: GET /v1/portraits-enabled → 200 { enabled: true }');

  const setRes = fakeRes();
  await handlePortraitsEnabledSet(jsonReq({ enabled: false }), setRes, { settings });
  assert(setRes.responses[0].status === 200 && setRes.responses[0].body.enabled === false, 'kill switch: POST with { enabled: false } → 200 echoing false');

  const badRes = fakeRes();
  await handlePortraitsEnabledSet(jsonReq({ enabled: 'yes' }), badRes, { settings });
  assert(badRes.responses[0].status === 400, 'kill switch: a non-boolean enabled → 400 (no coercion)');
  const missingRes = fakeRes();
  await handlePortraitsEnabledSet(jsonReq({}), missingRes, { settings });
  assert(missingRes.responses[0].status === 400, 'kill switch: a missing enabled → 400');
}

// --- visual_portraits_enabled = 'false': every gated route 403s before touching the DB or
// issuing any fetch; the layer-manifest pair is unaffected either way. ---
{
  const deps = {
    db: {
      // Any DB access during a disabled call is a bug — the guard must short-circuit first.
      withUserScope: async () => {
        throw new Error('kill switch: the DB must not be touched while disabled');
      },
    },
    settings: makeSettings({ visual_portraits_enabled: 'false' }),
    imageConnections: undefined,
    llm: concludeLlm,
  };
  const cases = [
    ['entities GET', async () => {
      const r = fakeRes();
      await handlePortraitEntities({}, r, deps, USER, new URL('http://x/v1/portraits/entities'));
      return r;
    }],
    ['from-cast-character', async () => {
      const r = fakeRes();
      await handlePortraitEntityFromCastCharacter(jsonReq({ characterId: 'anything' }), r, deps, USER);
      return r;
    }],
    ['wiki GET', async () => {
      const r = fakeRes();
      await handlePortraitWiki({}, r, deps, USER, new URL('http://x/v1/portraits/wiki'));
      return r;
    }],
    ['generate', async () => {
      const r = fakeRes();
      await handlePortraitGenerate(jsonReq({}), r, deps, USER);
      return r;
    }],
    ['feedback', async () => {
      const r = fakeRes();
      await handlePortraitFeedback(jsonReq({}), r, deps, USER);
      return r;
    }],
  ];
  for (const [label, run] of cases) {
    const res = await run();
    const responded = res.responses[0];
    assert(
      responded && responded.status === 403 && responded.body.error === 'portrait studio is disabled — enable it in Settings',
      `kill switch: ${label} → 403 with the pinned error body, DB untouched`,
    );
  }

  // The layer-manifest pair stays reachable (Manage Layers must survive a kill) — and, because
  // the guard never ran, the manifest read still resolves from settings.
  const layersRes = fakeRes();
  await handlePortraitLayersGet(layersRes, deps);
  assert(layersRes.responses[0].status === 200 && layersRes.responses[0].body.manifest.layers.some((l) => l.id === 'subject'), 'kill switch: GET /v1/portraits/layers is NOT gated — it still answers the manifest while disabled');
}

if (process.exitCode) {
  console.error('\nportrait bridge verification FAILED');
  process.exit(1);
}
console.log('\nportrait bridge verification passed');