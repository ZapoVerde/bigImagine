/**
 * @file orchestrator/src/io/chatMemory/recallForPrompt.ts
 * @stamp 2026-08-17
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
 * handleChatCompletions only trims after assembly), embedded once, then handed to the two lane
 * modules in parallel:
 *
 *  1. recallChunkLane.ts — chat_chunks, this chat's archived full-turn texts (the CNZ "chat
 *     lane"). Owns the content + header vector fetch, temporal decay, the keyword blend, and the
 *     dynamic cutoff for this lane (Stages 1/3/4/5 of docs/plans/rag-dynamic-cutoff-plan.md).
 *  2. recallFactLane.ts — canon_facts, approved rows only, deduped to most-recent-approved per
 *     arc_tag/entity_key, with the same dynamic cutoff (Stage 2 of the same plan).
 *
 * This file's own job is narrower than it used to be: the two lanes' fetch/scoring pipelines
 * moved into their own modules per bi_principles.md §10's 300-line budget once Stages 3-5 grew
 * the chunk lane substantially. What's left here is settings resolution and orchestration:
 * resolve the live settings into plain numbers, build and embed the query once, call both lanes,
 * and return their combined result. The retrieval knobs are all live settings read on every call
 * (chat_memory_auto_recall_enabled, chat_memory_auto_recall_pairs, chat_memory_auto_recall_
 * chunk_top_k / _chunk_min, chat_memory_auto_recall_pool_multiple, chat_memory_auto_recall_
 * cutoff_mode, canon_recall_top_k / canon_recall_min — migrations 0077/0091/0092); the exported
 * AUTO_RECALL_* constants are the fallback defaults when a setting is unset or corrupt, same
 * fail-open shape as canon_recall_top_k. `enabled === 'false'` silences the silent path without
 * touching the recall tools, which stay in the RP allow-list.
 *
 * Both lanes are scoped to this chat_id inside the caller's already-open withUserScope session
 * (RLS applies user_id, chat_id narrows to "this conversation" — same trusted-identity scoping
 * as the two recall tools; the module takes the session rather than opening its own scope, since
 * buildChatMemorySystemPrompt's rp branch is already inside one). Results are formatted into one
 * labeled block and returned as the prompt-assembly caller's extra memoryContext part. Fail-open
 * by contract: any error (embedding provider down, DB hiccup, malformed row, either lane
 * throwing) logs a warning and returns '' — retrieval must never break or stall a turn.
 *
 * This deliberately runs *before* trimToLiveWindow's cutoff in the prompt assembler's Promise.all
 * (httpServer.ts's buildChatMemorySystemPrompt) — the query uses the full untrimmed history so
 * the user's last entry is always the newest pair, exactly CNZ's `allPairs.slice(-horizonPairs)`.
 *
 * @api-declaration
 * buildAutoRecallQuery(messages, pairCount?) -> string — the embedded query text (pure).
 * buildAutoRecallParts(session, settings, embeddings, userId, chatId, messages) ->
 *   Promise<{ chunks, facts }> — raw retrieval, fail-open to empty parts.
 * buildAutoRecallPrompt(session, settings, embeddings, userId, chatId, messages) ->
 *   Promise<string> — the legacy labeled block (formatAutoRecallBlock over the parts), kept for
 *   the deprecated memory_recall alias. `session` is the caller's already-user-scoped DbSession.
 *
 * @contract
 *   assertions:
 *     purity:          impure (embeddings provider call, settings read, Postgres IO via the two
 *                       lane modules)
 *     state_ownership: []
 *     external_io:     [embeddings provider, orchestrator settings store, Postgres]
 */

import type { EmbeddingProvider } from '../embeddings/types.js';
import type { OrchestratorSettingsStore } from '../orchestratorSettings.js';
import type { DbSession } from '../postgres.js';
import type { LlmMessage } from '../llm/types.js';
import type { CutoffMode } from './recallCutoff.js';
import { recallChunkLane, type ChunkRow } from './recallChunkLane.js';
import { recallFactLane, type CanonFactRow } from './recallFactLane.js';
import { log } from '../logger.js';

/** How many trailing turn-pairs form the query — mirrors Canonize's own `ragClassifierHistory`
 *  default (3), which the user named as the reference behavior. This is the fallback default;
 *  the live value is the chat_memory_auto_recall_pairs setting (migration 0077), read on every
 *  call so a save takes effect on the next turn, no restart. */
export const AUTO_RECALL_PAIRS = 3;

/** How many full-turn chunks to pull. Canonize's chat lane default Max is `ragChatMax` = 8
 *  (their state.js PROFILE_DEFAULTS, "Chat Min / Max" in docs/settings.md) with a
 *  distributional cutoff; "a number of full turn text" (user) — a fixed handful, content
 *  verbatim, is the basics-shaped version of that. The 4 this used to default to predated the
 *  CNZ audit; 8 matches the CNZ installation's own default exactly (the plan's Stage-5.1
 *  addendum records the audit). Same default/fallback split as AUTO_RECALL_PAIRS: the live
 *  value is chat_memory_auto_recall_chunk_top_k, now understood as the **Max** ceiling the
 *  dynamic cutoff clamps to (migration 0091, recallCutoff.ts). */
export const AUTO_RECALL_CHUNK_TOP_K = 8;

/** The Min floor for the dynamic chunk cutoff (migration 0091) — how many chunks are injected
 *  at minimum even when the distribution says nothing clears the threshold. Canonize's own
 *  `ragChatMin` default (2) unchanged. The live value is chat_memory_auto_recall_chunk_min. */
const DEFAULT_CHUNK_MIN = 2;

/** Pool Multiple P (migration 0091) — candidate pool = P × Max (min 6, recallCutoff.poolSize),
 *  Canonize's `ragPoolMultiple` default (2). The live value is
 *  chat_memory_auto_recall_pool_multiple; parsed as a float, not an integer (Canonize's own P is
 *  not restricted to whole numbers either). Shared unchanged between the chunk and fact lanes. */
const DEFAULT_POOL_MULTIPLE = 2;

/** Cutoff Mode (migration 0091) — how strict the threshold is: 'mean' keeps everything above the
 *  pool's mean distance, 'mean+1sd'/'mean+2sd' demand results stand below mean − 1/2×σ (distance
 *  space, where lower is better). Canonize's `ragCutoffMode` default ('mean'). The live value is
 *  chat_memory_auto_recall_cutoff_mode; an unrecognized string falls back to 'mean'. Shared
 *  unchanged between the chunk and fact lanes. */
const DEFAULT_CUTOFF_MODE: CutoffMode = 'mean';

const DEFAULT_FACT_TOP_K = 8;

/** The Min floor for the dynamic cutoff on the canon_facts lane (migration 0092, Stage 2 of the
 *  CNZ retrieval port) — how many facts are injected at minimum even when the pool distribution
 *  says nothing clears the threshold. Canonize's own `ragChatMin` default (2) unchanged, same as
 *  the chunk lane's DEFAULT_CHUNK_MIN. The live value is canon_recall_min. */
const DEFAULT_FACT_MIN = 2;

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

/** Raw retrieval result — the unformatted parts the narrator stack's component markers render
 *  through their own templates (io/chatMemory/memoryInjection.ts). buildAutoRecallPrompt still
 *  formats them into the legacy labeled block for the deprecated memory_recall alias. */
export interface AutoRecallParts {
  chunks: ChunkRow[];
  facts: CanonFactRow[];
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

/** The legacy labeled block — byte-identical to the pre-split output, so the deprecated
 *  memory_recall alias keeps its exact shape. Exported for memoryInjection's fused renderer. */
export function formatAutoRecallBlock(chunks: ChunkRow[], facts: CanonFactRow[]): string {
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
}

export function buildAutoRecallPrompt(
  session: DbSession,
  settings: OrchestratorSettingsStore,
  embeddings: EmbeddingProvider,
  userId: string,
  chatId: string,
  messages: LlmMessage[],
): Promise<string> {
  return buildAutoRecallParts(session, settings, embeddings, userId, chatId, messages).then((p) =>
    formatAutoRecallBlock(p.chunks, p.facts),
  );
}

/** Raw CNZ-style auto-recall retrieval: query text from the trailing turn-pairs, embedded once,
 *  then the chat's archived full-turn chunks (recallChunkLane) and its approved canon facts
 *  (recallFactLane) in parallel. Fail-open by contract: any error (embedding provider down, DB
 *  hiccup, malformed row) logs a warning and returns empty parts — retrieval must never break or
 *  stall a turn. */
export function buildAutoRecallParts(
  session: DbSession,
  settings: OrchestratorSettingsStore,
  embeddings: EmbeddingProvider,
  userId: string,
  chatId: string,
  messages: LlmMessage[],
): Promise<AutoRecallParts> {
  return (async () => {
    try {
      const [enabledRaw, pairsRaw, chunkTopKRaw, factTopKRaw, chunkMinRaw, poolMultipleRaw, cutoffModeRaw, factMinRaw] =
        await Promise.all([
          settings.get('chat_memory_auto_recall_enabled'),
          settings.get('chat_memory_auto_recall_pairs'),
          settings.get('chat_memory_auto_recall_chunk_top_k'),
          settings.get('canon_recall_top_k'),
          settings.get('chat_memory_auto_recall_chunk_min'),
          settings.get('chat_memory_auto_recall_pool_multiple'),
          settings.get('chat_memory_auto_recall_cutoff_mode'),
          settings.get('canon_recall_min'),
        ]);

      // Master switch: 'false' disables the auto-injection entirely. The recall *tools* stay in
      // the RP allow-list either way — this knob only silences the silent path (CNZ's own
      // enable/disable shape). Unset/any-other-value = on (the shipped default).
      if (enabledRaw === 'false') return { chunks: [], facts: [] };

      const parsedPairs = pairsRaw ? parseInt(pairsRaw, 10) : NaN;
      const pairs = Number.isFinite(parsedPairs) && parsedPairs > 0 ? parsedPairs : AUTO_RECALL_PAIRS;

      const parsedChunkTopK = chunkTopKRaw ? parseInt(chunkTopKRaw, 10) : NaN;
      const chunkTopK =
        Number.isFinite(parsedChunkTopK) && parsedChunkTopK > 0
          ? Math.min(parsedChunkTopK, MAX_CHUNK_TOP_K)
          : AUTO_RECALL_CHUNK_TOP_K;

      // The dynamic cutoff's three knobs (migration 0091, recallCutoff.ts), same parse-with-
      // fallback shape as every other setting here. min clamps to the Max (chunkTopK) at read
      // time so a misconfigured min > max can never make the floor step exceed the ceiling.
      const parsedChunkMin = chunkMinRaw ? parseInt(chunkMinRaw, 10) : NaN;
      const chunkMin =
        Number.isFinite(parsedChunkMin) && parsedChunkMin > 0
          ? Math.min(parsedChunkMin, chunkTopK)
          : Math.min(DEFAULT_CHUNK_MIN, chunkTopK);

      const parsedPoolMultiple = poolMultipleRaw ? parseFloat(poolMultipleRaw) : NaN;
      const poolMultiple =
        Number.isFinite(parsedPoolMultiple) && parsedPoolMultiple > 0 ? parsedPoolMultiple : DEFAULT_POOL_MULTIPLE;

      const cutoffMode: CutoffMode =
        cutoffModeRaw === 'mean' || cutoffModeRaw === 'mean+1sd' || cutoffModeRaw === 'mean+2sd'
          ? cutoffModeRaw
          : DEFAULT_CUTOFF_MODE;

      const parsedFactTopK = factTopKRaw ? parseInt(factTopKRaw, 10) : NaN;
      const factTopK =
        Number.isFinite(parsedFactTopK) && parsedFactTopK > 0 ? Math.min(parsedFactTopK, MAX_FACT_TOP_K) : DEFAULT_FACT_TOP_K;

      // The fact lane's per-channel Min (migration 0092, Stage 2) — same parse-with-fallback
      // shape as chunkMin, clamped to the fact Max (factTopK) at read time so a misconfigured
      // min > max can never make the floor step exceed the ceiling.
      const parsedFactMin = factMinRaw ? parseInt(factMinRaw, 10) : NaN;
      const factMin =
        Number.isFinite(parsedFactMin) && parsedFactMin > 0
          ? Math.min(parsedFactMin, factTopK)
          : Math.min(DEFAULT_FACT_MIN, factTopK);

      const query = buildAutoRecallQuery(messages, pairs);
      if (!query) return { chunks: [], facts: [] };

      const [vector] = await embeddings.embed([query]);
      if (!vector) return { chunks: [], facts: [] };

      // The shared Pool Multiple and Cutoff Mode apply to both lanes unchanged (the Stage-1
      // naming anticipated this); the per-channel Max (chunkTopK / factTopK) and Min (chunkMin /
      // factMin) differ per lane. Each lane module owns its own fetch/scoring pipeline — see
      // recallChunkLane.ts and recallFactLane.ts.
      const [{ chunks }, { facts }] = await Promise.all([
        recallChunkLane(session, userId, chatId, vector, query, { min: chunkMin, max: chunkTopK, poolMultiple, cutoffMode }),
        recallFactLane(session, userId, chatId, vector, { min: factMin, max: factTopK, poolMultiple, cutoffMode }),
      ]);

      return { chunks, facts };
    } catch (err) {
      // Fail-open: a retrieval error must never break the turn. Log and continue empty.
      log.warn('buildAutoRecallParts: retrieval failed, continuing without recalled context', { userId, chatId, err });
      return { chunks: [], facts: [] };
    }
  })();
}
