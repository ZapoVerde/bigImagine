/**
 * @file orchestrator/src/server/openai.ts
 * @stamp 2026-07-26
 * @architectural-role Pure Function module — OpenAI Chat Completions request/response shapes
 * @description
 * The minimal subset of the OpenAI Chat Completions shape the native frontend needs: chat
 * completions (streaming and non-streaming) and a models list. bigBrain never calls a real OpenAI
 * endpoint — this is only the shape bigBrain's own HTTP server produces for its own frontend to
 * consume; the shape happens to be OpenAI-compatible because that's how it was originally built,
 * not because an external OpenAI-shaped client is a target consumer.
 *
 * `attachments` is a bigBrain extension, not part of the OpenAI shape: bigBrain's own frontend
 * calls POST /v1/attachments/extract first to turn a staged file into Markdown, then sends the
 * result here alongside `messages` — httpServer.ts splices it onto the latest user message for
 * this turn only (util/attachmentContext.ts), never persisting it.
 *
 * `images` is a second, separate bigBrain extension: unlike `attachments`, an image never goes
 * through POST /v1/attachments/extract at all (there's nothing to extract — bb_principles.md §2
 * puts interpreting an image on the LLM, not a preprocessing step) — the frontend base64-encodes
 * it client-side and sends it straight here. MAX_IMAGES/MAX_IMAGE_BASE64_LENGTH are enforced in
 * the type guard itself so a malformed/oversized request is rejected before httpServer.ts ever
 * builds a message from it; httpServer.ts separately gates on the active connection's
 * LlmProvider.supportsVision before ever calling runTurn.
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

export interface IncomingImage {
  mimeType: string;
  /** Raw base64, no "data:...;base64," prefix — client-encoded, never touches
   *  POST /v1/attachments/extract. */
  base64: string;
}

// Unlike text, an oversized image can only be rejected, never truncated — and per-vendor limits
// differ, so this is a conservative, provider-agnostic ceiling, not any one vendor's actual limit.
const MAX_IMAGES_PER_TURN = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Reject on the encoded length itself (base64 inflates raw bytes by 4/3) rather than decoding
// first — a cheap string-length check ahead of ever allocating a Buffer for a hostile payload.
const MAX_IMAGE_BASE64_LENGTH = Math.ceil((MAX_IMAGE_BYTES * 4) / 3);
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

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
  /** bigBrain extension: staged images, spliced onto the latest user message for this turn only
   *  (util/attachmentContext.ts) — see this file's own preamble. httpServer.ts separately rejects
   *  the whole turn before runTurn if the active connection isn't vision-capable. */
  images?: IncomingImage[];
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

function isIncomingImage(value: unknown): value is IncomingImage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.mimeType !== 'string' || !ALLOWED_IMAGE_MIME_TYPES.has(v.mimeType)) return false;
  if (typeof v.base64 !== 'string' || v.base64.length === 0 || v.base64.length > MAX_IMAGE_BASE64_LENGTH) {
    return false;
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
  if (v.images !== undefined) {
    if (!Array.isArray(v.images) || v.images.length > MAX_IMAGES_PER_TURN || !v.images.every(isIncomingImage)) {
      return false;
    }
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
