// Proves the agentic loop's control flow and DB-scoping wiring, per the Phase 2 build-order gate
// ("a stub/echo tool round-trips through the full loop with user_id scoping enforced").
//
// The fake pool below simulates exactly the two statements postgres.ts issues
// (set_config(...) then a query) with real per-connection state, so this proves the *plumbing*:
// runTurn threads userId -> withUserScope -> set_config -> the tool's query -> back through the
// loop to the LLM's final reply, without ever crossing between two concurrent scopes. It does
// NOT prove Postgres's RLS policies themselves reject cross-user access — that's already proven
// against the real deployed database by db/checks/verify_rls.sql (Phase 1). Proving this same
// wiring against the real, RLS-enforcing Postgres is the natural first thing to do once the
// orchestrator is deployed as a real service (Phase 4).
//
// The fake pool also captures every `insert into turn_metrics` runTurn's own
// io/turnMetrics.ts issues (0041_turn_metrics.sql), so this also proves the metrics
// accumulator's wiring end to end: a normal multi-round turn produces one row with the right
// round_count/tool_call_count/rounds shape, and a turn where the LLM itself throws mid-round
// still produces exactly one row (outcome 'error', a populated error_reason, rounds reflecting
// only what actually completed) rather than losing the failure's shape entirely.

import { createStubLlmProvider } from '../dist/io/llm/stub.js';
import { createPostgresClient } from '../dist/io/postgres.js';
import { createToolRegistry } from '../dist/orchestrator/toolRegistry.js';
import { runTurn } from '../dist/orchestrator/loop.js';
import { whoamiTool } from '../dist/tools/whoamiTool.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakePool() {
  const setConfigCalls = [];
  const turnMetricsInserts = [];
  return {
    setConfigCalls,
    turnMetricsInserts,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            setConfigCalls.push(scopedUserId);
            return { rows: [] };
          }
          if (sql.includes('app_current_user_id()')) {
            return { rows: [{ app_current_user_id: scopedUserId }] };
          }
          if (sql.includes('insert into turn_metrics')) {
            turnMetricsInserts.push({
              userId: params[0],
              taskId: params[1],
              kind: params[2],
              roundCount: params[3],
              toolCallCount: params[4],
              totalDurationMs: params[5],
              outcome: params[6],
              errorReason: params[7],
              rounds: JSON.parse(params[8]),
            });
            return { rows: [] };
          }
          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

async function runForUser(userId) {
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const tools = createToolRegistry([whoamiTool]);

  const llm = createStubLlmProvider([
    {
      message: { role: 'assistant', content: '' },
      toolCalls: [{ id: 'call_1', name: 'whoami', arguments: {} }],
    },
    {
      message: { role: 'assistant', content: `done for ${userId}` },
      toolCalls: [],
    },
  ]);

  const result = await runTurn({
    userId,
    taskId: `task-${userId}`,
    messages: [{ role: 'user', content: 'who am I?' }],
    llm,
    db,
    tools,
  });
  return { reply: result.content, setConfigCalls: pool.setConfigCalls, turnMetricsInserts: pool.turnMetricsInserts };
}

const alice = await runForUser('11111111-1111-1111-1111-111111111111');
assert(alice.reply === 'done for 11111111-1111-1111-1111-111111111111', 'loop returns the LLM\'s final reply after the tool round-trip');
assert(
  // 2, not 1: the whoami tool call's own withUserScope, plus recordTurnMetrics's separate
  // withUserScope for the turn_metrics insert (io/turnMetrics.ts) — both correctly scoped to the
  // same requesting user, in two distinct transactions.
  alice.setConfigCalls.length === 2 && alice.setConfigCalls.every((id) => id === '11111111-1111-1111-1111-111111111111'),
  'every DB access this turn made (the tool call and the turn_metrics insert) was scoped to the requesting user',
);

assert(alice.turnMetricsInserts.length === 1, 'exactly one turn_metrics row is written for a successful turn');
{
  const m = alice.turnMetricsInserts[0];
  assert(m.outcome === 'ok', 'turn_metrics records outcome ok for a successful turn');
  assert(m.roundCount === 2, 'turn_metrics round_count matches the two LLM rounds the turn took');
  assert(Array.isArray(m.rounds) && m.rounds.length === 2, 'turn_metrics rounds jsonb has one entry per round');
  assert(
    m.rounds[0].tool_calls.length === 1 && m.rounds[0].tool_calls[0].name === 'whoami' && m.rounds[0].tool_calls[0].outcome === 'ok',
    'round 0 recorded the whoami tool call with its outcome',
  );
  assert(m.toolCallCount === 1, 'turn_metrics tool_call_count sums tool calls across every round');
  assert(m.totalDurationMs >= 0, 'turn_metrics total_duration_ms is a real elapsed-time measurement');
}

const bob = await runForUser('22222222-2222-2222-2222-222222222222');
assert(
  bob.setConfigCalls[0] === '22222222-2222-2222-2222-222222222222',
  'a second, concurrent-in-spirit request scopes independently to its own user',
);
assert(
  alice.setConfigCalls[0] !== bob.setConfigCalls[0],
  'no cross-request leakage between two different users\' scoping',
);

// A tool call for a name the registry doesn't have must degrade gracefully (an error payload
// fed back to the LLM), never throw out of the loop and never silently no-op.
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const tools = createToolRegistry([]); // no tools registered
  const llm = createStubLlmProvider([
    {
      message: { role: 'assistant', content: '' },
      toolCalls: [{ id: 'call_1', name: 'nonexistent', arguments: {} }],
    },
    { message: { role: 'assistant', content: 'handled the missing tool' }, toolCalls: [] },
  ]);
  const result = await runTurn({
    userId: 'x',
    taskId: 'task-missing-tool',
    messages: [{ role: 'user', content: 'hi' }],
    llm,
    db,
    tools,
  });
  assert(result.content === 'handled the missing tool', 'an unknown tool name degrades gracefully instead of crashing the loop');
  assert(result.focusedNoteId === undefined, 'no focusHint anywhere means focusedNoteId stays undefined');
}

// Canvas: a tool declaring focusHint surfaces its result through runTurn, last-call-wins, and a
// focusHint that throws doesn't take the reply down with it.
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const focusingTool = {
    definition: { name: 'touch_note', description: 'test', parameters: { type: 'object', properties: {} } },
    handler: async () => ({ noteId: 'note-a' }),
    focusHint: (result) => result.noteId ?? null,
  };
  const tools = createToolRegistry([focusingTool]);
  const llm = createStubLlmProvider([
    {
      message: { role: 'assistant', content: '' },
      toolCalls: [{ id: 'call_1', name: 'touch_note', arguments: {} }],
    },
    { message: { role: 'assistant', content: 'done' }, toolCalls: [] },
  ]);
  const result = await runTurn({ userId: 'x', taskId: 'task-focus-hint', messages: [{ role: 'user', content: 'hi' }], llm, db, tools });
  assert(result.focusedNoteId === 'note-a', 'a tool call\'s focusHint surfaces as runTurn\'s focusedNoteId');
}
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const throwingTool = {
    definition: { name: 'touch_note', description: 'test', parameters: { type: 'object', properties: {} } },
    handler: async () => ({ noteId: 'note-a' }),
    focusHint: () => {
      throw new Error('focusHint blew up');
    },
  };
  const tools = createToolRegistry([throwingTool]);
  const llm = createStubLlmProvider([
    {
      message: { role: 'assistant', content: '' },
      toolCalls: [{ id: 'call_1', name: 'touch_note', arguments: {} }],
    },
    { message: { role: 'assistant', content: 'done anyway' }, toolCalls: [] },
  ]);
  const result = await runTurn({ userId: 'x', taskId: 'task-focus-hint', messages: [{ role: 'user', content: 'hi' }], llm, db, tools });
  assert(result.content === 'done anyway', 'a throwing focusHint never breaks the turn\'s reply');
  assert(result.focusedNoteId === undefined, 'a throwing focusHint just leaves focusedNoteId unset');
}

// turn_metrics failure path: the LLM itself throws partway through a turn (here, mid-loop —
// only one turn is scripted but the tool call it requests forces a second round). runTurn must
// still write exactly one turn_metrics row, reflecting only the round that actually completed.
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const tools = createToolRegistry([whoamiTool]);
  const llm = createStubLlmProvider([
    {
      message: { role: 'assistant', content: '' },
      toolCalls: [{ id: 'call_1', name: 'whoami', arguments: {} }],
    },
  ]);

  let threw = false;
  try {
    await runTurn({
      userId: 'x',
      taskId: 'task-failing-turn',
      messages: [{ role: 'user', content: 'hi' }],
      llm,
      db,
      tools,
    });
  } catch {
    threw = true;
  }
  assert(threw, 'runTurn rethrows when the LLM call itself fails mid-turn');
  assert(pool.turnMetricsInserts.length === 1, 'a failed turn still writes exactly one turn_metrics row');

  const m = pool.turnMetricsInserts[0];
  assert(m.outcome === 'error', 'turn_metrics records outcome error for a failed turn');
  assert(typeof m.errorReason === 'string' && m.errorReason.length > 0, 'turn_metrics captures a populated error_reason');
  assert(m.roundCount === 1, 'turn_metrics round_count reflects only the round that completed before the failure');
  assert(m.rounds[0].tool_calls.length === 1, 'the completed round\'s tool call is preserved in the failure-path row');
}

if (process.exitCode) {
  console.error('\nloop verification FAILED');
  process.exit(1);
}
console.log('\nloop verification passed');
