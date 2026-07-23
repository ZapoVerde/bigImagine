/**
 * @file orchestrator/src/server/openApiToolServer.ts
 * @stamp 2026-07-23
 * @architectural-role Pure Function module (spec) + IO Wrapper (invocation) — the OpenAPI tool
 * surface for external callers (Open WebUI's "OpenAPI tool server" connection type, or any other
 * OpenAPI-aware client)
 * @description
 * A second, additive front door onto the exact same ToolRegistry httpServer.ts's own
 * /v1/chat/completions already dispatches into — not a replacement for it. That existing path
 * stays bigBrain's own reasoning loop calling its own tools; this path lets an *external* caller's
 * own model decide when to call one directly, bypassing runTurn entirely: the caller already
 * decided which tool and with what arguments, so there's no reasoning left for bigBrain to do —
 * just authenticate, scope, execute, per bb_principles.md §4 same as ever.
 *
 * buildOpenApiSpec needs no authoring: ToolDefinition.parameters is already JSON Schema, which
 * OpenAPI 3.1 adopted directly, so every registered tool becomes one POST path mechanically.
 * invokeTool reuses PostgresClient.withUserScope exactly like the orchestrator loop's own tool
 * dispatch does — RLS scoping is identical regardless of which front door a call came through.
 *
 * @api-declaration
 * buildOpenApiSpec(definitions, baseUrl) — pure; one POST path per tool definition
 * invokeTool(db, tools, userId, name, args) — looks up the tool, runs it scoped to userId, and
 *   never throws — failures (unknown tool, a thrown handler) come back as a {status, body} pair
 *   for the caller to translate into an HTTP response
 *
 * @contract
 *   assertions:
 *     purity:          buildOpenApiSpec is pure; invokeTool is impure (Postgres IO via the
 *                      injected session, runs whatever the resolved tool's handler does)
 *     state_ownership: []
 *     external_io:     [Postgres (via the PostgresClient it's given), whatever the invoked tool's
 *                      own handler does]
 */

import { log } from '../io/logger.js';
import type { ToolDefinition } from '../io/llm/types.js';
import type { PostgresClient } from '../io/postgres.js';
import type { ToolRegistry } from '../orchestrator/toolRegistry.js';

export interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string };
  servers: { url: string }[];
  paths: Record<string, unknown>;
  components: { securitySchemes: Record<string, unknown> };
}

export function buildOpenApiSpec(definitions: ToolDefinition[], baseUrl: string): OpenApiSpec {
  const paths: Record<string, unknown> = {};
  for (const def of definitions) {
    paths[`/${def.name}`] = {
      post: {
        operationId: def.name,
        summary: def.description,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: def.parameters } },
        },
        responses: {
          '200': { description: 'Tool result', content: { 'application/json': { schema: {} } } },
        },
        security: [{ bearerAuth: [] }],
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: { title: 'bigBrain Tools', version: '1.0.0' },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
  };
}

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
    log.error(`OpenAPI tool invocation failed for "${name}" (user ${userId})`, err);
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}
