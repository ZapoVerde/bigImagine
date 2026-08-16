/**
 * @file orchestrator/src/server/characterDescription.ts
 * @stamp 2026-08-15
 * @architectural-role IO Wrapper — the decoupled character-description trigger (rp-cast-
 *   infrastructure-plan.md A3, sibling to locationImages.ts's fireLocationImageGeneration)
 * @description
 * The fire-and-forget trigger for describeCharacterIfNeeded: invoked from the response
 * 'finish' event (and the onCharactersScraped hook on the deferred cleanup-tick scrape path) so
 * the reply the user is waiting on is already sent before a provider round-trip starts. There
 * is no render leg for characters in this plan (no image-gen — the portrait/visual side is
 * explicitly out of scope), so unlike fireLocationImageGeneration there is nothing to await
 * after the describer: the chain is just the one LLM call, fail-open inside itself.
 *
 * The injected llm is the turn's gated provider where the caller has one (the post-turn fire
 * sites pass turnLlm — the same connection the story itself ran on, mirroring the location
 * describer's defaulting to the main chat LLM); hook sites (cleanup tick, swipe path) pass none
 * and fall back to deps.llm, exactly like fireLocationImageGeneration's default.
 *
 * @api-declaration
 * fireCharacterDescription(deps, userId, chatId, characterId, llm?) -> void — fire-and-forget;
 *   never throws into the caller (the async body's failure is handled inside describeCharacter
 *   itself, which is fail-open by contract).
 *
 * @contract
 *   assertions:
 *     purity:          impure (runs the describeCharacterIfNeeded pass)
 *     state_ownership: []
 *     external_io:     [what describeCharacterIfNeeded does: Postgres, settings, LLM, trace]
 *     never:           throws synchronously. The async body never rejects (the pass it awaits
 *                      is fail-open), so the caller's void(async () => …)() is safe.
 */

import type { LlmProvider } from '../io/llm/types.js';
import type { HttpServerDeps } from './httpServer.js';
import { describeCharacterIfNeeded } from '../orchestrator/describeCharacter.js';

export function fireCharacterDescription(
  deps: HttpServerDeps,
  userId: string,
  chatId: string | undefined,
  characterId: string,
  llm: LlmProvider = deps.llm,
): void {
  void (async () => {
    await describeCharacterIfNeeded(
      { db: deps.db, settings: deps.settings },
      llm,
      userId,
      chatId,
      characterId,
    );
  })();
}
