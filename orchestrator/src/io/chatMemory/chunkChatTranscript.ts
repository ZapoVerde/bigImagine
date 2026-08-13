/**
 * @file orchestrator/src/io/chatMemory/chunkChatTranscript.ts
 * @stamp 2026-07-28
 * @architectural-role Pure Function — splits a run of chat messages into embeddable chunks
 * @description
 * The chat-lane analogue of plugins/documents/src/chunkDocument.ts, but grouped by a fixed number
 * of turn-pairs rather than heading structure — a chat transcript has no headings to split on.
 * DEFAULT_MESSAGES_PER_CHUNK (4 = 2 user/assistant pairs) mirrors Canonize's own default chunk
 * size (2 turn-pairs); it is the fallback when the live `chat_memory_chunk_pairs` setting is
 * unset or corrupt — the same fallback shape as the other pair-based knobs (resolveSyncSettings
 * in chatMemorySync.ts, resolveEagerLlm in eagerChunkSync.ts, recallForPrompt.ts). Each caller
 * resolves the live value once per pass and passes it in; the chunker itself stays pure.
 *
 * Only ever called on a run of messages already known to be the "rolled-off" tail
 * (chatMemorySync.ts's runOneChatSync / eagerChunkSync.ts's maybeEagerChunk decide that
 * boundary) — this module has no opinion about which messages are eligible, it only groups
 * whatever it's given. A trailing partial group (fewer than messagesPerChunk messages left over)
 * is dropped, not chunked short — the sync callers only call this with a message count that's an
 * exact multiple of their resolved messagesPerChunk, so a leftover here would mean a caller bug,
 * not a real partial-pair chat. That guarantee itself rests on every turn being exactly one user
 * + one assistant message today; the callers' own eligibility math is turn-boundary-aware (not a
 * blind raw-message count) specifically so this still holds once a turn can span more than two
 * messages (e.g. a future "continue" affordance) — but this module would need to become
 * turn-boundary-aware too at that point, since a mid-turn split here would break a chunk's
 * semantic grouping even though the callers' own boundaries stayed correct.
 *
 * @api-declaration
 * chunkChatTranscript(messages, startOrdinal, messagesPerChunk) — groups messages into
 *   fixed-size chunks; ordinal numbering continues from startOrdinal so chunks stay uniquely
 *   ordered across repeated syncs of the same chat; messagesPerChunk is the resolved chunk size
 *   in raw messages (2 × the `chat_memory_chunk_pairs` setting)
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export const DEFAULT_MESSAGES_PER_CHUNK = 4;
/** The pair-denominated form of the default chunk size (2 turn-pairs = today's 4-message chunk).
 *  Callers that resolve `chat_memory_chunk_pairs` fall back to this when the row is unset or
 *  corrupt (toPositiveInt semantics); chunkChatTranscript itself receives the *message*-denominated
 *  value (pairs × 2). */
export const DEFAULT_CHUNK_PAIRS = 2;

export interface ChatTranscriptMessage {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatChunk {
  ordinal: number;
  content: string;
  /** The last message this chunk covers — chat_chunks doesn't store this directly (only the sync
   *  point that produced it does), but the sync callers use it to confirm chunking consumed
   *  exactly the message range they were given. */
  lastMessageId: string;
}

export function chunkChatTranscript(
  messages: ChatTranscriptMessage[],
  startOrdinal: number,
  messagesPerChunk: number,
): ChatChunk[] {
  const chunks: ChatChunk[] = [];

  for (let i = 0; i + messagesPerChunk <= messages.length; i += messagesPerChunk) {
    const group = messages.slice(i, i + messagesPerChunk);
    const content = group.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
    chunks.push({
      ordinal: startOrdinal + chunks.length,
      content,
      lastMessageId: group[group.length - 1]!.messageId,
    });
  }

  return chunks;
}
