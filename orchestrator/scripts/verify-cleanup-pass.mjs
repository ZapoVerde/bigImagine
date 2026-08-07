// Proves the cleanup pass's fail-open contract (docs/vistalyze_integration/cleanup_prompt.md §1,
// §6) against stub db/llm — no server, no network, no Postgres. runCleanupPass is exported from
// server/httpServer.ts solely so this suite can exercise it in isolation: the whole function is
// wrapped in one try/catch, so a slot-load failure, an empty enabled-slot set, a provider
// timeout, or empty output must all log and return the raw reply unchanged — never throw.
//
// §3.2's previous-turns contract is proven here too: {{prev_turns, N}} in the preset text expands
// to the last N turn pairs of historyMessages as labeled User:/Assistant: text — no separate
// message prepend, the pair count is prompt-controlled (default 2 when the argument is omitted) —
// so the cleanup model can update the header (location/date/time) and cast from previous context.
// §3.1's character/persona macros are proven here too: {{user}}/{{char}} resolve from the
// persona_name setting and the chat's linked character, and degrade to empty rather than failing
// the pass when the lookup throws.
//
// io/promptTrace.ts's capture is proven here too: every prompt the pass actually sends is recorded
// in the chat's trace before the call goes out (the cleanup text embeds {{message}} = the raw
// pre-cleanup reply, which cleanup itself discards — the trace is the only place it ever exists),
// and nothing is recorded when the pass resolves to no messages.
//
// The pass-through null branch ("cleanup_preset_id unset on the chat → skip entirely, zero cost")
// lives at the call sites in handleChatCompletions/regenerateSwipe, not inside runCleanupPass,
// so it's proven here in its isolation-level equivalent: a preset whose slots resolve to zero
// enabled messages must return the raw reply without the LLM ever being invoked.

import { runCleanupPass } from '../dist/server/httpServer.js';
import { getPromptTrace } from '../dist/io/promptTrace.js';

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
// (server/httpServer.ts) — slot_type/marker_key/enabled/custom_role/custom_content/label. The
// chat→character name lookup (resolveCleanupMacroSnapshot) is answered on SQL prefix; characterThrow
// makes only that lookup fail, to prove the fail-soft path separately from a slot-load failure.
function stubDb(slotRows, { throwOnQuery = false, characterName = undefined, characterThrow = false } = {}) {
  return {
    async withUserScope(_userId, fn) {
      return fn({
        async query(sql) {
          if (throwOnQuery) throw new Error('db connection refused');
          if (sql.startsWith('select c.name from chat_sessions')) {
            if (characterThrow) throw new Error('characters table read failed');
            return characterName === undefined ? [] : [{ name: characterName }];
          }
          return slotRows;
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

// --- Success + substitution + prev_turns: {{message}} gets the raw reply, {{prev_turns, 2}} ---
// --- expands the last 2 turn pairs as labeled text inside the slot -----------------------------
{
  const llm = stubLlm((messages) => messages[0].content.replace('TEXT TO FIX:', 'FIXED:'));
  const out = await runCleanupPass(
    stubDb([customSlot('PREVIOUS TURNS:\n{{prev_turns, 2}}\n\nClean up this turn.\n\nTEXT TO FIX:\n{{message}}')]),
    'u1',
    'chat-1',
    presetId,
    llm,
    RAW_REPLY,
    HISTORY,
  );
  assert(llm.calls.length === 1, 'the cleanup LLM is invoked exactly once for a populated preset');
  assert(llm.calls[0].length === 1, 'history is no longer prepended as messages — the preset slot alone is the whole call');
  const content = llm.calls[0][0].content;
  assert(
    content.startsWith(
      `PREVIOUS TURNS:\nUser: ${HISTORY[0].content}\nAssistant: ${HISTORY[1].content}\nUser: ${HISTORY[2].content}\nAssistant: ${HISTORY[3].content}`,
    ),
    '{{prev_turns, 2}} expands the last 2 turn pairs as labeled User:/Assistant: text, roles and order preserved',
  );
  assert(content.includes(`TEXT TO FIX:\n${RAW_REPLY}`), '{{message}} in the custom slot is replaced with the raw reply before the call');
  assert(out === content.replace('TEXT TO FIX:', 'FIXED:'), 'the cleanup LLM reply becomes the returned text');
}

// --- The pair count is prompt-controlled: {{prev_turns, 1}} keeps only the last pair ------------
{
  const llm = stubLlm();
  await runCleanupPass(stubDb([customSlot('{{prev_turns, 1}}')]), 'u1', 'chat-1', presetId, llm, RAW_REPLY, HISTORY);
  assert(
    llm.calls[0][0].content === `User: ${HISTORY[2].content}\nAssistant: ${HISTORY[3].content}`,
    '{{prev_turns, 1}} expands only the last turn pair (2 messages)',
  );
}

// --- {{prev_turns}} with no argument defaults to 2 pairs; older history is truncated away -------
{
  const llm = stubLlm();
  const eight = [
    { role: 'user', content: 'turn 0 user' },
    { role: 'assistant', content: 'turn 0 asst' },
    { role: 'user', content: 'turn 1 user' },
    { role: 'assistant', content: 'turn 1 asst' },
    ...HISTORY,
  ];
  await runCleanupPass(stubDb([customSlot('{{prev_turns}}')]), 'u1', 'chat-1', presetId, llm, RAW_REPLY, eight);
  assert(
    llm.calls[0][0].content ===
      `User: ${HISTORY[0].content}\nAssistant: ${HISTORY[1].content}\nUser: ${HISTORY[2].content}\nAssistant: ${HISTORY[3].content}`,
    '{{prev_turns}} without an argument defaults to the last 2 turn pairs, truncated to the most recent',
  );
  assert(!llm.calls[0][0].content.includes('turn 0 user'), 'history older than the requested pair count is excluded');
}

// --- Empty history: {{prev_turns, 2}} expands to nothing, slot still resolves, no crash ---------
{
  const llm = stubLlm();
  await runCleanupPass(stubDb([customSlot('Clean this: {{message}} ({{prev_turns, 2}})')]), 'u1', 'chat-1', presetId, llm, RAW_REPLY, []);
  assert(
    llm.calls[0][0].content === `Clean this: ${RAW_REPLY} ()`,
    'an empty history expands {{prev_turns, 2}} to empty text and the slot resolves cleanly',
  );
}

// --- {{prev_turns, 0}} is an explicit "no history" request: empty expansion ---------------------
{
  const llm = stubLlm();
  await runCleanupPass(stubDb([customSlot('Clean this: {{message}} ({{prev_turns, 0}})')]), 'u1', 'chat-1', presetId, llm, RAW_REPLY, HISTORY);
  assert(
    llm.calls[0][0].content === `Clean this: ${RAW_REPLY} ()`,
    '{{prev_turns, 0}} expands to nothing even with history available — zero is an explicit opt-out',
  );
}

// --- {{user}}/{{char}} resolve from the persona_name setting + the chat's linked character ------
{
  const llm = stubLlm();
  const settings = { async get(key) {
    return key === 'persona_name' ? 'Jeremy' : null;
  } };
  await runCleanupPass(
    stubDb([customSlot('{{user}} and {{char}} clean this: {{message}}')], { characterName: 'Elara' }),
    'u1',
    'chat-1',
    presetId,
    llm,
    RAW_REPLY,
    HISTORY,
    settings,
  );
  assert(
    llm.calls[0][llm.calls[0].length - 1].content === `Jeremy and Elara clean this: ${RAW_REPLY}`,
    "{{user}} resolves to the persona_name setting and {{char}} to the chat's linked character name",
  );
}

// --- Fail-soft: a throwing character lookup degrades {{user}}/{{char}} to empty, cleanup still runs ---
{
  const llm = stubLlm();
  const settings = { async get(key) {
    return key === 'persona_name' ? 'Jeremy' : null;
  } };
  await runCleanupPass(
    stubDb([customSlot('{{user}} {{char}}: {{message}}')], { characterThrow: true }),
    'u1',
    'chat-1',
    presetId,
    llm,
    RAW_REPLY,
    HISTORY,
    settings,
  );
  assert(
    llm.calls[0][llm.calls[0].length - 1].content === ` : ${RAW_REPLY}`,
    'a throwing macro lookup degrades {{user}}/{{char}} to empty rather than failing the cleanup pass',
  );
}

// --- Backward compat: a preset that never references {{prev_turns}} keeps the legacy behavior ---
// --- (last 2 turn pairs prepended as messages), so pre-macro presets don't lose history ---------
{
  const llm = stubLlm();
  await runCleanupPass(stubDb([customSlot('Clean this: {{message}}')]), 'u1', 'chat-1', presetId, llm, RAW_REPLY, HISTORY);
  assert(llm.calls[0].length === 5, 'a preset without {{prev_turns}} gets the legacy 2-pair message prepend (4 + the slot)');
  assert(
    llm.calls[0].slice(0, 4).every((m, i) => m.role === HISTORY[i].role && m.content === HISTORY[i].content),
    'the legacy prepend preserves roles and order for pre-macro presets',
  );
  assert(llm.calls[0][4].content === `Clean this: ${RAW_REPLY}`, 'the preset slot still lands last in the legacy path');
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

// --- io/promptTrace.ts: runCleanupPass records the exact prompt it sends, before the call -------
{
  const llm = stubLlm();
  const presetText = '{{prev_turns, 2}}\nClean this: {{message}}';
  await runCleanupPass(stubDb([customSlot(presetText)]), 'u1', 'chat-trace-1', presetId, llm, RAW_REPLY, HISTORY);
  const trace = getPromptTrace('chat-trace-1');
  assert(
    trace.length >= 1 && trace[trace.length - 1].kind === 'cleanup' && trace[trace.length - 1].title === 'Cleanup Prompt',
    "runCleanupPass records a 'cleanup' entry in the chat's prompt trace before sending",
  );
  const recordedItems = trace[trace.length - 1].items;
  assert(
    recordedItems.length === llm.calls[0].length &&
      recordedItems.every((item, i) => item.content === llm.calls[0][i].content && item.role === llm.calls[0][i].role),
    'the recorded trace items are exactly the messages sent to the LLM (same content, roles, order)',
  );
}

// --- the trace records nothing when the pass sends nothing (empty preset, fail-open path) --------
{
  const before = getPromptTrace('chat-1').length;
  await runCleanupPass(stubDb([]), 'u1', 'chat-1', presetId, stubLlm(), RAW_REPLY, HISTORY);
  assert(
    getPromptTrace('chat-1').length === before,
    'a cleanup pass that resolves to no messages records nothing — the trace only reflects prompts actually sent',
  );
}

if (process.exitCode) {
  console.error('\ncleanup pass verification FAILED');
  process.exit(1);
}
console.log('\ncleanup pass verification passed');
