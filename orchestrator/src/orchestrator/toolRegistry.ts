/**
 * @file orchestrator/src/orchestrator/toolRegistry.ts
 * @stamp 2026-08-11
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
import type { EmbeddingProvider } from '../io/embeddings/types.js';

export interface ToolHandlerContext {
  userId: string;
  db: DbSession;
  /** Required, not optional — every tool handler already runs inside a request that has an
   *  EmbeddingProvider available in scope (it's a PluginDeps member everywhere plugins get
   *  constructed), so there's no legitimate call site that can't supply one. Making it optional
   *  would just relocate a silent embed gap into every other tool instead of closing it
   *  (chub-lorebook-embed-repair.md). */
  embeddings: EmbeddingProvider;
  /** The live conversation this turn belongs to (RunTurnOptions.taskId when taskKind is 'chat') —
   *  undefined for a non-chat task (e.g. an agent_routine dispatch has no chat to anchor to).
   *  plugins/canonize's propose_canon_fact uses this to scope a proposed fact to its chat. */
  chatId?: string;
  /** The chat_messages row this turn's tool calls should anchor to — the just-persisted user
   *  message that triggered this turn (server/httpServer.ts persists it before calling runTurn
   *  specifically so this is available here, not one turn stale). Undefined when chatId is. */
  anchorMessageId?: string;
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
