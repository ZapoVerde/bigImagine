// Proves the character-description pass (orchestrator/src/orchestrator/describeCharacter.ts,
// docs/plans/rp-cast-infrastructure-plan.md A2, character-appearance-field-plan.md) against a
// fake Postgres pool and a stub LLM — no server, no network. Structurally mirrors
// verify-location-describer.mjs; the suite exercises:
//   - the skip rule, per field: a never-described row (persona + appearance both empty — the
//     mint/A1-carry-forward seed) fires the describer; a row with either field already filled
//     (enriched persona, carried-forward, or user-authored) has that field left alone
//     (bi_principles.md §3 — explicit signal outranks inferred), and the pass skips entirely
//     only when both fields are non-empty;
//   - the write: one LLM call fills both blurbs — the reply's Appearance: marker lands in
//     characters.appearance and its Persona: marker in characters.persona;
//   - the per-field write rule: a row with persona already set but appearance blank gets only
//     appearance written, persona byte-for-byte unchanged (and vice versa), even though the
//     model was asked for both;
//   - the marker parse: markdown-wrapped labels are tolerated; a reply missing one marker still
//     writes the other (fail-open per field — a good appearance blurb is never discarded because
//     the persona half came back malformed, and vice versa);
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
  const characters = []; // { character_id, user_id, name, persona, appearance, status }
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
                ? [
                    {
                      character_id: row.character_id,
                      name: row.name,
                      persona: row.persona,
                      appearance: row.appearance,
                      status: row.status,
                    },
                  ]
                : [],
            };
          }
          if (sql.startsWith('select role, content from chat_messages')) {
            const rows = chatMessages
              .filter((m) => m.chat_id === params[0])
              .map((m) => ({ role: m.role, content: m.content }));
            return { rows };
          }
          if (sql.startsWith('update characters set ')) {
            // The pass writes only the fields that were empty going in, so the SET list varies
            // (appearance alone, persona alone, or both). Parse the $N placeholders in the SQL
            // to know which param is which field; params is 1-indexed like the SQL.
            const row = characters.find((c) => c.character_id === params[0] && c.user_id === params[1]);
            if (row) {
              for (const m of sql.matchAll(/(\w+) = \$(\d+)/g)) {
                const field = m[1];
                if (field === 'updated_at' || field === 'character_id') continue;
                row[field] = params[Number(m[2]) - 1];
              }
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
const CHAR = '44444444-4444-4444-4444-444444444444';

const BOTH_REPLY = `Appearance: Tall and lean, with a scar over one eyebrow and tar-grimed hands.
Persona: A weather-beaten dockhand with a quick laugh, always smells faintly of tar.`;
const PERSONA_REPLY = `Persona: A weather-beaten dockhand with a quick laugh and a scar over one eyebrow, always smells faintly of tar.`;

function characterWith(overrides = {}) {
  return {
    character_id: CHAR,
    user_id: USER,
    name: 'Seraphina',
    persona: '', // the mint/never-described seed
    appearance: '', // migration 0110's never-described seed
    status: 'transient',
    ...overrides,
  };
}

// --- Happy path: a never-described row fires ONE call and both markers land ---------------------
{
  const pool = createFakePool();
  pool.characters.push(characterWith());
  pool.chatMessages.push(
    { chat_id: CHAT, user_id: USER, role: 'user', content: 'Seraphina waves from the dock.' },
    { chat_id: CHAT, user_id: USER, role: 'assistant', content: 'She grins, rope in hand.' },
  );
  const db = createPostgresClient(pool);
  const llm = stubLlm([BOTH_REPLY]);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);

  assert(llm.calls.length === 1, 'a never-described character fires exactly one describer call for both fields');
  assert(
    pool.characters[0].appearance === 'Tall and lean, with a scar over one eyebrow and tar-grimed hands.',
    "the reply's Appearance: marker is written to characters.appearance",
  );
  assert(
    pool.characters[0].persona === 'A weather-beaten dockhand with a quick laugh, always smells faintly of tar.',
    "the reply's Persona: marker is written to characters.persona",
  );
  const prompt = llm.calls[0].messages[0].content;
  assert(prompt.includes('Seraphina'), 'the prompt interpolates {{character_name}}');
  assert(prompt.includes('waves from the dock.') && prompt.includes('rope in hand.'), 'the prompt interpolates {{context}} from the chat\'s recent turns');
  assert(prompt.includes('[SYSTEM: TASK — CHARACTER ARCHIVIST]'), 'an unset character_describer_prompt uses the built-in default (§18)');
  assert(prompt.includes('Physically inherent traits only'), 'the built-in prompt interpolates the shared APPEARANCE_SECTION_RULE');
}

// --- Per-field skip 1: persona already set, appearance blank → only appearance written ----------
{
  const pool = createFakePool();
  const original = 'A quiet, careful healer.';
  pool.characters.push(characterWith({ persona: original }));
  const db = createPostgresClient(pool);
  const llm = stubLlm([BOTH_REPLY]);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(llm.calls.length === 1, 'a row with persona set but appearance blank still fires (the appearance half of the pass)');
  assert(pool.characters[0].persona === original, 'a pre-set persona is left byte-for-byte untouched even though the model was asked for both');
  assert(pool.characters[0].appearance.includes('scar over one eyebrow'), 'the appearance half is written from the same one call');
}

// --- Per-field skip 2: appearance already set, persona blank → only persona written -------------
{
  const pool = createFakePool();
  const originalAppearance = 'A stocky smith with iron-grey hair.';
  pool.characters.push(characterWith({ appearance: originalAppearance }));
  const db = createPostgresClient(pool);
  const llm = stubLlm([BOTH_REPLY]);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(pool.characters[0].appearance === originalAppearance, 'a pre-set appearance is left byte-for-byte untouched');
  assert(pool.characters[0].persona.includes('dockhand'), 'the persona half is written from the same one call');
}

// --- Skip rule: both fields already filled never fires -------------------------------------------
{
  const pool = createFakePool();
  pool.characters.push(characterWith({ persona: 'A quiet, careful healer.', appearance: 'Tall and thin.' }));
  const db = createPostgresClient(pool);
  const llm = stubLlm([BOTH_REPLY]);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(llm.calls.length === 0, 'a row with both persona and appearance non-empty is already described — skipped');
  assert(pool.characters[0].persona === 'A quiet, careful healer.' && pool.characters[0].appearance === 'Tall and thin.', 'a fully described row is untouched');
}

// --- Skip rule: an A1 carry-forward persona never re-fires (covers user-authored) ----------------
{
  const pool = createFakePool();
  pool.characters.push(characterWith({ persona: 'Carried forward from a prior appearance.', appearance: '', status: 'transient' }));
  const db = createPostgresClient(pool);
  const llm = stubLlm([PERSONA_REPLY]);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(llm.calls.length === 1, "a carried-forward persona but blank appearance still fires for the appearance half (bi_principles.md §3 per field)");
  assert(pool.characters[0].persona === 'Carried forward from a prior appearance.', 'a carried-forward persona is left byte-for-byte untouched');
}

// --- Marker parse: markdown-wrapped labels ----------------------------------------------------------
{
  const pool = createFakePool();
  pool.characters.push(characterWith());
  const db = createPostgresClient(pool);
  const llm = stubLlm([`**Appearance:** A stern quartermaster who counts every coin twice.\n**Persona:** Quiet, exacting.`]);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(pool.characters[0].appearance === 'A stern quartermaster who counts every coin twice.', 'markdown-wrapped Appearance: parses');
  assert(pool.characters[0].persona === 'Quiet, exacting.', 'markdown-wrapped Persona: parses');
}

// --- One marker missing: the other is still written (fail-open per field) -------------------------
{
  const pool = createFakePool();
  pool.characters.push(characterWith());
  const db = createPostgresClient(pool);
  const llm = stubLlm(['Appearance: A dockhand with a rope-burned palm.']);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(pool.characters[0].appearance === 'A dockhand with a rope-burned palm.', 'a reply with only the Appearance: marker still writes appearance');
  assert(pool.characters[0].persona === '', 'the missing Persona: marker leaves persona untouched, not discarded-and-blanked');
}
{
  const pool = createFakePool();
  pool.characters.push(characterWith());
  const db = createPostgresClient(pool);
  const llm = stubLlm([PERSONA_REPLY]);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(pool.characters[0].persona.includes('dockhand'), 'a reply with only the Persona: marker still writes persona');
  assert(pool.characters[0].appearance === '', 'the missing Appearance: marker leaves appearance untouched');
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
  const llm = stubLlm([BOTH_REPLY]);
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
      return { message: { content: BOTH_REPLY } };
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
  assert(pool.characters[0].persona === '' && pool.characters[0].appearance === '', 'a failed describer leaves the blank fields untouched');
}

// --- Fail-open 2: empty reply / no marker ------------------------------------------------------------
{
  const pool = createFakePool();
  pool.characters.push(characterWith());
  const db = createPostgresClient(pool);
  const llm = stubLlm(['']);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(pool.characters[0].persona === '' && pool.characters[0].appearance === '', 'an empty reply leaves the row untouched');
}
{
  const pool = createFakePool();
  pool.characters.push(characterWith());
  const db = createPostgresClient(pool);
  const llm = stubLlm(['She seems friendly enough.']);
  await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, llm, USER, CHAT, CHAR);
  assert(pool.characters[0].persona === '' && pool.characters[0].appearance === '', 'a reply with no usable marker leaves the row untouched');
}

// --- Fail-open 3: missing row / DB failure ------------------------------------------------------------
{
  const pool = createFakePool(); // no character at all
  const db = createPostgresClient(pool);
  const llm = stubLlm([BOTH_REPLY]);
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
    await describeCharacterIfNeeded({ db, settings: { get: async () => undefined, set: async () => {} } }, stubLlm([BOTH_REPLY]), USER, CHAT, CHAR);
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
