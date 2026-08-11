/**
 * @file orchestrator/src/orchestrator/agentRoutineDispatch.ts
 * @stamp 2026-07-28
 * @architectural-role Orchestrator — the scheduled_jobs 'agent_routine' poll/dispatch loop
 * @description
 * The counterpart to plugins/temporal/src/jobPoll.ts's 'alarm' dispatch, but for the
 * classification that job intentionally left untouched (its own doc: "'agent_routine' needs a
 * household kill switch and a per-job daily run cap first"). Lives in core rather than
 * plugins/temporal because it needs things a plugin structurally cannot reach: the full
 * ToolRegistry (built in index.ts only after every plugin's own registerTools has already run)
 * and orchestrator/loop.ts's runTurn (a plugin may depend on @bigbrain/orchestrator, never the
 * reverse — orchestrator/pluginLoader.ts's own doc) — so index.ts wires this the same tier it
 * wires the HTTP server, not through the plugin loader.
 *
 * Same per-user roster-then-claim shape as jobPoll.ts (scheduled_jobs is RLS-forced identically),
 * but the claim and the actual work are two separate steps rather than one transaction: a claimed
 * 'once' job flips to 'completed' and a claimed 'daily' job's next_run_at is advanced *before*
 * runAgentRoutine actually runs it, not after. That ordering is deliberate — advancing state
 * first means a crash mid-run silently skips one firing (self-healing: a 'daily' job just fires
 * again next period) rather than risking a double-fire that bills the same routine's LLM usage
 * twice, a far worse failure mode for something with a real token cost. Also unlike jobPoll.ts,
 * the claim transaction never holds a lock across the actual LLM work (runTurn can take many
 * seconds across several tool-call rounds) — advance-then-release, then run outside the
 * transaction.
 *
 * A routine always runs inside its own linked_chat_id (required at creation —
 * db/migrations/0035_agent_routine_dispatch.sql's scheduled_jobs_routine_fields), never a fresh
 * throwaway session: that's what lets it inherit the chat's own tool allow-list/system
 * prompt/sampling params exactly like a live turn would (mirrors server/httpServer.ts's
 * handleChatCompletions assembly), and what leaves a real, readable transcript of what an
 * unattended run actually did — the household's only visibility into it besides the llm_calls
 * audit log (bb_principles.md §11).
 *
 * The wake-up itself is injected as a synthetic 'user' message (LlmMessage has no
 * "system-triggered" role) carrying the job's instructions, clearly labeled as automatic so
 * anyone reading the transcript later can tell it wasn't typed by a household member. Persisted
 * to chat_messages only on success — a refused/failed run (llmGate.ts's cap check, or a genuine
 * provider error) leaves no trace in the transcript, just a server log line and, for a refusal,
 * an llm_calls row with outcome 'refused'/'error' — there's no assistant reply to append, and
 * chat_messages has no role for "the routine tried to run and couldn't."
 *
 * @api-declaration
 * startAgentRoutineDispatchLoop(deps) — begins polling every POLL_INTERVAL_MS
 * dispatchDueAgentRoutinesTick(deps) — one poll cycle, exported so verify scripts can drive it
 *   directly instead of waiting on real wall-clock ticks
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, LLM IO via runTurn; owns the interval timer)
 *     state_ownership: [the setInterval timer this starts]
 *     external_io:     [Postgres, the LLM via runTurn]
 */

import { log } from '../io/logger.js';
import type { ChatSessionStore } from '../io/chatSessions.js';
import type { LlmMessage, LlmProvider } from '../io/llm/types.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import type { PostgresClient } from '../io/postgres.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import { formatCurrentDateContext } from '../util/dateContext.js';
import { nextDailyOccurrence } from '../util/nextOccurrence.js';
import { runTurn } from './loop.js';
import { createToolRegistry, filterToolRegistry, type ToolRegistry } from './toolRegistry.js';

const POLL_INTERVAL_MS = 5_000;

export interface AgentRoutineDispatchDeps {
  db: PostgresClient;
  llm: LlmProvider;
  tools: ToolRegistry;
  chats: ChatSessionStore;
  settings: OrchestratorSettingsStore;
  /** Forwarded to every runTurn this dispatch makes so its tool handlers get an embeddings
   *  provider on ToolHandlerContext (chub-lorebook-embed-repair.md) — composition root already
   *  holds one, index.ts passes it through. */
  embeddings: EmbeddingProvider;
}

interface UserRow {
  user_id: string;
}

interface DueJobRow {
  job_id: string;
  title: string;
  instructions: string;
  schedule_kind: string;
  time_of_day: string | null;
  timezone: string;
  linked_chat_id: string;
}

async function claimDueRoutinesForUser(db: PostgresClient, userId: string): Promise<DueJobRow[]> {
  return db.withUserScope(userId, async (session) => {
    const due = await session.query<DueJobRow>(
      `select job_id, title, instructions, schedule_kind, time_of_day, timezone, linked_chat_id
       from scheduled_jobs
       where status = 'active' and classification = 'agent_routine' and next_run_at <= now()
       for update`,
    );
    for (const job of due) {
      if (job.schedule_kind === 'daily' && job.time_of_day) {
        const nextRunAt = nextDailyOccurrence(job.time_of_day, job.timezone, new Date());
        await session.query(
          `update scheduled_jobs set last_run_at = now(), next_run_at = $2, updated_at = now() where job_id = $1`,
          [job.job_id, nextRunAt.toISOString()],
        );
      } else {
        await session.query(
          `update scheduled_jobs set status = 'completed', last_run_at = now(), updated_at = now() where job_id = $1`,
          [job.job_id],
        );
      }
    }
    return due;
  });
}

async function runAgentRoutine(deps: AgentRoutineDispatchDeps, userId: string, job: DueJobRow): Promise<void> {
  const detail = await deps.chats.getChat(userId, job.linked_chat_id);
  if (!detail) {
    log.error('agent_routine dispatch: linked_chat_id no longer exists, skipping', { jobId: job.job_id, chatId: job.linked_chat_id });
    return;
  }

  const sessionParams = detail.session.params;
  // Same RP rule as server/httpServer.ts: an rp-kind chat's turns never see tools — the model
  // just executes the prompt stack. (The migration normalizes stored tool_names for existing rp
  // rows; this guard makes the invariant hold even if a row ever carries a non-empty list again.)
  const sessionTools =
    detail.session.kind === 'rp'
      ? createToolRegistry([])
      : detail.session.toolNames !== null
        ? filterToolRegistry(deps.tools, detail.session.toolNames)
        : deps.tools;
  const timezone = (await deps.settings.get('household_timezone')) ?? 'UTC';
  const systemPrompt = [formatCurrentDateContext(timezone), sessionParams.system].filter(Boolean).join('\n\n');

  const history: LlmMessage[] = detail.messages.map((m) => ({ role: m.role, content: m.content }));
  const wakeMessage: LlmMessage = {
    role: 'user',
    content: `[Automatic — scheduled routine "${job.title}" triggered this, no household member typed it]\n\n${job.instructions}`,
  };

  log.info('agent_routine dispatch: running', { jobId: job.job_id, userId, chatId: job.linked_chat_id });

  let reply: string;
  try {
    ({ content: reply } = await runTurn({
      userId,
      taskId: job.job_id,
      taskKind: 'agent_routine',
      messages: [...history, wakeMessage],
      systemPrompt,
      model: sessionParams.model,
      sampling: { temperature: sessionParams.temperature, topP: sessionParams.top_p, maxTokens: sessionParams.max_tokens },
      llm: deps.llm,
      db: deps.db,
      tools: sessionTools,
      embeddings: deps.embeddings,
    }));
  } catch (err) {
    log.error('agent_routine dispatch: run failed or was refused', { jobId: job.job_id, err });
    return;
  }

  await deps.chats.appendMessages(userId, job.linked_chat_id, [
    { role: 'user', content: wakeMessage.content },
    { role: 'assistant', content: reply },
  ]);
  log.info('agent_routine dispatch: completed', { jobId: job.job_id });
}

export async function dispatchDueAgentRoutinesTick(deps: AgentRoutineDispatchDeps): Promise<void> {
  const users = await deps.db.withSystemScope((session) => session.query<UserRow>('select user_id from users'));
  for (const { user_id: userId } of users) {
    const due = await claimDueRoutinesForUser(deps.db, userId);
    for (const job of due) {
      await runAgentRoutine(deps, userId, job);
    }
  }
}

export function startAgentRoutineDispatchLoop(deps: AgentRoutineDispatchDeps): void {
  const tick = () => {
    dispatchDueAgentRoutinesTick(deps).catch((err) => log.error('agent_routine dispatch tick failed', err));
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
