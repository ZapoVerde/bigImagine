/**
 * @file plugins/temporal/src/jobPoll.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — scheduled_jobs background poll loop (alarm classification only)
 * @description
 * Same per-user-scoped roster-then-loop shape as timerPoll.ts (scheduled_jobs is RLS-forced the
 * same way, db/migrations/0032_scheduled_jobs.sql). Unlike a timer completing (a bare status flip
 * with no further consequence), firing a 'daily' job needs a JS-computed next_run_at
 * (nextOccurrence.ts's IANA-zone-aware arithmetic) — not something a single SQL UPDATE can
 * express — so the claim is two statements inside one withUserScope transaction: `select ... for
 * update` locks the due rows first, so an overlapping tick can't also claim them (it will simply
 * find nothing left once this transaction commits and next_run_at has moved on), then each row is
 * updated individually with its computed next state.
 *
 * Only classification = 'alarm' is dispatched here — 'agent_routine' rows exist in the table
 * already (the schema accepts them) but are left completely untouched until a later stage adds
 * the household kill switch and per-job daily run cap that have to exist before anything
 * autonomous can run unattended.
 *
 * @api-declaration
 * startJobPollLoop(db) — begins polling every POLL_INTERVAL_MS
 * pollJobsTick(db) — one poll cycle, exported so verify scripts can drive it directly
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO; owns the interval timer)
 *     state_ownership: [the setInterval timer this starts]
 *     external_io:     [Postgres, via the PostgresClient it's given]
 */

import { log } from '@bigbrain/orchestrator/logger';
import type { PostgresClient } from '@bigbrain/orchestrator/postgres';
import { nextDailyOccurrence } from './nextOccurrence.js';

const POLL_INTERVAL_MS = 5_000;

interface UserRow {
  user_id: string;
}

interface DueJobRow {
  job_id: string;
  schedule_kind: string;
  time_of_day: string | null;
  timezone: string;
  next_run_at: string;
}

async function fireDueAlarmsForUser(db: PostgresClient, userId: string): Promise<void> {
  await db.withUserScope(userId, async (session) => {
    const due = await session.query<DueJobRow>(
      `select job_id, schedule_kind, time_of_day, timezone, next_run_at from scheduled_jobs
       where status = 'active' and classification = 'alarm' and next_run_at <= now()
       for update`,
    );
    for (const job of due) {
      const firedAt = new Date(job.next_run_at);
      if (job.schedule_kind === 'daily' && job.time_of_day) {
        const nextRunAt = nextDailyOccurrence(job.time_of_day, job.timezone, firedAt);
        await session.query(
          `update scheduled_jobs set last_run_at = $2, next_run_at = $3, updated_at = now() where job_id = $1`,
          [job.job_id, firedAt.toISOString(), nextRunAt.toISOString()],
        );
      } else {
        await session.query(
          `update scheduled_jobs set status = 'completed', last_run_at = $2, updated_at = now() where job_id = $1`,
          [job.job_id, firedAt.toISOString()],
        );
      }
      log.info('scheduled alarm fired', { userId, jobId: job.job_id });
    }
  });
}

export async function pollJobsTick(db: PostgresClient): Promise<void> {
  const users = await db.withSystemScope((session) => session.query<UserRow>('select user_id from users'));
  for (const { user_id } of users) {
    await fireDueAlarmsForUser(db, user_id);
  }
}

export function startJobPollLoop(db: PostgresClient): void {
  const tick = () => {
    pollJobsTick(db).catch((err) => log.error('scheduled_jobs poll tick failed', err));
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
