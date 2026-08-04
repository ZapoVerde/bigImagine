/**
 * @file orchestrator/src/io/turnMetrics.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — turn-level companion to io/llm/llmGate.ts's per-call metering
 * @description
 * orchestrator/loop.ts accumulates one RoundMetric per LLM round (and one ToolCallMetric per tool
 * call within it) into a plain mutable TurnMetricsAccumulator as the turn runs, then hands it here
 * once the turn finishes (success or failure) to become one db/migrations/0041_turn_metrics.sql
 * row. The accumulator lives outside runTurnInner's return path specifically so a row still gets
 * written from runTurn's outer catch if runTurnInner throws partway through — round_count/
 * tool_call_count/rounds reflect exactly how far the turn got, not a guess.
 *
 * recordTurnMetrics never rethrows: a metrics-recording failure must never fail a user's actual
 * turn. Callers are expected to await it inside their own .catch(...) (see loop.ts).
 *
 * @api-declaration
 * createMetricsAccumulator() — a fresh { rounds: [] } bag for one turn.
 * recordTurnMetrics(db, fields) — inserts one turn_metrics row via db.withUserScope. Throws only
 *   if the insert itself fails; callers decide whether/how to log that.
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO)
 *     state_ownership: []
 *     external_io:     [Postgres via db.withUserScope]
 */

import type { PostgresClient } from './postgres.js';

export interface ToolCallMetric {
  name: string;
  durationMs: number;
  outcome: 'ok' | 'error';
}

export interface RoundMetric {
  round: number;
  llmDurationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  toolCalls: ToolCallMetric[];
}

export interface TurnMetricsAccumulator {
  rounds: RoundMetric[];
}

export function createMetricsAccumulator(): TurnMetricsAccumulator {
  return { rounds: [] };
}

function toolCallCount(rounds: RoundMetric[]): number {
  return rounds.reduce((sum, r) => sum + r.toolCalls.length, 0);
}

function serializeRounds(rounds: RoundMetric[]): unknown {
  return rounds.map((r) => ({
    round: r.round,
    llm_duration_ms: r.llmDurationMs,
    prompt_tokens: r.promptTokens,
    completion_tokens: r.completionTokens,
    total_tokens: r.totalTokens,
    tool_calls: r.toolCalls.map((t) => ({ name: t.name, duration_ms: t.durationMs, outcome: t.outcome })),
  }));
}

export async function recordTurnMetrics(
  db: PostgresClient,
  fields: {
    userId: string;
    taskId: string;
    kind: string;
    totalDurationMs: number;
    outcome: 'ok' | 'error';
    errorReason?: string;
    accumulator: TurnMetricsAccumulator;
  },
): Promise<void> {
  const { rounds } = fields.accumulator;
  await db.withUserScope(fields.userId, (session) =>
    session.query(
      `insert into turn_metrics
         (user_id, task_id, kind, round_count, tool_call_count, total_duration_ms, outcome, error_reason, rounds)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        fields.userId,
        fields.taskId,
        fields.kind,
        rounds.length,
        toolCallCount(rounds),
        fields.totalDurationMs,
        fields.outcome,
        fields.errorReason ?? null,
        JSON.stringify(serializeRounds(rounds)),
      ],
    ),
  );
}
