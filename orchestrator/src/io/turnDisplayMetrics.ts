/**
 * @file orchestrator/src/io/turnDisplayMetrics.ts
 * @stamp 2026-08-14
 * @architectural-role IO Wrapper — same shape as io/turnMetrics.ts: one exported insert function,
 * no reasoning, no derivation (bi_principles.md §8)
 * @description
 * Persists one client-reported RP turn timing record (db/migrations/0102_turn_display_metrics.sql,
 * docs/plans/llm-stats-page-plan.md Timing section). Every *_ms field is elapsed milliseconds
 * since that turn's dispatch_at, measured client-side — the only vantage point that can capture
 * "did the user actually see it" (network time is real time; a server timestamp can't see paint).
 *
 * recordTurnDisplayMetrics never rethrows: a metrics-recording failure must never fail the
 * user's actual turn (the same fire-and-forget convention recordTurnMetrics documents). The
 * caller (handleTurnDisplayMetrics.ts) is expected to await it inside its own try/catch and
 * treat a failure as "that turn is missing from Timing stats, nothing else."
 *
 * Standard user_scoped RLS, unlike llm_calls' deliberate exemption: nothing household-wide
 * aggregates this table, so the usual pattern applies.
 *
 * @api-declaration
 * recordTurnDisplayMetrics(db, fields) — inserts one turn_display_metrics row via db.withUserScope.
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO)
 *     state_ownership: []
 *     external_io:     [Postgres via db.withUserScope]
 */

import type { PostgresClient } from './postgres.js';

export interface TurnDisplayMetricFields {
  userId: string;
  chatId: string;
  messageId: string;
  dispatchAt: string; // ISO timestamp
  firstTokenMs?: number;
  lastTokenMs?: number;
  displayLandMs?: number;
  displaySettleMs?: number;
  headerStartMs?: number;
  headerStopMs?: number;
  bodyStartMs?: number;
  bodyStopMs?: number;
  footerStartMs?: number;
  footerStopMs?: number;
  outcome: 'ok' | 'aborted' | 'error';
  terminatedAtMs?: number;
}

export async function recordTurnDisplayMetrics(
  db: PostgresClient,
  fields: TurnDisplayMetricFields,
): Promise<void> {
  await db.withUserScope(fields.userId, (session) =>
    session.query(
      `insert into turn_display_metrics
         (user_id, chat_id, message_id, dispatch_at, first_token_ms, last_token_ms, display_land_ms,
          display_settle_ms, header_start_ms, header_stop_ms, body_start_ms, body_stop_ms,
          footer_start_ms, footer_stop_ms, outcome, terminated_at_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        fields.userId,
        fields.chatId,
        fields.messageId,
        fields.dispatchAt,
        fields.firstTokenMs ?? null,
        fields.lastTokenMs ?? null,
        fields.displayLandMs ?? null,
        fields.displaySettleMs ?? null,
        fields.headerStartMs ?? null,
        fields.headerStopMs ?? null,
        fields.bodyStartMs ?? null,
        fields.bodyStopMs ?? null,
        fields.footerStartMs ?? null,
        fields.footerStopMs ?? null,
        fields.outcome,
        fields.terminatedAtMs ?? null,
      ],
    ),
  );
}
