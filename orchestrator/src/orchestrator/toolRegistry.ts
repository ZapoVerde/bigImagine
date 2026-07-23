/**
 * @file orchestrator/src/orchestrator/toolRegistry.ts
 * @stamp 2026-07-21
 * @architectural-role Stateful Owner — the one place registered tools live
 * @description
 * Plugins register a ToolDefinition (what the LLM sees) paired with a ToolHandler (what
 * actually runs). The registry itself does no reasoning about which tool to call — that
 * decision belongs to the LLM alone, per bb_principles.md §2 — it only looks handlers up by
 * the name the LLM chose.
 *
 * @api-declaration
 * createToolRegistry(tools: RegisteredTool[]) — .definitions() for the LLM's tool manifest,
 *   .get(name) to resolve a tool call to its handler
 *
 * @contract
 *   assertions:
 *     purity:          impure (owns the tools map)
 *     state_ownership: [the name -> RegisteredTool map]
 *     external_io:     []
 */

import type { DbSession } from '../io/postgres.js';
import type { ToolDefinition } from '../io/llm/types.js';

export interface ToolHandlerContext {
  userId: string;
  db: DbSession;
}

export type ToolHandler = (args: unknown, ctx: ToolHandlerContext) => Promise<unknown>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export interface ToolRegistry {
  definitions(): ToolDefinition[];
  get(name: string): RegisteredTool | undefined;
}

export function createToolRegistry(tools: RegisteredTool[]): ToolRegistry {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return {
    definitions: () => tools.map((t) => t.definition),
    get: (name: string) => byName.get(name),
  };
}
