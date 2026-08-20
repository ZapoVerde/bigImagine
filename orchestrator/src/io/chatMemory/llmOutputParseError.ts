/**
 * @file orchestrator/src/io/chatMemory/llmOutputParseError.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function — parse-failure error carrying the LLM's raw reply
 * @description
 * Every plain-text LLM call in this lane (bridgeChatMemory/distillChatMemory/curateWorldMemory/
 * curatePeople/summarizeChatChunk) parses its completion locally and throws a plain Error on
 * malformed output — deliberately stricter than Canonize's own tolerant parser, since these commit
 * straight into SQL (parseBridgeOutput.ts's own doc). That message names *what* was wrong, but not
 * *what the model actually said* — without the raw reply, chat_memory_sync_status's error row
 * (bi_principles.md §11) is a dead end: there's no way to tell whether the model drifted off-format
 * entirely, half-followed it, or hit some edge case worth tuning the prompt for.
 *
 * withParseErrorContext wraps the parse call at each of those five IO-wrapper call sites, where the
 * raw completion text (turn.message.content) is already in scope — rewrapping any parse throw with
 * the untouched raw reply plus promptName, the Settings-tab key the failing prompt is edited under
 * (bi_principles.md §17). Both ride the existing SyncStepError.cause chain (chatMemorySync.ts)
 * unchanged; runChatMemorySyncTick unwraps them onto chat_memory_sync_status (migration 0130) for
 * the review panel's error-detail modal.
 *
 * @api-declaration
 * LlmOutputParseError(promptName, rawReply, cause)
 * withParseErrorContext(promptName, rawReply, fn) — runs fn(), rewrapping any throw as the above
 *
 * @contract
 *   assertions:
 *     purity:          pure (wraps a synchronous call; no IO of its own)
 *     state_ownership: []
 *     external_io:     []
 */

export class LlmOutputParseError extends Error {
  /** The Settings-tab prompt key this reply came from, e.g. "chat_memory_bridge_prompt" — lets the
   *  review panel link a failure straight to the prompt worth tuning. */
  readonly promptName: string;
  /** The model's completion text, untouched — exactly what parsing rejected. */
  readonly rawReply: string;

  constructor(promptName: string, rawReply: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.promptName = promptName;
    this.rawReply = rawReply;
    this.cause = cause;
  }
}

export function withParseErrorContext<T>(promptName: string, rawReply: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new LlmOutputParseError(promptName, rawReply, err);
  }
}
