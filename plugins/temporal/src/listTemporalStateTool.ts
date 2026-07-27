/**
 * @file plugins/temporal/src/listTemporalStateTool.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — the list_temporal_state RegisteredTool
 * @description
 * Returns the requesting user's own timers (RLS-scoped, db/migrations/0031_active_timers.sql),
 * grouped by status: every currently `running` timer, plus any that finished or were cancelled
 * within the last hour — enough recent history to answer "did my timer go off?" without this
 * tool becoming an unbounded timer log. Will also surface `scheduled_jobs` rows once
 * schedule_routine ships (a later stage) — the response shape is deliberately grouped-by-status
 * already so that addition doesn't need a reshape.
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

export function createListTemporalStateTool(): RegisteredTool {
  return {
    definition: {
      name: 'list_temporal_state',
      description: 'List the requesting user\'s active timers, plus any that recently completed or were cancelled.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: async (_args, ctx) => {
      const rows = await ctx.db.query<TimerRow>(
        `select timer_id, label, duration_seconds, end_at, status from active_timers
         where status = 'running' or updated_at > now() - interval '1 hour'
         order by end_at asc`,
      );
      const shaped = rows.map((r) => ({
        timerId: r.timer_id,
        label: r.label,
        durationSeconds: r.duration_seconds,
        endAt: r.end_at,
        status: r.status,
      }));
      return {
        running: shaped.filter((r) => r.status === 'running'),
        completed: shaped.filter((r) => r.status === 'completed'),
        cancelled: shaped.filter((r) => r.status === 'cancelled'),
      };
    },
  };
}
