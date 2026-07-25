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
  return {
    setConfigCalls,
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
    messages: [{ role: 'user', content: 'who am I?' }],
    llm,
    db,
    tools,
  });
  return { reply: result.content, setConfigCalls: pool.setConfigCalls };
}

const alice = await runForUser('11111111-1111-1111-1111-111111111111');
assert(alice.reply === 'done for 11111111-1111-1111-1111-111111111111', 'loop returns the LLM\'s final reply after the tool round-trip');
assert(
  alice.setConfigCalls.length === 1 && alice.setConfigCalls[0] === '11111111-1111-1111-1111-111111111111',
  'the tool call was scoped to the requesting user exactly once',
);

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
  const result = await runTurn({ userId: 'x', messages: [{ role: 'user', content: 'hi' }], llm, db, tools });
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
  const result = await runTurn({ userId: 'x', messages: [{ role: 'user', content: 'hi' }], llm, db, tools });
  assert(result.content === 'done anyway', 'a throwing focusHint never breaks the turn\'s reply');
  assert(result.focusedNoteId === undefined, 'a throwing focusHint just leaves focusedNoteId unset');
}

if (process.exitCode) {
  console.error('\nloop verification FAILED');
  process.exit(1);
}
console.log('\nloop verification passed');
