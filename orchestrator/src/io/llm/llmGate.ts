/**
 * @file orchestrator/src/io/llm/llmGate.ts
 * @stamp 2026-07-28
 * @architectural-role IO Wrapper — the one seam bb_principles.md §14 requires every LLM call to
 * pass through
 * @description
 * Wraps a real LlmProvider and returns another one with the identical LlmProvider shape (same
 * complete() signature) — every existing caller (orchestrator/loop.ts's runTurn,
 * io/llm/generateChatTitle.ts, plugins/lists/src/classifySection.ts, and every other forced-schema
 * helper) keeps calling llm.complete() exactly as before, unaware it's gated. index.ts wraps
 * deps.llm with this exactly once, at boot, so every plugin's closed-over llm reference and every
 * chat's per-profile override (both ultimately built from the same seam) are gated automatically —
 * no call site needed to change (bb_principles.md §14's own "no dozen files touched" reasoning).
 *
 * Every call reads its {taskId, kind, userId} from callContext.ts's ambient AsyncLocalStorage —
 * set once per turn by runTurnInner, or once per standalone call by whatever wraps a system call
 * like generateChatTitle — never passed as a complete() argument, since LlmProvider's shape is
 * fixed by bb_principles.md §6 and isn't this file's to change. getCallContext() returning
 * undefined is a bug (a call reached the model from outside any tagged scope) and throws rather
 * than logging an unattributed row.
 *
 * Only kind === 'agent_routine' calls are ever refused or trip a breach reaction — a live
 * conversation or a system classification call is metered (an llm_calls row is written either
 * way) but never capped, matching send_push_notification's own per-feature-not-per-platform
 * caution: an unattended routine's budget should never be able to interrupt the household's own
 * chat.
 *
 * llm_calls is deliberately RLS-exempt, same category as provider_credentials/
 * orchestrator_settings (bb_principles.md §12-13's household-wide shape) rather than the usual
 * user_scoped pattern (bb_principles.md §4) — the household-wide cap check genuinely needs to sum
 * usage across every user, which a user_id-scoped RLS policy (force row level security) cannot do
 * even from withSystemScope (postgres.ts: an unset app.current_user_id satisfies no user_scoped
 * policy, not "all of them"). This table is never queried with a caller-supplied filter a user
 * could manipulate — only this gate reads or writes it, with userId/jobId always coming from
 * trusted server-side call context, never request content — so RLS isn't defending anything here
 * that this file doesn't already defend itself.
 *
 * Both caps are rolling 24-hour windows (`created_at > now() - interval '1 day'`), not a
 * calendar-day reset in household_timezone — same simpler shape notification_logs' hourly rate
 * cap already uses, and avoids a timezone-conversion query for what "per day" needs to mean here.
 *
 * Token caps are necessarily a soft, after-the-fact ceiling: a call's own token cost isn't known
 * until it returns, so the pre-flight check can only refuse a call from starting once *prior*
 * calls already put today's tally at or past the cap — a job sitting just under its limit can
 * still make one more call that pushes it over before the next one is refused. Call-count caps
 * are exact by contrast, since the count of calls made so far is always precisely known.
 *
 * @api-declaration
 * createGatedLlmProvider(base, db, settings) — returns an LlmProvider wrapping base
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, delegates to the wrapped LlmProvider, reads settings)
 *     state_ownership: []
 *     external_io:     [Postgres (via db.withSystemScope), whatever `base` does]
 */

import type { PostgresClient } from '../postgres.js';
import type { OrchestratorSettingsStore } from '../orchestratorSettings.js';
import type { LlmCompleteOptions, LlmMessage, LlmProvider, LlmTurn, ToolDefinition } from './types.js';
import { getCallContext } from './callContext.js';

const DEFAULT_HOUSEHOLD_MAX_RUNS_PER_DAY = 20;
const DEFAULT_HOUSEHOLD_MAX_TOKENS_PER_DAY = 200_000;

interface JobCapRow {
  status: string;
  max_runs_per_day: number;
  max_tokens_per_day: number;
}

interface TallyRow {
  calls: number;
  tokens: number;
}

async function loadJobCaps(db: PostgresClient, jobId: string): Promise<JobCapRow | undefined> {
  const rows = await db.withSystemScope((session) =>
    session.query<JobCapRow>(
      `select status, max_runs_per_day, max_tokens_per_day from scheduled_jobs where job_id = $1`,
      [jobId],
    ),
  );
  return rows[0];
}

async function tallySince(db: PostgresClient, where: string, params: unknown[]): Promise<TallyRow> {
  const rows = await db.withSystemScope((session) =>
    session.query<{ calls: string; tokens: string }>(
      `select count(*)::text as calls, coalesce(sum(total_tokens), 0)::text as tokens
       from llm_calls where outcome = 'ok' and created_at > now() - interval '1 day' and ${where}`,
      params,
    ),
  );
  return { calls: Number(rows[0]?.calls ?? '0'), tokens: Number(rows[0]?.tokens ?? '0') };
}

async function logCall(
  db: PostgresClient,
  fields: {
    userId: string;
    kind: string;
    taskId: string;
    jobId: string | null;
    outcome: 'ok' | 'refused' | 'error';
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    reason: string | null;
  },
): Promise<void> {
  await db.withSystemScope((session) =>
    session.query(
      `insert into llm_calls (user_id, kind, task_id, job_id, outcome, prompt_tokens, completion_tokens, total_tokens, reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        fields.userId,
        fields.kind,
        fields.taskId,
        fields.jobId,
        fields.outcome,
        fields.promptTokens,
        fields.completionTokens,
        fields.totalTokens,
        fields.reason,
      ],
    ),
  );
}

/** Refuses (throws) before ever calling the base provider if the household switch is off, the job
 *  itself isn't active, or either cap (job or household, calls or tokens) is already at/over its
 *  ceiling from prior calls. Returns nothing on success — silence means "go ahead." */
async function preflightAgentRoutineCheck(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  jobId: string,
): Promise<void> {
  const enabled = (await settings.get('agent_routines_enabled')) === 'true';
  if (!enabled) throw new Error('agent_routines_enabled is off — this routine will not run until re-enabled in Settings');

  const job = await loadJobCaps(db, jobId);
  if (!job) throw new Error(`scheduled_jobs row ${jobId} not found`);
  if (job.status !== 'active') throw new Error(`job ${jobId} is '${job.status}', not 'active' — refusing to dispatch`);

  const jobTally = await tallySince(db, 'job_id = $1', [jobId]);
  if (jobTally.calls >= job.max_runs_per_day) {
    throw new Error(`job ${jobId} already made ${jobTally.calls} calls today (cap ${job.max_runs_per_day})`);
  }
  if (jobTally.tokens >= job.max_tokens_per_day) {
    throw new Error(`job ${jobId} already used ${jobTally.tokens} tokens today (cap ${job.max_tokens_per_day})`);
  }

  const householdMaxRuns = Number((await settings.get('agent_routine_max_runs_per_day')) ?? DEFAULT_HOUSEHOLD_MAX_RUNS_PER_DAY);
  const householdMaxTokens = Number((await settings.get('agent_routine_max_tokens_per_day')) ?? DEFAULT_HOUSEHOLD_MAX_TOKENS_PER_DAY);
  const householdTally = await tallySince(db, `kind = 'agent_routine'`, []);
  if (householdTally.calls >= householdMaxRuns) {
    throw new Error(`household already made ${householdTally.calls} agent_routine calls today (cap ${householdMaxRuns})`);
  }
  if (householdTally.tokens >= householdMaxTokens) {
    throw new Error(`household already used ${householdTally.tokens} agent_routine tokens today (cap ${householdMaxTokens})`);
  }
}

/** Runs after a successful call is logged: re-tallies including the call just made, and trips the
 *  same breaker a human would (per-job -> that job's own status; household-wide -> the same
 *  agent_routines_enabled switch the big red button controls) if either cap is now met. */
async function reactToBreach(db: PostgresClient, settings: OrchestratorSettingsStore, jobId: string): Promise<void> {
  const job = await loadJobCaps(db, jobId);
  if (!job || job.status !== 'active') return;

  const jobTally = await tallySince(db, 'job_id = $1', [jobId]);
  if (jobTally.calls >= job.max_runs_per_day || jobTally.tokens >= job.max_tokens_per_day) {
    await db.withSystemScope((session) =>
      session.query(
        `update scheduled_jobs set status = 'capped', capped_reason = $2, updated_at = now()
         where job_id = $1 and status = 'active'`,
        [jobId, `daily cap reached: ${jobTally.calls} calls / ${jobTally.tokens} tokens`],
      ),
    );
    return;
  }

  const householdMaxRuns = Number((await settings.get('agent_routine_max_runs_per_day')) ?? DEFAULT_HOUSEHOLD_MAX_RUNS_PER_DAY);
  const householdMaxTokens = Number((await settings.get('agent_routine_max_tokens_per_day')) ?? DEFAULT_HOUSEHOLD_MAX_TOKENS_PER_DAY);
  const householdTally = await tallySince(db, `kind = 'agent_routine'`, []);
  if (householdTally.calls >= householdMaxRuns || householdTally.tokens >= householdMaxTokens) {
    await settings.set('agent_routines_enabled', 'false');
    await settings.set(
      'agent_routines_disabled_reason',
      `household daily cap reached: ${householdTally.calls} calls / ${householdTally.tokens} tokens`,
    );
  }
}

export function createGatedLlmProvider(base: LlmProvider, db: PostgresClient, settings: OrchestratorSettingsStore): LlmProvider {
  return {
    name: base.name,
    supportsVision: base.supportsVision,
    listModels: base.listModels,
    async complete(messages: LlmMessage[], tools: ToolDefinition[], options?: LlmCompleteOptions): Promise<LlmTurn> {
      const ctx = getCallContext();
      if (!ctx) {
        throw new Error(
          'llmGate: complete() called with no call context set — every LLM call must run inside runWithCallContext (bb_principles.md §14)',
        );
      }

      if (ctx.kind === 'agent_routine') {
        try {
          await preflightAgentRoutineCheck(db, settings, ctx.taskId);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await logCall(db, {
            userId: ctx.userId,
            kind: ctx.kind,
            taskId: ctx.taskId,
            jobId: ctx.taskId,
            outcome: 'refused',
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            reason,
          });
          throw err;
        }
      }

      let turn: LlmTurn;
      try {
        turn = await base.complete(messages, tools, options);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await logCall(db, {
          userId: ctx.userId,
          kind: ctx.kind,
          taskId: ctx.taskId,
          jobId: ctx.kind === 'agent_routine' ? ctx.taskId : null,
          outcome: 'error',
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          reason,
        });
        throw err;
      }

      await logCall(db, {
        userId: ctx.userId,
        kind: ctx.kind,
        taskId: ctx.taskId,
        jobId: ctx.kind === 'agent_routine' ? ctx.taskId : null,
        outcome: 'ok',
        promptTokens: turn.usage?.promptTokens ?? null,
        completionTokens: turn.usage?.completionTokens ?? null,
        totalTokens: turn.usage?.totalTokens ?? null,
        reason: null,
      });

      if (ctx.kind === 'agent_routine') {
        await reactToBreach(db, settings, ctx.taskId);
      }

      return turn;
    },
  };
}
