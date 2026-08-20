// Proves the Vistalyze image-generation plumbing (docs/vistalyze_integration/endpoint.md) against
// a fake Postgres pool + mocked fetch — no server, no real provider network. The suite exercises:
//   - io/imageConnections.ts's store CRUD against a fake pool: create with/without a key,
//     list (redacted — no apiKey ever), update, activate (single active enforced in the fake),
//     remove (refuses the active row), resolveActive returning the decrypted profile;
//   - the migration 0105 purpose split: create/update carry purpose (default 'background'),
//     resolveActive() defaults to 'background' (pre-split call sites unchanged), activate()
//     demotes only same-purpose rivals, and one active row per purpose coexists — the rebuilt
//     image_connections_one_active_per_purpose partial unique index;
//   - util/synthesizeImagePrompt.ts + io/imageGen dispatch are exercised indirectly through
//     generateLocationImage below (the pollinations adapter needs no fetch, so it works with no
//     network at all), and io/imageGen/runware.ts's wire shape is pinned directly against a
//     mocked fetch (Bearer header + array body + imageInference taskType + positivePrompt/
//     CFGScale/scheduler field names — the proven REST contract, not the legacy WS-era shape);
//   - orchestrator/generateLocationImage.ts (migration 0129): a base combination cache hit (no
//     provider call), an existing combination surviving a description/environment/provider drift
//     (proves prompt hashing is gone), a fresh render on a location with no combination at all,
//     no-active-connection fail-open, unknown-location fail-open, and the swipe -> combination
//     association write;
//   - endpoint.md §3.3's testImageConnection probe for the pollinations kind (URL constructed,
//     no fetch — but the key is required, see below).

import { randomBytes } from 'node:crypto';
import { createFieldCipher } from '../dist/io/fieldCipher.js';
import { createPostgresClient } from '../dist/io/postgres.js';
import { createImageConnectionStore } from '../dist/io/imageConnections.js';
import { generateLocationImage } from '../dist/orchestrator/generateLocationImage.js';
import { generateRunwareImage } from '../dist/io/imageGen/runware.js';
import { testImageConnection } from '../dist/server/adminServer.js';
import { createOrchestratorSettingsStore } from '../dist/io/orchestratorSettings.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const cipher = createFieldCipher({ BIGBRAIN_FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') });

// --- Fake pool covering image_connections + locations + orchestrator_settings. ---
function createFakePool() {
  const imageConnections = [];
  const locations = [];
  const locationImageCombinations = []; // {combination_id, location_id, time_of_day_key, image_url, image_generated_at, rendered_prompt, provider_kind, provider_model, seed} (migration 0129)
  const chatMessages = []; // {chat_id, active_swipe_id} — feeds the location_swipe_images association branch
  const locationChatLinks = []; // {location_id, chat_id, anchor_swipe_id} (migration 0096)
  const swipeImages = new Map(); // `${chatId}:${swipeId}` -> location_swipe_images row (0076, widened 0129)
  const settings = new Map();
  let connCounter = 0;
  let comboCounter = 0;
  let clock = 1000;
  const now = () => new Date((clock += 1000)).toISOString();

  return {
    imageConnections,
    locations,
    locationImageCombinations,
    chatMessages,
    locationChatLinks,
    swipeImages,
    settings,
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

          // --- imageConnections store queries ---
          if (sql.includes('select id, purpose from image_connections')) {
            const row = imageConnections.find((c) => c.id === params[0]);
            return { rows: row ? [{ id: row.id, purpose: row.purpose }] : [] };
          }
          if (sql.includes('from image_connections') && !sql.includes('select id, purpose from')) {
            const whereIsActive = sql.includes('where is_active');
            const whereId = sql.includes('where id = $1');
            const wherePurpose = sql.includes('purpose = $1');
            const rows = imageConnections
              .filter((c) => (whereIsActive ? c.is_active : true))
              .filter((c) => (whereId ? c.id === params[0] : true))
              .filter((c) => (wherePurpose ? c.purpose === params[0] : true))
              .sort((a, b) => a.name.localeCompare(b.name));
            // node-postgres returns `numeric` (cfg_scale) and `bigint` (locations.seed,
            // image_connections.seed) columns as STRINGS — mimic that at this boundary so the
            // store's Number() coercion is what's under test (the real-pg behavior that
            // stringified seed/CFGScale onto the runware wire).
            return {
              rows: rows.map((c) => ({
                ...c,
                cfg_scale: c.cfg_scale == null ? null : String(c.cfg_scale),
                seed: c.seed == null ? null : String(c.seed),
              })),
            };
          }
          if (sql.includes('select api_key_ciphertext from image_connections')) {
            const row = imageConnections.find((c) => c.id === params[0]);
            return { rows: row ? [{ api_key_ciphertext: row.api_key_ciphertext }] : [] };
          }
          if (sql.startsWith('insert into image_connections')) {
            const [name, kind, model, apiKeyCiphertext, baseUrl, width, height, samplingSteps, cfgScale, samplerName, prefix, negative, workflow, purpose, seed] = params;
            const row = {
              id: `img-conn-${++connCounter}`,
              name,
              kind,
              model,
              api_key_ciphertext: apiKeyCiphertext,
              base_url: baseUrl,
              width,
              height,
              sampling_steps: samplingSteps,
              cfg_scale: cfgScale,
              sampler_name: samplerName,
              master_positive_style_prefix: prefix,
              master_negative_prompt: negative,
              workflow_parameters: workflow ? JSON.parse(workflow) : null,
              is_active: false,
              updated_at: now(),
              purpose: purpose ?? 'background',
              seed: seed ?? null,
            };
            imageConnections.push(row);
            return { rows: [{ ...row }] };
          }
          if (sql.startsWith('update image_connections set is_active = false')) {
            // purpose-scoped demotion (migration 0105): only same-purpose rivals lose active.
            for (const c of imageConnections) if (c.is_active && c.id !== params[0] && c.purpose === params[1]) c.is_active = false;
            return { rows: [] };
          }
          if (sql.startsWith('update image_connections set is_active = true')) {
            const row = imageConnections.find((c) => c.id === params[0]);
            if (row) {
              row.is_active = true;
              row.updated_at = now();
              return { rows: [{ id: row.id }] };
            }
            return { rows: [] };
          }
          if (sql.includes('update image_connections set ') && !sql.includes('set is_active')) {
            // generic patch: last param is the id; sets are `col = $n` pairs (updated_at = now()
            // carries no placeholder and is skipped). Guarded on 'set is_active' not the bare
            // column name — the `returning` clause legitimately carries is_active.
            const id = params[params.length - 1];
            const row = imageConnections.find((c) => c.id === id);
            if (!row) return { rows: [] };
            const setClause = sql.slice(sql.indexOf('set ') + 4, sql.indexOf(' where '));
            const assignments = setClause.split(', ');
            for (const assignment of assignments) {
              const match = assignment.match(/^\s*(\w+)\s*=\s*\$(\d+)/);
              if (!match) continue; // e.g. updated_at = now()
              const column = match[1];
              const value = params[Number(match[2]) - 1];
              row[column] = value ?? null;
            }
            row.updated_at = now();
            return { rows: [{ ...row }] };
          }
          if (sql.startsWith('delete from image_connections')) {
            const idx = imageConnections.findIndex((c) => c.id === params[0]);
            if (idx >= 0) imageConnections.splice(idx, 1);
            return { rows: [] };
          }

          // --- orchestrator_settings store ---
          if (sql.includes('from orchestrator_settings')) {
            const value = settings.get(params[0]);
            return { rows: value !== undefined ? [{ value }] : [] };
          }
          if (sql.startsWith('insert into orchestrator_settings')) {
            settings.set(params[0], params[1]);
            return { rows: [] };
          }

          // --- locations queries (generateLocationImage) ---
          // Two distinct location_id selects: the initial eligibility+row load (several columns,
          // used once per call) and the pre-provider eligibility recheck (location_id alone,
          // migration 0129) — must be told apart or the recheck would wrongly resolve the full
          // row shape.
          if (sql.includes('from locations where location_id =') && sql.includes('visual_description, environment, seed')) {
            // db/migrations/0096 eligibility (BG_ELIGIBILITY_CLAUSE), modeled in JS: user-authored
            // (status null) is always eligible; an auto-registered row is eligible when linked to
            // the calling chat via location_chat_links and not inactive, OR when the chat's active
            // swipe has a recorded location_swipe_images association with this location (an
            // orphaned/re-anchored row still resolves for the swipe that actually used it).
            const chatId = params[2];
            const activeSwipeIds = chatMessages.filter((m) => m.chat_id === chatId && m.active_swipe_id).map((m) => m.active_swipe_id);
            const eligible = (l) =>
              l.status == null ||
              (l.status !== 'inactive' && locationChatLinks.some((link) => link.location_id === l.location_id && link.chat_id === chatId)) ||
              activeSwipeIds.some((swipeId) => swipeImages.get(`${chatId}:${swipeId}`)?.location_id === l.location_id);
            const row = locations.find((l) => l.location_id === params[0] && l.user_id === scopedUserId && eligible(l));
            const anchorLink = row ? locationChatLinks.find((link) => link.location_id === row.location_id && link.chat_id === chatId) : null;
            return {
              rows: row
                ? [
                    {
                      location_id: row.location_id,
                      visual_description: row.visual_description,
                      environment: row.environment,
                      // bigint-as-string, exactly like node-postgres hands locations.seed back
                      seed: row.seed == null ? null : String(row.seed),
                      // anchor_swipe_id now lives on location_chat_links, read via the same
                      // correlated-subquery shape the real query uses.
                      anchor_swipe_id: anchorLink?.anchor_swipe_id ?? null,
                      status: row.status ?? null,
                    },
                  ]
                : [],
            };
          }
          if (sql.startsWith('select location_id from locations where location_id =')) {
            // migration 0129's pre-provider eligibility recheck — same predicate, one column.
            const chatId = params[2];
            const activeSwipeIds = chatMessages.filter((m) => m.chat_id === chatId && m.active_swipe_id).map((m) => m.active_swipe_id);
            const eligible = (l) =>
              l.status == null ||
              (l.status !== 'inactive' && locationChatLinks.some((link) => link.location_id === l.location_id && link.chat_id === chatId)) ||
              activeSwipeIds.some((swipeId) => swipeImages.get(`${chatId}:${swipeId}`)?.location_id === l.location_id);
            const row = locations.find((l) => l.location_id === params[0] && l.user_id === scopedUserId && eligible(l));
            return { rows: row ? [{ location_id: row.location_id }] : [] };
          }

          // --- location_image_combinations queries (migration 0129) ---
          if (sql.includes('from location_image_combinations') && sql.includes('is not distinct from')) {
            const [locationId, todKey] = params;
            const row = locationImageCombinations.find((c) => c.location_id === locationId && c.time_of_day_key === (todKey ?? null));
            return { rows: row ? [{ combination_id: row.combination_id, image_url: row.image_url }] : [] };
          }
          if (sql.startsWith('insert into location_image_combinations')) {
            const [locationId, todKey, imageUrl, renderedPrompt, providerKind, providerModel, seed] = params;
            if (locationImageCombinations.some((c) => c.location_id === locationId && c.time_of_day_key === (todKey ?? null))) {
              return { rows: [] }; // on conflict do nothing — the race-loser path
            }
            const row = {
              combination_id: `combo-${++comboCounter}`,
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
            // migration 0076, widened by 0129: per-swipe association recorded on every successful
            // resolution (cache hit or fresh render), keyed by combination_id.
            const [chatId, swipeId, locationId, combinationId, imageUrl] = params;
            swipeImages.set(`${chatId}:${swipeId}`, { chat_id: chatId, swipe_id: swipeId, location_id: locationId, combination_id: combinationId, image_url: imageUrl, image_generated_at: now() });
            return { rows: [] };
          }

          throw new Error(`fake pool got an unexpected query: ${sql.slice(0, 120)}`);
        },
      };
    },
  };
}

const pool = createFakePool();
const db = createPostgresClient(pool);
const imageConnections = createImageConnectionStore(db, cipher);
const settings = createOrchestratorSettingsStore(db);
const USER = 'user-1';

// --- store CRUD: create with a key (encrypted write-only), create keyless, list redacted ---
// width/height are the connection's explicit output pixels; unset on create → the 1344×768
// default (a 16:9 landscape, matching VLZ's own background renders).
const withKey = await imageConnections.create({
  name: 'runware-prod',
  kind: 'runware',
  model: 'runware:100@1',
  apiKey: 'sk-runware-secret',
});
assert(withKey.hasApiKey === true && withKey.apiKey === undefined, 'create stores the key (hasApiKey true) and never returns it');
assert(
  pool.imageConnections.find((c) => c.id === withKey.id)?.api_key_ciphertext !== 'sk-runware-secret',
  'the stored api_key_ciphertext is encrypted, not the plaintext key',
);
assert(withKey.width === 1344 && withKey.height === 768, 'create without width/height falls back to the 1344×768 default');
assert(withKey.seed === null, 'create without a seed defaults to null (random) — migration 0123');

const keyless = await imageConnections.create({ name: 'local-comfyui', kind: 'comfyui', model: 'anything', baseUrl: 'http://127.0.0.1:8188' });
assert(keyless.hasApiKey === false, 'a keyless connection (a local comfyui endpoint) is created without a key');

const listed = await imageConnections.list();
assert(
  listed.length === 2 && listed.every((c) => c.apiKey === undefined) && listed.every((c) => c.hasApiKey === (c.name === 'runware-prod')),
  'list returns every connection, redacted (hasApiKey only, never the key)',
);

// --- activate: single active; resolveActive decrypts ---
await imageConnections.activate(withKey.id);
const active = await imageConnections.resolveActive();
assert(active?.kind === 'runware' && active.apiKey === 'sk-runware-secret', 'resolveActive returns the decrypted profile of the active connection');
assert(typeof active?.cfgScale === 'number' && active.cfgScale === 7, 'resolveActive coerces the numeric cfg_scale column back to a number (pg returns strings)');

const profileById = await imageConnections.resolveById(keyless.id);
assert(profileById?.apiKey === null, 'resolveById of a keyless connection yields apiKey null');

// --- purpose split (migration 0105): one active row per purpose; resolveActive() defaults to
// --- 'background' (so every pre-0105 call site resolves exactly the row it did before); an
// --- activation demotes only same-purpose rivals. -------------------------------------------------
const ptA = await imageConnections.create({ name: 'pt-prod', kind: 'runware', model: 'runware:100@1', apiKey: 'sk-pt', purpose: 'portrait' });
assert(ptA.purpose === 'portrait' && withKey.purpose === 'background', 'create honors an explicit purpose and defaults the column to background');

// withKey (background, key sk-runware-secret) is the active row; activating a portrait
// connection must leave it alone. The profile has no id — apiKey is its identity proxy.
await imageConnections.activate(ptA.id);
const bgActive = await imageConnections.resolveActive();
const ptActive = await imageConnections.resolveActive('portrait');
assert(bgActive?.apiKey === 'sk-runware-secret', 'activating a portrait connection leaves the active background row untouched');
assert(ptActive?.apiKey === 'sk-pt', "resolveActive('portrait') returns the decrypted portrait profile");
assert(
  pool.imageConnections.filter((c) => c.purpose === 'background' && c.is_active).length === 1
    && pool.imageConnections.filter((c) => c.purpose === 'portrait' && c.is_active).length === 1,
  'one active row per purpose coexists (the per-purpose partial unique index)',
);

// A second portrait activation demotes the first portrait row only — background stays put.
const ptB = await imageConnections.create({ name: 'pt-b', kind: 'fal-ai', model: 'fal-ai/flux/dev', apiKey: 'sk-pt-b', purpose: 'portrait' });
await imageConnections.activate(ptB.id);
assert((await imageConnections.resolveActive())?.apiKey === 'sk-runware-secret', 'the background active row survives a portrait-side switch');
assert((await imageConnections.resolveActive('portrait'))?.apiKey === 'sk-pt-b', 'a second portrait activation demotes the first portrait row (per-purpose single active)');
assert(
  pool.imageConnections.filter((c) => c.purpose === 'portrait' && c.is_active).length === 1,
  'exactly one active portrait row after the switch',
);

// --- seed (migration 0123): stored/round-tripped as a number despite the bigint-as-string
// boundary, null clears it back to random, and a patch omitting it leaves the value untouched. ---
const seeded = await imageConnections.create({ name: 'seeded-conn', kind: 'pollinations', model: 'flux', apiKey: 'sk-seed', seed: 424242 });
assert(seeded.seed === 424242 && typeof seeded.seed === 'number', 'create with a seed stores and returns it as a number (bigint-as-string coerced)');
const seededProfile = await imageConnections.resolveById(seeded.id);
assert(seededProfile?.seed === 424242, 'resolveById coerces the stored seed back to a number for the profile too');
const seedUntouched = await imageConnections.update(seeded.id, { name: 'seeded-conn-renamed' });
assert(seedUntouched?.seed === 424242, 'a patch omitting seed leaves the stored value untouched');
const seedCleared = await imageConnections.update(seeded.id, { seed: null });
assert(seedCleared?.seed === null, 'a patch with seed: null explicitly clears it back to random');

// update() can move a connection between purposes.
const moved = await imageConnections.update(ptB.id, { purpose: 'background' });
assert(moved?.purpose === 'background', 'update can move a connection between purposes');

// --- update: rotate key + change dimensions ---
const patched = await imageConnections.update(keyless.id, { width: 1024, height: 1024, masterNegativePrompt: 'blurry' });
assert(patched?.width === 1024 && patched.height === 1024 && patched.masterNegativePrompt === 'blurry', 'update applies the given field changes');

// --- remove: refuses the active row, deletes a non-active one ---
assert((await imageConnections.remove(withKey.id)) === 'is_active', 'remove refuses the active connection');
assert((await imageConnections.remove(keyless.id)) === 'ok', 'remove deletes a non-active connection');
assert((await imageConnections.remove('missing')) === 'not_found', 'remove of an unknown id reports not_found');

// --- io/imageGen/runware.ts: the wire shape must match the live REST contract ---
// Pins the proven request contract (Authorization: Bearer header, ARRAY body, taskType
// imageInference, positivePrompt/negativePrompt/CFGScale/scheduler field names) verified
// against the stack's own Canvalyze route (plugin/routes/runware.js) and the official SDK
// (Runware/runware-typescript, schema 2026-07-30). The legacy WebSocket-era shape (apiKey in
// body, 'imageGeneration', 'prompt', 'cfgScale') would 401 / validation-fail live — this is the
// regression guard for that half-migration.
{
  const realFetch = global.fetch;
  let captured;
  global.fetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ data: [{ taskUUID: JSON.parse(init.body)[0].taskUUID, imageURL: 'https://cdn.runware.ai/img/abc.jpg' }] }),
    };
  };
  try {
    const url = await generateRunwareImage({
      prompt: 'a harbor at dusk',
      negativePrompt: 'blurry',
      model: 'runware:z-image@turbo',
      apiKey: 'sk-rw-test',
      baseUrl: null,
      width: 1344,
      height: 768,
      seed: 42,
      steps: 8,
      cfgScale: 7,
      samplerName: 'Euler a',
      workflowParameters: null,
    });
    assert(url === 'https://cdn.runware.ai/img/abc.jpg', 'the runware adapter returns the CDN imageURL from the response');
    assert(captured.url === 'https://api.runware.ai/v1' && captured.init.method === 'POST', 'the runware adapter POSTs the REST endpoint');
    assert(captured.init.headers.authorization === 'Bearer sk-rw-test', 'the runware adapter authenticates with an Authorization: Bearer header');
    const sent = JSON.parse(captured.init.body);
    const task = sent[0];
    assert(Array.isArray(sent), 'the runware adapter sends an ARRAY of tasks (the documented REST body shape)');
    assert(task.taskType === 'imageInference', 'the runware adapter uses taskType imageInference (imageGeneration is the legacy WebSocket-era type)');
    assert(task.positivePrompt === 'a harbor at dusk' && task.negativePrompt === 'blurry', 'the runware adapter maps prompt/negative to positivePrompt/negativePrompt');
    assert(task.model === 'runware:z-image@turbo' && task.width === 1344 && task.height === 768, 'the runware adapter forwards model and pixel dimensions');
    assert(task.CFGScale === 7 && task.steps === 8, 'the runware adapter sends CFGScale (capital) and steps');
    assert(task.scheduler === 'Euler a' && task.samplerName === undefined, 'the runware adapter maps sampler_name to Runware\'s scheduler field');
    assert(task.seed === 42 && task.numberResults === 1 && task.outputType[0] === 'URL' && task.outputFormat === 'JPG' && task.checkNSFW === false,
      'the runware adapter sends seed, numberResults, a URL output type and checkNSFW=false (Canvalyze\'s proven base task)');
    assert(task.apiKey === undefined, 'the runware adapter never puts the apiKey in the body (it lives in the Bearer header)');
    assert(task.taskUUID && task.taskUUID.length > 0, 'the runware adapter gives each task a taskUUID for response correlation');
  } finally {
    global.fetch = realFetch;
  }
}

// --- io/imageGen/runware.ts: task-level errorCode and missing imageURL surface as clear errors ---
{
  const realFetch = global.fetch;
  const base = { prompt: 'x', negativePrompt: '', model: 'runware:100@1', apiKey: 'k', baseUrl: null, width: 1024, height: 1024, seed: null, steps: 30, cfgScale: 7, samplerName: null, workflowParameters: null };
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ data: [{ taskUUID: 't', errorCode: 'INVALID_PROMPT', message: 'bad prompt' }] }) });
  try {
    let threw = false;
    try {
      await generateRunwareImage(base);
    } catch (e) {
      threw = /INVALID_PROMPT/.test(e.message) && /bad prompt/.test(e.message);
    }
    assert(threw, 'the runware adapter surfaces task-level errorCode with its message');
  } finally {
    global.fetch = realFetch;
  }
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ data: [{ taskUUID: 't' }] }) });
  try {
    let threw = false;
    try {
      await generateRunwareImage(base);
    } catch (e) {
      threw = /no imageURL/.test(e.message);
    }
    assert(threw, 'the runware adapter throws a clear error when the response has no imageURL');
  } finally {
    global.fetch = realFetch;
  }
}

// --- generateLocationImage: combination cache hit (migration 0129) ---
{
  pool.locations.push({
    location_id: 'loc-cached',
    user_id: USER,
    visual_description: 'The Forest Clearing',
    environment: { time_of_day: 'dusk' },
    seed: 7,
  });
  pool.locationImageCombinations.push({
    combination_id: 'combo-clearing',
    location_id: 'loc-cached',
    time_of_day_key: null,
    image_url: 'https://cdn.example.invalid/clearing.png',
  });
  const result = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-cached');
  assert(result.ok === true && result.cached === true && result.imageUrl === 'https://cdn.example.invalid/clearing.png', 'an existing base combination is a cache hit — no provider call');
}

// --- generateLocationImage: prompt/environment changes never invalidate an existing combination ---
// The whole point of the 0129 rewrite: combination identity is location_id (+ optional TOD), never
// the synthesized prompt or provider inputs. A location whose environment/description has since
// drifted from what was rendered must still resolve its existing combination unchanged.
{
  pool.locations.push({
    location_id: 'loc-drifted',
    user_id: USER,
    visual_description: 'A mossy clearing, now overgrown and rain-slicked',
    environment: { time_of_day: 'dusk', weather: 'rain' },
    seed: 7,
  });
  pool.locationImageCombinations.push({
    combination_id: 'combo-drifted',
    location_id: 'loc-drifted',
    time_of_day_key: null,
    image_url: 'https://cdn.example.invalid/old.png',
  });
  // Swap the active connection entirely (provider/model change) — must not matter for a hit.
  const poll = await imageConnections.create({ name: 'poll', kind: 'pollinations', model: 'flux', apiKey: 'poll-token-123' });
  await imageConnections.activate(poll.id);
  const result = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-drifted');
  assert(result.ok === true && result.cached === true && result.imageUrl === 'https://cdn.example.invalid/old.png', 'a changed description/environment/provider never invalidates an existing combination — prompt hashing is gone');
}

// --- generateLocationImage: no existing combination renders fresh through the active connection ---
{
  pool.locations.push({
    location_id: 'loc-noimg',
    user_id: USER,
    visual_description: 'A dark cave',
    environment: {},
    seed: null,
  });
  const result = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-noimg');
  assert(result.ok === true && result.cached !== true && typeof result.imageUrl === 'string', 'a location with no combination at all renders fresh');
  assert(pool.locationImageCombinations.some((c) => c.location_id === 'loc-noimg' && c.time_of_day_key === null && c.image_url === result.imageUrl), 'the fresh render is persisted as a new base combination');
}

// --- generateLocationImage fail-open: unknown location ---
{
  const result = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-unknown');
  assert(result.ok === false && result.error === 'location_not_found', 'an unknown location resolves fail-open with location_not_found');
}

// --- generateLocationImage fail-open: no active connection ---
{
  // Clear every active flag in the shared pool; the store then resolves no active connection.
  for (const c of pool.imageConnections) c.is_active = false;
  // A fresh location with no image (a cache miss needs a provider — which needs an active
  // connection) proves the fail-open path.
  pool.locations.push({
    location_id: 'loc-noactive',
    user_id: USER,
    visual_description: 'An empty hall',
    environment: {},
    seed: null,
  });
  const result = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-noactive');
  assert(result.ok === false && result.error === 'no_active_connection', 'with no active connection the pass fails open (no throw, structured result)');
}

// --- generateLocationImage: db/migrations/0096 eligibility — regenerate_location_image must not
// --- render an inactive or foreign-chat-transient location, even given its id directly. --------
{
  const chatId = 'chat-live';
  const liveSwipe = 'swipe-live';
  pool.chatMessages.push({ chat_id: chatId, active_swipe_id: liveSwipe });
  pool.locations.push({
    location_id: 'loc-inactive',
    user_id: USER,
    visual_description: 'The Dark Cave',
    environment: {},
    seed: null,
    status: 'inactive', // demoted alternate timeline
  });
  pool.locationChatLinks.push({ location_id: 'loc-inactive', chat_id: chatId, anchor_swipe_id: 'swipe-dead' });
  pool.locations.push({
    location_id: 'loc-transient-live',
    user_id: USER,
    visual_description: 'The Forest Clearing',
    environment: {},
    seed: null,
    status: 'transient',
  });
  pool.locationChatLinks.push({ location_id: 'loc-transient-live', chat_id: chatId, anchor_swipe_id: liveSwipe });

  const inactiveNoChat = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-inactive');
  assert(inactiveNoChat.ok === false && inactiveNoChat.error === 'location_not_found', 'an inactive location resolves not-found, never rendered, even with no chat context');

  const inactiveWithChat = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-inactive', chatId);
  assert(inactiveWithChat.ok === false && inactiveWithChat.error === 'location_not_found', 'an inactive location resolves not-found even given its own chat — inactive is never eligible');

  const transientForeignChat = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-transient-live', 'chat-other');
  assert(transientForeignChat.ok === false && transientForeignChat.error === 'location_not_found', "a transient location anchored to a different chat's swipe is not eligible");

  // Re-activate a connection — the "no active connection" test above cleared every is_active flag.
  const pollAgain = await imageConnections.create({ name: 'poll-again', kind: 'pollinations', model: 'flux', apiKey: 'poll-token-456' });
  await imageConnections.activate(pollAgain.id);
  const transientLiveChat = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-transient-live', chatId);
  assert(transientLiveChat.ok === true && typeof transientLiveChat.imageUrl === 'string', "a transient location on the calling chat's active swipe path renders normally");

  // migration 0076, widened by 0129: the successful resolution records the (chat, swipe,
  // location) -> combination association — the per-swipe record that makes the image reusable on
  // cycle-back instead of re-generated (the "save that combination with that location and swipe"
  // rule).
  const assoc = pool.swipeImages.get(`${chatId}:${liveSwipe}`);
  assert(
    assoc?.location_id === 'loc-transient-live' && assoc.image_url === transientLiveChat.imageUrl && typeof assoc.combination_id === 'string',
    'the rendered combination is recorded against the swipe (migration 0076/0129)',
  );
}

// --- endpoint.md §3.3 testImageConnection probe (pollinations: URL constructed, no fetch) ---
{
  const probe = await imageConnections.create({ name: 'probe', kind: 'pollinations', model: 'flux', apiKey: 'probe-token' });
  const testResult = await testImageConnection(imageConnections, settings, probe.id);
  assert(
    testResult?.ok === true && typeof testResult.imageUrl === 'string' && decodeURIComponent(testResult.imageUrl).includes('serene mountain landscape'),
    'the Test probe renders through the saved connection and reports the image URL',
  );
  assert(
    typeof testResult?.prompt === 'string' && testResult.prompt.includes('serene mountain landscape at golden hour'),
    'the Test probe reports the exact synthesized prompt that was sent',
  );
  assert((await testImageConnection(imageConnections, settings, 'missing')) === undefined, 'the Test probe for an unknown id returns undefined (404 at the route)');
}

// --- pollinations without a key is a loud, structured failure (not keyless anymore) ---
{
  pool.locations.push({
    location_id: 'loc-nokey',
    user_id: USER,
    visual_description: 'A windmill at noon',
    environment: {},
    seed: null,
  });
  const noKey = await imageConnections.create({ name: 'poll-nokey', kind: 'pollinations', model: 'flux' });
  await imageConnections.activate(noKey.id);
  const result = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-nokey');
  assert(
    result.ok === false && typeof result.error === 'string' && result.error.includes('apiKey is required'),
    'a pollinations connection without a key fails with a clear structured error, not a silent anonymous render',
  );
}

// --- probe prompt is *synthesized*: the connection's master positive style prefix must appear ---
{
  const styled = await imageConnections.create({
    name: 'probe-styled',
    kind: 'pollinations',
    model: 'flux',
    apiKey: 'probe-style-token',
    masterPositiveStylePrefix: 'cinematic 35mm film, anamorphic lens flare',
    masterNegativePrompt: 'blurry, low quality',
  });
  const testResult = await testImageConnection(imageConnections, settings, styled.id);
  assert(
    typeof testResult?.prompt === 'string' &&
      testResult.prompt.includes('cinematic 35mm film, anamorphic lens flare') &&
      testResult.prompt.includes('golden hour'),
    'the probe prompt is synthesized through the Master Image Prompt Template with the connection\'s style prefix (parallax_fade_teststep.md §4.2)',
  );
}

// --- generateLocationImage → runware wire: pg-style string numerics never reach the payload ---
// Regression guard for the invalidSeed failure: locations.seed (bigint) and cfg_scale (numeric)
// come back from node-postgres as strings, and the fake pool above mimics that. A cache-miss
// render through a real runware connection must still put NUMBER seed/CFGScale on the wire.
{
  const rw = await imageConnections.create({ name: 'runware-wire', kind: 'runware', model: 'runware:z-image@turbo', apiKey: 'sk-rw-wire', cfgScale: 1, samplingSteps: 7 });
  await imageConnections.activate(rw.id);
  pool.locations.push({
    location_id: 'loc-wire',
    user_id: USER,
    visual_description: 'A sunlit study',
    environment: {},
    seed: 7,
  });
  const realFetch = global.fetch;
  let captured;
  global.fetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ data: [{ taskUUID: JSON.parse(init.body)[0].taskUUID, imageURL: 'https://cdn.runware.ai/img/wire.jpg' }] }),
    };
  };
  try {
    const result = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-wire');
    assert(result.ok === true && typeof result.imageUrl === 'string', 'a fresh location renders through the runware adapter (mocked fetch)');
    const task = JSON.parse(captured.init.body)[0];
    assert(typeof task.seed === 'number' && task.seed === 7, 'the runware wire carries seed as a NUMBER (bigint-as-string coerced at the DB boundary — the invalidSeed fix)');
    assert(typeof task.CFGScale === 'number' && task.CFGScale === 1, 'the runware wire carries CFGScale as a NUMBER (numeric-as-string coerced at the DB boundary)');
  } finally {
    global.fetch = realFetch;
  }
}

if (process.exitCode) {
  console.error('\nimage connections verification FAILED');
  process.exit(1);
}
console.log('\nimage connections verification passed');
