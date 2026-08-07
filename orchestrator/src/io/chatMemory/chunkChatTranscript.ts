/**
 * @file plugins/chat-memory/src/chunkChatTranscript.ts
 * @stamp 2026-07-28
 * @architectural-role Pure Function — splits a run of chat messages into embeddable chunks
 * @description
 * The chat-lane analogue of plugins/documents/src/chunkDocument.ts, but grouped by a fixed number
 * of turn-pairs rather than heading structure — a chat transcript has no headings to split on.
 * MESSAGES_PER_CHUNK (4 = 2 user/assistant pairs) mirrors Canonize's own default chunk size (2
 * turn-pairs); kept a plain constant, not a setting, for the same reason chunkDocument.ts's
 * CHUNK_CHAR_CAP is one — nothing yet needs it to vary.
 *
 * Only ever called on a run of messages already known to be the "rolled-off" tail (runChatSync.ts
 * decides that boundary) — this module has no opinion about which messages are eligible, it only
 * groups whatever it's given. A trailing partial group (fewer than MESSAGES_PER_CHUNK messages
 * left over) is dropped, not chunked short — runChatSync.ts only calls this with a message count
 * that's an exact multiple of MESSAGES_PER_CHUNK, so a leftover here would mean a caller bug, not
 * a real partial-pair chat. That guarantee itself rests on every turn being exactly one user +
 * one assistant message today; runChatSync.ts's own eligibility math is turn-boundary-aware (not a
 * blind raw-message count) specifically so this still holds once a turn can span more than two
 * messages (e.g. a future "continue" affordance) — but this module would need to become
 * turn-boundary-aware too at that point, since a mid-turn split here would break a chunk's semantic
 * grouping even though runChatSync.ts's own boundaries stayed correct.
 *
 * @api-declaration
 * chunkChatTranscript(messages, startOrdinal) — groups messages into fixed-size chunks; ordinal
 *   numbering continues from startOrdinal so chunks stay uniquely ordered across repeated syncs
 *   of the same chat
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export const MESSAGES_PER_CHUNK = 4;

export interface ChatTranscriptMessage {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatChunk {
  ordinal: number;
  content: string;
  /** The last message this chunk covers — chat_chunks doesn't store this directly (only the sync
   *  point that produced it does), but runChatSync.ts uses it to confirm chunking consumed
   *  exactly the message range it was given. */
  lastMessageId: string;
}

export function chunkChatTranscript(messages: ChatTranscriptMessage[], startOrdinal: number): ChatChunk[] {
  const chunks: ChatChunk[] = [];

  for (let i = 0; i + MESSAGES_PER_CHUNK <= messages.length; i += MESSAGES_PER_CHUNK) {
    const group = messages.slice(i, i + MESSAGES_PER_CHUNK);
    const content = group.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
    chunks.push({
      ordinal: startOrdinal + chunks.length,
      content,
      lastMessageId: group[group.length - 1]!.messageId,
    });
  }

  return chunks;
}
