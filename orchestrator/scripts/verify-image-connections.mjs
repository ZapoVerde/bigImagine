// Proves the Vistalyze image-generation plumbing (docs/vistalyze_integration/endpoint.md) against
// a fake Postgres pool + mocked fetch — no server, no real provider network. The suite exercises:
//   - io/imageConnections.ts's store CRUD against a fake pool: create with/without a key,
//     list (redacted — no apiKey ever), update, activate (single active enforced in the fake),
//     remove (refuses the active row), resolveActive returning the decrypted profile;
//   - util/synthesizeImagePrompt.ts + io/imageGen dispatch are exercised indirectly through
//     generateLocationImage below (the pollinations adapter needs no fetch, so it works with no
//     network at all), and io/imageGen/runware.ts's wire shape is pinned directly against a
//     mocked fetch (Bearer header + array body + imageInference taskType + positivePrompt/
//     CFGScale/scheduler field names — the proven REST contract, not the legacy WS-era shape);
//   - orchestrator/generateLocationImage.ts: cache hit (updated_at <= image_generated_at → no
//     provider call), cache miss on a touched row, miss on a null image_url, no-active-connection
//     fail-open, unknown-location fail-open, and the URL + image_generated_at write-back;
//   - endpoint.md §3.3's testImageConnection probe for the pollinations kind (URL constructed,
//     no fetch — but the key is required, see below).

import { randomBytes } from 'node:crypto';
import { createFieldCipher } from '../dist/io/fieldCipher.js';
import { createPostgresClient } from '../dist/io/postgres.js';
import { createImageConnectionStore } from '../dist/io/imageConnections.js';
import { generateLocationImage } from '../dist/orchestrator/generateLocationImage.js';
import { parseAspectRatio } from '../dist/io/imageGen/types.js';
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
  const chatMessages = []; // {chat_id, active_swipe_id} — §2.6 eligibility
  const settings = new Map();
  let connCounter = 0;
  let locCounter = 0;
  let clock = 1000;
  const now = () => new Date((clock += 1000)).toISOString();

  return {
    imageConnections,
    locations,
    chatMessages,
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
          if (sql.includes('from image_connections') && !sql.includes('select id from')) {
            const whereIsActive = sql.includes('where is_active');
            const whereId = sql.includes('where id = $1');
            const rows = imageConnections
              .filter((c) => (whereIsActive ? c.is_active : true))
              .filter((c) => (whereId ? c.id === params[0] : true))
              .sort((a, b) => a.name.localeCompare(b.name));
            return { rows: [...rows] };
          }
          if (sql.includes('select id from image_connections')) {
            const row = imageConnections.find((c) => c.id === params[0]);
            return { rows: row ? [{ id: row.id }] : [] };
          }
          if (sql.includes('select api_key_ciphertext from image_connections')) {
            const row = imageConnections.find((c) => c.id === params[0]);
            return { rows: row ? [{ api_key_ciphertext: row.api_key_ciphertext }] : [] };
          }
          if (sql.startsWith('insert into image_connections')) {
            const [name, kind, model, apiKeyCiphertext, baseUrl, aspectRatio, samplingSteps, cfgScale, samplerName, prefix, negative, workflow] = params;
            const row = {
              id: `img-conn-${++connCounter}`,
              name,
              kind,
              model,
              api_key_ciphertext: apiKeyCiphertext,
              base_url: baseUrl,
              aspect_ratio: aspectRatio,
              sampling_steps: samplingSteps,
              cfg_scale: cfgScale,
              sampler_name: samplerName,
              master_positive_style_prefix: prefix,
              master_negative_prompt: negative,
              workflow_parameters: workflow ? JSON.parse(workflow) : null,
              is_active: false,
              updated_at: now(),
            };
            imageConnections.push(row);
            return { rows: [{ ...row }] };
          }
          if (sql.startsWith('update image_connections set is_active = false')) {
            for (const c of imageConnections) if (c.is_active && c.id !== params[0]) c.is_active = false;
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
          if (sql.includes('from locations where location_id =')) {
            // §2.6 eligibility, modeled in JS same as verify-locations.mjs: a transient row counts
            // only when its anchor is on the calling chat's ($3) active swipe path.
            const chatId = params[2];
            const activeSwipeIds = new Set(
              chatMessages.filter((m) => m.chat_id === chatId && m.active_swipe_id).map((m) => m.active_swipe_id),
            );
            const eligible = (l) =>
              l.status === 'permanent' || l.status == null || (l.status === 'transient' && activeSwipeIds.has(l.anchor_swipe_id));
            const row = locations.find((l) => l.location_id === params[0] && l.user_id === scopedUserId && eligible(l));
            return {
              rows: row
                ? [
                    {
                      location_id: row.location_id,
                      visual_description: row.visual_description,
                      environment: row.environment,
                      seed: row.seed,
                      image_url: row.image_url,
                      image_generated_at: row.image_generated_at,
                      image_rendered_input: row.image_rendered_input,
                    },
                  ]
                : [],
            };
          }
          if (sql.startsWith('update locations set image_url')) {
            const row = locations.find((l) => l.location_id === params[0] && l.user_id === params[3]);
            if (row) {
              row.image_url = params[1];
              row.image_generated_at = now();
              row.image_rendered_input = JSON.parse(params[2]);
            }
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

const profileById = await imageConnections.resolveById(keyless.id);
assert(profileById?.apiKey === null, 'resolveById of a keyless connection yields apiKey null');

// --- update: rotate key + change a field ---
const patched = await imageConnections.update(keyless.id, { aspectRatio: '1:1', masterNegativePrompt: 'blurry' });
assert(patched?.aspectRatio === '1:1' && patched.masterNegativePrompt === 'blurry', 'update applies the given field changes');

// --- remove: refuses the active row, deletes a non-active one ---
assert((await imageConnections.remove(withKey.id)) === 'is_active', 'remove refuses the active connection');
assert((await imageConnections.remove(keyless.id)) === 'ok', 'remove deletes a non-active connection');
assert((await imageConnections.remove('missing')) === 'not_found', 'remove of an unknown id reports not_found');

// --- parseAspectRatio (pure) ---
assert(parseAspectRatio('16:9').width === 1344 && parseAspectRatio('16:9').height === 768, '16:9 parses to native Flux/SDXL pixels');
assert(parseAspectRatio('bogus').width === 1024 && parseAspectRatio('bogus').height === 1024, 'an unknown ratio falls back to square');

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

// --- generateLocationImage: cache hit (image + matching input snapshot) ---
{
  pool.locations.push({
    location_id: 'loc-cached',
    user_id: USER,
    visual_description: 'The Forest Clearing',
    environment: { time_of_day: 'dusk' },
    seed: 7,
    image_url: 'https://cdn.example.invalid/clearing.png',
    image_generated_at: new Date().toISOString(),
    image_rendered_input: { visual_description: 'The Forest Clearing', environment: { time_of_day: 'dusk' }, seed: 7 },
  });
  const result = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-cached');
  assert(result.ok === true && result.cached === true && result.imageUrl === 'https://cdn.example.invalid/clearing.png', 'a row whose inputs match its render snapshot is a cache hit — no provider call');
}

// --- generateLocationImage: cache miss on changed inputs (snapshot diverges) ---
{
  pool.locations.push({
    location_id: 'loc-miss',
    user_id: USER,
    visual_description: 'A mossy clearing',
    environment: { time_of_day: 'dusk', weather: 'rain' },
    seed: 7,
    image_url: 'https://cdn.example.invalid/old.png',
    image_generated_at: new Date(Date.now() - 120_000).toISOString(),
    // snapshot records the old state: weather changed (or was added) since the render → miss
    image_rendered_input: { visual_description: 'A mossy clearing', environment: { time_of_day: 'dusk' }, seed: 7 },
  });
  // The active connection is runware (activated above) — make it pollinations instead so the
  // miss path needs no network. Pollinations is NOT keyless (anonymous requests are
  // watermarked/rate-limited since 2025), so the row carries a token and the adapter bakes it
  // into the URL as `token` (io/imageGen/pollinations.ts).
  const poll = await imageConnections.create({ name: 'poll', kind: 'pollinations', model: 'flux', apiKey: 'poll-token-123' });
  await imageConnections.activate(poll.id);
  const result = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-miss');
  assert(result.ok === true && result.cached !== true, 'a touched row is a cache miss and re-renders');
  assert(
    typeof result.imageUrl === 'string' && result.imageUrl.startsWith('https://image.pollinations.ai/prompt/')
      && result.imageUrl.includes('token=poll-token-123'),
    'the pollinations adapter returns its constructed URL carrying the connection token (no network needed)',
  );
  const row = pool.locations.find((l) => l.location_id === 'loc-miss');
  assert(row.image_url === result.imageUrl && row.image_generated_at !== null, 'the new URL + image_generated_at are written back to the location row');
}

// --- generateLocationImage: null image_url is a miss even if the row is untouched ---
{
  pool.locations.push({
    location_id: 'loc-noimg',
    user_id: USER,
    visual_description: 'A dark cave',
    environment: {},
    seed: null,
    image_url: null,
    image_generated_at: null,
    updated_at: new Date().toISOString(),
  });
  const result = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-noimg');
  assert(result.ok === true && result.cached !== true && typeof result.imageUrl === 'string', 'a null image_url is a miss that renders a fresh image');
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
    image_url: null,
    image_generated_at: null,
    image_rendered_input: null,
  });
  const result = await generateLocationImage({ db, settings, imageConnections }, USER, 'loc-noactive');
  assert(result.ok === false && result.error === 'no_active_connection', 'with no active connection the pass fails open (no throw, structured result)');
}

// --- generateLocationImage: §2.6 eligibility — regenerate_location_image must not render an ---
// --- inactive or foreign-chat-transient location, even given its id directly. ------------------
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
    image_url: null,
    image_generated_at: null,
    image_rendered_input: null,
    status: 'inactive', // demoted alternate timeline
    anchor_swipe_id: 'swipe-dead',
  });
  pool.locations.push({
    location_id: 'loc-transient-live',
    user_id: USER,
    visual_description: 'The Forest Clearing',
    environment: {},
    seed: null,
    image_url: null,
    image_generated_at: null,
    image_rendered_input: null,
    status: 'transient',
    anchor_swipe_id: liveSwipe,
  });

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
    image_url: null,
    image_generated_at: null,
    updated_at: new Date().toISOString(),
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

if (process.exitCode) {
  console.error('\nimage connections verification FAILED');
  process.exit(1);
}
console.log('\nimage connections verification passed');
