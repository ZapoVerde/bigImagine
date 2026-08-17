// Proves studio-character-bridge-plan.md Parts A-C's route/service logic against a fake
// Postgres pool + fake settings + fake LLM gate — no server, no network (fetch is stubbed per
// test), no real provider (orchestrator/scripts/verify-location-presence-scraper.mjs's
// convention). The suite exercises:
//   - from-character (Part A, character-appearance-field-plan.md): create a subject entity
//     from a character's appearance (preferred over persona when present); blank appearance
//     falls back to the persona; unknown characterId → 404; both appearance and persona blank →
//     409 with no entity created or touched; refresh overwrites standing_instructions
//     unconditionally (no "already seeded, skip");
//   - set-as-avatar (Part C): non-subject-layer → 400; entity with no character_id → 400; no
//     last_image_url → 400; success always overwrites the character's avatar regardless of the
//     current avatar_path; a failing image fetch → 500 without corrupting state (fail-open);
//   - submitPortraitFeedback (Part B/C): the winning chromosome's per-layer slots land on the
//     winning entities; an entity that only a losing candidate referenced is left untouched;
//     the winner image promotes to the linked character's avatar fill-when-empty only — a
//     null avatar_path gets written and becomes 'local', a non-null one is left exactly as it
//     was (the plan's "fill-when-empty, not overwrite" crux), and a fetch failure skips the
//     promotion without failing the feedback;
//   - the kill switch (portrait-chain-hardening-plan.md): visual_portraits_enabled = 'false'
//     makes every gated handler 403 with the pinned error body before touching the DB or
//     issuing a fetch, while the layer-manifest pair stays reachable either way;
//   - the switch's own handlers: readPortraitsEnabled unset → true, handlePortraitsEnabledGet/
//     Set round-trip the boolean, and a missing/non-boolean body is a 400.
//
// writeAvatar (characterMedia.ts) writes to disk under BIGBRAIN_CHARACTER_MEDIA_DIR, so that env
// var is pointed at a throwaway temp dir BEFORE the module graph loads — hence the dynamic
// imports.

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MEDIA_DIR = await mkdtemp(join(tmpdir(), 'bigimagine-avatar-'));
process.env.BIGBRAIN_CHARACTER_MEDIA_DIR = MEDIA_DIR;

const { DEFAULT_LAYER_MANIFEST } = await import('../dist/portraits/layerStack.js');
const {
  handlePortraitEntities,
  handlePortraitEntityFromCharacter,
  handlePortraitEntitySetAsAvatar,
  handlePortraitFeedback,
  handlePortraitGenerate,
  handlePortraitLayersGet,
  handlePortraitsEnabledGet,
  handlePortraitsEnabledSet,
  handlePortraitWiki,
  readPortraitsEnabled,
} = await import('../dist/server/portraitRoutes.js');
const { submitPortraitFeedback } = await import('../dist/orchestrator/portraitFeedback.js');

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
// issue for these three surfaces. ---
function makeDb() {
  const state = {
    entities: [],
    characters: [],
    candidates: [],
    wikiEntries: [],
    episodes: 0,
    episodeCounter: 0,
    wikiCounter: 0,
    promoted: [], // { entityId, imageUrl, candidateId, slotsJson? }
    ratingWrites: [],
    noteWrites: [],
    avatarPathWrites: [], // characters whose avatar_path was actually updated
  };
  const query = (sql, params = []) => {
    const s = sql;
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
    if (s.includes('select character_id from visual_entities')) {
      const row = state.entities.find((e) => e.entity_id === params[0] && e.user_id === params[1]);
      return [{ character_id: row?.character_id ?? null }];
    }
    if (s.includes('select template from visual_entities')) {
      const row = state.entities.find((e) => e.user_id === params[0] && e.entity_id === params[1]);
      return [{ template: row?.template ?? null }];
    }
    if (s.startsWith('select entity_id, layer_id, character_id, name, slots') && s.includes('from visual_entities where entity_id')) {
      const row = state.entities.find((e) => e.entity_id === params[0] && e.user_id === params[1]);
      return row ? [row] : [];
    }
    if (s.includes('from characters') && s.includes('avatar_path')) {
      const row = state.characters.find((c) => c.character_id === params[0] && c.user_id === params[1]);
      return [{ avatar_path: row?.avatar_path ?? null }];
    }
    if (s.startsWith('update characters set avatar_path')) {
      const row = state.characters.find((c) => c.character_id === params[0] && c.user_id === params[2]);
      if (row) {
        row.avatar_path = params[1];
        state.avatarPathWrites.push({ characterId: params[0], avatarPath: params[1] });
      }
      return [];
    }
    if (s.startsWith('select character_id, name, persona, appearance from characters')) {
      const row = state.characters.find((c) => c.character_id === params[0] && c.user_id === params[1]);
      return row ? [{ character_id: row.character_id, name: row.name, persona: row.persona, appearance: row.appearance }] : [];
    }
    if (s.startsWith('select entity_id from visual_entities') && s.includes("layer_id = 'subject'")) {
      // subjectExistsForCharacter
      return state.entities.filter((e) => e.user_id === params[0] && e.layer_id === 'subject' && e.character_id === params[1]);
    }
    if (s.startsWith('update visual_entities set standing_instructions')) {
      const row = state.entities.find((e) => e.user_id === params[0] && e.layer_id === 'subject' && e.character_id === params[1]);
      if (row) row.standing_instructions = params[2];
      return row ? [row] : [];
    }
    if (s.startsWith('insert into visual_entities')) {
      const isFromCharacter = params.length === 4;
      if (isFromCharacter) {
        const [userId, characterId, name, persona] = params;
        const row = {
          entity_id: randomUUID(),
          user_id: userId,
          layer_id: 'subject',
          character_id: characterId,
          name,
          slots: {},
          standing_instructions: persona,
          template: null,
          last_image_url: null,
          current_best_candidate_id: null,
          created_at: now(),
          updated_at: now(),
        };
        state.entities.push(row);
        return [row];
      }
      const [userId, layerId, characterId, name, slotsJson, standingInstructions, template] = params;
      const row = {
        entity_id: randomUUID(),
        user_id: userId,
        layer_id: layerId,
        character_id: characterId,
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

async function mediaFileExists(characterId) {
  try {
    await readFile(join(MEDIA_DIR, `${characterId}.png`));
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// from-character (Part A)
// ============================================================================

// --- Creates a subject entity from a character's appearance — appearance preferred over
// persona when both are present (character-appearance-field-plan.md). ---
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
  await handlePortraitEntityFromCharacter(jsonReq({ characterId: 'char-new' }), res, { db, settings: makeSettings() }, USER);

  assert(res.responses.length === 1 && res.responses[0].status === 200, 'from-character: known character returns 200');
  const created = db.state.entities.find((e) => e.character_id === 'char-new');
  assert(res.responses[0].body.action === 'created' && !!created, 'from-character: a new subject entity is created (action "created")');
  assert(created.layer_id === 'subject' && created.name === 'Talfryn', 'from-character: the entity is a subject layer carrying the character\'s name');
  assert(
    created.standing_instructions === 'Tall and stooped, with calloused hands and a beard shot through with grey.',
    'from-character: standing_instructions is seeded from the APPEARANCE when present, not the persona',
  );
  assert(res.responses[0].body.entity.entity_id === created.entity_id, 'from-character: the response returns the created entity');
}

// --- A character with a persona but no appearance still seeds — the fallback to persona. ---
{
  const db = makeDb();
  db.state.characters.push({ character_id: 'char-fallback', user_id: USER, name: 'Mair', persona: 'A sharp-eyed harbormaster.', appearance: '', avatar_path: null });
  const res = fakeRes();
  await handlePortraitEntityFromCharacter(jsonReq({ characterId: 'char-fallback' }), res, { db, settings: makeSettings() }, USER);
  const created = db.state.entities.find((e) => e.character_id === 'char-fallback');
  assert(
    created?.standing_instructions === 'A sharp-eyed harbormaster.',
    'from-character: a blank appearance falls back to the persona for seeding (no silent regression to 409)',
  );
}

// --- Refresh overwrites standing_instructions unconditionally — no "already seeded, skip". ---
{
  const db = makeDb();
  db.state.characters.push({
    character_id: 'char-refresh',
    user_id: USER,
    name: 'Mair',
    persona: 'A sharp-eyed harbormaster.',
    appearance: 'An old salt with a weather-lined face.',
    avatar_path: null,
  });
  seedSubjectEntity(db, { entityId: 'e-refresh', characterId: 'char-refresh', instructions: 'The old instructions from a prior seed.' });
  // The appearance changed since the last seed — clicking again is the operator's refresh signal.
  db.state.characters[0].appearance = 'A harbormaster whose coat is salt-cured and whose gaze is a ledger.';
  const res = fakeRes();
  await handlePortraitEntityFromCharacter(jsonReq({ characterId: 'char-refresh' }), res, { db, settings: makeSettings() }, USER);

  assert(res.responses[0].body.action === 'refreshed', 'from-character: an already-seeded entity is refreshed, not rejected (action "refreshed")');
  const entity = db.state.entities.find((e) => e.entity_id === 'e-refresh');
  assert(entity.standing_instructions === 'A harbormaster whose coat is salt-cured and whose gaze is a ledger.', 'from-character: refresh overwrites standing_instructions with the CURRENT appearance — unconditional');
  assert(db.state.entities.length === 1, 'from-character: refresh updates in place — no duplicate entity');
}

// --- Unknown characterId → 404, nothing created. ---
{
  const db = makeDb();
  const res = fakeRes();
  await handlePortraitEntityFromCharacter(jsonReq({ characterId: 'no-such-character' }), res, { db, settings: makeSettings() }, USER);
  assert(res.responses[0].status === 404 && res.responses[0].body.error === 'character not found', 'from-character: unknown characterId → 404 "character not found"');
  assert(db.state.entities.length === 0, 'from-character: a 404 creates no entity');
}

// --- Both appearance and persona blank → 409, no entity created or touched. ---
{
  const db = makeDb();
  db.state.characters.push({ character_id: 'char-blank', user_id: USER, name: 'Ghost', persona: '   ', appearance: '', avatar_path: null });
  seedSubjectEntity(db, { entityId: 'e-ghost', characterId: 'char-blank', instructions: 'original instructions — must survive untouched' });
  const res = fakeRes();
  await handlePortraitEntityFromCharacter(jsonReq({ characterId: 'char-blank' }), res, { db, settings: makeSettings() }, USER);
  assert(
    res.responses[0].status === 409 && res.responses[0].body.error === 'character has no appearance or persona',
    'from-character: both appearance and persona blank → 409 "character has no appearance or persona"',
  );
  assert(
    db.state.entities.find((e) => e.entity_id === 'e-ghost').standing_instructions === 'original instructions — must survive untouched',
    'from-character: a 409 leaves the existing entity untouched',
  );
  assert(db.state.entities.length === 1, 'from-character: a 409 creates nothing');
}

// ============================================================================
// set-as-avatar (Part C)
// ============================================================================

const avatarUrl = 'https://cdn.example.com/winning.png';
const okFetch = () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 1, 2, 3]) });

// --- Non-subject-layer entity → 400. ---
{
  const db = makeDb();
  db.state.entities.push({
    entity_id: 'e-outfit',
    user_id: USER,
    layer_id: 'outfit',
    character_id: SUBJECT_CHAR,
    name: 'Coat',
    slots: {},
    standing_instructions: '',
    template: null,
    last_image_url: avatarUrl,
    current_best_candidate_id: null,
    created_at: now(),
    updated_at: now(),
  });
  const res = fakeRes();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = okFetch;
  try {
    await handlePortraitEntitySetAsAvatar(res, { db, settings: makeSettings() }, USER, new URL('http://x/v1/portraits/entities/e-outfit/set-as-avatar'));
  } finally {
    globalThis.fetch = prevFetch;
  }
  assert(res.responses[0].status === 400, 'set-as-avatar: a non-subject-layer entity → 400');
}

// --- Entity with no character_id → 400. ---
{
  const db = makeDb();
  seedSubjectEntity(db, { entityId: 'e-unlinked', characterId: null, lastImageUrl: avatarUrl });
  const res = fakeRes();
  await handlePortraitEntitySetAsAvatar(res, { db, settings: makeSettings() }, USER, new URL('http://x/v1/portraits/entities/e-unlinked/set-as-avatar'));
  assert(res.responses[0].status === 400 && res.responses[0].body.error.includes('no linked character'), 'set-as-avatar: an entity with no character_id → 400');
}

// --- Entity with no last_image_url → 400. ---
{
  const db = makeDb();
  seedSubjectEntity(db, { entityId: 'e-noimage', characterId: SUBJECT_CHAR, lastImageUrl: null });
  const res = fakeRes();
  await handlePortraitEntitySetAsAvatar(res, { db, settings: makeSettings() }, USER, new URL('http://x/v1/portraits/entities/e-noimage/set-as-avatar'));
  assert(res.responses[0].status === 400 && res.responses[0].body.error.includes('no winning image'), 'set-as-avatar: an entity with no winning image → 400');
}

// --- Success always overwrites — regardless of the character's current avatar_path. ---
{
  const db = makeDb();
  seedSubjectEntity(db, { entityId: 'e-winner', characterId: SUBJECT_CHAR, lastImageUrl: avatarUrl });
  db.state.characters.push({ character_id: SUBJECT_CHAR, user_id: USER, name: 'Rin', persona: 'x', avatar_path: '/avatars/imported.png' });
  const res = fakeRes();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = okFetch;
  try {
    await handlePortraitEntitySetAsAvatar(res, { db, settings: makeSettings() }, USER, new URL('http://x/v1/portraits/entities/e-winner/set-as-avatar'));
  } finally {
    globalThis.fetch = prevFetch;
  }
  assert(res.responses[0].status === 200 && res.responses[0].body.avatarSet === true, 'set-as-avatar: success → 200 { avatarSet: true }');
  assert(
    db.state.characters.find((c) => c.character_id === SUBJECT_CHAR).avatar_path === 'local',
    'set-as-avatar: the character avatar is overwritten (avatar_path becomes "local") even when it was already set',
  );
  assert(await mediaFileExists(SUBJECT_CHAR), 'set-as-avatar: the winning image bytes are written as the stored avatar');
}

// --- Image fetch failure → 500, no state corruption (fail-open). ---
{
  const db = makeDb();
  const failChar = '33333333-3333-3333-3333-333333333333';
  seedSubjectEntity(db, { entityId: 'e-fail', characterId: failChar, lastImageUrl: avatarUrl });
  db.state.characters.push({ character_id: failChar, user_id: USER, name: 'Rin', persona: 'x', avatar_path: '/avatars/keep.png' });
  const res = fakeRes();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 502 });
  try {
    await handlePortraitEntitySetAsAvatar(res, { db, settings: makeSettings() }, USER, new URL('http://x/v1/portraits/entities/e-fail/set-as-avatar'));
  } finally {
    globalThis.fetch = prevFetch;
  }
  assert(res.responses[0].status === 500, 'set-as-avatar: a failing image fetch → 500 (fail-open, never a partial write)');
  assert(
    db.state.characters.find((c) => c.character_id === failChar).avatar_path === '/avatars/keep.png',
    'set-as-avatar: a failed fetch leaves the existing avatar untouched',
  );
  assert(!(await mediaFileExists(failChar)), 'set-as-avatar: a failed fetch writes no avatar file');
}

// ============================================================================
// submitPortraitFeedback (Part B/C)
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

// --- Winner promotion + fill-when-empty avatar. ---
{
  const db = makeDb();
  seedFeedbackRound(db, { avatarPath: null });
  const res = fakeRes();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = okFetch;
  try {
    await handlePortraitFeedback(jsonReq(feedbackInput), res, { db, settings: makeSettings(), llm: concludeLlm, imageConnections: undefined }, USER);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assert(res.responses[0].status === 200, 'feedback: a well-formed round → 200');
  assert(res.responses[0].body.episodeId === 'ep-1', 'feedback: an episode row is recorded and returned');

  const sub = db.state.entities.find((e) => e.entity_id === 'e-sub');
  const out = db.state.entities.find((e) => e.entity_id === 'e-out');
  assert(sub.last_image_url === 'https://img/winner.png' && sub.current_best_candidate_id === WINNER, 'feedback: the winning entity gets the winner image + candidate id');
  assert(sub.slots.subject_identity === 'Rin V1' && out.slots.outfit_style === 'red coat', 'feedback: each winning entity gets ITS OWN layer\'s slots from the winning chromosome');
  const other = db.state.entities.find((e) => e.entity_id === 'e-other-out');
  assert(other.last_image_url === 'https://img/old.png' && other.slots.outfit_style === 'old wool', 'feedback: an entity only a losing candidate referenced is left untouched');

  const char = db.state.characters.find((c) => c.character_id === SUBJECT_CHAR);
  assert(char.avatar_path === 'local', 'feedback: a null avatar_path is filled — avatar_path becomes "local"');
  assert(await mediaFileExists(SUBJECT_CHAR), 'feedback: the winner image is written as the character avatar (fill-when-empty)');
  assert(res.responses[0].body.reflection?.action === 'created', 'feedback: the reflection investigation concludes and reports the wiki write');
}

// --- Fill-when-empty, NOT overwrite: a non-null avatar_path is left exactly as it was. ---
{
  const db = makeDb();
  const keptChar = '44444444-4444-4444-4444-444444444444';
  seedFeedbackRound(db, { avatarPath: '/avatars/imported.png', characterId: keptChar });
  const res = fakeRes();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = okFetch;
  try {
    await handlePortraitFeedback(jsonReq(feedbackInput), res, { db, settings: makeSettings(), llm: concludeLlm, imageConnections: undefined }, USER);
  } finally {
    globalThis.fetch = prevFetch;
  }
  const char = db.state.characters.find((c) => c.character_id === keptChar);
  assert(char.avatar_path === '/avatars/imported.png', 'feedback: an existing avatar_path is left untouched — fill-when-empty, never overwrite');
  assert(!(await mediaFileExists(keptChar)), 'feedback: no avatar file is written when one is already set');
  assert(db.state.avatarPathWrites.length === 0, 'feedback: no avatar update query fires when the avatar is already set');
}

// --- Avatar fetch failure skips the promotion but the feedback still succeeds (fail-open). ---
{
  const db = makeDb();
  seedFeedbackRound(db, { avatarPath: null });
  const res = fakeRes();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 502 });
  try {
    await handlePortraitFeedback(jsonReq(feedbackInput), res, { db, settings: makeSettings(), llm: concludeLlm, imageConnections: undefined }, USER);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assert(res.responses[0].status === 200, 'feedback: a failed avatar fetch does not fail the feedback (fail-open)');
  const char = db.state.characters.find((c) => c.character_id === SUBJECT_CHAR);
  assert(char.avatar_path === null, 'feedback: a failed avatar fetch leaves avatar_path null');
  assert(res.responses[0].body.episodeId === 'ep-1', 'feedback: the episode record survives the skipped promotion');
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
    ['from-character', async () => {
      const r = fakeRes();
      await handlePortraitEntityFromCharacter(jsonReq({ characterId: 'anything' }), r, deps, USER);
      return r;
    }],
    ['set-as-avatar', async () => {
      const r = fakeRes();
      await handlePortraitEntitySetAsAvatar(r, deps, USER, new URL('http://x/v1/portraits/entities/anything/set-as-avatar'));
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