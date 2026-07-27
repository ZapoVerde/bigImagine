/**
 * @file plugins/temporal/src/listTemporalStateTool.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — the list_temporal_state RegisteredTool
 * @description
 * Returns the requesting user's own timers and alarm-classification scheduled jobs (both
 * RLS-scoped: db/migrations/0031_active_timers.sql, 0032_scheduled_jobs.sql), grouped by status —
 * every currently `running` timer plus any that finished or were cancelled within the last hour
 * (enough recent history to answer "did my timer go off?" without this becoming an unbounded
 * log), and every active alarm plus any alarm that fired within the last hour.
 * `classification = 'agent_routine'` jobs are deliberately excluded — nothing dispatches them
 * yet (jobPoll.ts), so surfacing them here would be reporting on a job that silently never runs.
 *
 * @api-declaration
 * createListTemporalStateTool() — returns the list_temporal_state RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface TimerRow {
  timer_id: string;
  label: string;
  duration_seconds: number;
  end_at: string;
  status: string;
}

interface AlarmRow {
  job_id: string;
  title: string;
  schedule_kind: string;
  time_of_day: string | null;
  timezone: string;
  status: string;
  next_run_at: string;
  last_run_at: string | null;
}

export function createListTemporalStateTool(): RegisteredTool {
  return {
    definition: {
      name: 'list_temporal_state',
      description:
        "List the requesting user's active timers and alarms — plus any that recently completed, fired, or were cancelled.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: async (_args, ctx) => {
      const timerRows = await ctx.db.query<TimerRow>(
        `select timer_id, label, duration_seconds, end_at, status from active_timers
         where status = 'running' or updated_at > now() - interval '1 hour'
         order by end_at asc`,
      );
      const timers = timerRows.map((r) => ({
        timerId: r.timer_id,
        label: r.label,
        durationSeconds: r.duration_seconds,
        endAt: r.end_at,
        status: r.status,
      }));

      const alarmRows = await ctx.db.query<AlarmRow>(
        `select job_id, title, schedule_kind, time_of_day, timezone, status, next_run_at, last_run_at from scheduled_jobs
         where classification = 'alarm' and (status = 'active' or updated_at > now() - interval '1 hour')
         order by next_run_at asc`,
      );
      const alarms = alarmRows.map((r) => ({
        jobId: r.job_id,
        title: r.title,
        scheduleKind: r.schedule_kind,
        timeOfDay: r.time_of_day,
        timezone: r.timezone,
        status: r.status,
        nextRunAt: r.next_run_at,
        lastRunAt: r.last_run_at,
      }));

      return {
        running: timers.filter((t) => t.status === 'running'),
        completed: timers.filter((t) => t.status === 'completed'),
        cancelled: timers.filter((t) => t.status === 'cancelled'),
        upcomingAlarms: alarms.filter((a) => a.status === 'active'),
        recentlyFiredAlarms: alarms.filter((a) => a.status !== 'active'),
      };
    },
  };
}
