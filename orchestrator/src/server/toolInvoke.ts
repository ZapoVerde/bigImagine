/**
 * @file orchestrator/src/server/toolInvoke.ts
 * @stamp 2026-08-03
 * @architectural-role IO Wrapper — direct tool invocation by name for the native frontend
 * @description
 * A second, additive front door onto the exact same ToolRegistry httpServer.ts's own
 * /v1/chat/completions already dispatches into — not a replacement for it. That existing path
 * stays the orchestrator's own reasoning loop calling its own tools; this path lets the native
 * frontend call one directly by name (a UI action, not a conversational turn), bypassing runTurn
 * entirely — the caller already decided which tool and with what arguments, so there's no
 * reasoning left to do — just authenticate, scope, execute, per bi_principles.md §4 same as ever.
 *
 * invokeTool reuses PostgresClient.withUserScope exactly like the orchestrator loop's own tool
 * dispatch does — RLS scoping is identical regardless of which front door a call came through.
 *
 * @api-declaration
 * invokeTool(db, tools, userId, name, args) — looks up the tool, runs it scoped to userId, and
 *   never throws — failures (unknown tool, a thrown handler) come back as a {status, body} pair
 *   for the caller to translate into an HTTP response
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session, runs whatever the resolved
 *                      tool's handler does)
 *     state_ownership: []
 *     external_io:     [Postgres (via the PostgresClient it's given), whatever the invoked tool's
 *                      own handler does]
 */

import { log } from '../io/logger.js';
import type { PostgresClient } from '../io/postgres.js';
import type { ToolRegistry } from '../orchestrator/toolRegistry.js';

export interface ToolInvocationResult {
  status: number;
  body: unknown;
}

export async function invokeTool(
  db: PostgresClient,
  tools: ToolRegistry,
  userId: string,
  name: string,
  args: unknown,
): Promise<ToolInvocationResult> {
  const tool = tools.get(name);
  if (!tool) {
    return { status: 404, body: { error: `unknown tool: ${name}` } };
  }

  try {
    const result = await db.withUserScope(userId, (session) => tool.handler(args, { userId, db: session }));
    return { status: 200, body: result ?? {} };
  } catch (err) {
    log.error(`tool invocation failed for "${name}" (user ${userId})`, err);
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}
