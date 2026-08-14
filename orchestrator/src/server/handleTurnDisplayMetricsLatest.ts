/**
 * @file orchestrator/src/server/handleTurnDisplayMetricsLatest.ts
 * @stamp 2026-08-14
 * @architectural-role IO Wrapper — the client-facing read side of the Timing section
 * (docs/plans/turn-timeline-graph-plan.md), sibling of handleTurnDisplayMetrics.ts
 * @description
 * GET /v1/chats/:chatId/turn-display-metrics/latest — the chat drawer Timing section's durable
 * "last turn" read: the newest recorded turn_display_metrics row for this chat, or null when the
 * chat has none. Dispatched from handleChatRoutes (the /v1/chats family route), so userId is
 * already authenticated by withUser — the same regular chat auth the POST side uses, deliberately
 * not the admin key: a user's own chat's timing is no more sensitive than the chat itself.
 *
 * The read is user_scoped by construction (latestTurnDisplayMetric runs inside withUserScope, and
 * migration 0102's RLS policy filters on user_id = app_current_user_id()), so a foreign chat_id
 * simply reads no rows — never someone else's data, and never an error the drawer would have to
 * interpret.
 *
 * @api-declaration
 * handleTurnDisplayMetricsLatest(res, deps, userId, chatId) — responds { turn: TurnDisplayMetricRow | null }
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO)
 *     state_ownership: []
 *     external_io:     [Postgres via latestTurnDisplayMetric]
 */

import type { ServerResponse } from 'node:http';
import { sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';
import { latestTurnDisplayMetric } from '../io/turnDisplayMetrics.js';

export async function handleTurnDisplayMetricsLatest(
  res: ServerResponse,
  deps: HttpServerDeps,
  userId: string,
  chatId: string,
): Promise<void> {
  const turn = await latestTurnDisplayMetric(deps.db, userId, chatId);
  sendJson(res, 200, { turn });
}
