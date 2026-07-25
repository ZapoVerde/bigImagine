/**
 * @file orchestrator/src/orchestrator/toolRegistry.ts
 * @stamp 2026-07-25
 * @architectural-role Stateful Owner — the one place registered tools live
 * @description
 * Plugins register a ToolDefinition (what the LLM sees) paired with a ToolHandler (what
 * actually runs). The registry itself does no reasoning about which tool to call — that
 * decision belongs to the LLM alone, per bb_principles.md §2 — it only looks handlers up by
 * the name the LLM chose. A tool may optionally also declare focusHint (Canvas) — the registry
 * doesn't act on it, just carries it alongside definition/handler for loop.ts to read.
 *
 * @api-declaration
 * createToolRegistry(tools: RegisteredTool[]) — .definitions() for the LLM's tool manifest,
 *   .get(name) to resolve a tool call to its handler
 * filterToolRegistry(registry, allowed) — a view of an existing registry restricted to the named
 *   tools (a chat session's tool allow-list, io/chatSessions.ts); wraps rather than reconstructs,
 *   since RegisteredTool[] can't be enumerated back out of a ToolRegistry
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
  /** Given this tool's own result, returns an id worth surfacing as the chat's focused document
   *  (e.g. a note id) — Canvas (orchestrator/src/orchestrator/loop.ts's runTurn) relays whatever
   *  this returns without interpreting it; only the tool itself knows what "canvas-worthy" means
   *  for its own domain. */
  focusHint?: (result: unknown) => string | null;
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

export function filterToolRegistry(registry: ToolRegistry, allowed: string[]): ToolRegistry {
  const allowedNames = new Set(allowed);
  return {
    definitions: () => registry.definitions().filter((d) => allowedNames.has(d.name)),
    get: (name: string) => (allowedNames.has(name) ? registry.get(name) : undefined),
  };
}
