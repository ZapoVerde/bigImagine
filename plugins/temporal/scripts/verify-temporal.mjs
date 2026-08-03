// Proves all four tools end to end through info/registerTools (the real loader contract), plus
// timerPoll.ts's pollTick and jobPoll.ts's pollJobsTick directly (rather than waiting on real
// wall-clock setInterval ticks) — same small stateful fake Postgres pool style as plugins/lists'
// verify-lists.mjs, since these tools genuinely depend on prior state. Also proves a fired 'alarm'
// job actually delivers through the NotificationProvider it's given (this is the bug: jobPoll.ts
// used to only flip scheduled_jobs' status, never deliver anything), and that a fired alarm with
// no provider configured just advances state without erroring.

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { info, registerTools } from '../dist/index.js';
import { pollTick } from '../dist/timerPoll.js';
import { pollJobsTick } from '../dist/jobPoll.js';
import { nextDailyOccurrence } from '@bigbrain/orchestrator/next-occurrence';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakePool(users) {
  const timers = [];
  const jobs = [];
  const notificationLogs = [];
  let timerCounter = 0;
  let jobCounter = 0;

  return {
    timers,
    jobs,
    notificationLogs,
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
            return { rows: users.map((u) => ({ user_id: u })) };
          }

          if (sql.includes('insert into active_timers')) {
            const [userId, label, durationSeconds, endAt, linkedNoteId, linkedChatId] = params;
            assert(scopedUserId === userId, 'set_timer inserts scoped to the requesting user');
            const timer_id = `timer-${++timerCounter}`;
            timers.push({
              timer_id,
              user_id: userId,
              label: label ?? 'Timer',
              duration_seconds: durationSeconds,
              end_at: endAt,
              status: 'running',
              linked_note_id: linkedNoteId,
              linked_chat_id: linkedChatId,
              updated_at: new Date().toISOString(),
            });
            const row = timers[timers.length - 1];
            return { rows: [{ timer_id: row.timer_id, label: row.label, duration_seconds: row.duration_seconds, end_at: row.end_at, status: row.status }] };
          }

          if (sql.includes("update active_timers set status = 'cancelled'")) {
            const [timerId] = params;
            const timer = timers.find((t) => t.timer_id === timerId && t.user_id === scopedUserId && t.status === 'running');
            if (!timer) return { rows: [] };
            timer.status = 'cancelled';
            timer.updated_at = new Date().toISOString();
            return { rows: [{ timer_id: timer.timer_id }] };
          }

          if (sql.includes("update active_timers set status = 'completed'")) {
            const now = Date.now();
            const due = timers.filter((t) => t.user_id === scopedUserId && t.status === 'running' && new Date(t.end_at).getTime() <= now);
            for (const t of due) {
              t.status = 'completed';
              t.updated_at = new Date().toISOString();
            }
            return { rows: due.map((t) => ({ timer_id: t.timer_id })) };
          }

          if (sql.includes('select timer_id, label, duration_seconds, end_at, status from active_timers')) {
            const oneHourAgo = Date.now() - 60 * 60 * 1000;
            const rows = timers.filter(
              (t) => t.user_id === scopedUserId && (t.status === 'running' || new Date(t.updated_at).getTime() > oneHourAgo),
            );
            return { rows: rows.map((t) => ({ timer_id: t.timer_id, label: t.label, duration_seconds: t.duration_seconds, end_at: t.end_at, status: t.status })) };
          }

          if (sql.includes('insert into scheduled_jobs')) {
            const [userId, title, classification, scheduleKind, timeOfDay, timezone, nextRunAt, linkedChatId, instructions, maxRunsPerDay, maxTokensPerDay] = params;
            assert(scopedUserId === userId, 'schedule_routine inserts scoped to the requesting user');
            const job_id = `job-${++jobCounter}`;
            jobs.push({
              job_id,
              user_id: userId,
              title,
              classification,
              schedule_kind: scheduleKind,
              time_of_day: timeOfDay,
              timezone,
              status: 'active',
              last_run_at: null,
              next_run_at: nextRunAt,
              linked_chat_id: linkedChatId,
              instructions,
              max_runs_per_day: maxRunsPerDay,
              max_tokens_per_day: maxTokensPerDay,
              updated_at: new Date().toISOString(),
            });
            const row = jobs[jobs.length - 1];
            return { rows: [row] };
          }

          if (sql.includes('update scheduled_jobs set status = $2')) {
            const [jobId, status] = params;
            const job = jobs.find((j) => j.job_id === jobId && j.user_id === scopedUserId);
            if (!job) return { rows: [] };
            job.status = status;
            job.updated_at = new Date().toISOString();
            return { rows: [job] };
          }

          if (sql.includes("select job_id, title, schedule_kind, time_of_day, timezone, next_run_at from scheduled_jobs")) {
            const now = Date.now();
            const due = jobs.filter(
              (j) => j.user_id === scopedUserId && j.status === 'active' && j.classification === 'alarm' && new Date(j.next_run_at).getTime() <= now,
            );
            return { rows: due.map((j) => ({ job_id: j.job_id, title: j.title, schedule_kind: j.schedule_kind, time_of_day: j.time_of_day, timezone: j.timezone, next_run_at: j.next_run_at })) };
          }

          if (sql.includes('update scheduled_jobs set last_run_at = $2, next_run_at = $3')) {
            const [jobId, lastRunAt, nextRunAt] = params;
            const job = jobs.find((j) => j.job_id === jobId);
            job.last_run_at = lastRunAt;
            job.next_run_at = nextRunAt;
            job.updated_at = new Date().toISOString();
            return { rows: [] };
          }

          if (sql.includes("update scheduled_jobs set status = 'completed'")) {
            const [jobId, lastRunAt] = params;
            const job = jobs.find((j) => j.job_id === jobId);
            job.status = 'completed';
            job.last_run_at = lastRunAt;
            job.updated_at = new Date().toISOString();
            return { rows: [] };
          }

          if (sql.includes('select job_id, title, schedule_kind, time_of_day, timezone, status, next_run_at, last_run_at from scheduled_jobs')) {
            const oneHourAgo = Date.now() - 60 * 60 * 1000;
            const rows = jobs.filter(
              (j) =>
                j.user_id === scopedUserId &&
                j.classification === 'alarm' &&
                (j.status === 'active' || new Date(j.updated_at).getTime() > oneHourAgo),
            );
            return {
              rows: rows.map((j) => ({
                job_id: j.job_id,
                title: j.title,
                schedule_kind: j.schedule_kind,
                time_of_day: j.time_of_day,
                timezone: j.timezone,
                status: j.status,
                next_run_at: j.next_run_at,
                last_run_at: j.last_run_at,
              })),
            };
          }

          if (sql.includes('insert into notification_logs')) {
            const [userId, title, body, priority, status, error] = params;
            assert(scopedUserId === userId, 'alarm notification_logs insert is scoped to the requesting user');
            notificationLogs.push({ user_id: userId, title, body, priority, status, error });
            return { rows: [] };
          }

          if (sql.includes('select count(*)::text as count from notification_logs')) {
            const [userId] = params;
            const count = notificationLogs.filter((l) => l.user_id === userId && l.status === 'sent').length;
            return { rows: [{ count: String(count) }] };
          }

          throw new Error(`fake pool: unhandled query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

assert(info.id === 'temporal' && /^[a-z0-9_-]+$/.test(info.id), 'info.id is present and matches the id format pluginLoader.ts requires');

const fakePool = createFakePool(['user-a', 'user-b']);
const db = createPostgresClient(fakePool);

const fakeSettings = { get: async () => 'America/Los_Angeles' };
const tools = await registerTools({ db, settings: fakeSettings });
assert(tools.length === 4, 'registerTools returns exactly four tools');
const registry = createToolRegistry(tools);
for (const name of ['set_timer', 'cancel_timer', 'list_temporal_state', 'schedule_routine']) {
  assert(registry.definitions().some((d) => d.name === name), `${name} is registered`);
}

// --- set_timer ---
let runningTimerId;
let shortTimerId;
await db.withUserScope('user-a', async (session) => {
  const result = await registry.get('set_timer').handler({ durationSeconds: 3600 }, { userId: 'user-a', db: session });
  assert(result.label === 'Timer', 'set_timer defaults label to "Timer" when omitted');
  assert(result.status === 'running', 'a newly-set timer is running');
  runningTimerId = result.timerId;

  const labeled = await registry.get('set_timer').handler({ durationSeconds: 1, label: 'Break' }, { userId: 'user-a', db: session });
  assert(labeled.label === 'Break', 'set_timer honors an explicit label');
  shortTimerId = labeled.timerId;
});

// --- cancel_timer ---
await db.withUserScope('user-a', async (session) => {
  const cancelled = await registry.get('cancel_timer').handler({ timerId: runningTimerId }, { userId: 'user-a', db: session });
  assert(cancelled.found === true && cancelled.status === 'cancelled', 'cancel_timer cancels a running timer');

  const again = await registry.get('cancel_timer').handler({ timerId: runningTimerId }, { userId: 'user-a', db: session });
  assert(again.found === false, 'cancelling an already-cancelled timer is a no-op, not an error');
});

// --- pollTick completes due timers, scoped per user ---
{
  await new Promise((resolve) => setTimeout(resolve, 1100)); // let shortTimerId's 1s duration elapse
  await pollTick(db);

  let sawCompleted = false;
  await db.withUserScope('user-a', async (session) => {
    const state = await registry.get('list_temporal_state').handler({}, { userId: 'user-a', db: session });
    sawCompleted = state.completed.some((t) => t.timerId === shortTimerId);
    assert(state.cancelled.some((t) => t.timerId === runningTimerId), 'list_temporal_state groups the cancelled timer under "cancelled"');
    assert(state.running.length === 0, 'no timers remain running for user-a after cancel + completion');
  });
  assert(sawCompleted, 'pollTick flips a due timer to completed');
}

// --- RLS scoping: user-b never sees user-a's timers ---
await db.withUserScope('user-b', async (session) => {
  const state = await registry.get('list_temporal_state').handler({}, { userId: 'user-b', db: session });
  assert(state.running.length === 0 && state.completed.length === 0 && state.cancelled.length === 0, "user-b's list_temporal_state sees none of user-a's timers");
});

// --- schedule_routine: create once/daily, defaults timezone from settings ---
let onceJobId;
let dailyJobId;
await db.withUserScope('user-a', async (session) => {
  const once = await registry.get('schedule_routine').handler(
    { title: 'Take out trash', scheduleKind: 'once', runAt: new Date(Date.now() - 1000).toISOString() },
    { userId: 'user-a', db: session },
  );
  assert(once.status === 'active' && once.timezone === 'America/Los_Angeles', 'a "once" job defaults timezone from household_timezone');
  onceJobId = once.jobId;

  const daily = await registry.get('schedule_routine').handler(
    { title: 'Morning standup', scheduleKind: 'daily', timeOfDay: '08:30' },
    { userId: 'user-a', db: session },
  );
  assert(daily.scheduleKind === 'daily' && daily.timeOfDay === '08:30', 'a "daily" job stores its time_of_day');
  dailyJobId = daily.jobId;

  let threwMissingFields = false;
  try {
    await registry.get('schedule_routine').handler(
      { title: 'nope', scheduleKind: 'once', runAt: new Date().toISOString(), classification: 'agent_routine' },
      { userId: 'user-a', db: session },
    );
  } catch {
    threwMissingFields = true;
  }
  assert(threwMissingFields, 'agent_routine still requires instructions + linkedChatId even now that dispatch exists');

  const routine = await registry.get('schedule_routine').handler(
    {
      title: 'Morning news digest',
      scheduleKind: 'daily',
      timeOfDay: '07:00',
      classification: 'agent_routine',
      instructions: 'Summarize the morning news and send a notification.',
      linkedChatId: 'chat-1',
    },
    { userId: 'user-a', db: session },
  );
  assert(routine.classification === 'agent_routine', 'agent_routine jobs can now be created given instructions + linkedChatId');
  assert(routine.instructions === 'Summarize the morning news and send a notification.', 'agent_routine stores its instructions');
  assert(routine.maxRunsPerDay === 5 && routine.maxTokensPerDay === 50000, 'agent_routine defaults its per-job caps when omitted');
});

// --- jobPoll: 'once' completes, 'daily' recomputes next_run_at forward, no provider configured
// (the pre-fix state: state still advances, nothing errors, nothing is delivered) ---
const noNotificationSettings = { get: async () => undefined };
await pollJobsTick(db, undefined, noNotificationSettings);
await db.withUserScope('user-a', async (session) => {
  const state = await registry.get('list_temporal_state').handler({}, { userId: 'user-a', db: session });
  const firedOnce = state.recentlyFiredAlarms.find((a) => a.jobId === onceJobId);
  assert(firedOnce && firedOnce.status === 'completed', 'a due "once" alarm fires and completes, not recur');
  assert(!state.upcomingAlarms.some((a) => a.jobId === onceJobId), 'a completed "once" alarm no longer appears as upcoming');
  assert(state.upcomingAlarms.some((a) => a.jobId === dailyJobId), 'the not-yet-due "daily" alarm stays upcoming');
});
assert(fakePool.notificationLogs.length === 0, 'firing an alarm with no NotificationProvider configured delivers nothing (and does not throw)');

// --- jobPoll: a due alarm WITH a NotificationProvider configured actually delivers (the bug this
// stage fixes — jobPoll.ts used to only flip scheduled_jobs' status and never call the provider) ---
{
  const sent = [];
  const stubProvider = { async send(serverUrl, params) { sent.push({ serverUrl, ...params }); return { ok: true }; } };
  const notifyEnabledSettings = {
    async get(key) {
      if (key === 'notifications_enabled') return 'true';
      if (key === 'ntfy_server_url') return 'https://ntfy.example.com';
      return 'America/Los_Angeles';
    },
  };

  let deliveredJobId;
  await db.withUserScope('user-a', async (session) => {
    const job = await registry.get('schedule_routine').handler(
      { title: 'The current time is 12:25', scheduleKind: 'once', runAt: new Date(Date.now() - 1000).toISOString() },
      { userId: 'user-a', db: session },
    );
    deliveredJobId = job.jobId;
  });

  await pollJobsTick(db, stubProvider, notifyEnabledSettings);

  assert(sent.length === 1, 'a fired alarm calls the configured NotificationProvider exactly once');
  assert(sent[0]?.title === 'The current time is 12:25', "the alarm's title becomes the notification title");
  assert(fakePool.notificationLogs.some((l) => l.status === 'sent' && l.title === 'The current time is 12:25'), 'the delivery is written to notification_logs with status "sent"');

  await db.withUserScope('user-a', async (session) => {
    const state = await registry.get('list_temporal_state').handler({}, { userId: 'user-a', db: session });
    const fired = state.recentlyFiredAlarms.find((a) => a.jobId === deliveredJobId);
    assert(fired && fired.status === 'completed', "the alarm's own status still advances alongside delivery");
  });
}

// --- schedule_routine: cancel/reactivate by jobId ---
await db.withUserScope('user-a', async (session) => {
  const cancelled = await registry.get('schedule_routine').handler({ jobId: dailyJobId, status: 'cancelled' }, { userId: 'user-a', db: session });
  assert(cancelled.found === true && cancelled.status === 'cancelled', 'schedule_routine cancels an existing job by id');

  const reactivated = await registry.get('schedule_routine').handler({ jobId: dailyJobId, status: 'active' }, { userId: 'user-a', db: session });
  assert(reactivated.status === 'active', 'schedule_routine reactivates a cancelled job');
});

// --- nextDailyOccurrence: correctly adjusts across a DST transition (America/New_York, 2026-03-08) ---
{
  const beforeDst = nextDailyOccurrence('08:30', 'America/New_York', new Date('2026-03-07T00:00:00Z'));
  assert(beforeDst.toISOString() === '2026-03-07T13:30:00.000Z', '8:30 AM EST (pre-DST) is 13:30 UTC');

  const afterDst = nextDailyOccurrence('08:30', 'America/New_York', new Date('2026-03-09T00:00:00Z'));
  assert(afterDst.toISOString() === '2026-03-09T12:30:00.000Z', '8:30 AM EDT (post-DST) is 12:30 UTC — the offset shifted by an hour');
}
