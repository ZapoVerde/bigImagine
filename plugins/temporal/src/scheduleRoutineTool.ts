/**
 * @file plugins/temporal/src/scheduleRoutineTool.ts
 * @stamp 2026-07-28
 * @architectural-role IO Wrapper — the schedule_routine RegisteredTool
 * @description
 * Two shapes in one tool, distinguished by whether jobId is present: creating a new job (title +
 * scheduleKind + runAt/timeOfDay), or updating an existing one's status (active <-> cancelled) —
 * the only update this stage needs. classification defaults to 'alarm'. 'agent_routine' is now
 * dispatchable (orchestrator/src/orchestrator/agentRoutineDispatch.ts, db/migrations/
 * 0035_agent_routine_dispatch.sql's kill switch + per-job/household caps) and requires both
 * instructions (what the LLM should actually do when it wakes up unattended — title stays a
 * human label) and linkedChatId (the dispatcher runs the routine inside that chat, inheriting its
 * tool allow-list and leaving a real transcript) — enforced here at creation time even though the
 * DB's own scheduled_jobs_routine_fields CHECK would catch it anyway, so a caller gets a clear
 * error instead of a raw constraint-violation message. maxRunsPerDay/maxTokensPerDay default to
 * the same conservative per-job values the column defaults use (5 / 50,000) when omitted.
 * timezone defaults to household_timezone (deps.settings), same pattern as plugins/calendar's
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
import { nextDailyOccurrence } from '@bigbrain/orchestrator/next-occurrence';

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
  instructions?: string | null;
  max_runs_per_day?: number;
  max_tokens_per_day?: number;
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
    instructions: row.instructions ?? undefined,
    maxRunsPerDay: row.max_runs_per_day,
    maxTokensPerDay: row.max_tokens_per_day,
  };
}

const DEFAULT_MAX_RUNS_PER_DAY = 5;
const DEFAULT_MAX_TOKENS_PER_DAY = 50_000;

interface CreateArgs {
  title: string;
  scheduleKind: 'once' | 'daily';
  runAt?: string;
  timeOfDay?: string;
  timezone?: string;
  classification?: 'alarm' | 'agent_routine';
  linkedChatId?: string;
  instructions?: string;
  maxRunsPerDay?: number;
  maxTokensPerDay?: number;
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
  if (value.instructions !== undefined && typeof value.instructions !== 'string') return false;
  if (value.maxRunsPerDay !== undefined && (typeof value.maxRunsPerDay !== 'number' || value.maxRunsPerDay <= 0)) return false;
  if (value.maxTokensPerDay !== undefined && (typeof value.maxTokensPerDay !== 'number' || value.maxTokensPerDay <= 0)) return false;
  if (value.classification === 'agent_routine') {
    if (typeof value.instructions !== 'string' || value.instructions.trim() === '') return false;
    if (typeof value.linkedChatId !== 'string' || value.linkedChatId === '') return false;
  }
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
        'Create a one-time or daily-recurring alarm or agent routine, or cancel/reactivate one by jobId. ' +
        'An "alarm" just reminds the household. An "agent_routine" wakes the LLM itself, unattended, to ' +
        'carry out its own instructions — requires linkedChatId and instructions, and is subject to a ' +
        'household kill switch and daily run/token caps (Settings tab).',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Provide to update (status only) an existing job instead of creating a new one.' },
          status: { type: 'string', enum: ['active', 'cancelled'], description: 'Required when jobId is given.' },
          title: { type: 'string', description: 'A short human label, e.g. "Take medication" or "Morning news digest".' },
          scheduleKind: { type: 'string', enum: ['once', 'daily'], description: '"once" fires a single time; "daily" recurs.' },
          runAt: { type: 'string', description: 'ISO timestamp. Required when scheduleKind is "once".' },
          timeOfDay: { type: 'string', description: '24h "HH:MM". Required when scheduleKind is "daily".' },
          timezone: { type: 'string', description: 'IANA zone, e.g. "America/New_York". Defaults to the household timezone.' },
          classification: { type: 'string', enum: ['alarm', 'agent_routine'], description: 'Defaults to "alarm".' },
          linkedChatId: {
            type: 'string',
            description: 'The chat session this job relates to. Required for classification "agent_routine" — that chat is where the routine actually runs.',
          },
          instructions: {
            type: 'string',
            description: 'Required for classification "agent_routine": what the LLM should actually do when this routine wakes up unattended.',
          },
          maxRunsPerDay: { type: 'number', description: 'agent_routine only. Defaults to 5.' },
          maxTokensPerDay: { type: 'number', description: 'agent_routine only. Defaults to 50000.' },
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

      const timezone = args.timezone ?? (await settings.get('household_timezone')) ?? 'UTC';
      let nextRunAt: Date;
      if (args.scheduleKind === 'once') {
        nextRunAt = new Date(args.runAt as string);
        if (Number.isNaN(nextRunAt.getTime())) throw new Error(`runAt must be a valid ISO timestamp, got "${args.runAt}"`);
      } else {
        nextRunAt = nextDailyOccurrence(args.timeOfDay as string, timezone, new Date());
      }

      const classification = args.classification ?? 'alarm';
      const [row] = await ctx.db.query<JobRow>(
        `insert into scheduled_jobs
           (user_id, title, classification, schedule_kind, time_of_day, timezone, next_run_at, linked_chat_id,
            instructions, max_runs_per_day, max_tokens_per_day)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning job_id, title, classification, schedule_kind, time_of_day, timezone, status, next_run_at,
           instructions, max_runs_per_day, max_tokens_per_day`,
        [
          ctx.userId,
          args.title,
          classification,
          args.scheduleKind,
          args.scheduleKind === 'daily' ? args.timeOfDay : null,
          timezone,
          nextRunAt.toISOString(),
          args.linkedChatId ?? null,
          classification === 'agent_routine' ? args.instructions : null,
          args.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY,
          args.maxTokensPerDay ?? DEFAULT_MAX_TOKENS_PER_DAY,
        ],
      );
      return shapeJob(row!);
    },
  };
}
