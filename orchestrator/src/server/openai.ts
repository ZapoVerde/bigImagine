/**
 * @file orchestrator/src/server/openai.ts
 * @stamp 2026-07-26
 * @architectural-role Pure Function module — OpenAI Chat Completions request/response shapes
 * @description
 * The minimal subset of the OpenAI API shape a client like Open WebUI needs from a custom
 * "OpenAI-compatible" connection: chat completions (streaming and non-streaming) and a models
 * list. bigBrain never calls a real OpenAI endpoint — this is only the shape bigBrain's own HTTP
 * server produces so an unmodified OpenAI-shaped client can treat it as a model (the Phase 4
 * decision: bigBrain drives, the chat UI only displays).
 *
 * `attachments` is a bigBrain extension, not part of the OpenAI shape: bigBrain's own frontend
 * calls POST /v1/attachments/extract first to turn a staged file into Markdown, then sends the
 * result here alongside `messages` — httpServer.ts splices it onto the latest user message for
 * this turn only (util/attachmentContext.ts), never persisting it. Clients that never send it
 * (Open WebUI) are completely unaffected.
 *
 * @api-declaration
 * isChatCompletionRequestBody(value) — type guard for the incoming request body
 * buildChatCompletion / buildChatCompletionChunk / buildModelsList — response builders
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export interface IncomingChatMessage {
  role: string;
  content: string;
}

export interface IncomingAttachment {
  filename: string;
  /** Already-extracted, fenced Markdown from POST /v1/attachments/extract — never raw file bytes. */
  markdown: string;
  truncated?: boolean;
  meta?: { totalChars: number; totalLines: number };
}

export interface ChatCompletionRequestBody {
  model?: string;
  messages: IncomingChatMessage[];
  stream?: boolean;
  /** bigBrain extension, not part of the OpenAI shape: ties this turn to a persisted chat
   *  session (io/chatSessions.ts) — the session's params/tools apply and the exchange is stored.
   *  Clients that don't send it (Open WebUI) get the original stateless behavior untouched. */
  chat_id?: string;
  /** bigBrain extension: staged files' extracted text, spliced onto the latest user message for
   *  this turn only (util/attachmentContext.ts) — see this file's own preamble. */
  attachments?: IncomingAttachment[];
}

function isIncomingChatMessage(value: unknown): value is IncomingChatMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).role === 'string' &&
    typeof (value as Record<string, unknown>).content === 'string'
  );
}

function isIncomingAttachment(value: unknown): value is IncomingAttachment {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.filename !== 'string' || typeof v.markdown !== 'string') return false;
  if (v.truncated !== undefined && typeof v.truncated !== 'boolean') return false;
  if (v.meta !== undefined) {
    if (typeof v.meta !== 'object' || v.meta === null) return false;
    const meta = v.meta as Record<string, unknown>;
    if (typeof meta.totalChars !== 'number' || typeof meta.totalLines !== 'number') return false;
  }
  return true;
}

export function isChatCompletionRequestBody(value: unknown): value is ChatCompletionRequestBody {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.chat_id !== undefined && typeof v.chat_id !== 'string') return false;
  if (v.attachments !== undefined && !(Array.isArray(v.attachments) && v.attachments.every(isIncomingAttachment))) {
    return false;
  }
  return Array.isArray(v.messages) && v.messages.every(isIncomingChatMessage);
}

export function buildChatCompletion(model: string, replyContent: string) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content: replyContent }, finish_reason: 'stop' },
    ],
  };
}

export function buildChatCompletionChunk(
  model: string,
  id: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function buildModelsList(modelIds: string[]) {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: modelIds.map((id) => ({ id, object: 'model', created, owned_by: 'bigbrain' })),
  };
}
