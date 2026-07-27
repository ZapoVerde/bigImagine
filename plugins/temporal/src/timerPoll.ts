/**
 * @file plugins/temporal/src/timerPoll.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — active_timers background poll loop
 * @description
 * active_timers is RLS-forced per user_id (db/migrations/0031_active_timers.sql's `force row
 * level security`), so there is no single unscoped query that can see every household member's
 * due timers at once — the same constraint plugins/lists' notionReconcile.ts works within.
 * withSystemScope reads the user roster (`users` has no RLS at all, db/migrations/0002_schema.sql,
 * same as provider_credentials), then each user's own due timers are flipped inside that user's
 * own withUserScope transaction, one at a time — same per-row-scoped-transaction shape
 * notionReconcile.ts uses per page, just at the user level here since there's no cross-user work
 * to parallelize within a tick.
 *
 * The UPDATE itself is the atomic claim: `where status = 'running' and end_at <= now()` inside a
 * single statement means two overlapping ticks can't both flip the same row (Postgres locks the
 * row it's updating), so no separate SELECT ... FOR UPDATE step is needed here — unlike
 * scheduled_jobs' cron dispatch (a later stage), a timer completing has no side effect beyond the
 * status flip itself, so there's nothing a double-fire could duplicate.
 *
 * @api-declaration
 * startTimerPollLoop(db) — begins polling every POLL_INTERVAL_MS; never returns, logs and
 *   continues on a failed tick rather than crashing the loop (bb_principles.md §11)
 * pollTick(db) — one poll cycle, exported so verify scripts can drive it directly instead of
 *   waiting on real wall-clock intervals
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO; owns the interval timer)
 *     state_ownership: [the setInterval timer this starts]
 *     external_io:     [Postgres, via the PostgresClient it's given]
 */

import { log } from '@bigbrain/orchestrator/logger';
import type { PostgresClient } from '@bigbrain/orchestrator/postgres';

const POLL_INTERVAL_MS = 3_000;

interface UserRow {
  user_id: string;
}

interface CompletedTimerRow {
  timer_id: string;
}

async function completeDueTimersForUser(db: PostgresClient, userId: string): Promise<void> {
  await db.withUserScope(userId, async (session) => {
    const completed = await session.query<CompletedTimerRow>(
      `update active_timers set status = 'completed', updated_at = now()
       where status = 'running' and end_at <= now()
       returning timer_id`,
    );
    for (const row of completed) {
      log.info('timer completed', { userId, timerId: row.timer_id });
    }
  });
}

export async function pollTick(db: PostgresClient): Promise<void> {
  const users = await db.withSystemScope((session) => session.query<UserRow>('select user_id from users'));
  for (const { user_id } of users) {
    await completeDueTimersForUser(db, user_id);
  }
}

export function startTimerPollLoop(db: PostgresClient): void {
  const tick = () => {
    pollTick(db).catch((err) => log.error('active_timers poll tick failed', err));
  };
  tick(); // don't wait a full interval before the first check
  setInterval(tick, POLL_INTERVAL_MS);
}
