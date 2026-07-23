/**
 * @file orchestrator/src/server/openai.ts
 * @stamp 2026-07-23
 * @architectural-role Pure Function module — OpenAI Chat Completions request/response shapes
 * @description
 * The minimal subset of the OpenAI API shape a client like Open WebUI needs from a custom
 * "OpenAI-compatible" connection: chat completions (streaming and non-streaming) and a models
 * list. bigBrain never calls a real OpenAI endpoint — this is only the shape bigBrain's own HTTP
 * server produces so an unmodified OpenAI-shaped client can treat it as a model (the Phase 4
 * decision: bigBrain drives, the chat UI only displays).
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

export interface ChatCompletionRequestBody {
  model?: string;
  messages: IncomingChatMessage[];
  stream?: boolean;
}

function isIncomingChatMessage(value: unknown): value is IncomingChatMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).role === 'string' &&
    typeof (value as Record<string, unknown>).content === 'string'
  );
}

export function isChatCompletionRequestBody(value: unknown): value is ChatCompletionRequestBody {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
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
