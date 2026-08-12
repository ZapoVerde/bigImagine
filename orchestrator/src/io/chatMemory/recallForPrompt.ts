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
 * handleChatCompletions only trims after assembly), embedded once, then two parallel searches:
 *
 *  1. chat_chunks — this chat's archived full-turn texts (the CNZ "chat lane"; a handful of
 *     whole turns, content verbatim like the tool returns; count = chat_memory_auto_recall_chunk_top_k,
 *     default AUTO_RECALL_CHUNK_TOP_K)
 *  2. canon_facts — approved rows only, deduped to most-recent-approved per arc_tag/entity_key,
 *     top-k from the live canon_recall_top_k setting (default 8) — the same dedup query
 *     recallCanonFactsTool.ts runs, just scoped to "now" (no as_of filter). Since 2026-08-16
 *     (Stage 2) this lane runs the same dynamic cutoff as the chunk lane, sharing the 0091
 *     Pool Multiple/Cutoff Mode knobs, with canon_recall_min as its per-channel Min floor.
 *
 * The retrieval knobs are all live settings read on every call (chat_memory_auto_recall_enabled,
 * chat_memory_auto_recall_pairs, chat_memory_auto_recall_chunk_top_k / _chunk_min,
 * chat_memory_auto_recall_pool_multiple, chat_memory_auto_recall_cutoff_mode, canon_recall_top_k /
 * canon_recall_min — migrations 0077/0091/0092); the exported AUTO_RECALL_* constants are the
 * fallback defaults when a setting is unset or corrupt, same fail-open shape as
 * canon_recall_top_k. `enabled === 'false'` silences the silent path without touching the recall
 * tools, which stay in the RP allow-list.
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
 * Since 2026-08-15 the chunk lane's fixed LIMIT is distribution-aware (docs/plans/
 * rag-dynamic-cutoff-plan.md, Stage 1 of the CNZ retrieval port): the query fetches a candidate
 * pool sized by the Pool Multiple setting (chat_memory_auto_recall_pool_multiple), then
 * io/chatMemory/recallCutoff.ts — the ported rag/cutoff.js pool-statistics stage — decides how
 * many of those candidates are actually worth injecting (mean/σ threshold in raw distance
 * space, Min floor / Max ceiling). A quiet turn with no real archive match now injects fewer
 * chunks instead of always exactly top-k; the decision and its statistics are logged per call.
 *
 * Since 2026-08-16 (Stage 2 of the same plan) the canon_facts lane gets the identical treatment:
 * the shared Pool Multiple and Cutoff Mode knobs from Stage 1 apply unchanged, the per-channel
 * Max is the existing canon_recall_top_k, and the new per-channel Min floor is canon_recall_min
 * (default '2', migration 0092) — the same per-channel Min/Max + shared Pool/Cutoff split
 * Canonize's own settings use, exactly as the Stage-1 naming anticipated. Facts are deduped per
 * arc/entity by the existing CTE before the cutoff measures their pool.
 *
 * Since 2026-08-17 (Stage 3 of the same plan) the chunk lane adds Canonize's temporal decay
 * (RAG_strategy_v4.md §3 Step 2, chat channel only): each chunk's distance is divided by
 * recallCutoff.ts's `decayFactor(ageChunks)` — a chunk `ageChunks` chunks behind the newest
 * archived chunk measures farther, so old-but-mediocre matches fall below the cutoff's
 * threshold. The decay applies BEFORE the pool is formed and measured, exactly Canonize's
 * pipeline order (decay → pool statistics), and only to chat_chunks — the fact lane keeps its
 * plain distance (Canonize's decay is chat-channel-only). The factor's constants are Canonize's
 * own (floor 0.70, coefficient 0.025), kept as plain constants per the plan — no new setting.
 *
 * Since 2026-08-17 (Stage 4 of the same plan) the chunk lane adds Canonize's keyword/FTS lane
 * (RAG_strategy_v4.md §3 Step 3): each fetched row's distance is re-ranked by its keyword match
 * BEFORE the pool is sliced and measured, Canonize's pipeline order (decay → keyword blend →
 * pool statistics), chat lane only. The chunk query now fetches a KEYWORD_WINDOW_SIZE window
 * (not the pool alone), scores every row with ts_rank over the content_tsv generated column
 * (migration 0093 — the tsquery is the OR of the query text's lexemes; a query with no lexemes
 * yields NULL, coalesced to 0, so the lane is inert rather than erroring), and
 * recallCutoff.ts's `blendKeyword` re-ranks the window by blended distance — the distance-space
 * form the Stage-1 doc flagged open: s = 1/(1+d) → blend with the (1−α) × top-vector-similarity
 * anchor → back to distance. The blend is additive (a row with no keyword match keeps its
 * decayed distance), its constants (KEYWORD_BLEND_ALPHA 0.7, KEYWORD_WINDOW_SIZE 100) are plain
 * constants per the plan — no new setting, no admin/frontend surface.
 *
 * Since 2026-08-17 (Stage 5 of the same plan) the chunk lane adds Canonize's header/second
 * vector lane (RAG_strategy_v4.md §3 Step 1): the query runs twice — once against
 * chat_chunks.vector_embed (content, migration 0037) and once against
 * chat_chunks.summary_vector_embed (header, migration 0094, NULL rows skipped) — and
 * recallCutoff.ts's `mergeLanes` fuses them with best-of scoring (the closer of the two
 * decayed distances) plus the 1.08× dual-confirmation bonus for chunks that matched both
 * lanes. The fused window then flows through the Stage 4 keyword blend and the Stage 1 cutoff
 * unchanged, preserving Canonize's pipeline order (fusion → decay-equivalent → keyword blend →
 * pool statistics). chatMemorySync.ts embeds chunk summaries from the next sync pass onward
 * (migration 0094's column is NULL for pre-existing rows, so those chunks stay
 * content-lane-only). No new setting, no admin/frontend surface.
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
 *     purity:          impure (embeddings provider call, settings read, Postgres IO)
 *     state_ownership: []
 *     external_io:     [embeddings provider, orchestrator settings store, Postgres]
 */

import type { EmbeddingProvider } from '../embeddings/types.js';
import type { OrchestratorSettingsStore } from '../orchestratorSettings.js';
import type { DbSession } from '../postgres.js';
import type { LlmMessage } from '../llm/types.js';
import { toPgVectorLiteral } from '../../util/pgvector.js';
import { applyCutoff, blendKeyword, mergeLanes, poolSize, type CutoffMode } from './recallCutoff.js';
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
 *  not restricted to whole numbers either). */
const DEFAULT_POOL_MULTIPLE = 2;

/** Cutoff Mode (migration 0091) — how strict the threshold is: 'mean' keeps everything above the
 *  pool's mean distance, 'mean+1sd'/'mean+2sd' demand results stand below mean − 1/2×σ (distance
 *  space, where lower is better). Canonize's `ragCutoffMode` default ('mean'). The live value is
 *  chat_memory_auto_recall_cutoff_mode; an unrecognized string falls back to 'mean'. */
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

/** Sanity cap for the computed pool size (migration 0091). A corrupt chat_memory_auto_recall_
 *  pool_multiple (e.g. a stray '9999') must not turn into an unbounded `SELECT ... LIMIT`
 *  against chat_chunks — cap the pool the same way MAX_CHUNK_TOP_K caps the Max setting. 40 is
 *  generous relative to MAX_CHUNK_TOP_K's 12: the pool is a statistics sample, never injected
 *  verbatim, so it can be a few multiples of the ceiling without ever shipping that many rows. */
const MAX_POOL_SIZE = 40;

/** Stage 4: the chunk lane's fetch window. The query returns this many best-first (decayed-
 *  distance) rows so the keyword blend (recallCutoff.ts blendKeyword) has room to promote
 *  lexical matches BEYOND the vector top-N_C before the pool is sliced from blended ranks —
 *  Canonize's pipeline (blend over the full collection, then slice the pool) with their
 *  topK=100k whole-collection fetch bounded so the per-turn fetch stays bounded. Generous
 *  relative to MAX_POOL_SIZE's 40, and the pool statistics only ever measure the blended
 *  top-N_C of it. The window must be >= the pool (the Math.max at the query keeps that true
 *  even if constants drift), so the blend always has at least a pool's worth of rows to
 *  promote within. Plain constant per the plan — no new setting. */
const KEYWORD_WINDOW_SIZE = 100;

interface ChunkRow {
  ordinal: number;
  summary: string;
  content: string;
  /** Decayed L2 distance to the query vector — the raw `vector_embed <-> $query` divided by
   *  Canonize's temporal-decay factor (recallCutoff.ts `decayFactor`, Stage 3) so older chunks
   *  measure farther. Selected (as `distance`) so the cutoff measures the decayed pool
   *  distribution before deciding how many to keep — Canonize applies decay BEFORE pool
   *  statistics, and the SQL ORDER BY uses the same decayed value. */
  distance: number;
  /** Full-text rank for this row (Stage 4) — ts_rank over chat_chunks.content_tsv (migration
   *  0093) for the query's lexemes, 0 when the row has no keyword match. Feeds
   *  recallCutoff.ts's `blendKeyword`, which re-ranks the window by blended distance before the
   *  cutoff measures it — the keyword lane is additive, so a row can only rank better. */
  kw_score: number;
}

interface CanonFactRow {
  fact_id: string;
  category: string;
  summary: string;
  detail: string;
  /** Raw L2 distance to the query vector (`vector_embed <-> $query`), selected so the cutoff
   *  can measure the fact pool's distribution (recallCutoff.ts) before deciding how many to
   *  keep — the Stage-2 counterpart of ChunkRow.distance. */
  distance: number;
}

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
 *  then the chat's archived full-turn chunks and its approved canon facts in parallel. Fail-open
 *  by contract: any error (embedding provider down, DB hiccup, malformed row) logs a warning and
 *  returns empty parts — retrieval must never break or stall a turn. */
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

      // Both lanes fetch candidate rows rather than exactly Max rows: the cutoff needs each
      // pool's distribution to decide how many of its leading rows are worth injecting. The
      // fact lane still sizes its fetch by the shared Pool Multiple × Max (capped — its $4
      // LIMIT); the chunk lane's fetch is now the Stage-4 keyword window (see
      // KEYWORD_WINDOW_SIZE) — the pool sizing still floors the window (window >= pool so the
      // blend always has at least a pool's worth of rows to promote within) and sizes the fact
      // lane. The shared Pool Multiple and Cutoff Mode apply to both lanes unchanged (the
      // Stage-1 naming anticipated this); the per-channel Max (chunkTopK / factTopK) and Min
      // (chunkMin / factMin) differ per lane.
      const pool = Math.min(poolSize(chunkTopK, poolMultiple), MAX_POOL_SIZE);
      const factPool = Math.min(poolSize(factTopK, poolMultiple), MAX_POOL_SIZE);
      const keywordWindow = Math.max(pool, KEYWORD_WINDOW_SIZE);

      const [chunkRows, headerRows, facts] = await Promise.all([
        session.query<ChunkRow>(
          // Stages 3-5: each row's distance is the raw `vector_embed <-> $query` divided by
          // Canonize's temporal-decay factor (recallCutoff.ts `decayFactor`) — a chunk
          // `ageChunks` chunks behind the newest archived chunk gets distance × 1/factor, so
          // older-but-relevant chunks rank (and are measured by the cutoff) as if farther away.
          // The expression mirrors decayFactor() verbatim — keep in sync
          // (verify-recall-for-prompt.mjs asserts the SQL shape). `now` is the newest chunk
          // ordinal for this chat (scalar subquery, index-assisted by chat_chunks_by_chat), so
          // the freshest chunk has age 0 → factor 1 → no decay. Stage 4 adds the keyword lane:
          // every row is scored with ts_rank over the content_tsv generated column (migration
          // 0093) for the OR of the query text's lexemes (ts_rank over a NULL tsquery is NULL,
          // coalesced to 0 when the query has none — the lane is inert, never an error), and
          // the fetch is the KEYWORD_WINDOW window rather than the pool alone, so blendKeyword
          // has room to promote lexical matches before the pool is sliced from blended ranks.
          `select ordinal, summary, content,
                  (vector_embed <-> $3)
                    / greatest(0.70, 1.0 - 0.025 * ln(2 * greatest(0, (select max(ordinal) from chat_chunks where user_id = $1 and chat_id = $2) - ordinal) + 1))
                    as distance,
                  coalesce(ts_rank(content_tsv, (select string_agg(lexeme, ' | ')::tsquery from unnest(to_tsvector('english', $4)))), 0)
                    as kw_score
           from chat_chunks
           where user_id = $1 and chat_id = $2
           order by distance
           limit ${keywordWindow}`,
          [userId, chatId, toPgVectorLiteral(vector), query],
        ),
        // Stage 5: the header lane — same shape against chat_chunks.summary_vector_embed
        // (migration 0094), skipping rows that predate it (NULL = never embedded; the content
        // lane still covers them). Same decayed distance + same lane-independent keyword score
        // (kw_score comes from content_tsv, not the lane's vector), so mergeLanes can fuse the
        // two windows with best-of scoring + the 1.08× dual-confirmation bonus. A chunk the
        // content lane missed can enter the merged window here — the header lane is additive.
        session.query<ChunkRow>(
          `select ordinal, summary, content,
                  (summary_vector_embed <-> $3)
                    / greatest(0.70, 1.0 - 0.025 * ln(2 * greatest(0, (select max(ordinal) from chat_chunks where user_id = $1 and chat_id = $2) - ordinal) + 1))
                    as distance,
                  coalesce(ts_rank(content_tsv, (select string_agg(lexeme, ' | ')::tsquery from unnest(to_tsvector('english', $4)))), 0)
                    as kw_score
           from chat_chunks
           where user_id = $1 and chat_id = $2 and summary_vector_embed is not null
           order by distance
           limit ${keywordWindow}`,
          [userId, chatId, toPgVectorLiteral(vector), query],
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
           select fact_id, category, summary, detail, vector_embed <-> $3 as distance
           from ranked
           order by vector_embed <-> $3
           limit $4`,
          [userId, chatId, toPgVectorLiteral(vector), factPool],
        ),
      ]);

      // Stage 5: fuse the two vector lanes (recallCutoff.ts mergeLanes — Canonize's RRF fusion,
      // Step 1) BEFORE the keyword blend, matching their pipeline order. Each chunk's distance
      // becomes the best-of (min) of its content and header decayed distances, with the 1.08×
      // dual-confirmation bonus when the chunk matched both lanes; header-only chunks join the
      // merged window, so the header lane can only add recall, never suppress it.
      const { rows: fusedRows, dualCount } = mergeLanes(
        chunkRows.map((r) => ({ ordinal: r.ordinal, distance: r.distance, kwScore: r.kw_score })),
        headerRows.map((r) => ({ ordinal: r.ordinal, distance: r.distance, kwScore: r.kw_score })),
      );
      const chunkByOrdinal = new Map([...chunkRows, ...headerRows].map((r) => [r.ordinal, r] as const));
      // Stage 4: the chunk lane's keyword blend (recallCutoff.ts blendKeyword) — each row's
      // ts_rank kw_score re-ranks the fused window by blended distance BEFORE the pool is
      // sliced and measured, Canonize's pipeline order (fusion → keyword blend → pool
      // statistics). The blend is additive: a row with no keyword match keeps its fused
      // distance, so the keyword lane can only promote, never bury. Re-sort by blended distance
      // (the queries returned decayed-distance order) before the cutoff, then keep the leading
      // slice.
      const { rows: blendedRows, scale: kwScale } = blendKeyword(
        fusedRows.map((r) => ({ distance: r.distance, kwScore: r.kwScore ?? 0 })),
      );
      const orderedChunks = fusedRows
        .map((r, i) => ({ row: chunkByOrdinal.get(r.ordinal)!, distance: blendedRows[i].distance }))
        .sort((a, b) => a.distance - b.distance);
      const { keepCount, stats } = applyCutoff(orderedChunks.map((x) => x.distance), {
        min: chunkMin,
        max: chunkTopK,
        cutoffMode,
      });
      const chunks = orderedChunks.slice(0, keepCount).map((x) => x.row);
      log.info('buildAutoRecallParts: chunk cutoff applied', {
        userId,
        chatId,
        min: chunkMin,
        max: chunkTopK,
        keepCount,
        temporalDecay: true, // Stage 3: distances measured are decayed (recallCutoff.decayFactor)
        keywordLane: true, // Stage 4: distances measured are keyword-blended (recallCutoff.blendKeyword)
        kwScale, // the max keyword contribution (Canonize's telemetry `kw≤`; 0 = lane inert)
        headerLane: true, // Stage 5: distances measured are fused across content+header (mergeLanes)
        dualCount, // how many chunks matched both lanes and received the 1.08× dual bonus
        ...stats,
      });

      const factCutoff = applyCutoff(facts.map((f) => f.distance), {
        min: factMin,
        max: factTopK,
        cutoffMode,
      });
      const keptFacts = facts.slice(0, factCutoff.keepCount);
      log.info('buildAutoRecallParts: fact cutoff applied', {
        userId,
        chatId,
        min: factMin,
        max: factTopK,
        keepCount: factCutoff.keepCount,
        ...factCutoff.stats,
      });

      return { chunks, facts: keptFacts };
    } catch (err) {
      // Fail-open: a retrieval error must never break the turn. Log and continue empty.
      log.warn('buildAutoRecallParts: retrieval failed, continuing without recalled context', { userId, chatId, err });
      return { chunks: [], facts: [] };
    }
  })();
}
