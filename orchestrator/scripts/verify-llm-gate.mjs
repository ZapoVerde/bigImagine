// Proves bb_principles.md §14's actual enforcement: a call with no context set throws before
// ever reaching the base provider; a 'chat'/'system' call is metered but never capped; an
// 'agent_routine' call is refused pre-flight when the household switch is off or either cap
// (job or household, calls or tokens) is already at/over its ceiling from prior calls, and a
// successful call that pushes a tally over its cap trips the same breaker a human would (that
// job's own status -> 'capped', or the household-wide agent_routines_enabled switch).
//
// Also proves docs/llm-gate-plan.md's retry/queueing extension: a retryable failure (5xx/429, or
// a bare thrown transport error) is retried internally up to llm_gate_max_retries times with
// every attempt sharing one request_id, a non-retryable failure (4xx, malformed tool arguments)
// skips retry entirely, and retried attempts still count toward agent_routine caps (outcome
// 'error' rows, not just 'ok').

import { createGatedLlmProvider } from '../dist/io/llm/llmGate.js';
import { runWithCallContext, withCallLabel } from '../dist/io/llm/callContext.js';
import { createPostgresClient } from '../dist/io/postgres.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakeSettings(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

function createFakePool(jobs) {
  const llmCalls = [];
  return {
    llmCalls,
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };

          if (sql.includes('select status, max_runs_per_day, max_tokens_per_day from scheduled_jobs')) {
            const job = jobs.get(params[0]);
            return { rows: job ? [job] : [] };
          }

          if (sql.includes('insert into llm_calls')) {
            const [
              userId, kind, taskId, jobId, outcome, promptTokens, completionTokens, totalTokens, durationMs, reason, requestId, attempt,
              providerKind, model, cacheReadTokens, costUsd, callLabel,
            ] = params;
            llmCalls.push({
              userId, kind, taskId, jobId, outcome, promptTokens, completionTokens, totalTokens, durationMs, reason, requestId, attempt,
              providerKind, model, cacheReadTokens, costUsd, callLabel,
            });
            return { rows: [] };
          }

          // tallySince counts outcome in ('ok', 'error') — a retried attempt is still real spend
          // (docs/llm-gate-plan.md §6), only 'refused' (never reached the provider) is excluded.
          if (sql.includes('from llm_calls where outcome') && sql.includes('job_id = $1')) {
            const rows = llmCalls.filter((c) => (c.outcome === 'ok' || c.outcome === 'error') && c.jobId === params[0]);
            return {
              rows: [
                {
                  calls: String(rows.length),
                  tokens: String(rows.reduce((sum, c) => sum + (c.totalTokens ?? 0), 0)),
                },
              ],
            };
          }

          if (sql.includes('from llm_calls where outcome') && sql.includes("kind = 'agent_routine'")) {
            const rows = llmCalls.filter((c) => (c.outcome === 'ok' || c.outcome === 'error') && c.kind === 'agent_routine');
            return {
              rows: [
                {
                  calls: String(rows.length),
                  tokens: String(rows.reduce((sum, c) => sum + (c.totalTokens ?? 0), 0)),
                },
              ],
            };
          }

          if (sql.includes("update scheduled_jobs set status = 'capped'")) {
            const [jobId, reason] = params;
            const job = jobs.get(jobId);
            if (job && job.status === 'active') {
              job.status = 'capped';
              job.capped_reason = reason;
            }
            return { rows: [] };
          }

          throw new Error(`fake pool: unhandled query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

function createFakeBase(turns) {
  let i = 0;
  return {
    name: 'fake',
    supportsVision: false,
    async complete() {
      const next = turns[i++];
      if (!next) throw new Error('fake base provider called more times than scripted');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** A fake base with streaming capability: completeStream replays a scripted sequence of
 *  (delta | Error) steps per call, where a thrown Error aborts that call mid-stream (after
 *  whatever deltas preceded it in the script). */
function createFakeStreamingBase(scripts) {
  let callIndex = 0;
  const calls = [];
  return {
    name: 'fake-streaming',
    supportsVision: false,
    calls,
    async completeStream(messages, tools, onDelta) {
      const script = scripts[callIndex++];
      if (!script) throw new Error('fake streaming base called more times than scripted');
      calls.push({ messages, tools, deltas: [] });
      let text = '';
      for (const step of script) {
        if (step instanceof Error) throw step;
        text += step;
        calls[calls.length - 1].deltas.push(step);
        onDelta(step);
      }
      return { message: { role: 'assistant', content: text }, toolCalls: [], usage: { promptTokens: 5, completionTokens: text.length, totalTokens: 5 + text.length, cacheReadTokens: 2 } };
    },
  };
}

/** A fake resolved LlmProfile (io/llm/profiles.ts shape) with price tiers, so ok/refused rows can
 *  be asserted to carry providerKind/model/costUsd (docs/plans/llm-stats-page-plan.md). One shared
 *  instance for every construction below — the gate must never mutate the profile it is handed. */
function createFakeProfile() {
  return {
    kind: 'openai-compatible',
    model: 'fake-model',
    apiKey: 'x',
    baseUrl: 'https://fake.example/v1',
    supportsVision: false,
    priceInputPerMillion: 1,
    priceOutputPerMillion: 2,
    priceCacheHitPerMillion: 0.5,
  };
}

const PROFILE = createFakeProfile();

// --- no call context at all -> throws before ever reaching the base provider ---
{
  const jobs = new Map();
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings();
  const base = createFakeBase([{ message: { role: 'assistant', content: 'hi' }, toolCalls: [] }]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);

  let threw = false;
  try {
    await gated.complete([{ role: 'user', content: 'hi' }], []);
  } catch {
    threw = true;
  }
  assert(threw, 'complete() with no call context throws (bb_principles.md §14)');
  assert(pool.llmCalls.length === 0, 'no llm_calls row is written for a call outside any context');
}

// --- withCallLabel (docs/plans/llm-call-label-breakdown-plan.md): a call made inside the scope
// logs the label; a call in the same outer context but outside/after the scope does not retain
// it — proves the nesting narrows the context for exactly the labeled call, never mutates the
// outer one ---
{
  const jobs = new Map();
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings();
  const base = createFakeBase([
    { message: { role: 'assistant', content: 'labeled' }, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    { message: { role: 'assistant', content: 'unlabeled' }, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
  ]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);

  await runWithCallContext({ taskId: 'chat-label-1', kind: 'system', userId: 'u1' }, () =>
    withCallLabel('cleanup:header', () => gated.complete([{ role: 'user', content: 'hi' }], [])),
  );
  assert(pool.llmCalls.length === 1 && pool.llmCalls[0].callLabel === 'cleanup:header', 'a call made inside withCallLabel logs the label');

  await runWithCallContext({ taskId: 'chat-label-1', kind: 'system', userId: 'u1' }, () =>
    gated.complete([{ role: 'user', content: 'hi' }], []),
  );
  assert(
    pool.llmCalls.length === 2 && pool.llmCalls[1].callLabel === null,
    'a call in the same outer context but outside the withCallLabel scope carries no label — the nesting is scoped, not a mutation of the outer context',
  );

  let threw = false;
  try {
    withCallLabel('cleanup:header', () => gated.complete([{ role: 'user', content: 'hi' }], []));
  } catch {
    threw = true;
  }
  assert(threw, 'withCallLabel outside any runWithCallContext throws the same no-context bug error');
  assert(pool.llmCalls.length === 2, 'the out-of-context withCallLabel never reaches the provider');
}

// --- kind: chat -- metered, never capped, even with agent_routines_enabled off ---
{
  const jobs = new Map();
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings({ agent_routines_enabled: 'false' });
  const base = createFakeBase([
    { message: { role: 'assistant', content: 'hi' }, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
  ]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);

  const turn = await runWithCallContext({ taskId: 'chat-1', kind: 'chat', userId: 'u1' }, () =>
    gated.complete([{ role: 'user', content: 'hi' }], []),
  );
  assert(turn.message.content === 'hi', 'a chat-kind call goes through even with agent_routines_enabled off');
  assert(pool.llmCalls.length === 1 && pool.llmCalls[0].outcome === 'ok' && pool.llmCalls[0].totalTokens === 15, 'a chat-kind call is logged with its usage');
  assert(
    pool.llmCalls[0].providerKind === 'openai-compatible' && pool.llmCalls[0].model === 'fake-model',
    'an ok row is attributed with the resolved profile\'s provider kind and model',
  );
  assert(
    pool.llmCalls[0].cacheReadTokens === null && Math.abs(pool.llmCalls[0].costUsd - 0.00002) < 1e-12,
    `an ok row without cache hits prices the whole prompt at the input rate (cost ${pool.llmCalls[0].costUsd})`,
  );
}

// --- kind: agent_routine, household switch off -> refused pre-flight, base provider never called ---
{
  const jobs = new Map([['job-1', { job_id: 'job-1', status: 'active', max_runs_per_day: 5, max_tokens_per_day: 50000 }]]);
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings({ agent_routines_enabled: 'false' });
  const base = createFakeBase([{ message: { role: 'assistant', content: 'should not be reached' }, toolCalls: [] }]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);

  let threw = false;
  try {
    await runWithCallContext({ taskId: 'job-1', kind: 'agent_routine', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'go' }], []));
  } catch {
    threw = true;
  }
  assert(threw, 'agent_routine call is refused when agent_routines_enabled is off');
  assert(pool.llmCalls.length === 1 && pool.llmCalls[0].outcome === 'refused', 'the refusal is still logged (an audit trail entry, not silently dropped)');
  assert(
    pool.llmCalls[0].providerKind === 'openai-compatible' && pool.llmCalls[0].model === 'fake-model' && pool.llmCalls[0].costUsd === null,
    'a refused row carries provider/model attribution but never a usage-derived cost',
  );
}

// --- kind: agent_routine, enabled, under caps -> succeeds and is logged ---
{
  const jobs = new Map([['job-2', { job_id: 'job-2', status: 'active', max_runs_per_day: 5, max_tokens_per_day: 50000 }]]);
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings({ agent_routines_enabled: 'true', agent_routine_max_runs_per_day: '20', agent_routine_max_tokens_per_day: '200000' });
  const base = createFakeBase([
    { message: { role: 'assistant', content: 'did the thing' }, toolCalls: [], usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } },
  ]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);

  const turn = await runWithCallContext({ taskId: 'job-2', kind: 'agent_routine', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'go' }], []));
  assert(turn.message.content === 'did the thing', 'an agent_routine call under both caps succeeds');
  assert(jobs.get('job-2').status === 'active', 'the job stays active after one call well under its cap');
}

// --- per-job cap breach: a call that pushes the job's own tally to its cap flips that job to 'capped' ---
{
  const jobs = new Map([['job-3', { job_id: 'job-3', status: 'active', max_runs_per_day: 2, max_tokens_per_day: 50000 }]]);
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings({ agent_routines_enabled: 'true', agent_routine_max_runs_per_day: '20', agent_routine_max_tokens_per_day: '200000' });
  const base = createFakeBase([
    { message: { role: 'assistant', content: 'run 1' }, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    { message: { role: 'assistant', content: 'run 2' }, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
  ]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);

  await runWithCallContext({ taskId: 'job-3', kind: 'agent_routine', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'go' }], []));
  assert(jobs.get('job-3').status === 'active', 'still active after the first of two allowed calls');

  await runWithCallContext({ taskId: 'job-3', kind: 'agent_routine', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'go' }], []));
  assert(jobs.get('job-3').status === 'capped', 'the job flips to capped once its own call-count cap is reached');
  assert(!!jobs.get('job-3').capped_reason, 'a capped job records why');

  let threwThirdCall = false;
  try {
    await runWithCallContext({ taskId: 'job-3', kind: 'agent_routine', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'go' }], []));
  } catch {
    threwThirdCall = true;
  }
  assert(threwThirdCall, 'a capped job refuses any further call, pre-flight, without needing to re-tally');
}

// --- household cap breach: trips the same agent_routines_enabled switch a human would ---
{
  const jobs = new Map([
    ['job-4', { job_id: 'job-4', status: 'active', max_runs_per_day: 10, max_tokens_per_day: 50000 }],
    ['job-5', { job_id: 'job-5', status: 'active', max_runs_per_day: 10, max_tokens_per_day: 50000 }],
  ]);
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings({ agent_routines_enabled: 'true', agent_routine_max_runs_per_day: '2', agent_routine_max_tokens_per_day: '200000' });
  const base = createFakeBase([
    { message: { role: 'assistant', content: 'a' }, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    { message: { role: 'assistant', content: 'b' }, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
  ]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);

  await runWithCallContext({ taskId: 'job-4', kind: 'agent_routine', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'go' }], []));
  await runWithCallContext({ taskId: 'job-5', kind: 'agent_routine', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'go' }], []));

  assert((await settings.get('agent_routines_enabled')) === 'false', 'the household call-count cap trips the same switch a human "big red button" would');
  assert(!!(await settings.get('agent_routines_disabled_reason')), 'the switch records why it flipped itself off');
}

// --- a base provider failure, with retries off, is logged as 'error' and rethrown after one
// attempt, not swallowed ---
{
  const jobs = new Map();
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings({ llm_gate_max_retries: '0' });
  const base = createFakeBase([new Error('upstream API exploded')]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);

  let threw = false;
  try {
    await runWithCallContext({ taskId: 'chat-2', kind: 'chat', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'hi' }], []));
  } catch (err) {
    threw = err.message === 'upstream API exploded';
  }
  assert(threw, 'a base provider error propagates unchanged, not masked by the gate');
  assert(pool.llmCalls.length === 1 && pool.llmCalls[0].outcome === 'error', 'a base provider failure is still logged for the audit trail');
}

// --- retryable failure (bare thrown error, no HTTP status -> transport-level) succeeds on a
// later internal attempt; caller sees one resolved promise, never the intermediate failures ---
{
  const jobs = new Map();
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings({ llm_gate_max_retries: '3', llm_gate_retry_base_ms: '1', llm_gate_retry_max_ms: '2' });
  const base = createFakeBase([
    new Error('fetch failed'),
    new Error('fetch failed'),
    { message: { role: 'assistant', content: 'third time lucky' }, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
  ]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);

  const turn = await runWithCallContext({ taskId: 'chat-3', kind: 'chat', userId: 'u1' }, () =>
    gated.complete([{ role: 'user', content: 'hi' }], []),
  );
  assert(turn.message.content === 'third time lucky', 'a call that fails twice on a retryable error still resolves once it succeeds');
  assert(pool.llmCalls.length === 3, 'every attempt (2 failures + 1 success) gets its own llm_calls row');
  assert(
    pool.llmCalls.every((c) => c.requestId === pool.llmCalls[0].requestId),
    'every attempt of the same logical call shares one request_id',
  );
  assert(
    pool.llmCalls.map((c) => c.attempt).join(',') === '0,1,2',
    'attempt increments per retry, 0-indexed',
  );
  assert(
    pool.llmCalls[0].outcome === 'error' && pool.llmCalls[1].outcome === 'error' && pool.llmCalls[2].outcome === 'ok',
    'the two failed attempts are logged as error, the final one as ok',
  );
}

// --- a non-retryable failure (4xx) skips retry entirely, even with retries available ---
{
  const jobs = new Map();
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings({ llm_gate_max_retries: '3', llm_gate_retry_base_ms: '1', llm_gate_retry_max_ms: '2' });
  const base = createFakeBase([
    new Error('OpenAI-compatible API error 401: invalid api key'),
    { message: { role: 'assistant', content: 'should never be reached' }, toolCalls: [] },
  ]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);

  let threw = false;
  try {
    await runWithCallContext({ taskId: 'chat-4', kind: 'chat', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'hi' }], []));
  } catch (err) {
    threw = err.message.includes('401');
  }
  assert(threw, 'a 401 (request itself is wrong) is not retried and propagates immediately');
  assert(pool.llmCalls.length === 1, 'exactly one attempt is made — no retry burned on a non-retryable failure');
}

// --- retried attempts still count toward agent_routine caps, not just the eventual success ---
{
  const jobs = new Map([['job-6', { job_id: 'job-6', status: 'active', max_runs_per_day: 2, max_tokens_per_day: 50000 }]]);
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings({
    agent_routines_enabled: 'true',
    agent_routine_max_runs_per_day: '20',
    agent_routine_max_tokens_per_day: '200000',
    llm_gate_max_retries: '2',
    llm_gate_retry_base_ms: '1',
    llm_gate_retry_max_ms: '2',
  });
  const base = createFakeBase([
    new Error('fetch failed'),
    { message: { role: 'assistant', content: 'ok' }, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
  ]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);

  await runWithCallContext({ taskId: 'job-6', kind: 'agent_routine', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'go' }], []));
  assert(
    jobs.get('job-6').status === 'capped',
    'the one failed attempt plus the one successful attempt together reach the 2-call cap — retries are not free',
  );
}

// --- Streaming (completeStream, docs/plans/completed/rp-streaming-plan.md) ---

// A completeStream failure before any delta is relayed retries per the existing backoff config;
// the caller sees one resolved promise with all deltas from the successful attempt.
{
  const jobs = new Map();
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings({ llm_gate_max_retries: '3', llm_gate_retry_base_ms: '1', llm_gate_retry_max_ms: '2' });
  const base = createFakeStreamingBase([
    [new Error('fetch failed')], // attempt 0: dies before any delta
    [new Error('fetch failed')], // attempt 1: dies before any delta
    ['third time lucky'],        // attempt 2: succeeds
  ]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);
  assert(typeof gated.completeStream === 'function', 'gated provider mirrors completeStream when the base has one');

  const deltas = [];
  const turn = await runWithCallContext({ taskId: 'chat-stream-1', kind: 'chat', userId: 'u1' }, () =>
    gated.completeStream([{ role: 'user', content: 'hi' }], [], (d) => deltas.push(d)),
  );
  assert(turn.message.content === 'third time lucky', 'a pre-first-delta failure is retried and the stream resolves once a later attempt succeeds');
  assert(deltas.join('') === 'third time lucky', 'the caller sees only the successful attempt\'s deltas');
  assert(pool.llmCalls.length === 3, 'every attempt (2 failures + 1 success) gets its own llm_calls row');
  assert(
    pool.llmCalls.map((c) => c.outcome).join(',') === 'error,error,ok',
    'the two failed attempts are logged as error, the final one as ok',
  );
  assert(pool.llmCalls[2].cacheReadTokens === 2, 'an ok streaming row carries the provider-reported cache-read token count');
  assert(
    Math.abs(pool.llmCalls[2].costUsd - 0.000036) < 1e-12,
    `cached tokens are priced at the cache tier, the rest at input/output (cost ${pool.llmCalls[2].costUsd})`,
  );
}

// A failure injected AFTER the first delta has fired propagates immediately with NO retry —
// the user has already seen the relayed text, and a second generation would duplicate it.
{
  const jobs = new Map();
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings({ llm_gate_max_retries: '3', llm_gate_retry_base_ms: '1', llm_gate_retry_max_ms: '2' });
  const base = createFakeStreamingBase([
    ['partial text ', new Error('connection dropped mid-stream')],
    ['should never be reached'],
  ]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);

  let threw = false;
  const deltas = [];
  try {
    await runWithCallContext({ taskId: 'chat-stream-2', kind: 'chat', userId: 'u1' }, () =>
      gated.completeStream([{ role: 'user', content: 'hi' }], [], (d) => deltas.push(d)),
    );
  } catch (err) {
    threw = err.message === 'connection dropped mid-stream';
  }
  assert(threw, 'a post-first-delta failure propagates immediately, never silently retried');
  assert(base.calls.length === 1, 'exactly one attempt reaches the base provider — no retry after the first delta');
  assert(deltas.join('') === 'partial text ', 'the deltas already relayed stay relayed (the caller decides what the client sees)');
  assert(pool.llmCalls.length === 1 && pool.llmCalls[0].outcome === 'error', 'the failed stream is logged once, as error');
}

// A gated provider over a base with no completeStream has no completeStream — the
// "undefined means no capability, not broken" convention, so the caller's fallback to
// complete() is what runStreamingRpTurn uses.
{
  const jobs = new Map();
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings({ agent_routines_enabled: 'true' });
  const base = createFakeBase([{ message: { role: 'assistant', content: 'hi' }, toolCalls: [] }]);
  const gated = createGatedLlmProvider(base, db, settings, PROFILE);
  assert(gated.completeStream === undefined, 'gated provider has no completeStream when the base lacks one');
}

if (process.exitCode) {
  console.error('\nLLM gate verification FAILED');
  process.exit(1);
}
console.log('\nLLM gate verification passed');
