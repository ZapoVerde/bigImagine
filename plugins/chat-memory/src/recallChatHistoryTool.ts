/**
 * @file plugins/chat-memory/src/recallChatHistoryTool.ts
 * @stamp 2026-07-28
 * @architectural-role IO Wrapper — semantic search over one chat's archived turns
 * @description
 * The chat-lane RAG tool (docs/chat-memory.md) — same shape as
 * plugins/documents/src/searchDocumentsTool.ts, chat_chunks in place of document_chunks. Scoped to
 * the calling chat only (ctx.db's RLS still applies user_id, but chat_id further narrows to "this
 * conversation" — deliberately not a cross-chat search, since Canonize's own chat lane is per-chat
 * too and there's no product need yet to search a different chat's history from this one).
 *
 * Deliberately a tool the LLM chooses to call, not something silently injected into every prompt
 * (bb_principles.md §2: the LLM reasons, nothing else does) — unlike chat_memory_entries (the
 * "key ideas" digest), which is small and unconditionally part of the chat's own system prompt
 * (server/httpServer.ts), full-turn recall is a deliberate reach into the archive and stays an
 * explicit, on-demand action.
 *
 * @api-declaration
 * createRecallChatHistoryTool(embeddings) — returns the recall_chat_history RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (embeddings provider call, Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [embeddings provider, Postgres (via the DbSession it's given)]
 */

import type { EmbeddingProvider } from '@bigbrain/orchestrator/embeddings';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { toPgVectorLiteral } from '@bigbrain/orchestrator/pgvector';

interface ChunkRow {
  ordinal: number;
  summary: string;
  content: string;
}

function isRecallArgs(value: unknown): value is { chat_id: string; query: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).chat_id === 'string' &&
    typeof (value as Record<string, unknown>).query === 'string'
  );
}

export function createRecallChatHistoryTool(embeddings: EmbeddingProvider): RegisteredTool {
  return {
    definition: {
      name: 'recall_chat_history',
      description:
        "Semantic search over this chat's archived (no longer visible) turns: finds the passages whose meaning best " +
        'matches the query. Use this when something from earlier in a long conversation is relevant but no longer in ' +
        'view.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The current chat_id.' },
          query: { type: 'string', description: 'What to search for.' },
        },
        required: ['chat_id', 'query'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isRecallArgs(args)) {
        throw new Error('recall_chat_history requires chat_id: string and query: string arguments');
      }
      const [vector] = await embeddings.embed([args.query]);
      const rows = await ctx.db.query<ChunkRow>(
        `select ordinal, summary, content
         from chat_chunks
         where user_id = $1 and chat_id = $2
         order by vector_embed <-> $3
         limit 8`,
        [ctx.userId, args.chat_id, toPgVectorLiteral(vector!)],
      );
      return rows.map((r) => ({ ordinal: r.ordinal, summary: r.summary, excerpt: r.content }));
    },
  };
}
