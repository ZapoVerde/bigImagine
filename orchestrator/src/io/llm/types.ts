/**
 * @file orchestrator/src/io/llm/types.ts
 * @stamp 2026-07-21
 * @architectural-role Pure Function module — shared types only, no behavior
 * @description
 * The interface every LLM provider adapter implements. bb_principles.md §6 (The Reasoning
 * Layer is Replaceable): this is the seam — orchestrator/loop.ts is written against
 * LlmProvider, never against a named vendor's request/response shape. Swapping providers means
 * writing a new adapter behind this interface, not touching the loop.
 *
 * @api-declaration
 * LlmMessage, ToolDefinition, ToolCall, LlmTurn, LlmUsage, LlmProvider — see inline docs
 *
 * @contract
 *   assertions:
 *     purity:          pure (types only)
 *     state_ownership: []
 *     external_io:     []
 */

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmImageAttachment {
  /** e.g. "image/png", "image/jpeg", "image/webp", "image/gif" — validated at the server boundary
   *  (server/openai.ts), trusted as-is by the time it reaches an adapter. */
  mimeType: string;
  /** Raw base64 payload, no "data:...;base64," prefix. */
  base64: string;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  /** Set only on a 'user' message: images to attach alongside the text content, this turn only.
   *  Never persisted (see util/attachmentContext.ts) — same ephemeral, client-resent shape as a
   *  text attachment's Markdown. Only meaningful when the resolved LlmProvider's own
   *  supportsVision is true; server/httpServer.ts is the one place that check happens, before any
   *  adapter ever sees a message carrying this. */
  images?: LlmImageAttachment[];
  /** Set only when role === 'tool': echoes the ToolCall.id this message answers. */
  toolCallId?: string;
  /** Set only on an assistant message that requested tool calls. Required for a follow-up
   *  complete() call to be well-formed: a real provider rejects a 'tool' message whose
   *  toolCallId doesn't trace back to a toolCalls entry on a preceding assistant message —
   *  this is what makes that possible when history is replayed. */
  toolCalls?: ToolCall[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmTurn {
  /** The assistant's reply. content is '' when the turn is purely tool call(s). */
  message: LlmMessage;
  toolCalls: ToolCall[];
  /** Token accounting for this one complete() call, straight from the vendor's own response —
   *  undefined only for a provider that genuinely doesn't report it (none of the three adapters
   *  here omit it; kept optional so a future minimal adapter isn't forced to fake one). Consumed
   *  by io/llm/llmGate.ts (bb_principles.md §14) to log usage and enforce agent_routine caps —
   *  never computed or estimated here, only relayed. */
  usage?: LlmUsage;
}

export interface LlmCompleteOptions {
  /** Force the named tool to be called instead of leaving it to the model's discretion — the
   *  "forced-schema call" pattern docs/spec.md §6.1/§6.3 use for extraction, not open-ended
   *  agentic tool use. `tools` must contain exactly this one definition when set. */
  forceTool?: string;
  /** Override the profile's own model for this call only — how a live model picker (Open
   *  WebUI's connection dropdown, backed by GET /v1/models) actually takes effect per request.
   *  Falls back to the profile's configured model when unset, which is what non-chat callers
   *  (e.g. the forced-schema classification call) get, since there's no picker in that path. */
  model?: string;
  /** Per-call sampling overrides — how a chat session's own params (io/chatSessions.ts) take
   *  effect. Omitted fields are simply not sent (temperature/topP), or fall back to the
   *  provider's static config then 16384 (maxTokens) — the provider's own defaults apply. 16384
   *  (not 1024) because tool arguments can carry a whole pasted document (save_document's
   *  contentMarkdown): anything smaller truncates the model's tool-call JSON mid-string on a
   *  real document and crashes the turn (see openaiCompatible.ts's fromOaiResponse). */
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  /** Whether this connection's configured model can accept LlmMessage.images. Set once, at
   *  construction, from the resolved LlmProfile.supportsVision (io/llm/profiles.ts) — there's no
   *  reliable way to detect this from the wire protocol itself, so it's always an explicit,
   *  admin-set flag, never inferred. server/httpServer.ts checks this before ever building a
   *  message carrying images, so a non-vision-capable connection fails the turn visibly instead of
   *  silently dropping the image or letting the model claim to have seen it (bb_principles.md §2). */
  readonly supportsVision: boolean;
  complete(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    options?: LlmCompleteOptions,
  ): Promise<LlmTurn>;
  /** Optional capability: the live model catalog behind a dynamic model picker (server/httpServer.ts's
   *  GET /v1/models). Not every provider has one worth exposing this way — undefined means "fall
   *  back to a single static entry," not "provider is broken." Keeping this on LlmProvider rather
   *  than passing baseUrl/apiKey out to httpServer.ts separately is what keeps them private to
   *  each adapter's own closure.
   *
   *  pricing is per-token, in USD, as strings straight from the vendor (OpenRouter's /models is
   *  the only source that actually has it; DeepSeek's doesn't, so it's simply absent there — not
   *  every provider needs to invent a number). Only GET /v1/admin/settings/models (the Settings
   *  tab's model picker) surfaces it; the public GET /v1/models Open WebUI uses only ever sends
   *  bare ids (server/httpServer.ts's handleModels maps to `.id` before responding), so this
   *  field never reaches that unauthenticated route. */
  listModels?(): Promise<{ id: string; pricing?: { prompt: string; completion: string } }[]>;
}
