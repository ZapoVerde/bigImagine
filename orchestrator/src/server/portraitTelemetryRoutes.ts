/**
 * @file orchestrator/src/server/portraitTelemetryRoutes.ts
 * @stamp 2026-08-19
 * @architectural-role IO Wrapper — the user-scoped Portrait round telemetry endpoint
 *   (docs/plans/portrait-studio-telemetry-plan.md)
 * @description
 * GET /v1/portraits/rounds/:roundId/telemetry — the durable per-round diagnostic surface behind
 * Portrait Studio's left-panel receipts. All IO lives here; the merge/totals arithmetic is the
 * pure module portraits/portraitTelemetry.ts.
 *
 * The query order is the plan's ownership discipline (§Endpoint and polling):
 *   1. Load the visual_rounds row through the normal user-scoped RLS path (db.withUserScope) —
 *      this is the ownership check, and it must succeed before anything else runs. A missing or
 *      foreign roundId returns the same not-found shape as every other user-scoped Portrait
 *      resource and never reveals whether another user's round exists.
 *   2. Only then query llm_calls — which carries NO RLS (llmGate.ts's own documented
 *      household-wide-table exemption, the same category as provider_credentials/
 *      orchestrator_settings) — through db.withSystemScope, filtered explicitly by BOTH
 *      round_id AND user_id. The route must never rely on round_id alone to scope that query.
 *   3. Query visual_round_image_calls, which does carry normal user-scoped RLS, through
 *      db.withUserScope.
 *
 * The handler is a thin read: no writes, no provider calls. It is user-gated (withUser) in
 * httpServer.ts's route table, same as every other Portrait surface, and opens with the same
 * requirePortraitsEnabled kill-switch gate.
 *
 * @api-declaration
 * handlePortraitRoundTelemetry(req, res, deps, userId, url) — GET
 *   /v1/portraits/rounds/:roundId/telemetry → 200 PortraitRoundTelemetry | 404 not-found |
 *   403 portrait-studio-disabled
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO)
 *     state_ownership: []
 *     external_io:     [Postgres (visual_rounds/visual_round_image_calls via db.withUserScope,
 *                       llm_calls via db.withSystemScope — the explicit user_id filter is the
 *                       only scoping llm_calls' RLS-exemption allows)]
 *     never:           throws. Every failure path logs and answers with a status + error body.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../io/logger.js';
import { sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';
import { requirePortraitsEnabled } from './portraitRoutes.js';
import { buildRoundTelemetry, type ImageCallRow, type LlmCallRow, type VisualRoundRow } from '../portraits/portraitTelemetry.js';

/** GET /v1/portraits/rounds/:roundId/telemetry — the round's calls and totals. See the module
 *  header for the ownership-check-then-scoped-read order; the shape is the pure module's
 *  PortraitRoundTelemetry. */
export async function handlePortraitRoundTelemetry(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  userId: string,
  url: URL,
): Promise<void> {
  if (!(await requirePortraitsEnabled(deps, res))) return;
  if (req.method !== 'GET') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const segments = url.pathname.slice('/v1/portraits/rounds'.length).split('/').filter(Boolean);
  if (segments.length !== 2 || segments[1] !== 'telemetry') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const roundId = decodeURIComponent(segments[0]);

  // 1. Ownership check first — through the normal user-scoped RLS path. A missing row is a 404
  //    (the same shape as other user-scoped Portrait resources), and the query's user_id
  //    predicate means a foreign roundId is simply a missing row.
  const roundRows = await deps.db.withUserScope(userId, (session) =>
    session.query<VisualRoundRow>(
      `select round_id, goal, started_at, completed_at, status
       from visual_rounds where round_id = $1 and user_id = $2`,
      [roundId, userId],
    ),
  );
  const round = roundRows[0];
  if (!round) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  // 2. llm_calls is RLS-exempt — never scoped by round_id alone. Run it through withSystemScope
  //    and filter by BOTH round_id and user_id, with the userId always coming from the trusted
  //    server-side auth context (this handler's userId), never from request content.
  const llmRows = await deps.db.withSystemScope((session) =>
    session.query<LlmCallRow>(
      `select call_id, user_id, outcome, prompt_tokens, completion_tokens, total_tokens,
              cache_read_tokens, duration_ms, reason, created_at, provider_kind, model, call_label
       from llm_calls where round_id = $1 and user_id = $2 order by created_at`,
      [roundId, userId],
    ),
  );

  // 3. visual_round_image_calls carries normal user-scoped RLS — plain withUserScope read.
  const imageRows = await deps.db.withUserScope(userId, (session) =>
    session.query<ImageCallRow>(
      `select call_id, round_id, candidate_id, status, provider_kind, model, duration_ms,
              error_code, error_message, started_at
       from visual_round_image_calls where round_id = $1 and user_id = $2 order by started_at`,
      [roundId, userId],
    ),
  );

  log.info('portraitTelemetry: round telemetry served', { roundId, userId, llmCalls: llmRows.length, imageCalls: imageRows.length });
  sendJson(res, 200, buildRoundTelemetry(round, llmRows, imageRows));
}