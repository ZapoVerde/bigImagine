// Proves all three tools end to end through info/registerTools (the real loader contract), plus
// timerPoll.ts's pollTick directly (rather than waiting on real wall-clock setInterval ticks) —
// same small stateful fake Postgres pool style as plugins/lists' verify-lists.mjs, since these
// tools genuinely depend on prior state (a timer inserted by one call is read/updated by another).

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { info, registerTools } from '../dist/index.js';
import { pollTick } from '../dist/timerPoll.js';

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
  let timerCounter = 0;

  return {
    timers,
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
            const [userId, label, durationSeconds, linkedListItemId, linkedNoteId, linkedChatId] = params;
            assert(scopedUserId === userId, 'set_timer inserts scoped to the requesting user');
            const timer_id = `timer-${++timerCounter}`;
            const endAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
            timers.push({
              timer_id,
              user_id: userId,
              label: label ?? 'Timer',
              duration_seconds: durationSeconds,
              end_at: endAt,
              status: 'running',
              linked_list_item_id: linkedListItemId,
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

const tools = await registerTools({ db });
assert(tools.length === 3, 'registerTools returns exactly three tools');
const registry = createToolRegistry(tools);
for (const name of ['set_timer', 'cancel_timer', 'list_temporal_state']) {
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
