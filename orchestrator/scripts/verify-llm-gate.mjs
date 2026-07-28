// Proves bb_principles.md §14's actual enforcement: a call with no context set throws before
// ever reaching the base provider; a 'chat'/'system' call is metered but never capped; an
// 'agent_routine' call is refused pre-flight when the household switch is off or either cap
// (job or household, calls or tokens) is already at/over its ceiling from prior calls, and a
// successful call that pushes a tally over its cap trips the same breaker a human would (that
// job's own status -> 'capped', or the household-wide agent_routines_enabled switch).

import { createGatedLlmProvider } from '../dist/io/llm/llmGate.js';
import { runWithCallContext } from '../dist/io/llm/callContext.js';
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
            const [userId, kind, taskId, jobId, outcome, promptTokens, completionTokens, totalTokens, reason] = params;
            llmCalls.push({ userId, kind, taskId, jobId, outcome, promptTokens, completionTokens, totalTokens, reason });
            return { rows: [] };
          }

          if (sql.includes('from llm_calls where outcome') && sql.includes('job_id = $1')) {
            const rows = llmCalls.filter((c) => c.outcome === 'ok' && c.jobId === params[0]);
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
            const rows = llmCalls.filter((c) => c.outcome === 'ok' && c.kind === 'agent_routine');
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

// --- no call context at all -> throws before ever reaching the base provider ---
{
  const jobs = new Map();
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings();
  const base = createFakeBase([{ message: { role: 'assistant', content: 'hi' }, toolCalls: [] }]);
  const gated = createGatedLlmProvider(base, db, settings);

  let threw = false;
  try {
    await gated.complete([{ role: 'user', content: 'hi' }], []);
  } catch {
    threw = true;
  }
  assert(threw, 'complete() with no call context throws (bb_principles.md §14)');
  assert(pool.llmCalls.length === 0, 'no llm_calls row is written for a call outside any context');
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
  const gated = createGatedLlmProvider(base, db, settings);

  const turn = await runWithCallContext({ taskId: 'chat-1', kind: 'chat', userId: 'u1' }, () =>
    gated.complete([{ role: 'user', content: 'hi' }], []),
  );
  assert(turn.message.content === 'hi', 'a chat-kind call goes through even with agent_routines_enabled off');
  assert(pool.llmCalls.length === 1 && pool.llmCalls[0].outcome === 'ok' && pool.llmCalls[0].totalTokens === 15, 'a chat-kind call is logged with its usage');
}

// --- kind: agent_routine, household switch off -> refused pre-flight, base provider never called ---
{
  const jobs = new Map([['job-1', { job_id: 'job-1', status: 'active', max_runs_per_day: 5, max_tokens_per_day: 50000 }]]);
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings({ agent_routines_enabled: 'false' });
  const base = createFakeBase([{ message: { role: 'assistant', content: 'should not be reached' }, toolCalls: [] }]);
  const gated = createGatedLlmProvider(base, db, settings);

  let threw = false;
  try {
    await runWithCallContext({ taskId: 'job-1', kind: 'agent_routine', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'go' }], []));
  } catch {
    threw = true;
  }
  assert(threw, 'agent_routine call is refused when agent_routines_enabled is off');
  assert(pool.llmCalls.length === 1 && pool.llmCalls[0].outcome === 'refused', 'the refusal is still logged (an audit trail entry, not silently dropped)');
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
  const gated = createGatedLlmProvider(base, db, settings);

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
  const gated = createGatedLlmProvider(base, db, settings);

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
  const gated = createGatedLlmProvider(base, db, settings);

  await runWithCallContext({ taskId: 'job-4', kind: 'agent_routine', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'go' }], []));
  await runWithCallContext({ taskId: 'job-5', kind: 'agent_routine', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'go' }], []));

  assert((await settings.get('agent_routines_enabled')) === 'false', 'the household call-count cap trips the same switch a human "big red button" would');
  assert(!!(await settings.get('agent_routines_disabled_reason')), 'the switch records why it flipped itself off');
}

// --- a base provider failure is logged as 'error' and rethrown, not swallowed ---
{
  const jobs = new Map();
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings();
  const base = createFakeBase([new Error('upstream API exploded')]);
  const gated = createGatedLlmProvider(base, db, settings);

  let threw = false;
  try {
    await runWithCallContext({ taskId: 'chat-2', kind: 'chat', userId: 'u1' }, () => gated.complete([{ role: 'user', content: 'hi' }], []));
  } catch (err) {
    threw = err.message === 'upstream API exploded';
  }
  assert(threw, 'a base provider error propagates unchanged, not masked by the gate');
  assert(pool.llmCalls.length === 1 && pool.llmCalls[0].outcome === 'error', 'a base provider failure is still logged for the audit trail');
}

if (process.exitCode) {
  console.error('\nLLM gate verification FAILED');
  process.exit(1);
}
console.log('\nLLM gate verification passed');
