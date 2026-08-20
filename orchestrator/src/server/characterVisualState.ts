/**
 * @file orchestrator/src/server/characterVisualState.ts
 * @stamp 2026-08-19b
 * @architectural-role IO Wrapper — the decoupled character visual-state trigger and its kill
 *   switch (docs/plans/character-visual-state-plan.md, sibling to locationImages.ts's
 *   fireLocationImageGeneration and characterDescription.ts's fireCharacterDescription)
 * @description
 * The fire-and-forget trigger for the character visual-state pipeline: invoked from the
 * response 'finish' event and the deferred cleanup-path hook so the reply the user is waiting on
 * is already sent before any text-LLM mint or image-provider round-trip starts. Runs Stage 3
 * (applyCharacterVisualState — locate the footer region, parse, resolve roster ids, guarded
 * diff/upsert, event append) against the final reply text, then for every fired visible-change
 * trigger hands the character's normalized outfit + expression to the autofire pipeline
 * (renderCharacterVisualCombination) — the only place the image provider is ever touched for
 * this feature. The footer's location is resolved live through the same resolveCleanupConfig
 * (cleanupLoop.ts) the Cleaner itself uses — the operator's cleanup_footer_regex is the single
 * authority, so this path and the cleanup loop can never disagree over where the footer is.
 *
 * The mints (describeStudioSlots for subject/expression) are Portrait Studio calls, not chat
 * calls — they go through the same portrait_llm_connection resolution every other
 * describeStudioSlots/describeStudioSubject call site in portraitRoutes.ts uses
 * (resolvePortraitLlm), never the turn's own chat LLM. A household that pins Studio mints to a
 * specific connection (independent of the active chat model) gets that here too; an unset/unknown
 * connection name falls back to deps.llm exactly like every other resolvePortraitLlm call site.
 *
 * Kill switch: character_visual_state_enabled, unset/'false' meaning OFF — the inverse default of
 * visual_portraits_enabled. That switch predates itself (an opt-out safety valve for an
 * already-in-use feature); this one is brand new and untested against a live household, so it is
 * opt-IN: nothing parses a footer, writes a snapshot, mints, or renders until the operator turns
 * it on. fireCharacterVisualState reads it first and no-ops before touching applyCharacterVisualState
 * at all — the single choke point every call site in handleChatCompletions.ts/turnExecution.ts/
 * index.ts/handleChats.ts already goes through.
 *
 * @api-declaration
 * fireCharacterVisualState(deps, userId, chatId, messageId, text) -> void — fire-and-forget;
 *   never throws into the caller (applyCharacterVisualState and renderCharacterVisualCombination
 *   are both fail-open by contract, so the async body never rejects); no-ops when the kill switch
 *   is off.
 * readCharacterVisualStateEnabled(settings) -> Promise<boolean> — the live switch read, default
 *   false.
 * handleCharacterVisualStateEnabledGet/Set — the admin-gated GET/POST pair
 *   (/v1/admin/character-visual-state-enabled), same shape as portraitRoutes.ts's
 *   handlePortraitLlmConnectionGet/Set.
 *
 * @contract
 *   assertions:
 *     purity:          impure (settings read, runs the apply + autofire pipelines)
 *     state_ownership: []
 *     external_io:     [orchestrator_settings, what the two pipelines do: Postgres, settings,
 *                       LLM mints, image provider]
 *     never:           throws synchronously. The async body never rejects, so the caller's
 *                      void(async () => …)() is safe.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpServerDeps } from './httpServer.js';
import { applyCharacterVisualState } from '../orchestrator/characterVisualState.js';
import { renderCharacterVisualCombination } from '../orchestrator/characterVisualAutofire.js';
import { resolveCleanupConfig } from '../orchestrator/cleanupLoop.js';
import { resolvePortraitLlm } from './portraitRoutes.js';
import { readJsonBody, sendJson } from './httpUtils.js';

export async function readCharacterVisualStateEnabled(settings: HttpServerDeps['settings']): Promise<boolean> {
  return (await settings.get('character_visual_state_enabled')) === 'true';
}

export async function handleCharacterVisualStateEnabledGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, { enabled: await readCharacterVisualStateEnabled(deps.settings) });
}

function parseSetCharacterVisualStateEnabledBody(raw: unknown): { enabled: boolean } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { enabled } = raw as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return undefined;
  return { enabled };
}

export async function handleCharacterVisualStateEnabledSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const parsed = parseSetCharacterVisualStateEnabledBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { enabled: boolean }' });
    return;
  }
  await deps.settings.set('character_visual_state_enabled', parsed.enabled ? 'true' : 'false');
  sendJson(res, 200, { enabled: parsed.enabled });
}

export function fireCharacterVisualState(
  deps: HttpServerDeps,
  userId: string,
  chatId: string,
  messageId: string,
  text: string,
): void {
  void (async () => {
    if (!(await readCharacterVisualStateEnabled(deps.settings))) return;
    const cleanupConfig = await resolveCleanupConfig(deps.settings);
    const result = await applyCharacterVisualState({ db: deps.db }, userId, chatId, messageId, text, cleanupConfig.footer);
    if (result.fired.length === 0) return;
    const llm = await resolvePortraitLlm(deps);
    for (const fired of result.fired) {
      await renderCharacterVisualCombination(
        { db: deps.db, settings: deps.settings, imageConnections: deps.imageConnections },
        llm,
        userId,
        chatId,
        fired.characterId,
        fired.outfit,
        fired.expression,
      );
    }
  })();
}