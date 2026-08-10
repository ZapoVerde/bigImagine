/**
 * @file orchestrator/src/orchestrator/ensureFirstTurnHeader.ts
 * @stamp 2026-08-08
 * @architectural-role Orchestrator — the first-turn synchronous scene-header repair
 * @description
 * Gets a chat background onto the *first* LLM turn of a new RP chat, instead of whenever a
 * later turn's reply happens to carry a scrapeable header. The scene header (`[ TimeOfDay |
 * 🗓️ … | 📍 Location ]` + `Present: …`) is the location/bg machinery's only input — the
 * post-turn scraper (locationAndPresenceScraper.ts) parses it, and without it there is no
 * location to render a bg for. But the header is *not* part of the turn-generation prompt: the
 * async cleanup subloop (cleanupLoop.ts) is what adds/repairs it, on its own 5s tick, *after*
 * the raw reply was already persisted and scraped — and nothing re-scrapes after the repair. So
 * on the first turn the scrape races ahead of the header and finds nothing: no location, no bg
 * trigger, and the bg only appears a turn or two later once the model starts mimicking the
 * repaired header it sees in history.
 *
 * This module closes that gap for the first turn only: called synchronously from
 * server/httpServer.ts right before the first assistant reply is persisted, it repairs the
 * header inline (one small LLM call, same machinery as the subloop's repair-header step — the
 * editable cleanup_header_regex/prompt settings, planCleanup/buildRepairPrompt/applyRepairSteps)
 * when the raw reply lacks a conforming header, so the stored message carries the header, the
 * scrape immediately after it sees one, and the async subloop later finds nothing to repair
 * (dedup: zero second LLM cost). Deliberately scoped to the header only: slop/footer work stays
 * with the async subloop (rules=[] below), and the call happens only once per chat — the
 * "first LLM turn" condition is the caller's, keyed on the pre-turn message count (0 = empty
 * chat, 1 = a seeded greeting only).
 *
 * Fail-open, same contract as locationAndPresenceScraper.ts (bi_principles.md §11): any failure
 * — config read, LLM error, empty repair output, a repaired text that still fails inspection —
 * returns the raw reply unchanged. A missing bg is never worth a broken first turn.
 *
 * @api-declaration
 * EnsureFirstTurnHeaderDeps — settings (OrchestratorSettingsStore)
 * ensureFirstTurnHeader(deps, llm, userId, chatId, rawReply, history) -> Promise<string> —
 *   the reply with a conforming header when the repair succeeded, else the raw reply unchanged
 *
 * @contract
 *   assertions:
 *     purity:          impure (settings read, LLM call, prompt-trace write)
 *     state_ownership: []
 *     external_io:     [orchestrator_settings (read), the LLM via the injected provider, the
 *                       prompt trace (recordPromptTrace)]
 *     never:           throws. Every failure path logs and returns the input unchanged.
 */

import { log } from '../io/logger.js';
import { runWithCallContext } from '../io/llm/callContext.js';
import type { LlmMessage, LlmProvider } from '../io/llm/types.js';
import { recordPromptTrace, type PromptTraceEntry } from '../io/promptTrace.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { resolveCleanupConfig } from './cleanupLoop.js';
import { applyRepairSteps, inspectHeader, planCleanup } from './cleanupHeuristics.js';

export interface EnsureFirstTurnHeaderDeps {
  settings: OrchestratorSettingsStore;
}

/**
 * Repair a first turn's missing/malformed scene header inline. Returns `rawReply` unchanged when
 * the header already conforms, the repair LLM errored or replied empty, or the repaired text
 * still fails header inspection — the caller persists whatever comes back, so a failed repair is
 * byte-identical to today's behavior, never a worse first turn.
 */
export async function ensureFirstTurnHeader(
  deps: EnsureFirstTurnHeaderDeps,
  llm: LlmProvider,
  userId: string,
  chatId: string,
  rawReply: string,
  history: LlmMessage[],
): Promise<string> {
  try {
    const config = await resolveCleanupConfig(deps.settings);
    // rules deliberately empty — this pass only guarantees the scene header (the location/bg
    // machinery's input), never slop or footer work, which stays with the async subloop.
    // knownLocations is '' by definition on turn 1 (a brand-new chat has no scene/locations yet,
    // so loadLocationBlock would render nothing) — passed explicitly so the default template's
    // {{known_locations}} token resolves and never leaks verbatim into the repair prompt.
    const plan = planCleanup(rawReply, [], config.header, config.footer, {
      history,
      userName: config.userName,
      knownLocations: '',
    });
    const headerStep = plan.steps.find((s) => s.kind === 'repair-header');
    if (!headerStep) {
      log.debug('ensureFirstTurnHeader: header already conforms, no repair needed', { chatId });
      return rawReply;
    }

    // Same trace contract as cleanupLoop.ts's dispatchStep: record before the call (the prompt
    // is sent either way), attach the reply afterwards — the repaired text replaces it in the
    // message, so the raw output is otherwise unrecoverable. The entry object stays live in the
    // trace after recordPromptTrace pushes it.
    const entry: PromptTraceEntry = {
      kind: 'cleanup',
      title: 'Cleanup Repair — header (first turn)',
      items: [
        { role: 'user', content: headerStep.prompt, chars: headerStep.prompt.length, estimatedTokens: Math.ceil(headerStep.prompt.length / 4) },
      ],
      capturedAt: Date.now(),
    };
    recordPromptTrace(chatId, entry);
    log.info('ensureFirstTurnHeader: first-turn header repair fired', { chatId, promptChars: headerStep.prompt.length });
    const turn = await runWithCallContext({ taskId: chatId, kind: 'system', userId }, () =>
      llm.complete([{ role: 'user', content: headerStep.prompt }], []),
    );
    const out = turn.message.content;
    if (!out || !out.trim()) {
      log.warn('ensureFirstTurnHeader: repair replied empty, keeping raw reply', { chatId });
      return rawReply;
    }
    entry.reply = out.trim();

    // Only the header step's output is real; any other step (edge-case footer repair) gets null
    // and is left untouched by applyRepairSteps.
    const outputs = plan.steps.map((s) => (s.kind === 'repair-header' ? out : null));
    const repaired = applyRepairSteps(plan.text, plan.steps, outputs);
    if (inspectHeader(repaired, config.header).status !== 'ok') {
      log.warn('ensureFirstTurnHeader: repaired text still fails header inspection, keeping raw reply', { chatId });
      return rawReply;
    }
    log.info('ensureFirstTurnHeader: first-turn header repaired', { chatId });
    return repaired;
  } catch (err) {
    log.error('ensureFirstTurnHeader: repair failed, keeping raw reply (fail-open)', { chatId, err });
    return rawReply;
  }
}
