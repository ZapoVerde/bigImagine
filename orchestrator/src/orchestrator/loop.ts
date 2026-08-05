/**
 * @file orchestrator/src/orchestrator/loop.ts
 * @stamp 2026-07-21
 * @architectural-role Orchestrator — the minimal agentic loop (docs/spec.md §4, steps 2-8;
 * write-time hint and read-time render tick deliberately not implemented yet, per the build
 * order — both are additive to this path)
 * @description
 * Sequences calls to the LLM and to tool handlers. Owns no state and does no direct IO of its
 * own — every side effect goes through the LlmProvider or PostgresClient it's given. The only
 * decision this file makes is mechanical (which tool name the LLM asked for, how many rounds to
 * allow); it never interprets what a message or tool result *means* — that's the LLM's job
 * alone, per bb_principles.md §2.
 *
 * Each tool call gets its own withUserScope transaction — simplest correct thing for a single
 * request scoped to one user_id throughout (bb_principles.md §4); nothing here batches multiple
 * tool calls into one transaction, since nothing yet needs that.
 *
 * runTurn wraps its entire body in runWithCallContext (io/llm/callContext.ts) exactly once, keyed
 * off opts.taskId/taskKind — every llm.complete() call made during the turn, including one a tool
 * handler triggers internally (e.g. classify_section's own forced-schema call), automatically
 * inherits it without this file or the tool needing to pass anything extra, since they all share
 * the one gated LlmProvider instance closed over since boot (bb_principles.md §14).
 *
 * runTurn also owns a TurnMetricsAccumulator (io/turnMetrics.ts) for the turn's whole lifetime —
 * created before runTurnInner starts, recorded as one turn_metrics row in both the success and
 * catch paths, so a turn that dies partway through still leaves behind exactly which rounds/tool
 * calls it completed before failing, not nothing.
 *
 * @api-declaration
 * runTurn(options: RunTurnOptions) — drives one user message through to a final chat reply,
 *   executing any tool calls the LLM requests along the way; throws if maxToolRounds is
 *   exceeded rather than returning a partial/guessed answer. Returns { content, focusedNoteId }:
 *   focusedNoteId is Canvas's hook — the id a tool's own focusHint (toolRegistry.ts) surfaced,
 *   last-one-wins across every tool call this turn, undefined if none did. This loop never asks
 *   what the id *means* (still bb_principles.md §2) — it only relays what the tool itself declared.
 *
 * @contract
 *   assertions:
 *     purity:          impure (drives LLM + DB IO wrappers)
 *     state_ownership: []
 *     external_io:     []
 */

import { randomUUID } from 'node:crypto';
import { log, runWithRequestId } from '../io/logger.js';
import type { LlmMessage, LlmProvider } from '../io/llm/types.js';
import { runWithCallContext, type LlmCallKind } from '../io/llm/callContext.js';
import type { PostgresClient } from '../io/postgres.js';
import { createMetricsAccumulator, recordTurnMetrics, type RoundMetric, type TurnMetricsAccumulator } from '../io/turnMetrics.js';
import type { ToolRegistry } from './toolRegistry.js';
import { describeToolCall } from './describeToolCall.js';
import { setTurnStatus, clearTurnStatus } from './turnStatus.js';

export interface RunTurnOptions {
  userId: string;
  /** What this whole turn — the main reasoning calls and any tool-triggered classification call
   *  nested inside it — is attributed to for bb_principles.md §14's gate: a chat_id for a live
   *  conversation, a scheduled_jobs.job_id for an unattended agent_routine dispatch. Required,
   *  not defaulted, since a call with no real task behind it is exactly what §14 exists to
   *  prevent. */
  taskId: string;
  /** Defaults 'chat' — the household's own conversation. Set 'agent_routine' for a dispatched
   *  routine so llmGate.ts's cap/kill-switch logic applies to this turn's calls. */
  taskKind?: LlmCallKind;
  /** The full conversation so far, ending in the latest user turn. A caller fronting a
   *  stateless HTTP API (one that resends the whole history each request, e.g. an
   *  OpenAI-shaped chat endpoint) passes it straight through; systemPrompt is a convenience
   *  for callers that don't already have one in messages (e.g. verification scripts). */
  messages: LlmMessage[];
  systemPrompt?: string;
  /** Per-request model override (e.g. from a chat client's own model picker) — passed straight
   *  through to every llm.complete() call this turn makes. Unset means the provider's own
   *  configured default. Nested calls a tool makes on its own (e.g. classifyNote's forced-schema
   *  call) are untouched by this — they're a separate llm.complete() invocation entirely, not
   *  routed through runTurn. */
  model?: string;
  /** Per-request sampling overrides (a persisted chat session's own params — see
   *  io/chatSessions.ts), forwarded to every llm.complete() call this turn makes. Unset fields
   *  fall through to the provider's own defaults, same as model above. */
  sampling?: { temperature?: number; topP?: number; maxTokens?: number };
  llm: LlmProvider;
  db: PostgresClient;
  tools: ToolRegistry;
  maxToolRounds?: number;
  /** The chat_messages row this turn's tools should anchor derived writes to (e.g.
   *  propose_canon_fact) — server/httpServer.ts persists the triggering user message before
   *  calling runTurn specifically so this id is available here, not one turn stale. Only
   *  meaningful alongside a chat taskId; omitted for stateless/non-chat turns. */
  anchorMessageId?: string;
}

export interface RunTurnResult {
  content: string;
  /** The id a tool's focusHint surfaced this turn (Canvas) — last one wins across every tool call
   *  made in the turn, undefined if none of them declared one. */
  focusedNoteId?: string;
}

export async function runTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
  const requestId = randomUUID();
  const callContext = { taskId: opts.taskId, kind: opts.taskKind ?? ('chat' as LlmCallKind), userId: opts.userId };
  const metrics = createMetricsAccumulator();
  const turnStart = Date.now();
  try {
    const result = await runWithRequestId(requestId, () =>
      runWithCallContext(callContext, () => runTurnInner(opts, metrics)),
    );
    await recordTurnMetrics(opts.db, {
      userId: opts.userId,
      taskId: opts.taskId,
      kind: callContext.kind,
      totalDurationMs: Date.now() - turnStart,
      outcome: 'ok',
      accumulator: metrics,
    }).catch((err) => log.error('failed to record turn_metrics', err));
    return result;
  } catch (err) {
    await recordTurnMetrics(opts.db, {
      userId: opts.userId,
      taskId: opts.taskId,
      kind: callContext.kind,
      totalDurationMs: Date.now() - turnStart,
      outcome: 'error',
      errorReason: err instanceof Error ? err.message : String(err),
      accumulator: metrics,
    }).catch((err2) => log.error('failed to record turn_metrics', err2));
    throw err;
  } finally {
    clearTurnStatus(opts.taskId);
  }
}

async function runTurnInner(opts: RunTurnOptions, metrics: TurnMetricsAccumulator): Promise<RunTurnResult> {
  const { userId, systemPrompt, model, sampling, llm, db, tools, maxToolRounds = 10 } = opts;
  // taskId is the chat_id for a live conversation (RunTurnOptions.taskId's own doc comment) — only
  // meaningful to thread through to tools as chatId when this turn actually is one.
  const chatId = (opts.taskKind ?? 'chat') === 'chat' ? opts.taskId : undefined;

  const messages: LlmMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push(...opts.messages);

  log.info(`runTurn start`, { userId, provider: llm.name, model, historyLength: opts.messages.length });

  let focusedNoteId: string | undefined;

  for (let round = 0; round < maxToolRounds; round++) {
    const llmStart = Date.now();
    const turn = await llm.complete(messages, tools.definitions(), { model, ...sampling });
    const roundMetric: RoundMetric = {
      round,
      llmDurationMs: Date.now() - llmStart,
      promptTokens: turn.usage?.promptTokens ?? null,
      completionTokens: turn.usage?.completionTokens ?? null,
      totalTokens: turn.usage?.totalTokens ?? null,
      toolCalls: [],
    };
    metrics.rounds.push(roundMetric);

    messages.push({
      ...turn.message,
      toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
    });

    if (turn.toolCalls.length === 0) {
      log.info(`runTurn done`, { userId, rounds: round + 1 });
      return { content: turn.message.content, focusedNoteId };
    }

    for (const call of turn.toolCalls) {
      log.info(`tool call: ${call.name}`, { userId, toolCallId: call.id });
      setTurnStatus(opts.taskId, describeToolCall(call.name, call.arguments));
      const tool = tools.get(call.name);

      const toolStart = Date.now();
      const resultPayload = await db.withUserScope(userId, async (session) => {
        if (!tool) return { error: `unknown tool: ${call.name}` };
        try {
          return await tool.handler(call.arguments, { userId, db: session, chatId, anchorMessageId: opts.anchorMessageId });
        } catch (err) {
          log.error(`tool ${call.name} threw`, err);
          return { error: err instanceof Error ? err.message : String(err) };
        }
      });
      roundMetric.toolCalls.push({
        name: call.name,
        durationMs: Date.now() - toolStart,
        outcome: resultPayload && typeof resultPayload === 'object' && 'error' in resultPayload ? 'error' : 'ok',
      });

      if (tool?.focusHint) {
        try {
          const hint = tool.focusHint(resultPayload);
          if (hint) focusedNoteId = hint;
        } catch (err) {
          log.error(`tool ${call.name}'s focusHint threw`, err);
        }
      }

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(resultPayload),
      });
    }
  }

  throw new Error(`runTurn exceeded maxToolRounds (${maxToolRounds}) without a final reply`);
}
