/**
 * @file orchestrator/src/server/turnExecution.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — the shared turn-execution pieces from httpServer.ts
 * @description
 * The connection-resolution + in-place-regeneration half of the turn path, shared by
 * handleChatCompletions and the swipe route's Rerun: the per-chat profile override resolver
 * (resolveTurnLlm — build a throwaway gated provider for a named connection, read the active
 * connection's price fields otherwise), the TurnPrice shape + pure profile→price conversion,
 * and regenerateSwipe — Rerun's in-place regeneration (runTurn/runStreamingRpTurn through the
 * shared assembleSessionTurnContext seam, persisted via chats.recordSwipe, post-cleanup
 * location scrape, no new user message).
 *
 * Reasoning blocks (docs/plans/reasoning-blocks-plan.md) follow the same relay-and-persist
 * shape as handleChatCompletions: onReasoningDelta (forwarded by the swipe route) relays each
 * classified reasoning delta as a bigimagine_reasoning SSE frame, and the accumulated reasoning
 * is persisted with the regenerated swipe via recordSwipe — and carried into the cleanup
 * handoff's composed swipe (finalizeCleanupResult's reasoning param), so a live repair never
 * nulls it out. Non-streaming swipes still detect + persist (no frames; the caller reads the
 * returned message's `reasoning` field).
 *
 * @api-declaration
 * resolveTurnLlm(deps, sessionParams, chatId) — { turnLlm, turnDefaultModel, turnPrice }
 * regenerateSwipe(deps, userId, chatId, detail, messageId, stream?, onDelta?, onCleanupEvent?,
 *   onReasoningDelta?) — { ok: true, message, locationId?, characterIds? } | { ok: false, aborted?, error }
 *
 * @contract
 *   assertions:
 *     purity:          impure (LLM call + chats.recordSwipe/updateChat + location scrape)
 *     state_ownership: []
 *     external_io:     [LLM (via turnLlm), Postgres (via deps.db/deps.chats)]
 */

import { createLlmProviderForProfile } from '../io/llm/index.js';
import { createGatedLlmProvider } from '../io/llm/llmGate.js';
import { pickPriceTier, type CallCostPrice } from '../io/llm/callCost.js';
import { log } from '../io/logger.js';
import { recordPromptTrace, type PromptTraceEntry } from '../io/promptTrace.js';
import { runTurn } from '../orchestrator/loop.js';
import { runStreamingRpTurn, type RunStreamingRpTurnResult } from '../orchestrator/streamingTurn.js';
import { isAbortError, registerTurnAbort, unregisterTurnAbort } from '../orchestrator/turnAbort.js';
import { claimCleanupInFlight, finalizeCleanupResult, releaseCleanupInFlight, type CleanupLoopDeps } from '../orchestrator/cleanupLoop.js';
import { clearCleanupLiveStatus } from '../orchestrator/cleanupLiveStatus.js';
import { finishStream, type CleanupLiveEvent } from '../orchestrator/liveCleanup.js';
import { fireLocationImageGeneration } from './locationImages.js';
import { fireCharacterDescription } from './characterDescription.js';
import { createToolRegistry, filterToolRegistry } from '../orchestrator/toolRegistry.js';
import { getHouseholdTimezone } from './adminServer.js';
import { assembleSessionTurnContext } from './promptAssembly.js';
import { toPreviewItem, type PromptPreviewItem } from './promptPreview.js';
import { parseStoryHeader, scrapeTurnPresence } from '../orchestrator/locationAndPresenceScraper.js';
import type { ChatDetail, ChatParams, StoredChatMessage } from '../io/chatSessions.js';
import type { LlmMessage, LlmProvider } from '../io/llm/types.js';
import type { HttpServerDeps } from './httpServer.js';

// A chat's own profile override (a per-chat connection picker, distinct from the household-wide
// active connection) swaps in a throwaway provider for that one named connection (io/llmConnections.ts),
// built fresh per turn — cheap, since every provider here is a stateless fetch wrapper
// (io/llm/anthropic.ts, io/llm/openaiCompatible.ts). Unlike the household setting, this needs no
// restart to take effect. An unknown connection name (stale override, a connection since renamed
// or deleted in the Connections tab) falls back to the household's active connection rather than
// failing the whole turn, logging why per bb_principles.md §11. Shared by handleChatCompletions and
// regenerateSwipe below — resolving which connection a chat's turn runs through doesn't depend on
// whether the reply is being appended as a new turn or swapped in as a swipe.
// The acting connection's per-token rates (USD per 1M tokens) for a turn — what the Prompt
// Inspector's receipt multiplies the vendor's usage by. Undefined end to end when the connection
// has no price configured; a tier is undefined when that tier has no rate (the receipt then omits
// the $ figure entirely rather than pricing it at another tier's rate). Already tier-resolved by
// toTurnPrice (pickPriceTier at the call's UTC hour) — this shape is always the effective tier,
// never both tiers.
export interface TurnPrice {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheHitPerMillion?: number;
}

// LlmProfile carries both price tiers (base + peak) as the llm_connections row does
// (io/llm/profiles.ts, relayed by io/llmConnections.ts's toProfile) — this is a pure shape
// conversion, not a second DB round-trip. pickPriceTier resolves which tier is in effect at the
// call's UTC wall-clock hour (docs/plans/deepseek-pricing-sync.md), freezing the effective
// single-tier price at turn resolution (here) rather than at call-resolution (llmGate.ts's
// computeCallCostUsd). A turn that straddles a peak/off-peak boundary can in principle see the
// Inspector's receipt disagree with llmGate's billed cost for that one call — accepted: this
// price is a trend signal (is spend trekking up, which connection is expensive), not a precise
// per-call invoice, so a rare few-minutes-wide boundary mismatch isn't worth threading the
// call-time tier back through the whole turn path. All three effective fields undefined collapses
// to undefined: a connection with no price set — or a peak-hour call against a base-only
// connection, omit-rather-than-guess — must read as "no price" end to end, never as a fabricated
// $0.00.
function toTurnPrice(profile: CallCostPrice | undefined): TurnPrice | undefined {
  if (!profile) return undefined;
  const effective = pickPriceTier(profile);
  if (
    effective.priceInputPerMillion === undefined &&
    effective.priceOutputPerMillion === undefined &&
    effective.priceCacheHitPerMillion === undefined
  ) {
    return undefined;
  }
  return {
    inputPerMillion: effective.priceInputPerMillion,
    outputPerMillion: effective.priceOutputPerMillion,
    cacheHitPerMillion: effective.priceCacheHitPerMillion,
  };
}

export async function resolveTurnLlm(
  deps: HttpServerDeps,
  sessionParams: ChatParams,
  chatId: string | undefined,
): Promise<{ turnLlm: LlmProvider; turnDefaultModel: string; turnPrice: TurnPrice | undefined }> {
  let turnLlm = deps.llm;
  let turnDefaultModel = deps.modelName;
  let turnPrice: TurnPrice | undefined;
  if (sessionParams.profile) {
    const profile = await deps.llmConnections.resolveByName(sessionParams.profile);
    if (profile) {
      // A per-chat override builds its own throwaway provider (this function's own doc above) —
      // gated the same as deps.llm (index.ts wraps that one once, at boot), since a call through
      // an override is exactly as real a call as one through the household's active connection
      // (bb_principles.md §14 doesn't carve out an exception for "which connection").
      turnLlm = createGatedLlmProvider(createLlmProviderForProfile(profile), deps.db, deps.settings, profile);
      turnDefaultModel = profile.model;
      // The override's own profile already carries the connection's prices — no second read.
      turnPrice = toTurnPrice(profile);
    } else {
      log.error(
        `chat_id ${chatId} names unknown connection "${sessionParams.profile}" — falling back to the active connection`,
      );
    }
  } else {
    // Default branch: reuse the boot-time deps.llm singleton unchanged — this resolveActive is
    // used ONLY to read the active connection's price fields, and must not replace turnLlm/
    // turnDefaultModel here (no second, redundant gated provider instance for a call that's
    // about to use the existing one). The returned profile is built from the same active row the
    // singleton was created from, so its prices are exactly the acting connection's.
    const active = await deps.llmConnections.resolveActive();
    turnPrice = toTurnPrice(active);
  }
  return { turnLlm, turnDefaultModel, turnPrice };
}

// Rerun's in-place regeneration path (docs/bi_principles.md: swipe capability on the last LLM
// response) — the exact same turn-running logic handleChatCompletions's chat_id path uses
// (connection resolution, memory/narrator system-prompt assembly, live-window trimming, runTurn,
// the optional cleanup pass), just persisted via chats.recordSwipe instead of appendMessages, and
// with no new user message to insert — messageId's own prior siblings in detail.messages are the
// entire prompt. Only ever called once the caller (handleChatRoutes below) has confirmed messageId
// is this chat's current last message; regenerating anything earlier would leave the turns after it
// stale, since nothing here touches them.
export async function regenerateSwipe(
  deps: HttpServerDeps,
  userId: string,
  chatId: string,
  detail: ChatDetail,
  messageId: string,
  // Real token-level streaming for the RP lane (docs/plans/completed/rp-streaming-plan.md) — same gate as
  // handleChatCompletions's streaming branch: only session.kind === 'rp' streams, and the swipe
  // route only passes stream: true when the client asked for it (body.stream, default false).
  // When streaming, the caller (the swipe route) is responsible for writing SSE frames from
  // onDelta; this function still owns the LLM call + persistence exactly as today, returning the
  // accumulated reply so the caller can finish its stream.
  stream = false,
  onDelta?: (textDelta: string) => void,
  // In-stream cleanup (docs/plans/completed/in-stream-cleanup-plan.md): the swipe route forwards its
  // bigimagine_cleanup / bigimagine_patch SSE-frame callback here, gated on the chat's
  // cleanup_enabled_at. When absent, no live cleanup runs for this swipe and the poll tick stays
  // the only cleanup path.
  onCleanupEvent?: (event: CleanupLiveEvent) => void,
  // Reasoning blocks (docs/plans/reasoning-blocks-plan.md): the swipe route forwards its
  // bigimagine_reasoning SSE-frame callback here. Optional exactly like onCleanupEvent — an
  // absent callback still classifies and persists the reasoning (the detector runs
  // unconditionally inside streamingTurn; only the live relay is skipped, e.g. non-streaming
  // swipes), and the accumulated reasoning is returned to the caller via the persisted
  // message's `reasoning` field either way.
  onReasoningDelta?: (reasoningDelta: string) => void,
): Promise<{ ok: true; message: StoredChatMessage; locationId?: string; characterIds?: string[] } | { ok: false; aborted?: boolean; error: string }> {
  const { db, settings, chats } = deps;
  const { session } = detail;
  const priorMessages = detail.messages.slice(0, -1);
  const messagesForLlm: LlmMessage[] = priorMessages.map((m) => ({ role: m.role, content: m.content }));
  const anchorMessageId = [...priorMessages].reverse().find((m) => m.role === 'user')?.messageId;

  // The RP lane runs with NO tools at all (2026-08-10 user direction: "simply let it execute the
  // prompt stack, with no funny business") — whatever tool_names the session row carries (the old
  // recall pair, null = all, anything) never reaches the model. Auto-recall is unaffected: it's
  // server-side injection into the stack, not a model tool call.
  const sessionTools =
    session.kind === 'rp' ? createToolRegistry([]) : session.toolNames !== null ? filterToolRegistry(deps.tools, session.toolNames) : deps.tools;
  const { turnLlm, turnPrice } = await resolveTurnLlm(deps, session.params, chatId);
  const timezone = await getHouseholdTimezone(deps.settings);
  const { systemPrompt, messagesForLlm: trimmed } = await assembleSessionTurnContext(
    db,
    deps.settings,
    deps.embeddings,
    userId,
    chatId,
    session.kind,
    session.characterId,
    session.promptStackPresetId,
    session.params,
    messagesForLlm,
    timezone,
    // The assistant message being regenerated IS this message — its id is the deterministic
    // lorebook gate seed (docs/lorebook-plan.md §4), stable across re-swipes of the same message.
    messageId,
  );

  // Same Prompt Inspector capture as handleChatCompletions (io/promptTrace.ts, kind 'main') — a
  // swipe re-runs the last turn, so its regenerated prompt is the newest "Main Prompt" the
  // inspector should show. Recorded before the call, success or not, like the cleanup pass. The
  // entry stays live so usage/price can be attached once the turn resolves — the same "absent
  // until the call returns, absent forever if it failed" contract as reply.
  const traceEntry: PromptTraceEntry = {
    kind: 'main',
    title: 'Main Prompt',
    items: [
      ...(systemPrompt ? [toPreviewItem('system', systemPrompt)] : []),
      ...trimmed.map((m) => toPreviewItem(m.role as PromptPreviewItem['role'], m.content)),
    ],
    capturedAt: Date.now(),
  };
  recordPromptTrace(chatId, traceEntry);

  let reply: string;
  let focusedNoteId: string | undefined;
  // Streaming RP swipe (rp-streaming-plan.md): run through the shared core, relaying each delta to
  // the caller's onDelta for immediate SSE flush. The abort handling matches the buffered path
  // below exactly — the route decides what the client sees (499 vs terminal frame) based on
  // whether headers were already written. A non-RP or non-streaming swipe keeps runTurn.
  const streamingRp = session.kind === 'rp' && stream === true;
  // Same live-cleanup gate as handleChatCompletions's streaming branch, plus the same wildcard
  // in-flight guard (chat, messageId, '*') held from stream start through finalizeCleanupResult so
  // the 5s poll tick never launches a duplicate repair pass on this message mid-writeback. The
  // cleanup LLM is the household gated provider (deps.llm), exactly like the poll tick's repairs.
  const liveCleanupActive = streamingRp && !!onCleanupEvent && session.cleanupEnabledAt != null;
  const cleanupDeps: CleanupLoopDeps = {
    db,
    llm: deps.llm,
    settings,
    chats,
    onLocationScraped: (u, c, locationId) => fireLocationImageGeneration(deps, u, c, locationId),
    // rp-cast-infrastructure-plan.md A3: the character analogue — a swipe regeneration that
    // lands a `Present:` roster fires each character's describer on the deferred scrape path.
    onCharactersScraped: (u, c, characterIds) =>
      characterIds.forEach((characterId) => fireCharacterDescription(deps, u, c, characterId)),
  };
  let cleanupHandoff: RunStreamingRpTurnResult['cleanup'] | undefined;
  let cleanupAbortController: AbortController | undefined;
  let liveCleanupGuardHeld = false;
  // The regenerated turn's accumulated reasoning span (reasoning-blocks-plan.md): persisted via
  // recordSwipe below and carried into the cleanup handoff's composed swipe; absent when the
  // turn produced no reasoning span. Declared here because both consumers live outside the
  // turn's own try block scope.
  let turnReasoning: RunStreamingRpTurnResult['reasoning'] | undefined;
  const releaseLiveCleanupGuard = () => {
    if (liveCleanupGuardHeld) {
      liveCleanupGuardHeld = false;
      releaseCleanupInFlight(chatId, messageId, '*');
      if (cleanupAbortController) unregisterTurnAbort(chatId, cleanupAbortController);
      // The settled cleanup_jobs rows finalizeCleanupResult just wrote are authoritative now —
      // drop the live overlay so a later getCleanupStatus polls the DB, not this turn's frames.
      clearCleanupLiveStatus(chatId);
    }
  };
  if (liveCleanupActive) {
    claimCleanupInFlight(chatId, messageId, '*');
    // A second controller under the same taskId (registerTurnAbort supports several per key) so
    // finishStream's end-of-stream repairs share the turn's Stop signal.
    cleanupAbortController = registerTurnAbort(chatId);
    liveCleanupGuardHeld = true;
  }
  if (streamingRp) {
    // stream=true implies the caller (the swipe route) passed onDelta — this is a programming
    // error if it didn't, not a runtime degradation path; fail loudly per conventions §11.
    if (!onDelta) throw new Error('regenerateSwipe: stream=true requires an onDelta callback');
    try {
      const turnResult = await runStreamingRpTurn({
        userId,
        taskId: chatId,
        messages: trimmed,
        systemPrompt,
        model: session.params.model,
        sampling: { temperature: session.params.temperature, topP: session.params.top_p, maxTokens: session.params.max_tokens },
        llm: turnLlm,
        db,
        settings,
        chats,
        onCleanupEvent,
        onReasoningDelta,
        onDelta,
      });
      reply = turnResult.content;
      cleanupHandoff = turnResult.cleanup;
      turnReasoning = turnResult.reasoning;
      traceEntry.usage = turnResult.usage;
      traceEntry.price = turnPrice;
    } catch (err) {
      if (isAbortError(err)) {
        log.info(`swipe regenerate aborted for chat ${chatId}`);
        releaseLiveCleanupGuard();
        return { ok: false, aborted: true, error: 'turn aborted' };
      }
      log.error(`swipe regenerate failed for chat ${chatId}`, err);
      releaseLiveCleanupGuard();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    try {
      const turnResult = await runTurn({
        userId,
        taskId: chatId,
        messages: trimmed,
        systemPrompt,
        model: session.params.model,
        sampling: { temperature: session.params.temperature, topP: session.params.top_p, maxTokens: session.params.max_tokens },
        llm: turnLlm,
        db,
        tools: sessionTools,
        anchorMessageId,
        embeddings: deps.embeddings,
      });
      reply = turnResult.content;
      focusedNoteId = turnResult.focusedNoteId;
      // Attached only after a successful resolve — a thrown/aborted turn leaves the entry without
      // usage/price, matching reply's "absent if the call failed" contract exactly.
      traceEntry.usage = turnResult.usage;
      traceEntry.price = turnPrice;
    } catch (err) {
      if (isAbortError(err)) {
        // The user hit Stop — not a failure. Nothing is written (the persisted user message simply
        // has no reply yet, which the frontend already presents as the Resend recovery path), so
        // the client gets a 499 to swallow quietly instead of an alarming 500.
        log.info(`swipe regenerate aborted for chat ${chatId}`);
        return { ok: false, aborted: true, error: 'turn aborted' };
      }
      log.error(`swipe regenerate failed for chat ${chatId}`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Everything between the wildcard claim above and this finally can throw — recordSwipe on a
  // DB error, finishStream on a non-abort bug (rethrown below) — and the guard must drop either
  // way, or the 5s poll tick would never process this message again until restart.
  // releaseLiveCleanupGuard is idempotent, so the finally is the handoff segment's single
  // release point. swipeResult's narrowing is lost across the try — the early !updated return
  // inside it is what makes the final return reachable only with a defined message.
  let swipeResult: StoredChatMessage | undefined;
  try {
    // reasoning (reasoning-blocks-plan.md): the regenerated reply's span is persisted with the
    // new swipe AND mirrored onto the row (recordSwipe's contract) — each swipe's reasoning is
    // independent, so the stashed previous swipe keeps its own (the plan's swipe edge case).
    const updated = await chats.recordSwipe(userId, chatId, messageId, reply, turnReasoning?.text);
    if (!updated) {
      return { ok: false, error: 'message no longer exists' };
    }
    swipeResult = updated;
    // Live cleanup persistence handoff (in-stream-cleanup-plan.md): recordSwipe just persisted the
    // regenerated raw text as the new active swipe — finishStream applies the end-of-stream repairs
    // (tail body, footer, deferred 'llm' pass) to the composed buffer, and finalizeCleanupResult
    // writes the composed text as the NEXT swipe (original stays a swipe, the send/swipe parity the
    // plan's Logic section carries through). Same finalizeCleanupResult the poll tick uses, so the
    // message is indistinguishable in cleanup_jobs from one the tick caught.
    if (cleanupHandoff) {
      try {
        const fsResult = await finishStream(cleanupHandoff.ctx, cleanupDeps, reply, {
          userId,
          chatId,
          signal: cleanupAbortController!.signal,
          onCleanupEvent,
        });
        await finalizeCleanupResult(cleanupDeps, userId, chatId, messageId, reply, fsResult.composed, fsResult.outcomes, turnReasoning?.text);
      } catch (err) {
        if (isAbortError(err)) {
          // A Stop landed during the end-of-stream repairs: the regenerated swipe above is already
          // persisted (the regeneration succeeded — report it as such); no composed swipe and no
          // job rows, so the poll tick catches the message, same as the tick's own abort path.
          log.info(`swipe live cleanup handoff aborted for chat ${chatId}`);
        } else {
          throw err; // finishStream is fail-open internally — a non-abort throw here is a bug
        }
      }
    }
  } finally {
    releaseLiveCleanupGuard();
  }
  // Stage 2 (docs/plans/vistalyze_integration/segway.md §4, location.md §4.2): post-cleanup heuristic
  // extraction against the regenerated text — recordSwipe above just made its swipe active,
  // which is the anchor the scraper's transient rows attach to. Fail-open inside the scraper:
  // never blocks the turn. The returned locationId feeds endpoint.md §5's decoupled
  // image-generation trigger (fired by the caller after the response is sent — never awaited
  // inline here). 'replace' mode: the turn being regenerated is discarded, so previous_scene_id
  // (the last-turn location state) is left pointing at the last *settled* location — the revert
  // target must survive a chain of swipes.
  // location.md §4.2's header-good gate: only scrape when the reply's header parses — a bad
  // header is left to the cleanup subloop, which repairs it and then fires the deferred scrape
  // on the repaired text (cleanupLoop.ts's onLocationScraped/onCharactersScraped hooks), so
  // nothing re-scrapes a headerless text and no wasted ensureActiveSwipe row is minted for it.
  const presence = parseStoryHeader(reply)
    ? await scrapeTurnPresence(
        { db, settings, ensureActiveSwipe: (u, c, m) => chats.ensureActiveSwipe(u, c, m) },
        userId,
        chatId,
        messageId,
        reply,
        'replace',
      )
    : undefined;
  if (focusedNoteId !== undefined) {
    await chats.updateChat(userId, chatId, { canvasNoteId: focusedNoteId });
  }
  return { ok: true, message: swipeResult!, locationId: presence?.locationId, characterIds: presence?.characterIds };
}