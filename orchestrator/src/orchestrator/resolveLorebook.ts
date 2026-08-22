/**
 * @file orchestrator/src/orchestrator/resolveLorebook.ts
 * @stamp 2026-08-11
 * @architectural-role Orchestrator — the turn-loop lorebook resolution step
 * @description
 * The §4/§7 orchestrator step of the Lorebook plan (docs/lorebook-plan.md): sequences recall →
 * timed-effect state → gate → format, and fills the `lorebook` PromptStackFields slot before
 * assemblePromptStack runs (docs/plans/turn-loop-plan.md's step 2, alongside the existing
 * canon-facts/memory-recall resolution). Per §4 it owns no state, does no IO itself, and decides
 * nothing about what the data means — only the order these calls happen in; every read goes
 * through the io/lorebook wrappers.
 *
 * Sequencing contract:
 *   1. `lorebook_mode` must be 'on' — the §2 default-off posture: anyone who never opts in sees
 *      byte-identical prompts to today (semantic recall only, no lorebook block).
 *   2. The query text is the recent-turn text (built by the caller via buildAutoRecallQuery, the
 *      same input recallForPrompt.ts already builds — §4) → recallLorebookEntries.
 *   3. fetchLorebookTimedEffectState over exactly the candidates recall returned.
 *   4. gateLorebookCandidates, seeded deterministically: turnSeed = deriveTurnSeed(assistantMessageId)
 *      — the assistant message_id being generated, not Math.random() — so the probability roll is
 *      reproducible within the turn and never breaks the byte-prefix cache (§4).
 *   5. Activated entries are formatted into the flat slot text in the gate's output order
 *      (constants first, then similarity rank — the §5 budget order).
 *
 * `lorebook_recall_top_k` / `lorebook_token_budget` mirror canon_recall_top_k's read pattern
 * (recallForPrompt.ts): parsed live, sane default when unset/corrupt, clamped. `lorebook_token_budget`
 * unset means no cap (Infinity) — the §11 open question's "independent budget" reading, with the
 * cap as the tuned setting rather than a hardcoded default. `lorebook_recursion_enabled` is not
 * read at all — §9 ships recursion disabled regardless of the flag.
 *
 * Fail-open by contract, same as every sibling resolution step: any error (settings, DB,
 * embedding, gate) logs and resolves to undefined — the slot just doesn't render, and the turn
 * proceeds byte-identical to a chat without lorebook. The assistant message_id only seeds the
 * roll; it is never persisted here (writeLorebookActivationLog is the caller's post-turn job,
 * same "write after, not during" shape as chatMemorySync).
 *
 * @api-declaration
 * resolveLorebook({ db, settings, embeddings, userId, chatId, characterId, queryText,
 *   assistantMessageId }) -> Promise<LorebookResolution | undefined> — { text, activatedEntryIds },
 *   or undefined when mode is off, nothing activated, or anything failed. The caller writes the
 *   activation-log rows from activatedEntryIds after the turn completes (writeLorebookActivationLog).
 *
 * @contract
 *   assertions:
 *     purity:          impure (orchestrates IO wrappers; deterministic output given its reads)
 *     state_ownership: []
 *     external_io:     [Postgres, embeddings provider]
 */

import type { PostgresClient } from '../io/postgres.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { recallLorebookEntries, DEFAULT_LOREBOOK_RECALL_TOP_K } from '../io/lorebook/recallLorebookEntries.js';
import { fetchLorebookTimedEffectState } from '../io/lorebook/fetchLorebookTimedEffectState.js';
import { gateLorebookCandidates, deriveTurnSeed } from './lorebookGate.js';
import { log } from '../io/logger.js';

/** Sane cap for a corrupt lorebook_recall_top_k, mirroring recallForPrompt.ts's MAX_FACT_TOP_K. */
const MAX_LOREBOOK_RECALL_TOP_K = 50;

export interface ResolveLorebookDeps {
  db: PostgresClient;
  settings: OrchestratorSettingsStore;
  embeddings: EmbeddingProvider;
  userId: string;
  chatId: string;
  characterId: string | null;
  /** The recent-turn text to embed — built by the caller (buildAutoRecallQuery, §4). */
  queryText: string;
  /** The assistant message_id being generated — the deterministic gate seed (deriveTurnSeed). */
  assistantMessageId: string;
}

/** The resolved slot: the formatted text plus the ids the turn handler needs to append the
 *  activation-log rows after the turn completes (docs/lorebook-plan.md §3e/§4). */
export interface LorebookResolution {
  text: string;
  activatedEntryIds: string[];
}

/** Deterministic, minimal slot text: a header + one bullet per activated entry in gate order. */
export function formatLorebookBlock(activated: { content: string }[]): string {
  return ['Lorebook — active entries:', ...activated.map((e) => `- ${e.content}`)].join('\n');
}

export async function resolveLorebook(deps: ResolveLorebookDeps): Promise<LorebookResolution | undefined> {
  const { db, settings, embeddings, userId, chatId, characterId, queryText, assistantMessageId } = deps;
  try {
    // Settings read live, canon_recall_top_k-style: unset/corrupt → sane default.
    const [mode, topKRaw, budgetRaw] = await Promise.all([
      settings.get('lorebook_mode'),
      settings.get('lorebook_recall_top_k'),
      settings.get('lorebook_token_budget'),
    ]);
    if (mode !== 'on') return undefined; // §2 default-off.

    const parsedTopK = Number(topKRaw);
    const topK =
      Number.isFinite(parsedTopK) && parsedTopK > 0
        ? Math.min(parsedTopK, MAX_LOREBOOK_RECALL_TOP_K)
        : DEFAULT_LOREBOOK_RECALL_TOP_K;
    const parsedBudget = Number(budgetRaw);
    const tokenBudget = Number.isFinite(parsedBudget) && parsedBudget >= 0 ? parsedBudget : Infinity;

    return db.withUserScope(userId, async (session) => {
      const [chat] = await session.query<{ card_id: string | null }>(
        'select card_id from chat_sessions where chat_id = $1 and user_id = $2',
        [chatId, userId],
      );
      const candidates = await recallLorebookEntries(session, embeddings, userId, characterId, chatId, queryText, topK, chat?.card_id ?? null);
      if (candidates.length === 0) return undefined;

      const timedState = await fetchLorebookTimedEffectState(
        session,
        userId,
        chatId,
        candidates.map((c) => c.entry_id),
      );
      // delay is "the chat has ≥N messages" (§5) — the stored total, not the trimmed window.
      const [countRow] = await session.query<{ n: string }>(
        'select count(*) as n from chat_messages where chat_id = $1',
        [chatId],
      );
      const chatMessageCount = Number(countRow?.n) || 0;

      const { activated, skipped, tokenCount } = gateLorebookCandidates(candidates, timedState, {
        turnSeed: deriveTurnSeed(assistantMessageId),
        tokenBudget,
        chatMessageCount,
      });
      if (activated.length === 0) return undefined;
      log.info('resolveLorebook: gate resolved', {
        chatId,
        candidates: candidates.length,
        activated: activated.length,
        skipped: skipped.length,
        tokenCount,
        budget: tokenBudget,
      });
      return { text: formatLorebookBlock(activated), activatedEntryIds: activated.map((a) => a.entry_id) };
    });
  } catch (err) {
    // Fail-open: a lorebook failure must never break or alter a turn.
    log.warn('resolveLorebook: resolution failed, lorebook slot omitted', { userId, chatId, err });
    return undefined;
  }
}
