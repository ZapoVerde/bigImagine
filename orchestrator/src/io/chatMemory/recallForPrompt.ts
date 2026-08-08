/**
 * @file orchestrator/src/io/chatMemory/recallForPrompt.ts
 * @stamp 2026-08-08
 * @architectural-role IO Wrapper — CNZ-style silent per-turn recall, injected at prompt assembly
 * @description
 * The read-path twin of the recall_chat_history / recall_canon_facts tools, but CNZ-shaped:
 * SillyTavern-Canonize never asks the model to reach for memory — on every generation its
 * rag/generation-hook.js builds a query from the last `ragClassifierHistory` (default 3)
 * turn-pairs of the raw transcript (`cleanForEmbedding(formatPairsAsTranscript(...))`), embeds
 * it once, pulls the chat's archived full-turn chunks AND its saved facts in parallel, and
 * injects both into the prompt unconditionally. This module is that same shape for the RP lane:
 * server-side, per-turn, no tool call, no LLM decision — the model's job is to reason over the
 * context it's given, not to remember to go fetch it (bb_principles.md §2, applied the way CNZ
 * applies it rather than the tool-gated way recallChatHistoryTool.ts documents).
 *
 * The user's own framing (session note): "for the prompt stack, we autopopulate the recall tool
 * with the last x turns plus the content of the user's last entry to pull both the saved facts
 * plus a number of full turn text — the way CNZ works." So the query is built from the trailing
 * AUTO_RECALL_PAIRS user/assistant pairs of the full message list handed to the prompt assembler
 * (which includes the just-sent user message — the client sends complete history, and
 * handleChatCompletions only trims after assembly), embedded once, then two parallel searches:
 *
 *  1. chat_chunks — this chat's archived full-turn texts (the CNZ "chat lane"; a handful of
 *     whole turns, content verbatim like the tool returns; count = chat_memory_auto_recall_chunk_top_k,
 *     default AUTO_RECALL_CHUNK_TOP_K)
 *  2. canon_facts — approved rows only, deduped to most-recent-approved per arc_tag/entity_key,
 *     top-k from the live canon_recall_top_k setting (default 8) — the same dedup query
 *     recallCanonFactsTool.ts runs, just scoped to "now" (no as_of filter)
 *
 * All three retrieval knobs are live settings read on every call (chat_memory_auto_recall_enabled,
 * chat_memory_auto_recall_pairs, chat_memory_auto_recall_chunk_top_k — migration 0077); the
 * exported AUTO_RECALL_* constants are the fallback defaults when a setting is unset or corrupt,
 * same fail-open shape as canon_recall_top_k. `enabled === 'false'` silences the silent path
 * without touching the recall tools, which stay in the RP allow-list.
 *
 * Both are scoped to this chat_id inside the caller's already-open withUserScope session (RLS
 * applies user_id, chat_id narrows to "this conversation" — same trusted-identity scoping as the
 * two recall tools; the module takes the session rather than opening its own scope, since
 * buildChatMemorySystemPrompt's rp branch is already inside one). Results are formatted into one
 * labeled block and returned as the prompt-assembly caller's extra memoryContext part. Fail-open
 * by contract: any error (embedding provider down, DB hiccup, malformed row) logs a warning and
 * returns '' — retrieval must never break or stall a turn.
 *
 * This deliberately runs *before* trimToLiveWindow's cutoff in the prompt assembler's Promise.all
 * (httpServer.ts's buildChatMemorySystemPrompt) — the query uses the full untrimmed history so
 * the user's last entry is always the newest pair, exactly CNZ's `allPairs.slice(-horizonPairs)`.
 *
 * @api-declaration
 * buildAutoRecallPrompt(session, settings, embeddings, userId, chatId, messages) ->
 *   Promise<string> — the labeled recall block, or '' when nothing matched / retrieval failed
 *   (fail-open). `session` is the caller's already-user-scoped DbSession.
 *
 * @contract
 *   assertions:
 *     purity:          impure (embeddings provider call, settings read, Postgres IO)
 *     state_ownership: []
 *     external_io:     [embeddings provider, orchestrator settings store, Postgres]
 */

import type { EmbeddingProvider } from '../embeddings/types.js';
import type { OrchestratorSettingsStore } from '../orchestratorSettings.js';
import type { DbSession } from '../postgres.js';
import type { LlmMessage } from '../llm/types.js';
import { toPgVectorLiteral } from '../../util/pgvector.js';
import { log } from '../logger.js';

/** How many trailing turn-pairs form the query — mirrors Canonize's own `ragClassifierHistory`
 *  default (3), which the user named as the reference behavior. This is the fallback default;
 *  the live value is the chat_memory_auto_recall_pairs setting (migration 0077), read on every
 *  call so a save takes effect on the next turn, no restart. */
export const AUTO_RECALL_PAIRS = 3;

/** How many full-turn chunks to pull. CNZ's chat lane defaults to 2-8 with a distributional
 *  cutoff; "a number of full turn text" (user) — a fixed handful, content verbatim, is the
 *  basics-shaped version of that. Same default/fallback split as AUTO_RECALL_PAIRS: the live
 *  value is chat_memory_auto_recall_chunk_top_k. */
export const AUTO_RECALL_CHUNK_TOP_K = 4;

const DEFAULT_FACT_TOP_K = 8;

/** Sanity cap so a corrupt canon_recall_top_k value can't balloon the injected block: facts are
 *  already deduped per arc/entity, so beyond ~50 the marginal recall value is nil while the
 *  token cost is real. recallCanonFactsTool.ts has no clamp (a tool call is one-off and
 *  model-sized); this runs every turn, so it bounds the steady-state prompt. */
const MAX_FACT_TOP_K = 50;

/** Sanity cap for chat_memory_auto_recall_chunk_top_k, same reasoning as MAX_FACT_TOP_K — this
 *  injects *full turn text* verbatim, so an unbounded corrupt value would blow up the prompt
 *  stack far faster than facts would. 12 is already generous (12 full turns of archive); the
 *  setting UI will present a much smaller range. */
const MAX_CHUNK_TOP_K = 12;

interface ChunkRow {
  ordinal: number;
  summary: string;
  content: string;
}

interface CanonFactRow {
  fact_id: string;
  category: string;
  summary: string;
  detail: string;
}

/** Query-text cleanup in CNZ's spirit: collapse whitespace runs so the embedded query is about
 *  words, not layout. (Deliberately not full CNZ parity — CNZ strips speaker labels via its
 *  transcript cleaner; keeping `User:`/`Assistant:` prefixes here preserves the speaker turn
 *  structure, which is part of what makes this a *conversation* query.) */
function cleanForEmbedding(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Build the query text from the trailing turn-pairs of the full message list. Each pair is one
 *  user + one assistant message (the "turn"); a trailing lone user message (the just-sent entry
 *  before its reply exists) counts as its own pair, so the user's last entry is always included
 *  — CNZ's formatPairsAsTranscript(allPairs.slice(-horizonPairs)) has the same shape. */
export function buildAutoRecallQuery(messages: LlmMessage[], pairCount = AUTO_RECALL_PAIRS): string {
  const pairs: { user: string; assistant?: string }[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      pairs.push({ user: message.content });
    } else if (message.role === 'assistant' && pairs.length > 0 && pairs[pairs.length - 1]!.assistant === undefined) {
      pairs[pairs.length - 1]!.assistant = message.content;
    }
  }
  return cleanForEmbedding(
    pairs
      .slice(-pairCount)
      .map((p) => `User: ${p.user}${p.assistant !== undefined ? `\nAssistant: ${p.assistant}` : ''}`)
      .join('\n'),
  );
}

export function buildAutoRecallPrompt(
  session: DbSession,
  settings: OrchestratorSettingsStore,
  embeddings: EmbeddingProvider,
  userId: string,
  chatId: string,
  messages: LlmMessage[],
): Promise<string> {
  return (async () => {
    try {
      const [enabledRaw, pairsRaw, chunkTopKRaw, factTopKRaw] = await Promise.all([
        settings.get('chat_memory_auto_recall_enabled'),
        settings.get('chat_memory_auto_recall_pairs'),
        settings.get('chat_memory_auto_recall_chunk_top_k'),
        settings.get('canon_recall_top_k'),
      ]);

      // Master switch: 'false' disables the auto-injection entirely. The recall *tools* stay in
      // the RP allow-list either way — this knob only silences the silent path (CNZ's own
      // enable/disable shape). Unset/any-other-value = on (the shipped default).
      if (enabledRaw === 'false') return '';

      const parsedPairs = pairsRaw ? parseInt(pairsRaw, 10) : NaN;
      const pairs = Number.isFinite(parsedPairs) && parsedPairs > 0 ? parsedPairs : AUTO_RECALL_PAIRS;

      const parsedChunkTopK = chunkTopKRaw ? parseInt(chunkTopKRaw, 10) : NaN;
      const chunkTopK =
        Number.isFinite(parsedChunkTopK) && parsedChunkTopK > 0
          ? Math.min(parsedChunkTopK, MAX_CHUNK_TOP_K)
          : AUTO_RECALL_CHUNK_TOP_K;

      const parsedFactTopK = factTopKRaw ? parseInt(factTopKRaw, 10) : NaN;
      const factTopK =
        Number.isFinite(parsedFactTopK) && parsedFactTopK > 0 ? Math.min(parsedFactTopK, MAX_FACT_TOP_K) : DEFAULT_FACT_TOP_K;

      const query = buildAutoRecallQuery(messages, pairs);
      if (!query) return '';

      const [vector] = await embeddings.embed([query]);
      if (!vector) return '';

      const [chunks, facts] = await Promise.all([
        session.query<ChunkRow>(
          `select ordinal, summary, content
           from chat_chunks
           where user_id = $1 and chat_id = $2
           order by vector_embed <-> $3
           limit ${chunkTopK}`,
          [userId, chatId, toPgVectorLiteral(vector)],
        ),
        session.query<CanonFactRow>(
          `with candidates as (
             select f.fact_id, f.category, f.summary, f.detail, f.arc_tag, f.entity_key, f.approved_at, f.vector_embed
             from canon_facts f
             where f.user_id = $1 and f.chat_id = $2 and f.status = 'approved'
           ),
           ranked as (
             select distinct on (coalesce(arc_tag, entity_key, fact_id::text)) fact_id, category, summary, detail, vector_embed
             from candidates
             order by coalesce(arc_tag, entity_key, fact_id::text), approved_at desc
           )
           select fact_id, category, summary, detail
           from ranked
           order by vector_embed <-> $3
           limit $4`,
          [userId, chatId, toPgVectorLiteral(vector), factTopK],
        ),
      ]);

      const parts: string[] = [];
      if (chunks.length) {
        parts.push(
          chunks
            .map(
              (c) =>
                `<memory turns="${c.ordinal}">\n${c.content}\n</memory>` +
                (c.summary ? ` <!-- ${c.summary} -->` : ''),
            )
            .join('\n'),
        );
      }
      if (facts.length) {
        parts.push(
          facts
            .map((f) => `- [${f.category}] ${f.summary}${f.detail ? ` — ${f.detail}` : ''}`)
            .join('\n'),
        );
      }
      return parts.length ? `Recalled from earlier in this conversation (archived):\n${parts.join('\n\n')}` : '';
    } catch (err) {
      // Fail-open: a retrieval error must never break the turn. Log and continue empty.
      log.warn('buildAutoRecallPrompt: retrieval failed, continuing without recalled context', { userId, chatId, err });
      return '';
    }
  })();
}
