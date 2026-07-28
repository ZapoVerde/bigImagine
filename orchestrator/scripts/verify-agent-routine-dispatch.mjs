// Proves agentRoutineDispatch.ts's own mechanics, independent of llmGate.ts's cap logic (covered
// separately by verify-llm-gate.mjs): claiming is per-user scoped the same way jobPoll.ts's alarm
// dispatch already proved (verify-temporal.mjs), a claimed 'once' job completes and a 'daily' job
// advances its next_run_at *before* the routine actually runs (not after — see the file's own
// doc on why that ordering matters), the routine runs inside its linked chat and only the wake
// message + reply get appended on success, and a routine whose linked chat no longer exists (or
// whose runTurn throws, e.g. llmGate.ts refusing it) is skipped without taking the whole tick down.

import { createPostgresClient } from '../dist/io/postgres.js';
import { createToolRegistry } from '../dist/orchestrator/toolRegistry.js';
import { createStubLlmProvider } from '../dist/io/llm/stub.js';
import { dispatchDueAgentRoutinesTick } from '../dist/orchestrator/agentRoutineDispatch.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakePool(jobs) {
  const updates = [];
  return {
    updates,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }
          if (sql.includes('select user_id from users')) {
            const ids = [...new Set(jobs.map((j) => j.user_id))];
            return { rows: ids.map((user_id) => ({ user_id })) };
          }
          if (sql.includes('select job_id, title, instructions, schedule_kind, time_of_day, timezone, linked_chat_id')) {
            const now = Date.now();
            const due = jobs.filter(
              (j) => j.user_id === scopedUserId && j.status === 'active' && new Date(j.next_run_at).getTime() <= now,
            );
            return {
              rows: due.map((j) => ({
                job_id: j.job_id,
                title: j.title,
                instructions: j.instructions,
                schedule_kind: j.schedule_kind,
                time_of_day: j.time_of_day,
                timezone: j.timezone,
                linked_chat_id: j.linked_chat_id,
              })),
            };
          }
          if (sql.includes('update scheduled_jobs set last_run_at = now(), next_run_at')) {
            const [jobId, nextRunAt] = params;
            const job = jobs.find((j) => j.job_id === jobId);
            job.next_run_at = nextRunAt;
            updates.push({ jobId, type: 'daily-advance', nextRunAt });
            return { rows: [] };
          }
          if (sql.includes("update scheduled_jobs set status = 'completed'")) {
            const [jobId] = params;
            const job = jobs.find((j) => j.job_id === jobId);
            job.status = 'completed';
            updates.push({ jobId, type: 'completed' });
            return { rows: [] };
          }
          throw new Error(`fake pool: unhandled query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

function createFakeChats(chatMap) {
  const appended = [];
  return {
    appended,
    async getChat(userId, chatId) {
      return chatMap.get(chatId);
    },
    async appendMessages(userId, chatId, messages) {
      appended.push({ userId, chatId, messages });
      const chat = chatMap.get(chatId);
      if (chat) chat.messages.push(...messages.map((m) => ({ messageId: `m-${appended.length}`, role: m.role, content: m.content, createdAt: new Date().toISOString() })));
    },
  };
}

function createFakeSettings(values = {}) {
  return { async get(key) { return values[key]; }, async set() {} };
}

const past = new Date(Date.now() - 1000).toISOString();

// --- a due 'once' agent_routine job completes, runs inside its linked chat, and the exchange is persisted ---
{
  const jobs = [
    {
      user_id: 'user-a',
      job_id: 'job-once',
      title: 'One-off digest',
      instructions: 'Say hello.',
      schedule_kind: 'once',
      time_of_day: null,
      timezone: 'America/Los_Angeles',
      linked_chat_id: 'chat-1',
      status: 'active',
      next_run_at: past,
    },
  ];
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const chats = createFakeChats(new Map([['chat-1', { session: { params: {}, toolNames: null }, messages: [] }]]));
  const llm = createStubLlmProvider([{ message: { role: 'assistant', content: 'Hello!' }, toolCalls: [] }]);
  const tools = createToolRegistry([]);
  const settings = createFakeSettings({ household_timezone: 'America/Los_Angeles' });

  await dispatchDueAgentRoutinesTick({ db, llm, tools, chats, settings });

  assert(jobs[0].status === 'completed', "a due 'once' agent_routine job flips to completed after claiming");
  assert(pool.updates.length === 1 && pool.updates[0].type === 'completed', 'the state advance happens (completed), proving claim-before-run ordering');
  assert(chats.appended.length === 1, 'the wake message + reply are appended to the linked chat');
  const [wakeMsg, replyMsg] = chats.appended[0].messages;
  assert(wakeMsg.role === 'user' && wakeMsg.content.includes('Say hello.'), 'the synthetic wake message carries the job\'s own instructions');
  assert(replyMsg.role === 'assistant' && replyMsg.content === 'Hello!', 'the routine\'s actual reply is what gets persisted');
}

// --- a due 'daily' agent_routine job advances next_run_at, not completed, and still runs ---
{
  const jobs = [
    {
      user_id: 'user-a',
      job_id: 'job-daily',
      title: 'Morning digest',
      instructions: 'Summarize the news.',
      schedule_kind: 'daily',
      time_of_day: '07:00',
      timezone: 'America/Los_Angeles',
      linked_chat_id: 'chat-2',
      status: 'active',
      next_run_at: past,
    },
  ];
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const chats = createFakeChats(new Map([['chat-2', { session: { params: {}, toolNames: null }, messages: [] }]]));
  const llm = createStubLlmProvider([{ message: { role: 'assistant', content: 'Here is the news.' }, toolCalls: [] }]);
  const tools = createToolRegistry([]);
  const settings = createFakeSettings({ household_timezone: 'America/Los_Angeles' });

  await dispatchDueAgentRoutinesTick({ db, llm, tools, chats, settings });

  assert(jobs[0].status === 'active', "a due 'daily' agent_routine job stays active, unlike 'once'");
  assert(pool.updates.length === 1 && pool.updates[0].type === 'daily-advance', 'next_run_at advances forward instead of completing');
  assert(new Date(jobs[0].next_run_at).getTime() > Date.now(), 'the advanced next_run_at is genuinely in the future');
  assert(chats.appended.length === 1, 'a daily routine still actually runs the same tick it was claimed');
}

// --- a routine whose linked chat no longer exists is skipped, not thrown out of the tick ---
{
  const jobs = [
    {
      user_id: 'user-a',
      job_id: 'job-orphan',
      title: 'Orphaned routine',
      instructions: 'Do something.',
      schedule_kind: 'once',
      time_of_day: null,
      timezone: 'UTC',
      linked_chat_id: 'chat-deleted',
      status: 'active',
      next_run_at: past,
    },
  ];
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const chats = createFakeChats(new Map()); // chat-deleted isn't in the map
  const llm = createStubLlmProvider([]); // should never be called
  const tools = createToolRegistry([]);
  const settings = createFakeSettings({ household_timezone: 'UTC' });

  let threw = false;
  try {
    await dispatchDueAgentRoutinesTick({ db, llm, tools, chats, settings });
  } catch {
    threw = true;
  }
  assert(!threw, 'a missing linked chat is skipped gracefully, not a crash of the whole tick');
  assert(chats.appended.length === 0, 'nothing is appended when there is no chat to append to');
}

// --- per-user scoping: user-b never sees or claims user-a's due routines ---
{
  const jobs = [
    { user_id: 'user-a', job_id: 'job-a', title: 't', instructions: 'i', schedule_kind: 'once', time_of_day: null, timezone: 'UTC', linked_chat_id: 'chat-a', status: 'active', next_run_at: past },
    { user_id: 'user-b', job_id: 'job-b', title: 't', instructions: 'i', schedule_kind: 'once', time_of_day: null, timezone: 'UTC', linked_chat_id: 'chat-b', status: 'active', next_run_at: past },
  ];
  const pool = createFakePool(jobs);
  const db = createPostgresClient(pool);
  const chats = createFakeChats(
    new Map([
      ['chat-a', { session: { params: {}, toolNames: null }, messages: [] }],
      ['chat-b', { session: { params: {}, toolNames: null }, messages: [] }],
    ]),
  );
  const llm = createStubLlmProvider([
    { message: { role: 'assistant', content: 'a done' }, toolCalls: [] },
    { message: { role: 'assistant', content: 'b done' }, toolCalls: [] },
  ]);
  const tools = createToolRegistry([]);
  const settings = createFakeSettings({ household_timezone: 'UTC' });

  await dispatchDueAgentRoutinesTick({ db, llm, tools, chats, settings });

  assert(jobs[0].status === 'completed' && jobs[1].status === 'completed', 'both users\' own due routines run in the same tick, each scoped to itself');
  assert(chats.appended.length === 2, 'each user\'s routine appends only to its own linked chat');
}

if (process.exitCode) {
  console.error('\nagent_routine dispatch verification FAILED');
  process.exit(1);
}
console.log('\nagent_routine dispatch verification passed');
