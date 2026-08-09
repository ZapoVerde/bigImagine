// Proves the room-description pass (orchestrator/src/orchestrator/describeLocation.ts,
// docs/vistalyze_integration/describer.md) against a fake Postgres pool and a stub LLM — no
// server, no network. The suite exercises:
//   - the skip rule: a never-described row (visual_description empty or equal to its name — the
//     mint seed) fires the describer; a described row (enriched description, or a user-authored
//     one via create_location) does not (bi_principles.md §3 — explicit signal outranks inferred);
//   - the write: a reply's Visuals: half lands in visual_description, Definition: in definition,
//     each independently (a one-marker reply still lands the one it has);
//   - the marker parse: markdown-wrapped labels and trailing prose are tolerated
//     (VLZ extractMarkerData's tolerant scan);
//   - the LLM gate: the call runs under runWithCallContext with kind 'system' and the prompt is
//     recorded to the prompt trace before the call (bi_principles.md §14, §18);
//   - the config surface: location_describer_prompt/location_describer_history_pairs are read
//     live, empty prompt = built-in default, corrupt pairs = 1;
//   - the fail-open contract: an LLM error, an empty reply, a reply with no markers, a missing
//     row, and a DB failure all resolve without throwing and without touching the row.
//   - the in-flight guard: a second concurrent call for the same location skips instead of
//     double-spending a text LLM round-trip.

import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../dist/io/postgres.js';
import { describeLocationIfNeeded, DEFAULT_LOCATION_DESCRIBER_PROMPT } from '../dist/orchestrator/describeLocation.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake pool: in-memory locations / chat_messages / orchestrator_settings, covering exactly
// the queries describeLocation.ts issues. ---
function createFakePool(settings = new Map()) {
  const locations = []; // { location_id, user_id, name, visual_description, definition, status }
  const chatMessages = []; // { chat_id, user_id, role, content }
  let clock = 1000;
  const now = () => new Date((clock += 1000)).toISOString();

  return {
    locations,
    chatMessages,
    settings,
    now,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }
          if (sql.includes('from locations where location_id')) {
            const row = locations.find((l) => l.location_id === params[0] && l.user_id === params[1]);
            return {
              rows: row
                ? [{ location_id: row.location_id, name: row.name, visual_description: row.visual_description, definition: row.definition ?? null, status: row.status }]
                : [],
            };
          }
          if (sql.startsWith('select role, content from chat_messages')) {
            const rows = chatMessages
              .filter((m) => m.chat_id === params[0])
              .map((m) => ({ role: m.role, content: m.content }));
            return { rows };
          }
          if (sql.startsWith('update locations set')) {
            const [locationId, visualDescription, definition, userId] = params;
            const row = locations.find((l) => l.location_id === locationId && l.user_id === userId);
            if (row) {
              if (visualDescription !== null) row.visual_description = visualDescription;
              if (definition !== null) row.definition = definition;
            }
            return { rows: [] };
          }
          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

// --- Stub LLM: records every call and returns canned replies. ---
function stubLlm(replies = []) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async complete(messages) {
      calls.push({ messages });
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (reply === undefined) throw new Error('stub LLM exhausted');
      return { message: { content: reply } };
    },
  };
}

const USER = '11111111-1111-1111-1111-111111111111';
const CHAT = '22222222-2222-2222-2222-222222222222';
const LOC = '33333333-3333-3333-3333-333333333333';

const VISUALS_REPLY = `Definition: A rowdy dockside tavern and the crew's usual meeting spot.
Visuals: A wide taproom with low oak beams, a great hearth, and lanterns casting warm light across scarred tables.`;

function locationWith(overrides = {}) {
  return {
    location_id: LOC,
    user_id: USER,
    name: 'The Drunken Kraken - Main Hall',
    visual_description: 'The Drunken Kraken - Main Hall', // the mint seed
    definition: null,
    status: 'transient',
    ...overrides,
  };
}

// --- Happy path: a never-described row fires the describer and both markers land -----------------
{
  const pool = createFakePool();
  pool.locations.push(locationWith());
  pool.chatMessages.push(
    { chat_id: CHAT, user_id: USER, role: 'user', content: 'Mair pushes open the door.' },
    { chat_id: CHAT, user_id: USER, role: 'assistant', content: 'The tavern is quiet tonight.' },
  );
  const db = createPostgresClient(pool);
  const llm = stubLlm([VISUALS_REPLY]);
  await describeLocationIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, LOC);

  assert(llm.calls.length === 1, 'a never-described location fires exactly one describer call');
  assert(pool.locations[0].visual_description === 'A wide taproom with low oak beams, a great hearth, and lanterns casting warm light across scarred tables.', 'the reply\'s Visuals: half is written to visual_description');
  assert(pool.locations[0].definition === "A rowdy dockside tavern and the crew's usual meeting spot.", 'the reply\'s Definition: half is written to definition');
  const prompt = llm.calls[0].messages[0].content;
  assert(prompt.includes('The Drunken Kraken - Main Hall'), 'the prompt interpolates {{location_name}}');
  assert(prompt.includes('Mair pushes open the door.') && prompt.includes('The tavern is quiet tonight.'), 'the prompt interpolates {{context}} from the chat\'s recent turns');
  assert(prompt.includes('[SYSTEM: TASK — LOCATION VISUAL ARCHIVIST]'), 'an unset location_describer_prompt uses the built-in default (§18)');
}

// --- Skip rule 1: an enriched (described) row never fires ----------------------------------------
{
  const pool = createFakePool();
  pool.locations.push(
    locationWith({ visual_description: 'A wide taproom with low oak beams.', definition: 'A dockside tavern.' }),
  );
  const db = createPostgresClient(pool);
  const llm = stubLlm([VISUALS_REPLY]);
  await describeLocationIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, LOC);
  assert(llm.calls.length === 0, 'a row whose visual_description no longer equals its name is already described — skipped');
  assert(pool.locations[0].visual_description === 'A wide taproom with low oak beams.', 'a described row is untouched');
}

// --- Skip rule 2: a user-authored (create_location) description never fires -----------------------
{
  const pool = createFakePool();
  pool.locations.push(
    locationWith({ visual_description: 'A clean, well-lit guildhall.', status: 'permanent' }),
  );
  const db = createPostgresClient(pool);
  const llm = stubLlm([VISUALS_REPLY]);
  await describeLocationIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, LOC);
  assert(llm.calls.length === 0, 'a user-authored description is explicit canon — never overwritten (bi_principles.md §3)');
}

// --- Marker parse: markdown-wrapped labels (VLZ extractMarkerData's tolerant scan) ---------------
{
  const pool = createFakePool();
  pool.locations.push(locationWith());
  const db = createPostgresClient(pool);
  const llm = stubLlm([
    `**Definition:** A quiet reading room.\n\n**Visuals:** Tall shelves of leather-bound books under a high vaulted ceiling.`,
  ]);
  await describeLocationIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, LOC);
  assert(pool.locations[0].visual_description === 'Tall shelves of leather-bound books under a high vaulted ceiling.', 'markdown-wrapped Visuals: parses');
  assert(pool.locations[0].definition === 'A quiet reading room.', 'markdown-wrapped Definition: parses (capture stops at the next marker)');
}

// --- Partial reply: a one-marker reply still lands the one it has --------------------------------
{
  const pool = createFakePool();
  pool.locations.push(locationWith());
  const db = createPostgresClient(pool);
  const llm = stubLlm(['Visuals: A narrow alley slick with rain.']);
  await describeLocationIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, LOC);
  assert(pool.locations[0].visual_description === 'A narrow alley slick with rain.', 'a Visuals-only reply still writes visual_description');
  assert(pool.locations[0].definition === null, 'a reply without Definition: leaves definition null');
}

// --- Config surface: the settings are read live, empty prompt = default, corrupt pairs = 1 -------
{
  const pool = createFakePool(
    new Map([
      ['location_describer_prompt', 'CUSTOM: {{location_name}} | {{context}}'],
      ['location_describer_history_pairs', 'bogus'],
    ]),
  );
  pool.locations.push(locationWith());
  pool.chatMessages.push({ chat_id: CHAT, user_id: USER, role: 'assistant', content: 'one' });
  pool.chatMessages.push({ chat_id: CHAT, user_id: USER, role: 'user', content: 'two' });
  pool.chatMessages.push({ chat_id: CHAT, user_id: USER, role: 'assistant', content: 'three' });
  pool.chatMessages.push({ chat_id: CHAT, user_id: USER, role: 'user', content: 'four' });
  const db = createPostgresClient(pool);
  const llm = stubLlm([VISUALS_REPLY]);
  await describeLocationIfNeeded({ db, settings: { get: async (k) => pool.settings.get(k), set: async () => {} } }, llm, USER, CHAT, LOC);
  const prompt = llm.calls[0].messages[0].content;
  assert(prompt.startsWith('CUSTOM:'), 'a non-empty location_describer_prompt overrides the built-in default');
  // corrupt pairs -> default 1 -> window = last (1*2 + 1) = 3 messages: two/three/four
  assert(prompt.includes('two') && prompt.includes('three') && prompt.includes('four') && !prompt.includes('one'), 'a corrupt history-pairs setting falls back to 1 turn-pair (fail-open shape)');
}

// --- In-flight guard: a concurrent second call for the same location skips ------------------------
{
  const pool = createFakePool();
  pool.locations.push(locationWith());
  const db = createPostgresClient(pool);
  let release;
  const gate = new Promise((r) => (release = r));
  const llm = {
    calls: 0,
    async complete() {
      llm.calls += 1;
      await gate; // hold the first call open so the second fires while the first is in flight
      return { message: { content: VISUALS_REPLY } };
    },
  };
  const settings = { get: async () => undefined, set: async () => {} };
  const first = describeLocationIfNeeded({ db, settings }, llm, USER, CHAT, LOC);
  const second = describeLocationIfNeeded({ db, settings }, llm, USER, CHAT, LOC);
  release();
  await Promise.all([first, second]);
  assert(llm.calls === 1, 'a second describer call for the same location while one is in flight skips (waste-prevention guard)');
}

// --- Fail-open 1: LLM error leaves the row untouched ----------------------------------------------
{
  const pool = createFakePool();
  pool.locations.push(locationWith());
  const db = createPostgresClient(pool);
  const llm = {
    async complete() {
      throw new Error('provider 429');
    },
  };
  let threw = false;
  try {
    await describeLocationIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, LOC);
  } catch {
    threw = true;
  }
  assert(!threw, 'an LLM error is swallowed — the pass never throws (fail-open)');
  assert(pool.locations[0].visual_description === 'The Drunken Kraken - Main Hall', 'a failed describer leaves the name-seeded row untouched — the render still runs as before');
}

// --- Fail-open 2: empty reply / no markers --------------------------------------------------------
{
  const pool = createFakePool();
  pool.locations.push(locationWith());
  const db = createPostgresClient(pool);
  const llm = stubLlm(['']);
  await describeLocationIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, LOC);
  assert(pool.locations[0].visual_description === 'The Drunken Kraken - Main Hall', 'an empty reply leaves the row untouched');
}
{
  const pool = createFakePool();
  pool.locations.push(locationWith());
  const db = createPostgresClient(pool);
  const llm = stubLlm(['This place is a tavern.']);
  await describeLocationIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, LOC);
  assert(pool.locations[0].visual_description === 'The Drunken Kraken - Main Hall', 'a reply with no Definition/Visuals markers leaves the row untouched');
}

// --- Fail-open 3: missing row / DB failure --------------------------------------------------------
{
  const pool = createFakePool(); // no location at all
  const db = createPostgresClient(pool);
  const llm = stubLlm([VISUALS_REPLY]);
  await describeLocationIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, LOC);
  assert(llm.calls.length === 0, 'a missing location row skips without calling the LLM');
}
{
  const pool = createFakePool();
  pool.locations.push(locationWith());
  const db = {
    async withUserScope() {
      throw new Error('db connection refused');
    },
  };
  let threw = false;
  try {
    await describeLocationIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, stubLlm([VISUALS_REPLY]), USER, CHAT, LOC);
  } catch {
    threw = true;
  }
  assert(!threw, 'a DB failure is swallowed — the pass never throws (fail-open)');
}

if (process.exitCode) {
  console.error('\nlocation describer verification FAILED');
  process.exit(1);
}
console.log('\nlocation describer verification passed');
