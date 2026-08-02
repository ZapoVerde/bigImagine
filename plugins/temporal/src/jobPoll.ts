/**
 * @file plugins/temporal/src/jobPoll.ts
 * @stamp 2026-07-29
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
 * An 'alarm' is supposed to actually remind the household (scheduleRoutineTool.ts's own
 * description: "An alarm just reminds the household") — so once a due row's state is advanced,
 * this also delivers it through @bigbrain/orchestrator/notification-sender's
 * sendHouseholdNotification, the same shared gate-check-then-send-then-log path
 * plugins/notifications' send_push_notification tool uses. provider is undefined when ntfy_topic
 * isn't configured (same as notifications/index.ts's own registerTools gate) — the state
 * transition still happens, just with nothing to deliver through. A notification failure is
 * caught and logged, never rethrown: it must not roll back the job's own status update, which sits
 * in the same withUserScope transaction and has to commit regardless of whether delivery
 * succeeded (a stuck 'active' alarm would just re-fire and re-attempt forever).
 *
 * Only classification = 'alarm' is dispatched here — 'agent_routine' rows exist in the table
 * already (the schema accepts them) but are left completely untouched until a later stage adds
 * the household kill switch and per-job daily run cap that have to exist before anything
 * autonomous can run unattended.
 *
 * @api-declaration
 * startJobPollLoop(db, provider, settings) — begins polling every POLL_INTERVAL_MS
 * pollJobsTick(db, provider, settings) — one poll cycle, exported so verify scripts can drive it
 *   directly
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO; owns the interval timer; delegates to the given NotificationProvider)
 *     state_ownership: [the setInterval timer this starts]
 *     external_io:     [Postgres, via the PostgresClient it's given; whatever NotificationProvider it's given does]
 */

import { log } from '@bigbrain/orchestrator/logger';
import type { PostgresClient } from '@bigbrain/orchestrator/postgres';
import type { NotificationProvider } from '@bigbrain/orchestrator/ntfy-provider';
import { sendHouseholdNotification } from '@bigbrain/orchestrator/notification-sender';
import { nextDailyOccurrence } from '@bigbrain/orchestrator/next-occurrence';
import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';

type OrchestratorSettingsStore = PluginDeps['settings'];

const POLL_INTERVAL_MS = 5_000;

interface UserRow {
  user_id: string;
}

interface DueJobRow {
  job_id: string;
  title: string;
  schedule_kind: string;
  time_of_day: string | null;
  timezone: string;
  next_run_at: string;
}

async function fireDueAlarmsForUser(
  db: PostgresClient,
  userId: string,
  provider: NotificationProvider | undefined,
  settings: OrchestratorSettingsStore,
): Promise<void> {
  await db.withUserScope(userId, async (session) => {
    const due = await session.query<DueJobRow>(
      `select job_id, title, schedule_kind, time_of_day, timezone, next_run_at from scheduled_jobs
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

      if (provider) {
        try {
          await sendHouseholdNotification(session, userId, provider, settings, {
            title: job.title,
            message: 'Your scheduled alarm is due.',
            tags: ['alarm_clock'],
          });
        } catch (err) {
          log.error('alarm fired but its notification failed to send', { userId, jobId: job.job_id, err });
        }
      }
    }
  });
}

export async function pollJobsTick(
  db: PostgresClient,
  provider: NotificationProvider | undefined,
  settings: OrchestratorSettingsStore,
): Promise<void> {
  const users = await db.withSystemScope((session) => session.query<UserRow>('select user_id from users'));
  for (const { user_id } of users) {
    await fireDueAlarmsForUser(db, user_id, provider, settings);
  }
}

export function startJobPollLoop(
  db: PostgresClient,
  provider: NotificationProvider | undefined,
  settings: OrchestratorSettingsStore,
): void {
  const tick = () => {
    pollJobsTick(db, provider, settings).catch((err) => log.error('scheduled_jobs poll tick failed', err));
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
