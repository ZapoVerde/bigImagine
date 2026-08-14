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
 * latestTurnDisplayMetric reads the newest row for one chat back out — the chat drawer Timing
 * section's durable "last turn" wire (docs/plans/turn-timeline-graph-plan.md): the table, not
 * the session, so a reload still remembers the last turn. Runs inside the same withUserScope, so
 * user_scoped RLS keeps it cross-user-safe by construction: a foreign chat_id reads no rows.
 *
 * Standard user_scoped RLS, unlike llm_calls' deliberate exemption: nothing household-wide
 * aggregates this table, so the usual pattern applies.
 *
 * @api-declaration
 * recordTurnDisplayMetrics(db, fields) — inserts one turn_display_metrics row via db.withUserScope.
 * latestTurnDisplayMetric(db, userId, chatId) — the newest turn_display_metrics row for that
 *   chat, or null when none. The shared camelCase wire shape (mapTurnDisplayMetricRow), same as
 *   the admin stats read maps to — one mapper, two readers.
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO)
 *     state_ownership: []
 *     external_io:     [Postgres via db.withUserScope]
 */

import type { PostgresClient } from './postgres.js';

/** The DB's snake_case row as node-postgres returns it — timestamptz columns as Date objects. */
export interface TurnDisplayMetricRowShape {
  turn_display_metric_id: string;
  user_id: string;
  chat_id: string;
  message_id: string;
  dispatch_at: Date;
  first_token_ms: number | null;
  last_token_ms: number | null;
  display_land_ms: number | null;
  display_settle_ms: number | null;
  header_start_ms: number | null;
  header_stop_ms: number | null;
  body_start_ms: number | null;
  body_stop_ms: number | null;
  footer_start_ms: number | null;
  footer_stop_ms: number | null;
  outcome: 'ok' | 'aborted' | 'error';
  terminated_at_ms: number | null;
  created_at: Date;
}

/** CamelCase wire shape of migration 0102's columns — the frontend's TurnDisplayMetricRow. */
export interface TurnDisplayMetricRow {
  turnDisplayMetricId: string;
  userId: string;
  chatId: string;
  messageId: string;
  dispatchAt: string; // ISO
  firstTokenMs: number | null;
  lastTokenMs: number | null;
  displayLandMs: number | null;
  displaySettleMs: number | null;
  headerStartMs: number | null;
  headerStopMs: number | null;
  bodyStartMs: number | null;
  bodyStopMs: number | null;
  footerStartMs: number | null;
  footerStopMs: number | null;
  outcome: 'ok' | 'aborted' | 'error';
  terminatedAtMs: number | null;
  createdAt: string; // ISO
}

/** Pure column-name mapping, shared by the admin stats reader and the per-chat latest read. */
export function mapTurnDisplayMetricRow(r: TurnDisplayMetricRowShape): TurnDisplayMetricRow {
  return {
    turnDisplayMetricId: r.turn_display_metric_id,
    userId: r.user_id,
    chatId: r.chat_id,
    messageId: r.message_id,
    dispatchAt: r.dispatch_at.toISOString(),
    firstTokenMs: r.first_token_ms,
    lastTokenMs: r.last_token_ms,
    displayLandMs: r.display_land_ms,
    displaySettleMs: r.display_settle_ms,
    headerStartMs: r.header_start_ms,
    headerStopMs: r.header_stop_ms,
    bodyStartMs: r.body_start_ms,
    bodyStopMs: r.body_stop_ms,
    footerStartMs: r.footer_start_ms,
    footerStopMs: r.footer_stop_ms,
    outcome: r.outcome,
    terminatedAtMs: r.terminated_at_ms,
    createdAt: r.created_at.toISOString(),
  };
}

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

/** The newest recorded turn for one chat, or null when that chat has none. User-scoped read: the
 *  withUserScope transaction sets app.current_user_id, so RLS only ever sees this user's own
 *  rows — a foreign chat_id (or a chat the user never turned) reads empty, never someone else's
 *  data. created_at/desc dispatch_at tiebreak mirrors the admin list's ordering, so the "last
 *  turn" is unambiguous when two rows share a wall-clock instant. */
export async function latestTurnDisplayMetric(
  db: PostgresClient,
  userId: string,
  chatId: string,
): Promise<TurnDisplayMetricRow | null> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<TurnDisplayMetricRowShape>(
      `select turn_display_metric_id, user_id, chat_id, message_id, dispatch_at,
              first_token_ms, last_token_ms, display_land_ms, display_settle_ms,
              header_start_ms, header_stop_ms, body_start_ms, body_stop_ms,
              footer_start_ms, footer_stop_ms, outcome, terminated_at_ms, created_at
       from turn_display_metrics
       where chat_id = $1
       order by created_at desc, dispatch_at desc
       limit 1`,
      [chatId],
    ),
  );
  const row = rows[0];
  return row ? mapTurnDisplayMetricRow(row) : null;
}
