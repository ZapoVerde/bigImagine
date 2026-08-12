// Proves the RP lane's shared streaming turn core (orchestrator/streamingTurn.ts,
// docs/plans/rp-streaming-plan.md) — the one place token-level streaming of an RP turn lives.
//
// The fake pool below is the same shape verify-loop.mjs uses: it simulates exactly the two
// statements postgres.ts issues (set_config then a query) per connection, captures every
// `insert into turn_metrics` (0041_turn_metrics.sql), and throws on anything unexpected — so
// this proves the *plumbing*: runStreamingRpTurn threads userId -> withUserScope ->
// turn_metrics, and that a mid-turn failure still produces exactly one metrics row with the
// right outcome, rather than losing the failure's shape.
//
// Streaming-specific assertions (what loop.ts's runTurn cannot cover):
//   - deltas arrive in order and concatenate to the provider's final content
//   - the fallback path (a provider with no completeStream) delivers one whole-reply delta
//   - a blank final reply is retried with the same message history, then fails loudly when the
//     budget is spent (mirroring loop.ts's MAX_EMPTY_REPLY_RETRIES rule)
//   - an abort mid-turn surfaces as an isAbortError (the shape POST /v1/chat/abort relies on)

import { createStubLlmProvider } from '../dist/io/llm/stub.js';
import { createPostgresClient } from '../dist/io/postgres.js';
import { runStreamingRpTurn } from '../dist/orchestrator/streamingTurn.js';
import { registerTurnAbort, abortTurn, unregisterTurnAbort, isAbortError } from '../dist/orchestrator/turnAbort.js';

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

function baseOpts(pool, llm, overrides = {}) {
  return {
    userId: 'u1',
    taskId: 'chat-stream-1',
    messages: [{ role: 'user', content: 'continue the scene' }],
    systemPrompt: 'You are Aria, a tavern keeper. Stay in character.',
    llm,
    db: createPostgresClient(pool),
    onDelta: () => {},
    ...overrides,
  };
}

// --- streaming provider: deltas arrive in order and concatenate to the final content ---
{
  const pool = createFakePool();
  const llm = createStubLlmProvider([
    { message: { role: 'assistant', content: 'The firelight flickers across the oak bar.' }, toolCalls: [], usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 } },
  ]);
  const deltas = [];
  const result = await runStreamingRpTurn(baseOpts(pool, llm, { onDelta: (d) => deltas.push(d) }));
  assert(deltas.length >= 2, 'the stub replays a multi-chunk reply through onDelta (not one big delta)');
  assert(deltas.join('') === 'The firelight flickers across the oak bar.', 'deltas concatenate to the provider\'s full reply');
  assert(result.content === 'The firelight flickers across the oak bar.', 'the resolved content matches the streamed text');
  assert(result.usage?.totalTokens === 20, 'vendor usage is relayed to the caller');
  assert(pool.turnMetricsInserts.length === 1, 'one turn_metrics row is written');
  assert(pool.turnMetricsInserts[0].outcome === 'ok', 'the metrics row records the ok outcome');
  assert(pool.turnMetricsInserts[0].roundCount === 1, 'the metrics row records one LLM round');
  assert(pool.setConfigCalls.length >= 1 && pool.setConfigCalls.every((u) => u === 'u1'), 'every DB touch is scoped to the user');
}

// --- fallback provider (no completeStream): one whole-reply delta via complete() ---
{
  const pool = createFakePool();
  const llm = createStubLlmProvider([
    { message: { role: 'assistant', content: 'A whole reply in one piece.' }, toolCalls: [], usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17 } },
  ]);
  delete llm.completeStream; // degrade to the complete()-only path
  const deltas = [];
  const result = await runStreamingRpTurn(baseOpts(pool, llm, { onDelta: (d) => deltas.push(d) }));
  assert(deltas.length === 1 && deltas[0] === 'A whole reply in one piece.', 'the fallback delivers exactly one whole-reply delta');
  assert(result.content === 'A whole reply in one piece.', 'the fallback resolves with the same content');
  assert(pool.turnMetricsInserts[0].outcome === 'ok', 'the fallback still writes an ok metrics row');
}

// --- blank replies are retried (same history), then fail loudly when the budget is spent ---
{
  const pool = createFakePool();
  const blank = { message: { role: 'assistant', content: '   ' }, toolCalls: [] };
  const llm = createStubLlmProvider([blank, blank, blank, blank]); // initial + 3 retries, all blank
  const deltas = [];
  let threw = false;
  try {
    await runStreamingRpTurn(baseOpts(pool, llm, { onDelta: (d) => deltas.push(d) }));
  } catch (err) {
    threw = err.message.includes('empty reply after 3 retries');
  }
  assert(threw, 'four blank replies exhaust the retry budget and fail the turn loudly');
  // Streaming cannot know a reply is blank until it ends — whitespace chunks may reach the
  // client live, but nothing meaningful ever does, and nothing is persisted.
  assert(deltas.join('').trim() === '', 'nothing meaningful was relayed to the client across the blank attempts');
  assert(pool.turnMetricsInserts.length === 1 && pool.turnMetricsInserts[0].outcome === 'error', 'the exhausted turn still leaves one error metrics row');
}

// --- a blank first attempt followed by a real reply succeeds (the retry is productive) ---
{
  const pool = createFakePool();
  const llm = createStubLlmProvider([
    { message: { role: 'assistant', content: '' }, toolCalls: [] },
    { message: { role: 'assistant', content: 'Second attempt says hello.' }, toolCalls: [] },
  ]);
  const deltas = [];
  const result = await runStreamingRpTurn(baseOpts(pool, llm, { onDelta: (d) => deltas.push(d) }));
  assert(result.content === 'Second attempt says hello.', 'a blank first attempt is retried and the second succeeds');
  assert(deltas.join('') === 'Second attempt says hello.', 'only the successful attempt\'s deltas reach the client');
  assert(pool.turnMetricsInserts[0].outcome === 'ok', 'the retried turn records an ok outcome');
}

// --- an abort mid-turn surfaces as isAbortError, exactly the shape /v1/chat/abort relies on ---
// A provider that yields control (awaits a tick) after the turn starts gives the test a window
// to fire abortTurn('chat-abort-1') — which aborts the controller runStreamingRpTurn registered
// under that taskId — and the signal the core passed into the provider call then reads aborted.
{
  const pool = createFakePool();
  const llm = {
    name: 'stub-abortable',
    supportsVision: false,
    async completeStream(_messages, _tools, onDelta, options) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (options?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      onDelta('partial text');
      return { message: { role: 'assistant', content: 'partial text' }, toolCalls: [] };
    },
  };
  const deltas = [];
  const turnPromise = runStreamingRpTurn(baseOpts(pool, llm, { taskId: 'chat-abort-1', onDelta: (d) => deltas.push(d) }));
  setTimeout(() => abortTurn('chat-abort-1'), 5);
  let threw = false;
  try {
    await turnPromise;
  } catch (err) {
    threw = isAbortError(err);
  }
  assert(threw, 'an aborted turn surfaces as an isAbortError');
  assert(deltas.length === 0, 'no deltas were relayed after the abort fired');
  assert(pool.turnMetricsInserts.length === 1 && pool.turnMetricsInserts[0].outcome === 'error', 'the aborted turn leaves one error metrics row');
}

if (process.exitCode) {
  console.error('\nstreaming turn verification FAILED');
  process.exit(1);
}
console.log('\nstreaming turn verification passed');
