/**
 * @file orchestrator/src/server/handleAdminStats.ts
 * @stamp 2026-08-14
 * @architectural-role IO Wrapper — the admin-only read side of the Stats page
 * (docs/plans/llm-stats-page-plan.md)
 * @description
 * Two read-only admin GET endpoints backing the Stats view's two sections, both gated by
 * withAdmin in httpServer.ts's route table (the same static-admin-key gate every other
 * /v1/admin/* route uses):
 *
 *   GET /v1/admin/llm-stats?days=<int>           → { calls: LlmCallStatRow[] }
 *   GET /v1/admin/turn-display-stats?days=<int>  → { turns: TurnDisplayMetricRow[] }
 *
 * `days` is a bounded lookback window — default 30, clamped to [1, 365] (plan Edge Cases: at
 * household scale a bounded window keeps both lists comfortably small, so neither endpoint
 * paginates). The actual queries live in adminServer.ts (listLlmStats/listTurnDisplayStats, the
 * same data-layer location as getLocationsAdmin/getLorebooksAdmin); this file only parses the
 * request and maps the rows out.
 *
 * @api-declaration
 * handleLlmStatsGet(req, res, deps)          — GET /v1/admin/llm-stats
 * handleTurnDisplayStatsGet(req, res, deps)  — GET /v1/admin/turn-display-stats
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the data functions)
 *     state_ownership: []
 *     external_io:     [Postgres via db.withSystemScope]
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';
import { listLlmStats, listTurnDisplayStats } from './adminServer.js';

const DEFAULT_DAYS = 30;

function daysFromQuery(req: IncomingMessage): number {
  const raw = new URL(req.url ?? '', 'http://placeholder').searchParams.get('days');
  const n = raw !== null && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(365, Math.max(1, Math.floor(n)));
}

export async function handleLlmStatsGet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, { calls: await listLlmStats(deps.db, daysFromQuery(req)) });
}

export async function handleTurnDisplayStatsGet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, { turns: await listTurnDisplayStats(deps.db, daysFromQuery(req)) });
}
