// Proves the persistent location background identity (migration 0129, docs/plans/
// location-image-combinations.md) against a fake Postgres pool -- no server, no network, no LLM
// (the pollinations adapter needs no fetch, so it exercises a real, un-mocked provider dispatch).
// The suite exercises:
//   - normalizeLocationTimeOfDay (pure): trim/lowercase, no semantic bucketing;
//   - the migration's structural guarantees (partial unique indexes, the setting registration);
//   - the chat-background settings bundle's todVariantsEnabled read/patch;
//   - generateLocationImage's full combination-cache matrix (the plan's "Required cases"):
//     base cache, TOD cache, date-ignored, prompt/provider-changes-ignored, a new location after a
//     provider change, swipe cycle-back (resolveChatLocationImage), broken-URL recovery
//     (handleLocationImageBroken), and the in-flight guard under concurrency.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPostgresClient } from '../dist/io/postgres.js';
import { generateLocationImage, normalizeLocationTimeOfDay } from '../dist/orchestrator/generateLocationImage.js';
import { resolveChatLocationImage, handleLocationImageBroken } from '../dist/server/locationImages.js';
import { getChatBackgroundSettings, parseSetChatBackgroundSettingsBody } from '../dist/server/admin/displaySettings.js';

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else console.log(`ok: ${message}`);
}

assert(normalizeLocationTimeOfDay(' Morning ') === 'morning', 'time of day is trimmed and lowercased');
assert(normalizeLocationTimeOfDay('late evening') === 'late evening', 'time of day is not semantically bucketed');
assert(normalizeLocationTimeOfDay('   ') === null, 'empty time of day becomes the base combination');

const migration = await readFile(new URL('../../db/migrations/0129_location_image_combinations.sql', import.meta.url), 'utf8');
assert(migration.includes('location_image_combinations_base_uq'), 'base combinations have a partial unique index');
assert(migration.includes('location_image_combinations_tod_uq'), 'time-of-day combinations have a partial unique index');
assert(migration.includes("'background_tod_variants_enabled'"), 'the migration registers the setting');
assert(migration.includes('on delete set null'), 'swipe history survives combination deletion');

const unsetStore = { get: async () => undefined, set: async () => {} };
const defaults = await getChatBackgroundSettings(unsetStore);
assert(defaults.todVariantsEnabled === false, 'time-of-day variants default off');
assert(parseSetChatBackgroundSettingsBody({ todVariantsEnabled: true })?.todVariantsEnabled === true, 'the setting accepts a boolean patch');
assert(parseSetChatBackgroundSettingsBody({ todVariantsEnabled: 'true' }) === undefined, 'the setting rejects a string patch');

// ---------------------------------------------------------------------------------------------
// Fake pool: locations, location_image_combinations, location_chat_links, location_swipe_images,
// scenes, chat_sessions, chat_messages -- exactly the tables generateLocationImage.ts and
// locationImages.ts touch. Correction (docs/plans/location-image-combinations.md's fake-pool-
// drift note): every query shape below is matched narrowly enough to fail loudly (throw) on an
// unrecognized query rather than silently no-op or hang.
function createFakePool() {
  const locations = []; // { location_id, user_id, name, definition, environment, seed, status, updated_at }
  const locationImageCombinations = []; // { combination_id, location_id, time_of_day_key, image_url, image_generated_at, rendered_prompt, provider_kind, provider_model, seed }
  const locationChatLinks = []; // { location_id, chat_id, anchor_swipe_id }
  const locationSwipeImages = []; // { chat_id, swipe_id, location_id, combination_id, image_url, image_generated_at }
  const scenes = []; // { scene_id, user_id, chat_id, active_location_id }
  const chatMessages = []; // { chat_id, active_swipe_id }
  const chatSessions = new Map(); // chat_id -> { scene_id, previous_scene_id }
  let clock = 1000;
  const now = () => new Date((clock += 1000)).toISOString();

  const normTod = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);
  const eligible = (l, chatId) =>
    l.status == null ||
    (l.status !== 'inactive' && locationChatLinks.some((k) => k.location_id === l.location_id && k.chat_id === chatId)) ||
    locationSwipeImages.some(
      (a) =>
        a.chat_id === chatId &&
        a.location_id === l.location_id &&
        chatMessages.some((m) => m.chat_id === chatId && m.active_swipe_id === a.swipe_id),
    );
  const findCombo = (locationId, todKey) => locationImageCombinations.find((c) => c.location_id === locationId && c.time_of_day_key === (todKey ?? null));

  return {
    locations,
    locationImageCombinations,
    locationChatLinks,
    locationSwipeImages,
    scenes,
    chatMessages,
    chatSessions,
    now,
    async connect() {
      let scopedUserId;
      return {
        release() {},
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          // --- generateLocationImage.ts ---
          if (sql.includes('visual_description, environment, seed')) {
            const [locationId, userId, chatId] = params;
            const row = locations.find((l) => l.location_id === locationId && l.user_id === userId && eligible(l, chatId));
            const link = row ? locationChatLinks.find((k) => k.location_id === row.location_id && k.chat_id === chatId) : null;
            return {
              rows: row
                ? [{ location_id: row.location_id, visual_description: row.name, environment: row.environment, seed: row.seed ?? null, anchor_swipe_id: link?.anchor_swipe_id ?? null }]
                : [],
            };
          }
          if (sql.startsWith('select location_id from locations where location_id')) {
            const [locationId, userId, chatId] = params;
            const row = locations.find((l) => l.location_id === locationId && l.user_id === userId && eligible(l, chatId));
            return { rows: row ? [{ location_id: row.location_id }] : [] };
          }
          if (sql.trim().startsWith('select combination_id, image_url from location_image_combinations')) {
            const [locationId, todKey] = params;
            const c = findCombo(locationId, todKey);
            return { rows: c ? [{ combination_id: c.combination_id, image_url: c.image_url }] : [] };
          }
          if (sql.startsWith('insert into location_image_combinations') && sql.includes('values')) {
            const [locationId, todKey, imageUrl, renderedPrompt, providerKind, providerModel, seed] = params;
            if (findCombo(locationId, todKey)) return { rows: [] }; // on conflict do nothing (race-loser path)
            const row = {
              combination_id: randomUUID(),
              location_id: locationId,
              time_of_day_key: todKey ?? null,
              image_url: imageUrl,
              image_generated_at: now(),
              rendered_prompt: renderedPrompt,
              provider_kind: providerKind,
              provider_model: providerModel ?? null,
              seed: seed ?? null,
            };
            locationImageCombinations.push(row);
            return { rows: [{ combination_id: row.combination_id, image_url: row.image_url }] };
          }
          if (sql.startsWith('insert into location_swipe_images')) {
            const [chatId, swipeId, locationId, combinationId, imageUrl] = params;
            const existing = locationSwipeImages.find((s) => s.chat_id === chatId && s.swipe_id === swipeId);
            const patch = { chat_id: chatId, swipe_id: swipeId, location_id: locationId, combination_id: combinationId, image_url: imageUrl, image_generated_at: now() };
            if (existing) Object.assign(existing, patch);
            else locationSwipeImages.push(patch);
            return { rows: [] };
          }

          // --- locationImages.ts: resolveChatLocationImage ---
          if (sql.includes('from chat_sessions where chat_id')) {
            const row = chatSessions.get(params[0]);
            return { rows: row ? [{ scene_id: row.scene_id ?? null, previous_scene_id: row.previous_scene_id ?? null }] : [] };
          }
          if (sql.includes('from scenes s') && sql.includes('(select c.image_url from location_image_combinations c')) {
            // current-scene path (the scene_id cache pointer)
            const [userId, sceneId, chatId, todFlag] = params;
            const scene = scenes.find((s) => s.scene_id === sceneId);
            const loc = scene ? locations.find((l) => l.location_id === scene.active_location_id && l.user_id === userId) : null;
            if (!loc || !eligible(loc, chatId)) return { rows: [] };
            const todKey = todFlag === 'true' ? normTod(loc.environment?.time_of_day) : null;
            const c = findCombo(loc.location_id, todKey);
            return { rows: [{ location_id: loc.location_id, name: loc.name, definition: loc.definition ?? null, image_url: c?.image_url ?? null }] };
          }
          if (sql.includes('from scenes s') && sql.includes('swi0')) {
            // previous-scene path
            const [userId, sceneId, chatId, todFlag] = params;
            const scene = scenes.find((s) => s.scene_id === sceneId);
            const loc = scene ? locations.find((l) => l.location_id === scene.active_location_id && l.user_id === userId) : null;
            if (!loc) return { rows: [] };
            const swiTop = locationSwipeImages
              .filter((s) => s.location_id === loc.location_id && s.chat_id === chatId)
              .sort((a, b) => String(b.image_generated_at ?? '').localeCompare(String(a.image_generated_at ?? '')))[0];
            const swiUrl = swiTop ? (locationImageCombinations.find((c) => c.combination_id === swiTop.combination_id)?.image_url ?? swiTop.image_url ?? null) : null;
            const todKey = todFlag === 'true' ? normTod(loc.environment?.time_of_day) : null;
            const cUrl = findCombo(loc.location_id, todKey)?.image_url ?? null;
            const imageUrl = swiUrl ?? cUrl;
            if (imageUrl == null) return { rows: [] };
            return { rows: [{ location_id: loc.location_id, name: loc.name, definition: loc.definition ?? null, image_url: imageUrl }] };
          }
          if (sql.includes('from locations l') && sql.includes('location_swipe_images a')) {
            // active-swipe fallback path
            const [userId, chatId, todFlag] = params;
            const candidates = locations.filter((l) => l.user_id === userId && eligible(l, chatId));
            const resolved = candidates.map((l) => {
              const aTop = locationSwipeImages
                .filter((a) => a.location_id === l.location_id && a.chat_id === chatId && chatMessages.some((m) => m.chat_id === chatId && m.active_swipe_id === a.swipe_id))
                .sort((a, b) => String(b.image_generated_at ?? '').localeCompare(String(a.image_generated_at ?? '')))[0];
              const aicUrl = aTop ? (locationImageCombinations.find((c) => c.combination_id === aTop.combination_id)?.image_url ?? null) : null;
              const todKey = todFlag === 'true' ? normTod(l.environment?.time_of_day) : null;
              const cUrl = findCombo(l.location_id, todKey)?.image_url ?? null;
              return { l, imageUrl: aicUrl ?? cUrl };
            });
            resolved.sort((a, b) => {
              const at = a.l.status === 'transient' ? 1 : 0;
              const bt = b.l.status === 'transient' ? 1 : 0;
              if (at !== bt) return bt - at;
              return String(b.l.updated_at ?? '').localeCompare(String(a.l.updated_at ?? ''));
            });
            const top = resolved[0];
            return { rows: top ? [{ location_id: top.l.location_id, name: top.l.name, definition: top.l.definition ?? null, image_url: top.imageUrl }] : [] };
          }

          // --- locationImages.ts: handleLocationImageBroken ---
          if (sql.startsWith('delete from location_image_combinations')) {
            const [locationId, imageUrl] = params;
            for (let i = locationImageCombinations.length - 1; i >= 0; i--) {
              const c = locationImageCombinations[i];
              if (c.location_id === locationId && (imageUrl === undefined || c.image_url === imageUrl)) locationImageCombinations.splice(i, 1);
            }
            return { rows: [] };
          }
          if (sql.startsWith('update locations set image_url = null')) {
            return { rows: [] }; // legacy column, no longer read by any query above
          }

          throw new Error(`verify-location-image-combinations: unexpected query: ${sql.slice(0, 140)}`);
        },
      };
    },
  };
}

function fakeSettings(initial = {}) {
  const values = { ...initial };
  return { get: async (k) => values[k], set: async (k, v) => void (values[k] = v), values };
}

function fakeImageConnections(profile) {
  return { current: profile, resolveCalls: [], async resolveActive(purpose) { this.resolveCalls.push(purpose); return this.current; } };
}

function fakeImageConnectionsGated(profile) {
  const resolves = [];
  let resolveFn;
  const gate = new Promise((r) => (resolveFn = r));
  return {
    resolveCalls: resolves,
    resolve: resolveFn,
    async resolveActive(purpose) {
      resolves.push(purpose);
      await gate;
      return profile;
    },
  };
}

function response() {
  return {
    statusCode: undefined,
    body: undefined,
    writeHead(status) { this.statusCode = status; },
    end(payload) { this.body = payload ? JSON.parse(payload) : undefined; },
  };
}

function profile(overrides = {}) {
  return {
    kind: 'pollinations',
    apiKey: 'tok-a',
    model: 'flux',
    masterPositiveStylePrefix: '',
    masterNegativePrompt: '',
    width: 768,
    height: 1024,
    samplingSteps: 20,
    cfgScale: 5,
    samplerName: 'euler',
    baseUrl: '',
    workflowParameters: null,
    ...overrides,
  };
}

const USER = 'u-combo';

function seedLocation(pool, overrides = {}) {
  const row = { location_id: randomUUID(), user_id: USER, name: 'A Room', definition: null, environment: {}, seed: null, status: null, updated_at: new Date().toISOString(), ...overrides };
  pool.locations.push(row);
  return row;
}

// --- Base cache: TOD disabled -- a second visit after the room's environment drifts is still a
// cache hit, one provider generation total. -----------------------------------------------------
{
  const pool = createFakePool();
  const kitchen = seedLocation(pool, { name: 'Kitchen', environment: { time_of_day: 'morning' } });
  const deps = { db: createPostgresClient(pool), settings: fakeSettings({ background_tod_variants_enabled: 'false' }), imageConnections: fakeImageConnections(profile()) };

  const first = await generateLocationImage(deps, USER, kitchen.location_id, undefined);
  assert(first.ok === true && first.cached !== true, 'base cache: the first visit renders fresh');
  assert(pool.locationImageCombinations.length === 1, 'base cache: exactly one combination exists after the first render');

  kitchen.environment = { time_of_day: 'evening' }; // the scraper's environment refresh, TOD off ignores it
  const second = await generateLocationImage(deps, USER, kitchen.location_id, undefined);
  assert(second.ok === true && second.cached === true && second.imageUrl === first.imageUrl, 'base cache: a later visit with a changed environment is still a cache hit (TOD off -> always the base combination)');
  assert(pool.locationImageCombinations.length === 1, 'base cache: still exactly one combination -- one provider generation total');
}

// --- TOD cache: TOD enabled -- morning, evening, morning again -> two combinations, two
// generations, the third resolution reuses the morning URL. --------------------------------------
{
  const pool = createFakePool();
  const kitchen = seedLocation(pool, { name: 'Kitchen', environment: { time_of_day: 'morning' } });
  // A template that actually embeds {{time_of_day}} -- the default template doesn't, so without
  // this the two variants would render byte-identical prompts (and thus URLs) despite being
  // stored as genuinely distinct combination rows.
  const deps = { db: createPostgresClient(pool), settings: fakeSettings({ background_tod_variants_enabled: 'true', image_prompt_template: '{{visual_description}} at {{time_of_day}}' }), imageConnections: fakeImageConnections(profile()) };

  const morning1 = await generateLocationImage(deps, USER, kitchen.location_id, undefined);
  assert(morning1.ok === true && morning1.cached !== true, 'TOD cache: morning renders fresh');

  kitchen.environment = { time_of_day: 'evening' };
  const evening = await generateLocationImage(deps, USER, kitchen.location_id, undefined);
  assert(evening.ok === true && evening.cached !== true && evening.imageUrl !== morning1.imageUrl, 'TOD cache: evening is a distinct combination, also rendered fresh');
  assert(pool.locationImageCombinations.length === 2, 'TOD cache: two combinations exist (morning + evening)');

  kitchen.environment = { time_of_day: 'morning' };
  const morning2 = await generateLocationImage(deps, USER, kitchen.location_id, undefined);
  assert(morning2.ok === true && morning2.cached === true && morning2.imageUrl === morning1.imageUrl, 'TOD cache: returning to morning reuses the original morning URL, no new render');
  assert(pool.locationImageCombinations.length === 2, 'TOD cache: still exactly two combinations after the third resolution');
}

// --- Date ignored: TOD enabled -- Monday morning, Tuesday morning -> same combination. ------------
{
  const pool = createFakePool();
  const kitchen = seedLocation(pool, { name: 'Kitchen', environment: { time_of_day: 'morning', date: 'Monday, June 15, 2026' } });
  const deps = { db: createPostgresClient(pool), settings: fakeSettings({ background_tod_variants_enabled: 'true' }), imageConnections: fakeImageConnections(profile()) };

  const monday = await generateLocationImage(deps, USER, kitchen.location_id, undefined);
  assert(monday.ok === true && monday.cached !== true, 'date ignored: Monday morning renders fresh');

  kitchen.environment = { time_of_day: 'morning', date: 'Tuesday, June 16, 2026' };
  const tuesday = await generateLocationImage(deps, USER, kitchen.location_id, undefined);
  assert(tuesday.ok === true && tuesday.cached === true && tuesday.imageUrl === monday.imageUrl, 'date ignored: Tuesday morning is a cache hit on the SAME "morning" combination -- the date never enters the identity');
  assert(pool.locationImageCombinations.length === 1, 'date ignored: exactly one combination across both days');
}

// --- Prompt/provider changes ignored for an existing combination: the test that actually proves
// prompt hashing is gone. -------------------------------------------------------------------------
{
  const pool = createFakePool();
  const kitchen = seedLocation(pool, { name: 'Kitchen', environment: {} });
  const settings = fakeSettings({ background_tod_variants_enabled: 'false', image_prompt_template: 'template A {{visual_description}}' });
  const images = fakeImageConnections(profile({ apiKey: 'tok-a', model: 'flux' }));
  const deps = { db: createPostgresClient(pool), settings, imageConnections: images };

  const base = await generateLocationImage(deps, USER, kitchen.location_id, undefined);
  assert(base.ok === true && base.cached !== true, 'prompt ignored: the base combination renders fresh once');

  // Change everything the OLD hash-based cache used to key on.
  await settings.set('image_prompt_template', 'a totally different template {{visual_description}} {{style_prefix}}');
  images.current = profile({ apiKey: 'tok-b', model: 'flux-2', masterPositiveStylePrefix: 'oil painting' });

  const after = await generateLocationImage(deps, USER, kitchen.location_id, undefined);
  assert(after.ok === true && after.cached === true && after.imageUrl === base.imageUrl, 'prompt ignored: the existing combination is reused verbatim after the template/style/model all changed');
  assert(pool.locationImageCombinations.length === 1, 'prompt ignored: zero new provider calls -- still exactly one combination');
}

// --- New location after a provider change: kitchen keeps its old URL, bedroom renders under the
// new provider configuration. -----------------------------------------------------------------
{
  const pool = createFakePool();
  const kitchen = seedLocation(pool, { name: 'Kitchen', environment: {} });
  const bedroom = seedLocation(pool, { name: 'Bedroom', environment: {} });
  const images = fakeImageConnections(profile({ apiKey: 'tok-a' }));
  const deps = { db: createPostgresClient(pool), settings: fakeSettings({ background_tod_variants_enabled: 'false' }), imageConnections: images };

  const kitchenResult = await generateLocationImage(deps, USER, kitchen.location_id, undefined);
  assert(kitchenResult.ok === true && kitchenResult.imageUrl.includes('token=tok-a'), 'new location: kitchen renders under the original connection (token a)');

  images.current = profile({ apiKey: 'tok-b' }); // the provider configuration changes
  const bedroomResult = await generateLocationImage(deps, USER, bedroom.location_id, undefined);
  assert(bedroomResult.ok === true && bedroomResult.imageUrl.includes('token=tok-b'), 'new location: bedroom renders fresh under the NEW connection (token b)');

  const kitchenCombo = pool.locationImageCombinations.find((c) => c.location_id === kitchen.location_id);
  assert(kitchenCombo.image_url === kitchenResult.imageUrl && kitchenCombo.image_url.includes('token=tok-a'), "new location: kitchen's stored combination is untouched by the later provider change");
}

// --- Swipe cycle-back: generate swipe A's combination, generate swipe B's, reactivate swipe A ->
// the exact combination recorded for A is returned, with no further generation. -------------------
{
  const pool = createFakePool();
  const CHAT = 'chat-cycle';
  const swipeA = 'swipe-a';
  const swipeB = 'swipe-b';
  const kitchen = seedLocation(pool, { name: 'Kitchen', environment: { time_of_day: 'morning' }, status: 'transient' });
  pool.locationChatLinks.push({ location_id: kitchen.location_id, chat_id: CHAT, anchor_swipe_id: swipeA });
  pool.chatMessages.push({ chat_id: CHAT, active_swipe_id: swipeA });

  const settings = fakeSettings({ background_tod_variants_enabled: 'true', image_prompt_template: '{{visual_description}} at {{time_of_day}}' });
  const deps = { db: createPostgresClient(pool), settings, imageConnections: fakeImageConnections(profile()) };

  const resultA = await generateLocationImage(deps, USER, kitchen.location_id, CHAT);
  assert(resultA.ok === true && resultA.cached !== true, 'swipe cycle-back: swipe A renders morning fresh');

  // The turn moves on: the scraper re-anchors the link to swipe B and the room's TOD changes.
  pool.locationChatLinks.find((k) => k.location_id === kitchen.location_id).anchor_swipe_id = swipeB;
  pool.chatMessages[0].active_swipe_id = swipeB;
  kitchen.environment = { time_of_day: 'evening' };
  const resultB = await generateLocationImage(deps, USER, kitchen.location_id, CHAT);
  assert(resultB.ok === true && resultB.cached !== true && resultB.imageUrl !== resultA.imageUrl, 'swipe cycle-back: swipe B renders a distinct evening combination');
  assert(pool.locationImageCombinations.length === 2, 'swipe cycle-back: two combinations exist after both swipes render');

  // The user cycles back to swipe A. The room's live environment still says "evening" (it was
  // never reverted) -- resolveChatLocationImage must still surface swipe A's own recorded URL.
  pool.chatMessages[0].active_swipe_id = swipeA;
  const state = await resolveChatLocationImage(createPostgresClient(pool), USER, CHAT, settings);
  assert(state.current?.imageUrl === resultA.imageUrl, "swipe cycle-back: reactivating swipe A resolves the exact combination recorded for A, independent of the room's current (evening) environment");
  assert(pool.locationImageCombinations.length === 2, 'swipe cycle-back: no new generation from reading the association back');
}

// --- Broken URL: deleting/marking one combination broken re-renders only that combination; a
// sibling combination for the same location is untouched. ------------------------------------
{
  const pool = createFakePool();
  const kitchen = seedLocation(pool, { name: 'Kitchen', environment: { time_of_day: 'morning' } });
  const deps = { db: createPostgresClient(pool), settings: fakeSettings({ background_tod_variants_enabled: 'true', image_prompt_template: '{{visual_description}} at {{time_of_day}}' }), imageConnections: fakeImageConnections(profile()) };

  const morning = await generateLocationImage(deps, USER, kitchen.location_id, undefined);
  kitchen.environment = { time_of_day: 'evening' };
  const evening = await generateLocationImage(deps, USER, kitchen.location_id, undefined);
  assert(pool.locationImageCombinations.length === 2, 'broken URL: both combinations exist before the report');

  const res = response();
  const url = new URL(`http://x/v1/locations/${kitchen.location_id}/image-broken?imageUrl=${encodeURIComponent(morning.imageUrl)}`);
  await handleLocationImageBroken(undefined, res, { db: createPostgresClient(pool) }, USER, url);
  assert(res.statusCode === 200 && res.body?.cleared === true, 'broken URL: the report handler responds 200 cleared');
  assert(pool.locationImageCombinations.length === 1 && pool.locationImageCombinations[0].image_url === evening.imageUrl, 'broken URL: only the reported (morning) combination is removed -- evening is untouched');

  kitchen.environment = { time_of_day: 'morning' };
  const rerendered = await generateLocationImage(deps, USER, kitchen.location_id, undefined);
  assert(rerendered.ok === true && rerendered.cached !== true, 'broken URL: the next visit to the cleared combination re-renders (cache miss)');
  assert(pool.locationImageCombinations.length === 2, 'broken URL: back to two combinations -- the untouched evening one plus the fresh morning one');
  assert(pool.locationImageCombinations.some((c) => c.image_url === evening.imageUrl), 'broken URL: the evening combination survived the whole episode unchanged');
}

// --- Concurrency: two simultaneous requests for the same (location, TOD) -> one stored
// combination, one provider round-trip; the in-flight guard dedupes the second caller before it
// ever reaches provider resolution. ---------------------------------------------------------------
{
  const pool = createFakePool();
  const kitchen = seedLocation(pool, { name: 'Kitchen', environment: {} });
  const images = fakeImageConnectionsGated(profile());
  const deps = { db: createPostgresClient(pool), settings: fakeSettings({ background_tod_variants_enabled: 'false' }), imageConnections: images };

  const first = generateLocationImage(deps, USER, kitchen.location_id, undefined);
  await new Promise((r) => setImmediate(r));
  assert(images.resolveCalls.length === 1, 'concurrency: the first render reaches provider resolution');

  const second = generateLocationImage(deps, USER, kitchen.location_id, undefined);
  await new Promise((r) => setImmediate(r));
  assert(images.resolveCalls.length === 1, 'concurrency: the duplicate is deduped by the in-flight guard before a second provider resolution');

  images.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert(firstResult.ok === true && secondResult.ok === false && secondResult.error === 'render_in_flight', 'concurrency: the guarded caller reports render_in_flight rather than double-rendering');
  assert(pool.locationImageCombinations.length === 1, 'concurrency: exactly one stored combination after the guarded pair');
}

if (process.exitCode) {
  console.error('\nlocation image combinations verification FAILED');
  process.exit(1);
}
console.log('\nlocation image combinations verification passed');
