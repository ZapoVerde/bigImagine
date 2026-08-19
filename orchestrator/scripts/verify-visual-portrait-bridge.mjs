// Proves portrait-studio-standalone-subjects-plan.md Parts B-D's route/service logic against a
// fake Postgres pool + fake settings + fake LLM gates — no server, no network, no real provider
// (orchestrator/scripts/verify-location-presence-scraper.mjs's convention). The suite exercises:
//   - create-entity bootstrap (Part B, reworked 2026-08-17 when migration 0114 dropped
//     standing_instructions): a subject created with no explicit slots gets a two-call bootstrap —
//     describeStudioSubject expands the seed into an appearance blurb, describeStudioSlots turns
//     that into structured slots — and neither the seed nor the blurb is ever persisted; a subject
//     created WITH explicit slots never invokes either describer (bi_principles.md §3 — explicit
//     outranks inferred); a describer/bootstrapper LLM failure still creates the entity (201) with
//     empty slots (fail-open, §11); a stray characterId in the body is accepted-and-ignored (never
//     written — entities are standalone); a non-subject layer's seed skips describeStudioSubject
//     and feeds describeStudioSlots directly;
//   - from-cast-character (Part C): ALWAYS inserts a brand-new, unlinked subject entity, its slots
//     bootstrapped from the character's appearance (preferred over persona when present; blank
//     appearance falls back to the persona); unknown characterId → 404; both appearance and
//     persona blank → 409 with nothing created; two consecutive calls with the same characterId
//     produce two distinct entity_ids, both character_id null; a legacy linked entity from the old
//     bridge is never touched or re-pointed (no refresh-in-place, no per-character dedup);
//   - set-as-avatar (Part C): the route is removed — the CRUD family 404s it instead of the old
//     always-overwrite promotion;
//   - submitPortraitFeedback (Part B/D + the vision-review-harness plan): the winning
//     chromosome's per-layer slots land on the winning entities; an entity only a losing candidate
//     referenced is left untouched; NO characters row is ever touched — zero queries against the
//     characters table, no avatar_path write, no writeAvatar call (Part D, promotion retired);
//     the reflection pass concludes through the single forced submit_lesson tool, persisting the
//     immutable attempt row (visual_episode_learning) before the episode's state changes, and
//     records winner_applied / lesson_created events;
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
    learning: [], // visual_episode_learning rows
    lessons: [], // visual_lessons rows
    events: [], // visual_episode_events rows
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
      // Winner promotion — two shapes: with slots (5 params: image_url, candidate_id, slotsJson,
      // userId, entityId) and without (4, a layer absent from the winning chromosome leaves that
      // entity's slots untouched).
      const withSlots = params.length === 5;
      const entityId = params[withSlots ? 4 : 3];
      const userIdParam = params[withSlots ? 3 : 2];
      state.promoted.push({
        entityId,
        imageUrl: params[0],
        candidateId: params[1],
        ...(withSlots ? { slotsJson: params[2] } : {}),
      });
      const row = state.entities.find((e) => e.entity_id === entityId && e.user_id === userIdParam);
      if (row) {
        row.last_image_url = params[0];
        row.current_best_candidate_id = params[1];
        if (withSlots) row.slots = JSON.parse(params[2]);
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
    // insertLesson's entity-name lookup (feedback reflection lesson ledger, commit e8f0d3e).
    if (s.startsWith('select name from visual_entities')) {
      const row = state.entities.find((e) => e.entity_id === params[0] && e.user_id === params[1]);
      return row ? [{ name: row.name }] : [];
    }
    if (s.startsWith('select character_id, name, persona, appearance from characters')) {
      const row = state.characters.find((c) => c.character_id === params[0] && c.user_id === params[1]);
      return row ? [{ character_id: row.character_id, name: row.name, persona: row.persona, appearance: row.appearance }] : [];
    }
    if (s.startsWith('insert into visual_entities')) {
      if (params.length === 3) {
        // from-cast-character (Part C): [userId, name, slotsJson] — always unlinked, subject layer,
        // slots already bootstrapped by the route (2026-08-17 — no more standing_instructions to
        // fall back on, so this path bootstraps up front instead of inserting `{}`).
        const [userId, name, slotsJson] = params;
        const row = {
          entity_id: randomUUID(),
          user_id: userId,
          layer_id: 'subject',
          character_id: null,
          name,
          slots: JSON.parse(slotsJson),
          template: null,
          last_image_url: null,
          current_best_candidate_id: null,
          created_at: now(),
          updated_at: now(),
        };
        state.entities.push(row);
        return [row];
      }
      // Create-entity: [userId, layerId, name, slotsJson, template] — character_id is hardcoded
      // null server-side, never a param.
      const [userId, layerId, name, slotsJson, template] = params;
      const row = {
        entity_id: randomUUID(),
        user_id: userId,
        layer_id: layerId,
        character_id: null,
        name,
        slots: JSON.parse(slotsJson),
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
    if (s.includes('from visual_wiki_revisions')) {
      return []; // no revisions in this fake — bounded context resolves with zero revision ids
    }
    if (s.includes('from visual_episode_learning')) {
      return [{ n: String(state.learning.length) }]; // nextAttempt count
    }
    if (s.startsWith('insert into visual_episode_events')) {
      state.events.push({ eventType: s.match(/'(winner_applied|reflection_started|reflection_failed|lesson_created|insufficient_evidence)'/)?.[1], payload: JSON.parse(params[2]) });
      return [];
    }
    if (s.startsWith('insert into visual_episode_learning')) {
      state.learning.push({ status: params[3], inputSnapshot: params[4], outputSnapshot: params[5] });
      return [{ learning_id: `learn-${state.learning.length}` }];
    }
    if (s.startsWith('insert into visual_lessons')) {
      state.lessons.push({ lessonId: `lesson-${state.lessons.length + 1}`, statement: params[3] });
      return [{ lesson_id: `lesson-${state.lessons.length}` }];
    }
    if (s.startsWith('update visual_episodes set reflection_status')) {
      return [];
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

function seedSubjectEntity(db, { entityId, characterId = SUBJECT_CHAR, lastImageUrl = null, slots = {} }) {
  const row = {
    entity_id: entityId,
    user_id: USER,
    layer_id: 'subject',
    character_id: characterId,
    name: 'Subject',
    slots,
    template: null,
    last_image_url: lastImageUrl,
    current_best_candidate_id: null,
    created_at: now(),
    updated_at: now(),
  };
  db.state.entities.push(row);
  return row;
}

// --- Fake LLM gates for the create-entity bootstrap sequence (Part B, reworked 2026-08-17):
// describeStudioSubject then describeStudioSlots, both routed through the SAME llm dependency —
// the routing gate tells them apart by their prompts' distinct [SYSTEM: TASK — ...] markers, so
// tests can assert on call count/order/content for the real two-call pipeline rather than a single
// canned reply. The throwing gate simulates a crash on every call — both describers catch their
// own errors internally (fail-open, §11), so a throw here never propagates to the caller; it just
// exercises the empty-result path. gate.calls.length is the positive, non-throw-dependent way to
// assert "this call never happened."
function makeRoutingGate({ describerReply = '', bootstrapReply = '' } = {}) {
  const gate = {
    calls: [],
    name: 'fake-routing-gate',
    async complete(messages) {
      gate.calls.push(messages);
      const content = messages[0]?.content ?? '';
      const reply = content.includes('SUBJECT VISUAL ARCHIVIST') ? describerReply : bootstrapReply;
      return { message: { role: 'assistant', content: reply }, toolCalls: [] };
    },
  };
  return gate;
}

function makeThrowingGate() {
  const gate = {
    calls: [],
    name: 'fake-throwing-gate',
    async complete(messages) {
      gate.calls.push(messages);
      throw new Error('simulated describer crash');
    },
  };
  return gate;
}

// ============================================================================
// create-entity bootstrap (Part B, reworked 2026-08-17 — migration 0114 dropped
// standing_instructions)
// ============================================================================

// --- Subject create with a seed and no explicit slots: describeStudioSubject fires first
// (expands the seed into a blurb), then describeStudioSlots fires with that blurb as context —
// neither the seed nor the blurb is persisted, only the resulting structured slots are. ---
{
  const db = makeDb();
  const gate = makeRoutingGate({
    describerReply: 'Appearance: Tall and stooped, with calloused hands and a beard shot through with grey.',
    bootstrapReply: 'body: Tall and stooped\nhands: calloused\nbeard: shot through with grey',
  });
  const res = fakeRes();
  await handlePortraitEntities(
    jsonReq({ layerId: 'subject', name: 'Talfryn', seed: 'an Italian woman in her 30s' }),
    res,
    { db, settings: makeSettings(), llm: gate },
    USER,
    new URL('http://x/v1/portraits/entities'),
  );

  assert(res.responses[0].status === 201, 'create-entity: a subject create → 201');
  assert(gate.calls.length === 2, 'create-entity: the subject bootstrap fires two calls — describer then slot bootstrapper');
  assert(
    gate.calls[0][0].content.includes('an Italian woman in her 30s') && gate.calls[0][0].content.includes('Talfryn'),
    'create-entity: the describer prompt interpolates both {{name}} and {{seed}}',
  );
  assert(
    gate.calls[1][0].content.includes('Tall and stooped, with calloused hands and a beard shot through with grey.'),
    'create-entity: the slot bootstrapper\'s context is the describer\'s blurb, not the raw seed',
  );
  const created = db.state.entities.find((e) => e.name === 'Talfryn');
  assert(
    created.slots.body === 'Tall and stooped' && created.slots.hands === 'calloused' && created.slots.beard === 'shot through with grey',
    'create-entity: the bootstrapper\'s structured slots land on the entity',
  );
  assert(created.standing_instructions === undefined, 'create-entity: no standing_instructions field exists on the row at all');
  assert(res.responses[0].body.entity_id === created.entity_id, 'create-entity: the response returns the created entity');
}

// --- A subject created WITH explicit slots never invokes either describer (§3 — explicit
// outranks inferred), seed or no seed. ---
{
  const db = makeDb();
  const gate = makeRoutingGate();
  const res = fakeRes();
  await handlePortraitEntities(
    jsonReq({ layerId: 'subject', name: 'Mair', slots: { look: 'A sharp-eyed harbormaster.' }, seed: 'ignored seed' }),
    res,
    { db, settings: makeSettings(), llm: gate },
    USER,
    new URL('http://x/v1/portraits/entities'),
  );

  assert(res.responses[0].status === 201, 'create-entity: a subject create with explicit slots → 201');
  assert(gate.calls.length === 0, 'create-entity: explicit slots skip both the describer and the slot bootstrapper entirely');
  const created = db.state.entities.find((e) => e.name === 'Mair');
  assert(
    created.slots.look === 'A sharp-eyed harbormaster.' && Object.keys(created.slots).length === 1,
    'create-entity: explicit slots are kept exactly as supplied when present',
  );
}

// --- A describer/bootstrapper LLM failure still creates the entity with empty slots
// (fail-open §11) — both calls fire (and both fail-open internally), but neither crashes. ---
{
  const db = makeDb();
  const gate = makeThrowingGate();
  const res = fakeRes();
  await handlePortraitEntities(
    jsonReq({ layerId: 'subject', name: 'Ghost', seed: 'a faceless wanderer' }),
    res,
    { db, settings: makeSettings(), llm: gate },
    USER,
    new URL('http://x/v1/portraits/entities'),
  );

  assert(res.responses[0].status === 201, 'create-entity: a describer crash still creates the entity → 201 (fail-open)');
  assert(gate.calls.length === 2, 'create-entity: both calls fire despite failing — the crash never short-circuits the bootstrap sequence');
  const created = db.state.entities.find((e) => e.name === 'Ghost');
  assert(Object.keys(created.slots).length === 0, 'create-entity: a describer/bootstrapper crash leaves slots empty');
}

// --- A stray characterId in the body is accepted-and-ignored: never written (standalone). ---
{
  const db = makeDb();
  const gate = makeRoutingGate();
  const res = fakeRes();
  await handlePortraitEntities(
    jsonReq({ layerId: 'subject', name: 'Rin', characterId: 'legacy-linked-char', slots: { look: 'hand-typed slots' } }),
    res,
    { db, settings: makeSettings(), llm: gate },
    USER,
    new URL('http://x/v1/portraits/entities'),
  );

  assert(res.responses[0].status === 201, 'create-entity: a characterId in the body is accepted, not an error');
  const created = db.state.entities.find((e) => e.name === 'Rin');
  assert(created.character_id === null, 'create-entity: a body characterId is never written — character_id stays null');
}

// --- A seed on a non-subject layer skips describeStudioSubject entirely and feeds
// describeStudioSlots directly (no expansion pass fits a style/outfit/expression layer). ---
{
  const db = makeDb();
  const gate = makeRoutingGate({ bootstrapReply: 'style_style: VLZ hybrid, moody rim light' });
  const res = fakeRes();
  await handlePortraitEntities(
    jsonReq({ layerId: 'style', name: 'VLZ hybrid', seed: 'a moody rim-lit hybrid look' }),
    res,
    { db, settings: makeSettings(), llm: gate },
    USER,
    new URL('http://x/v1/portraits/entities'),
  );

  assert(res.responses[0].status === 201, 'create-entity: a seed on a style layer is accepted, not an error');
  assert(gate.calls.length === 1, 'create-entity: a non-subject layer only fires the slot bootstrapper, never describeStudioSubject');
  assert(
    gate.calls[0][0].content.includes('a moody rim-lit hybrid look'),
    'create-entity: the style layer\'s seed reaches the slot bootstrapper directly, unexpanded',
  );
  const created = db.state.entities.find((e) => e.name === 'VLZ hybrid');
  assert(created.slots.style_style === 'VLZ hybrid, moody rim light', 'create-entity: the style layer gets bootstrapped slots from its seed');
}

// ============================================================================
// from-cast-character (Part C)
// ============================================================================

// --- Creates a subject entity from a character's appearance — appearance preferred over
// persona when both are present (character-appearance-field-plan.md). Always unlinked, slots
// bootstrapped through the same describer → slot-bootstrapper sequence create-entity uses
// (2026-08-17 — no more standing_instructions fallback, so this route must bootstrap up front). ---
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
  const gate = makeRoutingGate({ describerReply: 'Appearance: a tall, stooped figure.', bootstrapReply: 'body: tall and stooped' });
  const res = fakeRes();
  await handlePortraitEntityFromCastCharacter(jsonReq({ characterId: 'char-new' }), res, { db, settings: makeSettings(), llm: gate }, USER);

  assert(res.responses[0].status === 200, 'from-cast-character: a known character returns 200');
  assert(res.responses[0].body.entity?.entity_id, 'from-cast-character: the response carries { entity } — no action field');
  assert(res.responses[0].body.action === undefined, 'from-cast-character: the action field is dropped');
  assert(gate.calls.length === 2, 'from-cast-character: the same describer → slot-bootstrapper sequence as create-entity fires');
  assert(
    gate.calls[0][0].content.includes('Tall and stooped, with calloused hands and a beard shot through with grey.'),
    'from-cast-character: the describer is seeded from the APPEARANCE when present, not the persona',
  );
  const created = db.state.entities.find((e) => e.name === 'Talfryn');
  assert(created.layer_id === 'subject' && created.character_id === null, 'from-cast-character: the new entity is a subject layer, always unlinked');
  assert(created.slots.body === 'tall and stooped', 'from-cast-character: the bootstrapper\'s structured slots land on the entity');
  assert(res.responses[0].body.entity.entity_id === created.entity_id, 'from-cast-character: the response returns the created entity');
}

// --- A character with a persona but no appearance still seeds — the fallback to persona. ---
{
  const db = makeDb();
  db.state.characters.push({ character_id: 'char-fallback', user_id: USER, name: 'Mair', persona: 'A sharp-eyed harbormaster.', appearance: '', avatar_path: null });
  const gate = makeRoutingGate({ describerReply: 'Appearance: a weathered harbormaster.', bootstrapReply: 'look: weathered harbormaster' });
  const res = fakeRes();
  await handlePortraitEntityFromCastCharacter(jsonReq({ characterId: 'char-fallback' }), res, { db, settings: makeSettings(), llm: gate }, USER);
  assert(
    gate.calls[0][0].content.includes('A sharp-eyed harbormaster.'),
    'from-cast-character: a blank appearance falls back to the persona for the describer seed',
  );
  const created = db.state.entities.find((e) => e.name === 'Mair');
  assert(created?.slots.look === 'weathered harbormaster' && created.character_id === null, 'from-cast-character: the fallback-seeded entity still gets bootstrapped slots (still unlinked)');
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
  seedSubjectEntity(db, { entityId: 'e-legacy', characterId: 'char-twice', slots: { look: 'legacy linked slots' } });

  const gate = makeRoutingGate({ describerReply: 'Appearance: an old salt.', bootstrapReply: 'look: old salt' });
  const first = fakeRes();
  await handlePortraitEntityFromCastCharacter(jsonReq({ characterId: 'char-twice' }), first, { db, settings: makeSettings(), llm: gate }, USER);
  const second = fakeRes();
  await handlePortraitEntityFromCastCharacter(jsonReq({ characterId: 'char-twice' }), second, { db, settings: makeSettings(), llm: gate }, USER);

  const ids = db.state.entities.filter((e) => e.name === 'Mair');
  assert(ids.length === 2 && ids[0].entity_id !== ids[1].entity_id, 'from-cast-character: two clicks → two DISTINCT entity_ids');
  assert(ids.every((e) => e.character_id === null), 'from-cast-character: both new entities are unlinked (character_id null)');
  assert(
    ids.every((e) => e.slots.look === 'old salt'),
    'from-cast-character: both entities are bootstrapped from the same appearance',
  );
  const legacy = db.state.entities.find((e) => e.entity_id === 'e-legacy');
  assert(
    legacy.character_id === 'char-twice' && legacy.slots.look === 'legacy linked slots',
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
    { entity_id: 'e-sub', user_id: USER, layer_id: 'subject', character_id: characterId, name: 'Rin', slots: {}, template: null, last_image_url: null, current_best_candidate_id: null, created_at: now(), updated_at: now() },
    { entity_id: 'e-out', user_id: USER, layer_id: 'outfit', character_id: null, name: 'Coat', slots: {}, template: null, last_image_url: null, current_best_candidate_id: null, created_at: now(), updated_at: now() },
    { entity_id: 'e-style', user_id: USER, layer_id: 'style', character_id: null, name: 'Style', slots: {}, template: null, last_image_url: null, current_best_candidate_id: null, created_at: now(), updated_at: now() },
    { entity_id: 'e-expr', user_id: USER, layer_id: 'expression', character_id: null, name: 'Expr', slots: {}, template: null, last_image_url: null, current_best_candidate_id: null, created_at: now(), updated_at: now() },
    // An entity only the losing candidate referenced — must come through untouched.
    { entity_id: 'e-other-out', user_id: USER, layer_id: 'outfit', character_id: null, name: 'Old coat', slots: { outfit_style: 'old wool' }, template: null, last_image_url: 'https://img/old.png', current_best_candidate_id: 'c-old', created_at: now(), updated_at: now() },
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
        {
          id: 'less-1',
          name: 'submit_lesson',
          arguments: {
            status: 'conclusion',
            lesson: 'Keep coats above the knee for evening scenes.',
            evidence: 'The shorter red coat won with the calm expression and the human picked it.',
            next_change: { layer: 'outfit', instruction: 'End the coat above the knee.' },
            preserve: ['expression'],
            confidence: 'medium',
          },
        },
      ],
    };
  },
};

const feedbackInput = {
  entityIds: { subject: 'e-sub', outfit: 'e-out', style: 'e-style', expression: 'e-expr' },
  goal: 'A calmer evening variant of Rin.',
  candidateIds: [WINNER, LOSER],
  winnerId: WINNER,
  rationale: 'The calm expression and shorter coat read best for evening.',
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
  assert(res.responses[0].body.reflection?.action === 'concluded', 'feedback: the reflection pass concludes with a lesson');
  assert(res.responses[0].body.reflection?.lessonId === 'lesson-1', 'feedback: the concluded lesson id is returned');
  assert(db.state.lessons.length === 1 && db.state.lessons[0].statement.includes('above the knee'), 'feedback: a provisional visual_lessons row is created');
  assert(db.state.learning.length === 1 && db.state.learning[0].status === 'concluded', 'feedback: the immutable attempt row is persisted before the state change');
  assert(db.state.events.some((e) => e.eventType === 'winner_applied'), 'feedback: winner promotion is recorded as its own winner_applied event');
  assert(db.state.events.some((e) => e.eventType === 'lesson_created'), 'feedback: a lesson_created event is recorded');
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