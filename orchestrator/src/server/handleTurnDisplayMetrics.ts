/**
 * @file orchestrator/src/server/handleTurnDisplayMetrics.ts
 * @stamp 2026-08-14
 * @architectural-role IO Wrapper — the client-facing write side of the Timing section
 * (docs/plans/llm-stats-page-plan.md)
 * @description
 * POST /v1/turn-display-metrics — the fire-and-forget endpoint the frontend's turnTimeline.ts
 * recorder calls once per RP turn is final (success, abort, or error). Regular chat auth, the
 * same household-key / Cloudflare-Access resolution handleChatCompletions uses — this is written
 * by every ordinary chat turn, not an admin action. The row is inserted under the authenticated
 * userId (never anything the body says), into the user_scoped turn_display_metrics table.
 *
 * Validation is deliberately permissive about which timing fields are present: a partial payload
 * (only the fields reached before an abort) is a legitimate record, and the absent columns stay
 * null — "omit, don't fabricate a zero" (see the plan's Edge Cases). Only the three identity/
 * framing fields are required (chatId, messageId, dispatchAt, outcome); every *_ms field is an
 * optional non-negative finite number.
 *
 * The unique index on message_id (migration 0102) makes the endpoint idempotent: a duplicate
 * POST for the same turn is a no-op success ({ recorded: false }) rather than an error the
 * recorder would have to interpret. A failed insert of any other kind is still swallowed to a
 * 200-with-recorded:false — a metrics write must never fail the user's actual turn, the same
 * convention io/turnMetrics.ts documents.
 *
 * @api-declaration
 * handleTurnDisplayMetrics(req, res, deps) — POST /v1/turn-display-metrics
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO)
 *     state_ownership: []
 *     external_io:     [Postgres via db.withUserScope]
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticate, readJsonBody, sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';
import { recordTurnDisplayMetrics, type TurnDisplayMetricFields } from '../io/turnDisplayMetrics.js';

const OUTCOMES = ['ok', 'aborted', 'error'] as const;
const MS_FIELDS = [
  'firstTokenMs',
  'lastTokenMs',
  'displayLandMs',
  'displaySettleMs',
  'headerStartMs',
  'headerStopMs',
  'bodyStartMs',
  'bodyStopMs',
  'footerStartMs',
  'footerStopMs',
  'terminatedAtMs',
] as const;

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseTurnDisplayMetricsBody(raw: unknown): Omit<TurnDisplayMetricFields, 'userId'> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const body = raw as Record<string, unknown>;
  if (typeof body.chatId !== 'string' || !body.chatId) return undefined;
  if (typeof body.messageId !== 'string' || !body.messageId) return undefined;
  if (typeof body.dispatchAt !== 'string' || Number.isNaN(Date.parse(body.dispatchAt))) return undefined;
  if (typeof body.outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(body.outcome)) return undefined;

  const fields: Omit<TurnDisplayMetricFields, 'userId'> = {
    chatId: body.chatId,
    messageId: body.messageId,
    dispatchAt: body.dispatchAt,
    outcome: body.outcome as TurnDisplayMetricFields['outcome'],
  };
  for (const key of MS_FIELDS) {
    const value = body[key];
    if (value === undefined) continue;
    if (!isNonNegativeFinite(value)) return undefined;
    fields[key] = value;
  }
  return fields;
}

export async function handleTurnDisplayMetrics(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }

  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const fields = parseTurnDisplayMetricsBody(raw);
  if (!fields) {
    sendJson(res, 400, {
      error:
        'expected { chatId, messageId, dispatchAt (ISO), outcome: ok|aborted|error, and optional non-negative *_ms fields }',
    });
    return;
  }

  try {
    await recordTurnDisplayMetrics(deps.db, { ...fields, userId });
    sendJson(res, 200, { recorded: true });
  } catch (err) {
    // The unique index on message_id makes a duplicate insert idempotent ({ recorded: false });
    // any other failure is also swallowed — a metrics write must never fail the user's turn.
    const code = (err as { code?: string })?.code;
    if (code === '23505') {
      sendJson(res, 200, { recorded: false });
      return;
    }
    sendJson(res, 200, { recorded: false });
  }
}
