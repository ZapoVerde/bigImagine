/**
 * @file orchestrator/src/util/attachmentContext.ts
 * @stamp 2026-07-26
 * @architectural-role Pure Function — splices staged file attachments into a chat turn's messages
 * @description
 * Attached files never get their own message or a fabricated tool-call round — both would need to
 * survive being replayed on every future turn (a persisted chat's `messages` array is rebuilt from
 * the client's own flat history every request, see httpServer.ts's handleChatCompletions), and a
 * synthetic tool_use/tool_result pair a chat-completions client invented — one that never went
 * through a provider's actual tool-calling machinery — is exactly the shape both Anthropic's and
 * OpenAI's own message validation exists to reject. Appending the extracted Markdown directly onto
 * the *latest* user message's content is the smallest change that gets a file's text in front of
 * the model this one turn, without inventing a new message shape either adapter has to understand.
 *
 * This is deliberately never persisted: httpServer.ts calls this only to build the copy of
 * `messages` handed to runTurn — the chat's stored history and its auto-generated title both still
 * derive from the original, un-spliced messages. A file attached to one turn doesn't bloat that
 * chat's history forever; the browser is expected to resend a file's extracted text again if it's
 * still relevant to a later message.
 *
 * @api-declaration
 * AttachmentForContext
 * appendAttachmentsToLatestUserMessage(messages, attachments) — returns a new array; the input
 *   array and its messages are never mutated
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import { buildTruncationBanner, type TruncationMeta } from './truncateForContext.js';
import type { LlmMessage } from '../io/llm/types.js';

export interface AttachmentForContext {
  filename: string;
  markdown: string;
  truncated?: boolean;
  meta?: TruncationMeta;
}

function formatAttachment(attachment: AttachmentForContext): string {
  const banner = attachment.truncated && attachment.meta ? `\n${buildTruncationBanner(attachment.meta)}` : '';
  return `Attached file: ${attachment.filename}${banner}\n${attachment.markdown}`;
}

function findLastUserIndex(messages: LlmMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return i;
  }
  return -1;
}

export function appendAttachmentsToLatestUserMessage(
  messages: LlmMessage[],
  attachments: AttachmentForContext[],
): LlmMessage[] {
  if (attachments.length === 0) return messages;
  const targetIndex = findLastUserIndex(messages);
  if (targetIndex === -1) return messages;

  const block = attachments.map(formatAttachment).join('\n\n');
  const updated = [...messages];
  updated[targetIndex] = {
    ...updated[targetIndex]!,
    content: `${updated[targetIndex]!.content}\n\n${block}`,
  };
  return updated;
}
