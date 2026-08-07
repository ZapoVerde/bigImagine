// Proves the cleanup pass's fail-open contract (docs/vistalyze_integration/cleanup_prompt.md §1,
// §6) against stub db/llm — no server, no network, no Postgres. runCleanupPass is exported from
// server/httpServer.ts solely so this suite can exercise it in isolation: the whole function is
// wrapped in one try/catch, so a slot-load failure, an empty enabled-slot set, a provider
// timeout, or empty output must all log and return the raw reply unchanged — never throw.
//
// §3.2's trailing-context contract is proven here too: the last 2 turn pairs (≤4 messages) of
// historyMessages must be prepended ahead of the preset slots, roles preserved, so the cleanup
// model can update the header (location/date/time) and cast from previous context.
//
// The pass-through null branch ("cleanup_preset_id unset on the chat → skip entirely, zero cost")
// lives at the call sites in handleChatCompletions/regenerateSwipe, not inside runCleanupPass,
// so it's proven here in its isolation-level equivalent: a preset whose slots resolve to zero
// enabled messages must return the raw reply without the LLM ever being invoked.

import { runCleanupPass } from '../dist/server/httpServer.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// db.withUserScope(userId, fn) -> fn(session); session.query() returns whatever rows the test
// seeds (or throws, for the DB-failure case). Mirrors loadPromptStackSlots's read shape
// (server/httpServer.ts) — slot_type/marker_key/enabled/custom_role/custom_content/label.
function stubDb(rows, { throwOnQuery = false } = {}) {
  return {
    async withUserScope(_userId, fn) {
      return fn({
        async query() {
          if (throwOnQuery) throw new Error('db connection refused');
          return rows;
        },
      });
    },
  };
}

// Records every messages array handed to complete() so tests can assert interpolation and the
// trailing-history prefix, and delegates the reply to `respond` (default: a fixed cleaned string).
function stubLlm(respond) {
  return {
    calls: [],
    async complete(messages, _tools) {
      this.calls.push(messages);
      return { message: { content: respond ? respond(messages) : 'cleaned text' } };
    },
  };
}

function customSlot(content) {
  return {
    slot_type: 'custom',
    marker_key: null,
    enabled: true,
    custom_role: 'system',
    custom_content: content,
    label: null,
  };
}

const RAW_REPLY = 'She met his gaze and refused to flinch.';
const presetId = '11111111-1111-1111-1111-111111111111';

// Two turn pairs of plausible history — the cleanup model's context for header/cast state.
const HISTORY = [
  { role: 'user', content: 'Where are we now?' },
  { role: 'assistant', content: '[ Lunchtime | 🗓️ Wednesday, June 15, 2026 AD | 📍 Deck 6 - Observation Deck ]\nPresent: Mair\nYou stand at the aft rail.' },
  { role: 'user', content: 'Lead us to the casino.' },
  { role: 'assistant', content: 'You set off toward the Orchid Room.' },
];

// --- Pass-through / no-op: zero enabled messages -> raw reply, LLM never invoked ---------------
{
  const llm = stubLlm();
  const out = await runCleanupPass(stubDb([]), 'u1', 'chat-1', presetId, llm, RAW_REPLY, HISTORY);
  assert(out === RAW_REPLY, 'a preset resolving to zero messages returns the raw reply unchanged');
  assert(llm.calls.length === 0, 'no LLM call is made when the cleanup preset resolves to nothing');
}

// --- Success + substitution + trailing history: {{message}} gets the raw reply, history first ---
{
  const llm = stubLlm((messages) => messages[4].content.replace('TEXT TO FIX:', 'FIXED:'));
  const out = await runCleanupPass(
    stubDb([customSlot('Clean up this turn.\n\nTEXT TO FIX:\n{{message}}')]),
    'u1',
    'chat-1',
    presetId,
    llm,
    RAW_REPLY,
    HISTORY,
  );
  assert(llm.calls.length === 1, 'the cleanup LLM is invoked exactly once for a populated preset');
  assert(llm.calls[0].length === 5, 'the cleanup call is trailing history (4 messages) + the preset slot (1)');
  assert(
    llm.calls[0].slice(0, 4).every((m, i) => m.role === HISTORY[i].role && m.content === HISTORY[i].content),
    'the last 2 turn pairs are prepended ahead of the preset slots, roles and order preserved',
  );
  assert(
    llm.calls[0][4].content === `Clean up this turn.\n\nTEXT TO FIX:\n${RAW_REPLY}`,
    '{{message}} in the custom slot is replaced with the raw reply before the call',
  );
  assert(out === `Clean up this turn.\n\nFIXED:\n${RAW_REPLY}`, 'the cleanup LLM reply becomes the returned text');
}

// --- History truncation: only the last 2 turn pairs (4 messages) ride along --------------------
{
  const llm = stubLlm();
  const eight = [
    { role: 'user', content: 'turn 0 user' },
    { role: 'assistant', content: 'turn 0 asst' },
    { role: 'user', content: 'turn 1 user' },
    { role: 'assistant', content: 'turn 1 asst' },
    ...HISTORY,
  ];
  await runCleanupPass(stubDb([customSlot('Clean this: {{message}}')]), 'u1', 'chat-1', presetId, llm, RAW_REPLY, eight);
  assert(llm.calls[0].length === 5, 'history longer than 2 turn pairs is truncated to the last 4 messages');
  assert(llm.calls[0][0].content === HISTORY[0].content, 'the kept history is the most recent 4 (HISTORY), not the oldest turns');
  assert(llm.calls[0][4].content === `Clean this: ${RAW_REPLY}`, 'the preset slot still lands last after truncation');
}

// --- Empty history: preset slot alone, no crash -------------------------------------------------
{
  const llm = stubLlm();
  await runCleanupPass(stubDb([customSlot('Clean this: {{message}}')]), 'u1', 'chat-1', presetId, llm, RAW_REPLY, []);
  assert(llm.calls[0].length === 1, 'an empty history still produces the preset slot alone, no crash');
}

// --- Fail-open 1: the LLM call throws -> raw reply, error swallowed -----------------------------
{
  const llm = stubLlm(() => {
    throw new Error('provider 500');
  });
  const out = await runCleanupPass(stubDb([customSlot('Clean this: {{message}}')]), 'u1', 'chat-1', presetId, llm, RAW_REPLY, HISTORY);
  assert(out === RAW_REPLY, 'a throwing cleanup LLM call falls back to the raw reply (never blocks the turn)');
}

// --- Fail-open 2: empty LLM output -> raw reply (an empty cleanup must not blank the turn) ------
{
  const llm = stubLlm(() => '');
  const out = await runCleanupPass(stubDb([customSlot('Clean this: {{message}}')]), 'u1', 'chat-1', presetId, llm, RAW_REPLY, HISTORY);
  assert(out === RAW_REPLY, 'empty cleanup output falls back to the raw reply');
}

// --- Fail-open 2b: whitespace-only LLM output also counts as empty -------------------------------
{
  const llm = stubLlm(() => ' \n\t ');
  const out = await runCleanupPass(stubDb([customSlot('Clean this: {{message}}')]), 'u1', 'chat-1', presetId, llm, RAW_REPLY, HISTORY);
  assert(out === RAW_REPLY, 'whitespace-only cleanup output falls back to the raw reply, never blanks the turn');
}

// --- Fail-open 3: the slot load itself fails -> raw reply, error swallowed ----------------------
{
  const llm = stubLlm();
  const out = await runCleanupPass(stubDb([], { throwOnQuery: true }), 'u1', 'chat-1', presetId, llm, RAW_REPLY, HISTORY);
  assert(out === RAW_REPLY, 'a slot-load (DB) failure also falls back to the raw reply');
  assert(llm.calls.length === 0, 'no LLM call is attempted when the slot load itself failed');
}

if (process.exitCode) {
  console.error('\ncleanup pass verification FAILED');
  process.exit(1);
}
console.log('\ncleanup pass verification passed');
