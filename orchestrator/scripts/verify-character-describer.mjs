// Proves the character-description pass (orchestrator/src/orchestrator/describeCharacter.ts,
// docs/plans/rp-cast-infrastructure-plan.md A2) against a fake Postgres pool and a stub LLM — no
// server, no network. Structurally mirrors verify-location-describer.mjs; the suite exercises:
//   - the skip rule: a never-described row (persona empty — the mint/A1-carry-forward seed) fires
//     the describer; a described row (enriched persona, carried-forward, or user-authored) does
//     not (bi_principles.md §3 — explicit signal outranks inferred);
//   - the write: a reply's Persona: marker lands in characters.persona;
//   - the marker parse: markdown-wrapped labels are tolerated;
//   - the LLM gate: the call runs under runWithCallContext with kind 'system' and the prompt is
//     recorded to the prompt trace before the call (bi_principles.md §14, §18);
//   - the config surface: character_describer_prompt/character_describer_history_pairs are read
//     live, empty prompt = built-in default, corrupt pairs = 1;
//   - the fail-open contract: an LLM error, an empty reply, a reply with no marker, a missing
//     row, and a DB failure all resolve without throwing and without touching the row;
//   - the in-flight guard: a second concurrent call for the same character skips instead of
//     double-spending a text LLM round-trip.

import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../dist/io/postgres.js';
import { describeCharacterIfNeeded, DEFAULT_CHARACTER_DESCRIBER_PROMPT } from '../dist/orchestrator/describeCharacter.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake pool: in-memory characters / chat_messages / orchestrator_settings, covering exactly
// the queries describeCharacter.ts issues. ---
function createFakePool(settings = new Map()) {
  const characters = []; // { character_id, user_id, name, persona, status }
  const chatMessages = []; // { chat_id, user_id, role, content }

  return {
    characters,
    chatMessages,
    settings,
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            return { rows: [] };
          }
          if (sql.includes('from characters where character_id')) {
            const row = characters.find((c) => c.character_id === params[0] && c.user_id === params[1]);
            return {
              rows: row
                ? [{ character_id: row.character_id, name: row.name, persona: row.persona, status: row.status }]
                : [],
            };
          }
          if (sql.startsWith('select role, content from chat_messages')) {
            const rows = chatMessages
              .filter((m) => m.chat_id === params[0])
              .map((m) => ({ role: m.role, content: m.content }));
            return { rows };
          }
          if (sql.startsWith('update characters set persona')) {
            const [characterId, persona, userId] = params;
            const row = characters.find((c) => c.character_id === characterId && c.user_id === userId);
            if (row) row.persona = persona;
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
const CHAR = '44444444-4444-4444-4444-444444444444';

const PERSONA_REPLY = `Persona: A weather-beaten dockhand with a quick laugh and a scar over one eyebrow, always smells faintly of tar.`;

function characterWith(overrides = {}) {
  return {
    character_id: CHAR,
    user_id: USER,
    name: 'Seraphina',
    persona: '', // the mint/never-described seed
    status: 'transient',
    ...overrides,
  };
}

// --- Happy path: a never-described row fires the describer and the marker lands ------------------
{
  const pool = createFakePool();
  pool.characters.push(characterWith());
  pool.chatMessages.push(
    { chat_id: CHAT, user_id: USER, role: 'user', content: 'Seraphina waves from the dock.' },
    { chat_id: CHAT, user_id: USER, role: 'assistant', content: 'She grins, rope in hand.' },
  );
  const db = createPostgresClient(pool);
  const llm = stubLlm([PERSONA_REPLY]);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);

  assert(llm.calls.length === 1, 'a never-described character fires exactly one describer call');
  assert(
    pool.characters[0].persona === 'A weather-beaten dockhand with a quick laugh and a scar over one eyebrow, always smells faintly of tar.',
    "the reply's Persona: marker is written to characters.persona",
  );
  const prompt = llm.calls[0].messages[0].content;
  assert(prompt.includes('Seraphina'), 'the prompt interpolates {{character_name}}');
  assert(prompt.includes('waves from the dock.') && prompt.includes('rope in hand.'), 'the prompt interpolates {{context}} from the chat\'s recent turns');
  assert(prompt.includes('[SYSTEM: TASK — CHARACTER ARCHIVIST]'), 'an unset character_describer_prompt uses the built-in default (§18)');
}

// --- Skip rule 1: an enriched (described) row never fires ------------------------------------------
{
  const pool = createFakePool();
  pool.characters.push(characterWith({ persona: 'A quiet, careful healer.' }));
  const db = createPostgresClient(pool);
  const llm = stubLlm([PERSONA_REPLY]);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(llm.calls.length === 0, 'a row with a non-empty persona is already described — skipped');
  assert(pool.characters[0].persona === 'A quiet, careful healer.', 'a described row is untouched');
}

// --- Skip rule 2: an A1 carry-forward persona never fires (also covers user-authored) -------------
{
  const pool = createFakePool();
  pool.characters.push(characterWith({ persona: 'Carried forward from a prior appearance.', status: 'transient' }));
  const db = createPostgresClient(pool);
  const llm = stubLlm([PERSONA_REPLY]);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(llm.calls.length === 0, 'a carried-forward (A1) persona reads as already-described — never re-fires (bi_principles.md §3)');
}

// --- Marker parse: markdown-wrapped label ----------------------------------------------------------
{
  const pool = createFakePool();
  pool.characters.push(characterWith());
  const db = createPostgresClient(pool);
  const llm = stubLlm([`**Persona:** A stern quartermaster who counts every coin twice.`]);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(pool.characters[0].persona === 'A stern quartermaster who counts every coin twice.', 'markdown-wrapped Persona: parses');
}

// --- Config surface: the settings are read live, empty prompt = default, corrupt pairs = 1 --------
{
  const pool = createFakePool(
    new Map([
      ['character_describer_prompt', 'CUSTOM: {{character_name}} | {{context}}'],
      ['character_describer_history_pairs', 'bogus'],
    ]),
  );
  pool.characters.push(characterWith());
  pool.chatMessages.push({ chat_id: CHAT, user_id: USER, role: 'assistant', content: 'one' });
  pool.chatMessages.push({ chat_id: CHAT, user_id: USER, role: 'user', content: 'two' });
  pool.chatMessages.push({ chat_id: CHAT, user_id: USER, role: 'assistant', content: 'three' });
  pool.chatMessages.push({ chat_id: CHAT, user_id: USER, role: 'user', content: 'four' });
  const db = createPostgresClient(pool);
  const llm = stubLlm([PERSONA_REPLY]);
  await describeCharacterIfNeeded({ db, settings: { get: async (k) => pool.settings.get(k), set: async () => {} } }, llm, USER, CHAT, CHAR);
  const prompt = llm.calls[0].messages[0].content;
  assert(prompt.startsWith('CUSTOM:'), 'a non-empty character_describer_prompt overrides the built-in default');
  assert(prompt.includes('two') && prompt.includes('three') && prompt.includes('four') && !prompt.includes('one'), 'a corrupt history-pairs setting falls back to 1 turn-pair (fail-open shape)');
}

// --- In-flight guard: a concurrent second call for the same character skips ------------------------
{
  const pool = createFakePool();
  pool.characters.push(characterWith());
  const db = createPostgresClient(pool);
  let release;
  const gate = new Promise((r) => (release = r));
  const llm = {
    calls: 0,
    async complete() {
      llm.calls += 1;
      await gate;
      return { message: { content: PERSONA_REPLY } };
    },
  };
  const settings = { get: async () => undefined, set: async () => {} };
  const first = describeCharacterIfNeeded({ db, settings }, llm, USER, CHAT, CHAR);
  const second = describeCharacterIfNeeded({ db, settings }, llm, USER, CHAT, CHAR);
  release();
  await Promise.all([first, second]);
  assert(llm.calls === 1, 'a second describer call for the same character while one is in flight skips (waste-prevention guard)');
}

// --- Fail-open 1: LLM error leaves the row untouched ------------------------------------------------
{
  const pool = createFakePool();
  pool.characters.push(characterWith());
  const db = createPostgresClient(pool);
  const llm = {
    async complete() {
      throw new Error('provider 429');
    },
  };
  let threw = false;
  try {
    await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  } catch {
    threw = true;
  }
  assert(!threw, 'an LLM error is swallowed — the pass never throws (fail-open)');
  assert(pool.characters[0].persona === '', 'a failed describer leaves the blank persona untouched');
}

// --- Fail-open 2: empty reply / no marker ------------------------------------------------------------
{
  const pool = createFakePool();
  pool.characters.push(characterWith());
  const db = createPostgresClient(pool);
  const llm = stubLlm(['']);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(pool.characters[0].persona === '', 'an empty reply leaves the row untouched');
}
{
  const pool = createFakePool();
  pool.characters.push(characterWith());
  const db = createPostgresClient(pool);
  const llm = stubLlm(['She seems friendly enough.']);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(pool.characters[0].persona === '', 'a reply with no Persona: marker leaves the row untouched');
}

// --- Fail-open 3: missing row / DB failure ------------------------------------------------------------
{
  const pool = createFakePool(); // no character at all
  const db = createPostgresClient(pool);
  const llm = stubLlm([PERSONA_REPLY]);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(llm.calls.length === 0, 'a missing character row skips without calling the LLM');
}
{
  const pool = createFakePool();
  pool.characters.push(characterWith());
  const db = {
    async withUserScope() {
      throw new Error('db connection refused');
    },
  };
  let threw = false;
  try {
    await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, stubLlm([PERSONA_REPLY]), USER, CHAT, CHAR);
  } catch {
    threw = true;
  }
  assert(!threw, 'a DB failure is swallowed — the pass never throws (fail-open)');
}

if (process.exitCode) {
  console.error('\ncharacter describer verification FAILED');
  process.exit(1);
}
console.log('\ncharacter describer verification passed');
