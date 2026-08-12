/**
 * @file orchestrator/src/orchestrator/streamingTurn.ts
 * @stamp 2026-08-11
 * @architectural-role Orchestrator — the RP lane's single shared streaming turn core
 * @description
 * The one place token-level streaming of an RP turn lives (docs/plans/rp-streaming-plan.md).
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
 * Deliberate divergence from runTurn: the blank-reply retry re-calls completeStream with the
 * exact same message history (never pushing a blank attempt into it) — a retry here is safe
 * precisely because "blank" means nothing but whitespace was ever relayed, so nothing meaningful
 * reached the client from the failed attempt. A connection whose adapter has no completeStream
 * degrades to one whole-reply delta via complete() (bb_principles.md §6) — the turn still
 * "streams" in the contract sense, just with one big delta instead of many.
 *
 * @api-declaration
 * runStreamingRpTurn(opts) — drives one RP turn through the gated provider's completeStream,
 *   relaying every delta to opts.onDelta in arrival order, and resolves with the accumulated
 *   final text + vendor usage. Throws AbortError-shaped errors the same way runTurn does
 *   (isAbortError from turnAbort.ts recognizes them) — callers handle abort identically to
 *   today's runTurn catch block.
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
import { createMetricsAccumulator, recordTurnMetrics, type TurnMetricsAccumulator } from '../io/turnMetrics.js';
import { registerTurnAbort, unregisterTurnAbort } from './turnAbort.js';

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
   *  and buffered turn send byte-identical prompts (bb_principles.md §17). */
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
  /** Called once per text delta, in arrival order, with the exact text the provider streamed.
   *  Never called after the promise resolves or rejects. The caller (httpServer.ts) serializes
   *  each call into one SSE frame immediately, so "relay" means live, not buffered. */
  onDelta: (textDelta: string) => void;
}

export interface RunStreamingRpTurnResult {
  content: string;
  usage?: LlmUsage;
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

  log.info(`runStreamingRpTurn start`, { userId, provider: llm.name, model, historyLength: opts.messages.length });

  // Blank-reply retry, mirroring loop.ts's rule: re-call with the exact same history (never push
  // a blank attempt into it). Safe in the streaming path precisely because "blank" means nothing
  // but whitespace was ever relayed — nothing meaningful reached the client from the failed
  // attempt (rp-streaming-plan.md Edge Cases). A non-blank failure (including one after deltas
  // were relayed) propagates immediately — loop.ts's completeWithBlankRetry treats a thrown
  // llm.complete the same way: the caller decides what the client sees.
  let attempts = 0;
  for (;;) {
    const llmStart = Date.now();
    let relayedText = '';
    let usage: LlmUsage | undefined;
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (llm.completeStream) {
      const turn = await llm.completeStream(messages, [], (delta) => {
        relayedText += delta;
        opts.onDelta(delta);
      }, { model, ...sampling, signal });
      // The provider resolves with the fully-accumulated text; onDelta already relayed each
      // piece live. Use the resolved content (not our own concatenation) as the canonical reply,
      // same as completeWithBlankRetry trusts turn.message.content.
      relayedText = turn.message.content;
      usage = turn.usage;
    } else {
      // No streaming capability on this connection (bb_principles.md §6): degrade to one
      // whole-reply delta via complete(). The turn still "streams" in the contract sense — the
      // caller sees exactly one onDelta call carrying the full reply.
      const turn = await llm.complete(messages, [], { model, ...sampling, signal });
      relayedText = turn.message.content;
      usage = turn.usage;
      if (relayedText.length > 0) opts.onDelta(relayedText);
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
    if (isBlankReply(relayedText) && attempts <= MAX_EMPTY_REPLY_RETRIES) {
      log.warn(`runStreamingRpTurn blank reply, retrying`, {
        userId,
        attempt: attempts,
        maxRetries: MAX_EMPTY_REPLY_RETRIES,
      });
      continue;
    }
    if (isBlankReply(relayedText)) {
      throw new Error(`runStreamingRpTurn: LLM returned an empty reply after ${MAX_EMPTY_REPLY_RETRIES} retries`);
    }

    log.info(`runStreamingRpTurn done`, { userId, relayedChars: relayedText.length });
    return { content: relayedText, usage };
  }
}
