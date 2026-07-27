/**
 * @file plugins/temporal/src/scheduleRoutineTool.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — the schedule_routine RegisteredTool
 * @description
 * Two shapes in one tool, distinguished by whether jobId is present: creating a new job (title +
 * scheduleKind + runAt/timeOfDay), or updating an existing one's status (active <-> cancelled) —
 * the only update this stage needs. classification defaults to 'alarm'; 'agent_routine' is
 * rejected here even though db/migrations/0032_scheduled_jobs.sql's CHECK already accepts it —
 * the schema is future-proofed for it, but nothing dispatches it yet (no kill switch, no per-job
 * run cap), so creating one now would silently produce a job that never fires. timezone defaults
 * to household_timezone (deps.settings), same pattern as plugins/calendar's
 * get_calendar_schedule and math-utils' date_math.
 *
 * @api-declaration
 * createScheduleRoutineTool(settings) — returns the schedule_routine RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session; reads household_timezone
 *                      live via settings on every create call)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), orchestrator_settings (via settings)]
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { nextDailyOccurrence } from './nextOccurrence.js';

type OrchestratorSettingsStore = PluginDeps['settings'];

interface JobRow {
  job_id: string;
  title: string;
  classification: string;
  schedule_kind: string;
  time_of_day: string | null;
  timezone: string;
  status: string;
  next_run_at: string;
}

function shapeJob(row: JobRow) {
  return {
    jobId: row.job_id,
    title: row.title,
    classification: row.classification,
    scheduleKind: row.schedule_kind,
    timeOfDay: row.time_of_day,
    timezone: row.timezone,
    status: row.status,
    nextRunAt: row.next_run_at,
  };
}

interface CreateArgs {
  title: string;
  scheduleKind: 'once' | 'daily';
  runAt?: string;
  timeOfDay?: string;
  timezone?: string;
  classification?: 'alarm' | 'agent_routine';
  linkedChatId?: string;
}

interface UpdateArgs {
  jobId: string;
  status: 'active' | 'cancelled';
}

type ScheduleRoutineArgs = CreateArgs | UpdateArgs;

function isUpdateArgs(value: Record<string, unknown>): boolean {
  return typeof value.jobId === 'string' && value.jobId !== '';
}

function isCreateArgs(value: Record<string, unknown>): boolean {
  if (typeof value.title !== 'string' || value.title.trim() === '') return false;
  if (value.scheduleKind !== 'once' && value.scheduleKind !== 'daily') return false;
  if (value.scheduleKind === 'once' && typeof value.runAt !== 'string') return false;
  if (value.scheduleKind === 'daily' && typeof value.timeOfDay !== 'string') return false;
  if (value.timezone !== undefined && typeof value.timezone !== 'string') return false;
  if (value.classification !== undefined && value.classification !== 'alarm' && value.classification !== 'agent_routine') return false;
  if (value.linkedChatId !== undefined && typeof value.linkedChatId !== 'string') return false;
  return true;
}

function isScheduleRoutineArgs(value: unknown): value is ScheduleRoutineArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.jobId === 'string' && v.jobId !== '') {
    return isUpdateArgs(v) && (v.status === 'active' || v.status === 'cancelled');
  }
  return isCreateArgs(v);
}

export function createScheduleRoutineTool(settings: OrchestratorSettingsStore): RegisteredTool {
  return {
    definition: {
      name: 'schedule_routine',
      description:
        'Create a one-time or daily-recurring alarm, or cancel/reactivate one by jobId. Only human-facing alarms are supported right now, not autonomous routines.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Provide to update (status only) an existing job instead of creating a new one.' },
          status: { type: 'string', enum: ['active', 'cancelled'], description: 'Required when jobId is given.' },
          title: { type: 'string', description: 'What the alarm is for, e.g. "Take medication".' },
          scheduleKind: { type: 'string', enum: ['once', 'daily'], description: '"once" fires a single time; "daily" recurs.' },
          runAt: { type: 'string', description: 'ISO timestamp. Required when scheduleKind is "once".' },
          timeOfDay: { type: 'string', description: '24h "HH:MM". Required when scheduleKind is "daily".' },
          timezone: { type: 'string', description: 'IANA zone, e.g. "America/New_York". Defaults to the household timezone.' },
          classification: { type: 'string', enum: ['alarm'], description: 'Only "alarm" is supported right now.' },
          linkedChatId: { type: 'string', description: 'Optional: the chat session this alarm relates to.' },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isScheduleRoutineArgs(args)) {
        throw new Error(
          'schedule_routine requires either {jobId, status} to update, or {title, scheduleKind, runAt|timeOfDay} to create',
        );
      }

      if ('jobId' in args) {
        const [row] = await ctx.db.query<JobRow>(
          `update scheduled_jobs set status = $2, updated_at = now()
           where job_id = $1
           returning job_id, title, classification, schedule_kind, time_of_day, timezone, status, next_run_at`,
          [args.jobId, args.status],
        );
        return row ? { found: true, ...shapeJob(row) } : { found: false, jobId: args.jobId };
      }

      if (args.classification === 'agent_routine') {
        throw new Error('agent_routine jobs are not dispatched yet — use classification "alarm" (the default) for now');
      }

      const timezone = args.timezone ?? (await settings.get('household_timezone')) ?? 'UTC';
      let nextRunAt: Date;
      if (args.scheduleKind === 'once') {
        nextRunAt = new Date(args.runAt as string);
        if (Number.isNaN(nextRunAt.getTime())) throw new Error(`runAt must be a valid ISO timestamp, got "${args.runAt}"`);
      } else {
        nextRunAt = nextDailyOccurrence(args.timeOfDay as string, timezone, new Date());
      }

      const [row] = await ctx.db.query<JobRow>(
        `insert into scheduled_jobs (user_id, title, classification, schedule_kind, time_of_day, timezone, next_run_at, linked_chat_id)
         values ($1, $2, 'alarm', $3, $4, $5, $6, $7)
         returning job_id, title, classification, schedule_kind, time_of_day, timezone, status, next_run_at`,
        [
          ctx.userId,
          args.title,
          args.scheduleKind,
          args.scheduleKind === 'daily' ? args.timeOfDay : null,
          timezone,
          nextRunAt.toISOString(),
          args.linkedChatId ?? null,
        ],
      );
      return shapeJob(row!);
    },
  };
}
