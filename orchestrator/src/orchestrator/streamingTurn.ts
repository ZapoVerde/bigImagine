/**
 * @file orchestrator/src/orchestrator/streamingTurn.ts
 * @stamp 2026-08-11
 * @architectural-role Orchestrator — the RP lane's single shared streaming turn core
 * @description
 * The one place token-level streaming of an RP turn lives (docs/plans/completed/rp-streaming-plan.md).
 * Both of server/httpServer.ts's LLM-entry points — handleChatCompletions (a fresh send) and
 * regenerateSwipe (Rerun / swipe past the last stored variant) — converge on this function for
 * an RP + stream:true turn, so streaming exists exactly once, not as two independently-evolving
 * implementations. The RP lane runs with zero tools (httpServer.ts strips them to an empty
 * registry), so this core has no tool-round loop at all — it is a strictly simpler shape than
 * loop.ts's runTurn, not a streaming mode bolted onto it. The household/'chat'-kind lane is
 * untouched and keeps using runTurn's non-streaming complete() path exactly as today.
 *
 * Sequences calls to the gated LlmProvider's completeStream and the turn-metrics writer. Owns
 * no state and does no direct IO of its own — every side effect goes through the provider or
 * PostgresClient it's given, matching loop.ts's contract. The only decisions this file makes are
 * mechanical: relay deltas in arrival order, apply the same blank-reply retry rule runTurn uses,
 * and record turn_metrics the same way — it never interprets what a delta or reply *means* (that
 * stays the LLM's job alone, bb_principles.md §2).
 *
 * Reasoning blocks (docs/plans/reasoning-blocks-plan.md): every delta is also run through
 * liveReasoning.ts's tag detector, alongside (never instead of) the live-cleanup hook. A span
 * inside the configured open/close tag pair is routed to onReasoningDelta — never to onDelta —
 * and the accumulated reasoning returns in the result for the caller to persist in its own
 * column. The live-cleanup engine sees only the de-tagged content (liveCleanup's composed
 * buffer must stay in the client's coordinate space, and the client never accumulated the
 * tags). Detection is not gated by skipLiveTriggers and not a "cleanup" feature — it runs on
 * every RP streaming turn, subject only to the tags being configured.
 *
 * Deliberate divergence from runTurn: the blank-reply retry re-calls completeStream with the
 * exact same message history (never pushing a blank attempt into it) — a retry here is safe
 * precisely because "blank" means nothing but whitespace was ever relayed, so nothing meaningful
 * reached the client from the failed attempt. A connection whose adapter has no completeStream
 * degrades to one whole-reply delta via complete() (bb_principles.md §6) — the turn still
 * "streams" in the contract sense, just with one big delta instead of many. The plan's
 * "all-reasoning, no-reply" edge case is decided here: a turn that produced a reasoning span
 * but no reply text is NOT blank (it persists as reasoning with empty content — see the retry
 * comment in runStreamingRpTurnInner); blank means both channels empty.
 *
 * @api-declaration
 * runStreamingRpTurn(opts) — drives one RP turn through the gated provider's completeStream,
 *   relaying every content delta to opts.onDelta and every reasoning delta to
 *   opts.onReasoningDelta in arrival order, and resolves with the accumulated final text +
 *   vendor usage + accumulated reasoning ({ text, durationMs } when a span was produced).
 *   Throws AbortError-shaped errors the same way runTurn does (isAbortError from turnAbort.ts
 *   recognizes them) — callers handle abort identically to today's runTurn catch block.
 *
 * @contract
 *   assertions:
 *     purity:          impure (drives LLM + DB IO wrappers)
 *     state_ownership: []
 *     external_io:     []
 */

import { randomUUID } from 'node:crypto';
import { log, runWithRequestId } from '../io/logger.js';
import type { LlmMessage, LlmProvider, LlmUsage } from '../io/llm/types.js';
import { runWithCallContext, type LlmCallKind } from '../io/llm/callContext.js';
import type { PostgresClient } from '../io/postgres.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import type { ChatSessionStore } from '../io/chatSessions.js';
import { createMetricsAccumulator, recordTurnMetrics, type TurnMetricsAccumulator } from '../io/turnMetrics.js';
import { registerTurnAbort, unregisterTurnAbort } from './turnAbort.js';
import {
  collectLiveOutcomes,
  createLiveCleanupContext,
  onLiveDelta,
  resetLiveCleanupContext,
  type CleanupLiveEvent,
  type LiveCleanupContext,
  type LiveRegionOutcome,
} from './liveCleanup.js';
import { createReasoningDetector, resolveReasoningTags, type ReasoningDetector } from './liveReasoning.js';
import type { CleanupLoopDeps } from './cleanupLoop.js';

/** Same automatic retry budget as runTurn (loop.ts's MAX_EMPTY_REPLY_RETRIES) for a blank final
 *  reply: one initial attempt plus up to this many retries, then the turn fails visibly rather
 *  than persisting a silent empty reply. Kept as its own constant here so streamingTurn.ts never
 *  imports the non-streaming loop's internals — the two paths stay independent files with an
 *  agreed-upon number (documented in loop.ts as the canonical source). */
const MAX_EMPTY_REPLY_RETRIES = 3;

function isBlankReply(content: string): boolean {
  return content.trim() === '';
}

export interface RunStreamingRpTurnOptions {
  userId: string;
  /** chatId — same meaning as RunTurnOptions.taskId: the key POST /v1/chat/abort registers this
   *  turn under (orchestrator/turnAbort.ts) and the key turn_metrics rows are attributed to. */
  taskId: string;
  /** The full conversation so far, ending in the latest user turn, with the RP system prompt
   *  already included as the leading system message — the caller (httpServer.ts) assembles it
   *  with the exact same assembleSessionTurnContext path a non-streaming turn uses, so a streamed
   *  and buffered turn send byte-identical prompts. */
  messages: LlmMessage[];
  systemPrompt: string;
  /** The gated provider (io/llm/llmGate.ts) — never a raw adapter: every LLM call passes the
   *  single metering seam, bb_principles.md §14. */
  llm: LlmProvider;
  /** Per-request model override (a chat session's own pick) — passed straight through, same as
   *  runTurn's. Unset means the provider's configured default. */
  model?: string;
  sampling?: { temperature?: number; topP?: number; maxTokens?: number };
  db: PostgresClient;
  /** The same OrchestratorSettingsStore cleanupLoop.ts reads its config from — the live engine
   *  resolves the header/footer regex + prompts and the slop rules from it (in-stream-cleanup-plan.md). */
  settings: OrchestratorSettingsStore;
  /** A chats handle for history, matching CleanupLoopDeps — the live repairs' {{history, N}}.
   *  Required even when onCleanupEvent is absent (a caller that never opts in still passes it). */
  chats: ChatSessionStore;
  /** Called once per text delta, in arrival order, with the exact text the provider streamed.
   *  Never called after the promise resolves or rejects. The caller (httpServer.ts) serializes
   *  each call into one SSE frame immediately, so "relay" means live, not buffered. */
  onDelta: (textDelta: string) => void;
  /** Called once per reasoning delta (the part of the stream classified inside the configured
   *  tag pair — see orchestrator/liveReasoning.ts), in arrival order, interleaved with onDelta
   *  exactly as the provider emitted them. The reasoning text never reaches onDelta — a
   *  reasoning span is routed to this callback alone, and the tags themselves are consumed. The
   *  caller (httpServer.ts) translates each call into a bigimagine_reasoning SSE frame, the
   *  same interleaving convention as the existing bigimagine_cleanup / bigimagine_patch frames.
   *  Optional: an absent callback still classifies and returns the accumulated reasoning in the
   *  result — detection is not gated on relaying (reasoning-blocks-plan.md Logic). */
  onReasoningDelta?: (reasoningDelta: string) => void;
  /** When provided, live cleanup runs for this turn (the caller gates on the chat's
   *  cleanup_enabled_at + RP kind — an absent callback means no live cleanup at all, and the
   *  poll tick stays the only cleanup path). Each event is translated by the caller into a
   *  bigimagine_cleanup / bigimagine_patch SSE frame, interleaved with the content deltas.
   *  The raw stream is never delayed for any repair — cleanup only ever follows up on text
   *  already relayed, via a patch. */
  onCleanupEvent?: (event: CleanupLiveEvent) => void;
  /** Turn 1 of a new chat: the early-header and live-body triggers are not engaged (the reply
   *  is fully buffered and header-repaired synchronously before anything streams); the composed
   *  buffer still accumulates so the caller's finishStream can run the whole-body tail pass +
   *  footer + deferred 'llm' pass through the shared handoff. */
  skipLiveTriggers?: boolean;
}

export interface RunStreamingRpTurnResult {
  content: string;
  usage?: LlmUsage;
  /** Present when this turn produced a reasoning span (liveReasoning.ts detected a configured
   *  tag pair around part of the stream — the plan's Contracts: "present only when the turn
   *  produced a reasoning span; absent (never empty-string) otherwise"). `text` is the trimmed
   *  accumulated reasoning — what the caller persists alongside content (and never resends, by
   *  virtue of living in its own column); `durationMs` is the thinking window (open tag
   *  completed -> close tag completed or implicit close at stream end), for the client's
   *  "Thought for Xs" label. */
  reasoning?: { text: string; durationMs: number };
  /** Present when live cleanup ran for this turn (onCleanupEvent was provided and the connection
   *  has a completeStream). The composed buffer (byte-identical to what the caller accumulated
   *  via onDelta), the three regions' live states as of stream end, and the live engine's
   *  context — the caller runs liveCleanup.finishStream(ctx, deps, baseText, ...) with it, then
   *  finalizeCleanupResult. Undefined for a no-completeStream connection (nothing can be caught
   *  live — the poll tick handles the message, unchanged from today) or when the caller never
   *  opted in. */
  cleanup?: { composed: string; liveOutcomes: LiveRegionOutcome[]; ctx: LiveCleanupContext };
}

export async function runStreamingRpTurn(opts: RunStreamingRpTurnOptions): Promise<RunStreamingRpTurnResult> {
  const requestId = randomUUID();
  const callContext = { taskId: opts.taskId, kind: ('chat' as LlmCallKind), userId: opts.userId };
  const metrics = createMetricsAccumulator();
  const turnStart = Date.now();
  // Registered under taskId (the chat_id) so POST /v1/chat/abort can stop this turn server-side,
  // the same key + lifetime runTurn uses (orchestrator/turnAbort.ts): dropped in the finally
  // below, whatever the outcome.
  const abortController = registerTurnAbort(opts.taskId);
  try {
    const result = await runWithRequestId(requestId, () =>
      runWithCallContext(callContext, () => runStreamingRpTurnInner(opts, metrics, abortController.signal)),
    );
    await recordTurnMetrics(opts.db, {
      userId: opts.userId,
      taskId: opts.taskId,
      kind: callContext.kind,
      totalDurationMs: Date.now() - turnStart,
      outcome: 'ok',
      accumulator: metrics,
    }).catch((err) => log.error('failed to record turn_metrics', err));
    return result;
  } catch (err) {
    await recordTurnMetrics(opts.db, {
      userId: opts.userId,
      taskId: opts.taskId,
      kind: callContext.kind,
      totalDurationMs: Date.now() - turnStart,
      outcome: 'error',
      errorReason: err instanceof Error ? err.message : String(err),
      accumulator: metrics,
    }).catch((err2) => log.error('failed to record turn_metrics', err2));
    throw err;
  } finally {
    unregisterTurnAbort(opts.taskId, abortController);
  }
}

async function runStreamingRpTurnInner(
  opts: RunStreamingRpTurnOptions,
  metrics: TurnMetricsAccumulator,
  signal: AbortSignal,
): Promise<RunStreamingRpTurnResult> {
  const { llm, model, sampling, userId } = opts;
  const messages: LlmMessage[] = [{ role: 'system', content: opts.systemPrompt }, ...opts.messages];
  // The live engine's deps — the same shape cleanupLoop.ts's tick runs on, built here from the
  // core's own deps so liveCleanup's dispatchStep is literally the poll tick's function.
  const liveDeps: CleanupLoopDeps = { db: opts.db, llm, settings: opts.settings, chats: opts.chats };
  // The reasoning tag pair, read live per turn (reasoning-blocks-plan.md Logic: detection is
  // not a "cleanup" feature — it runs unconditionally on every RP streaming turn, subject only
  // to the tags actually being configured; a blank pair disables it entirely).
  const reasoningTags = await resolveReasoningTags(opts.settings);
  const reasoningEnabled = reasoningTags.openTag.length > 0 && reasoningTags.closeTag.length > 0;

  log.info(`runStreamingRpTurn start`, { userId, provider: llm.name, model, historyLength: opts.messages.length });

  // Blank-reply retry, mirroring loop.ts's rule: re-call with the exact same history (never push
  // a blank attempt into it). Safe in the streaming path precisely because "blank" means nothing
  // but whitespace was ever relayed — nothing meaningful reached the client from the failed
  // attempt (rp-streaming-plan.md Edge Cases). A non-blank failure (including one after deltas
  // were relayed) propagates immediately — loop.ts's completeWithBlankRetry treats a thrown
  // llm.complete the same way: the caller decides what the client sees.
  // reasoning-blocks-plan.md Edge Cases ("close tag never arrives"): a turn is only "blank"
  // when BOTH channels are empty. A turn that produced a reasoning span but no reply text is
  // NOT retried — it persists as reasoning with empty content (the plan's "whatever was
  // buffered becomes the persisted reasoning" — the thought is real signal worth keeping, and
  // an all-reasoning turn is not the silent-empty failure the retry rule exists to catch). The
  // detector is recreated on every blank retry, so a discarded attempt's reasoning can never
  // leak into the retry.
  let attempts = 0;
  // Created once (first completeStream attempt) when the caller opted into live cleanup; reset
  // on every blank retry so the buffer/region state mirror relayedText (a whitespace-only first
  // attempt can't fire a spurious header repair, and patch offsets never diverge from what the
  // client accumulated). Never created for a no-completeStream connection — nothing streams
  // live, so nothing can be caught live; the poll tick stays the only cleanup path for it.
  let liveCtx: LiveCleanupContext | undefined;
  for (;;) {
    const llmStart = Date.now();
    let relayedText = '';
    let usage: LlmUsage | undefined;
    // The per-attempt reasoning detector (recreated on every blank retry, like liveCtx). When
    // the tag pair is disabled, `undefined` keeps the whole pre-existing code path byte-identical.
    const reasoningDetector: ReasoningDetector | undefined = reasoningEnabled
      ? createReasoningDetector(reasoningTags.openTag, reasoningTags.closeTag)
      : undefined;
    /** Classify one raw provider delta and relay each channel to its own sink: reasoning text
     *  only ever reaches onReasoningDelta (never onDelta — the tags themselves are consumed),
     *  content text reaches onDelta and the live-cleanup engine with the same byte sequence the
     *  client accumulates (liveCleanup's composed buffer must stay in the client's coordinate
     *  space, so cleanup runs on the de-tagged content, not the raw stream). */
    const relayDelta = (delta: string): void => {
      if (delta.length === 0) return;
      if (!reasoningDetector) {
        relayedText += delta;
        opts.onDelta(delta);
        if (liveCtx) {
          if (opts.skipLiveTriggers) {
            liveCtx.composed += delta;
          } else {
            onLiveDelta(liveCtx, liveDeps, userId, opts.taskId, delta, signal, opts.onCleanupEvent);
          }
        }
        return;
      }
      const { reasoningDelta, contentDelta } = reasoningDetector.push(delta);
      if (reasoningDelta) opts.onReasoningDelta?.(reasoningDelta);
      if (contentDelta) {
        relayedText += contentDelta;
        opts.onDelta(contentDelta);
        if (liveCtx) {
          if (opts.skipLiveTriggers) {
            liveCtx.composed += contentDelta;
          } else {
            onLiveDelta(liveCtx, liveDeps, userId, opts.taskId, contentDelta, signal, opts.onCleanupEvent);
          }
        }
      }
    };
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (llm.completeStream) {
      if (opts.onCleanupEvent && !liveCtx) {
        // Fail-open inside: a config load failure returns undefined and the turn streams with no
        // live cleanup (the poll tick catches the message afterwards).
        liveCtx = await createLiveCleanupContext(liveDeps, userId, opts.taskId);
      }
      const turn = await llm.completeStream(messages, [], (delta) => {
        // Relay first, inspect second — the raw stream is never withheld for a repair; the
        // live hooks fire their LLM repairs concurrently under the same turn signal.
        relayDelta(delta);
      }, { model, ...sampling, signal });
      // The provider resolves with the fully-accumulated text; onDelta already relayed each
      // piece live. Use the resolved content (not our own concatenation) as the canonical reply,
      // same as completeWithBlankRetry trusts turn.message.content — except when the reasoning
      // detector was active: turn.message.content then still contains the raw tagged span, and
      // the canonical reply must be the de-tagged text the client actually accumulated.
      relayedText = reasoningDetector ? relayedText : turn.message.content;
      usage = turn.usage;
    } else {
      // No streaming capability on this connection (bb_principles.md §6): degrade to one
      // whole-reply delta via complete(). The turn still "streams" in the contract sense — the
      // caller sees exactly one onDelta call carrying the full reply (or, with a reasoning
      // detector active, one onReasoningDelta call for the span and one onDelta for the rest —
      // the detector is delta-size agnostic and classifies a whole-reply delta in one push).
      const turn = await llm.complete(messages, [], { model, ...sampling, signal });
      usage = turn.usage;
      relayDelta(turn.message.content);
    }
    // End-of-stream: the detector's leftover (an implicit close while still thinking — the
    // close tag never arrived; or a partial open tag flushed as ordinary content) is relayed
    // now so the client's live buffers match the persisted text. The accumulated reasoning is
    // read off the detector afterwards.
    let finalReasoning: { text: string; durationMs: number } | undefined;
    if (reasoningDetector) {
      const fin = reasoningDetector.finalize();
      if (fin.reasoningDelta) opts.onReasoningDelta?.(fin.reasoningDelta);
      if (fin.contentDelta) {
        relayedText += fin.contentDelta;
        opts.onDelta(fin.contentDelta);
      }
      const text = reasoningDetector.reasoning.trim();
      if (text.length > 0) {
        finalReasoning = { text, durationMs: reasoningDetector.durationMs() ?? 0 };
      }
    }
    metrics.rounds.push({
      round: 0,
      llmDurationMs: Date.now() - llmStart,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      toolCalls: [],
    });

    attempts++;
    const blankReply = isBlankReply(relayedText) && !finalReasoning;
    if (blankReply && attempts <= MAX_EMPTY_REPLY_RETRIES) {
      log.warn(`runStreamingRpTurn blank reply, retrying`, {
        userId,
        attempt: attempts,
        maxRetries: MAX_EMPTY_REPLY_RETRIES,
      });
      if (liveCtx) resetLiveCleanupContext(liveCtx);
      continue;
    }
    if (blankReply) {
      throw new Error(`runStreamingRpTurn: LLM returned an empty reply after ${MAX_EMPTY_REPLY_RETRIES} retries`);
    }

    log.info(`runStreamingRpTurn done`, { userId, relayedChars: relayedText.length, reasoningChars: finalReasoning?.text.length ?? 0 });
    return {
      content: relayedText,
      usage,
      reasoning: finalReasoning,
      cleanup: liveCtx ? { composed: liveCtx.composed, liveOutcomes: collectLiveOutcomes(liveCtx), ctx: liveCtx } : undefined,
    };
  }
}
