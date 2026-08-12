/**
 * @file orchestrator/src/orchestrator/liveReasoning.ts
 * @stamp 2026-08-16
 * @architectural-role Pure Function — the per-delta reasoning detector/splitter
 * @description
 * The reasoning-block detector for docs/plans/reasoning-blocks-plan.md: the server-side
 * equivalent of SillyTavern's reasoning.js tag parsing, adapted to BigImagine's
 * server-authoritative architecture (bi_principles.md §2 — "streamed deltas are relayed data,
 * never interpreted by the frontend"; the tag classification belongs here, in the orchestrator,
 * not in ChatView.tsx). Much simpler than liveCleanup.ts's engine: a three-state machine
 * (none/thinking/done), no LLM calls, no repairs — purely mechanical tag detection and text
 * routing, in the same spirit as cleanupHeuristics.ts's pure inspection functions.
 *
 * The state machine is driven by the same per-delta loop runStreamingRpTurn runs on:
 *   none     — until the accumulated buffer's tail matches the configured open tag
 *   thinking — every incoming character is reasoning text (never content); until the buffer
 *              since the open tag contains the configured close tag
 *   done     — terminal; everything after is ordinary content (a second open tag after the
 *              first close is passed through as content, not a second reasoning span — the
 *              simple single-span case this plan covers)
 *
 * The open and close tag strings themselves are consumed — never relayed on either channel.
 * The machine is delta-size agnostic: whether the stream delivers one character per call or the
 * whole reply in one delta (the no-completeStream fallback), the same classification results,
 * because state is derived from the accumulated text, never from delta boundaries — a tag pair
 * that straddles delta boundaries is detected correctly, and a whole-reply delta is handled in
 * one call.
 *
 * An empty/misconfigured tag pair (either tag blank) disables detection entirely — everything
 * is content, matching parseReasoningFromString's own "both prefix and suffix must be defined"
 * guard (the plan's Edge Cases). The default pair is '<think>' / '</think>', resolved live from
 * orchestrator_settings (reasoning_open_tag / reasoning_close_tag) by resolveReasoningTags —
 * same live-read shape as cleanupLoop.ts's resolveCleanupConfig (bi_principles.md §13/§6: the
 * tag pair is configuration, not a hardcoded assumption about one vendor's convention).
 *
 * @api-declaration
 * DEFAULT_REASONING_OPEN_TAG / DEFAULT_REASONING_CLOSE_TAG — the built-in pair
 * resolveReasoningTags(settings) -> { openTag, closeTag } — live-read the two keys, defaulting
 *   unset values to the built-in pair (no restart, same §13 shape as every other setting)
 * createReasoningDetector(openTag, closeTag, now?) -> ReasoningDetector
 *   .push(delta) -> { reasoningDelta, contentDelta } — classify one incoming text delta; at most
 *     one of the two outputs is non-empty
 *   .finalize() -> { reasoningDelta, contentDelta } — end-of-stream: an implicit close while
 *     still 'thinking' (the close tag never arrived), or a partial open tag flushed as content
 *   .state / .reasoning / .thinkingStartedAt / .thinkingEndedAt / .durationMs() — read-only
 *     inspection for the caller (streamingTurn.ts derives the duration pair and the trimmed
 *     accumulated text for persistence + the client's "Thought for Xs" label)
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO, no LLM calls, no module-level state — only the caller-held
 *                      detector object mutates)
 *     state_ownership: [the ReasoningDetector instance the streaming loop holds]
 *     external_io:     []
 */

import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';

export const DEFAULT_REASONING_OPEN_TAG = '<think>';
export const DEFAULT_REASONING_CLOSE_TAG = '</think>';

export type ReasoningState = 'none' | 'thinking' | 'done';

/** The classification of one incoming text delta — at most one side is ever non-empty. The tag
 *  strings themselves are consumed, so neither side ever carries an open or close tag. */
export interface ReasoningSplit {
  reasoningDelta: string;
  contentDelta: string;
}

export interface ReasoningDetector {
  state: ReasoningState;
  /** The accumulated inner reasoning text (everything since the open tag, minus the tags
   *  themselves). Unchanged by finalize; the caller trims before persisting. */
  reasoning: string;
  /** Epoch-ms timestamp when the open tag completed (state none -> thinking); null if never
   *  entered. finalize() sets it when it applies the implicit close. */
  thinkingStartedAt: number | null;
  /** Epoch-ms timestamp when the close tag completed (state -> done), or when finalize()
   *  applied the implicit close. Null if the detector never left 'none'. */
  thinkingEndedAt: number | null;
  /** durationMs = thinkingEndedAt - thinkingStartedAt; null until both exist. */
  durationMs(): number | null;
  /** Classify one text delta. Call exactly once per incoming delta, in arrival order. */
  push(delta: string): ReasoningSplit;
  /** End-of-stream: flush any remaining state. While still 'thinking', this is the implicit
   *  close — whatever was buffered since the open tag becomes reasoning (plan Edge Cases:
   *  "model cut off mid-thought"). While still 'none', a partial open tag is flushed as
   *  ordinary content (an incomplete tag is just literal text). Safe to call once, after the
   *  last push. */
  finalize(): ReasoningSplit;
}

/** Live-read the tag pair (reasoning_open_tag / reasoning_close_tag), defaulting unset values
 *  to the built-in pair — the plan's "one global tag pair, matching the header/footer regex
 *  config's scope". A blank value is NOT defaulted here (the store holds an explicit
 *  'disabled'); the detector itself treats a blank pair as disabled. */
export async function resolveReasoningTags(
  settings: OrchestratorSettingsStore,
): Promise<{ openTag: string; closeTag: string }> {
  const [openTag, closeTag] = await Promise.all([
    settings.get('reasoning_open_tag'),
    settings.get('reasoning_close_tag'),
  ]);
  return {
    openTag: openTag ?? DEFAULT_REASONING_OPEN_TAG,
    closeTag: closeTag ?? DEFAULT_REASONING_CLOSE_TAG,
  };
}

/** True when the pair is usable — both tags non-empty (the "both prefix and suffix must be
 *  defined" guard). A blank pair disables detection: the detector passes everything through as
 *  content and never enters 'thinking'. */
function pairEnabled(openTag: string, closeTag: string): boolean {
  return openTag.length > 0 && closeTag.length > 0;
}

export function createReasoningDetector(
  openTag: string,
  closeTag: string,
  now: () => number = Date.now,
): ReasoningDetector {
  let state: ReasoningState = 'none';
  let reasoning = '';
  let thinkingStartedAt: number | null = null;
  let thinkingEndedAt: number | null = null;
  // The chars not yet classified: while 'none' they are a candidate prefix of openTag; while
  // 'thinking' a candidate prefix of closeTag. Never longer than the tag it's matching.
  let held = '';
  const enabled = pairEnabled(openTag, closeTag);

  function push(delta: string): ReasoningSplit {
    const out: ReasoningSplit = { reasoningDelta: '', contentDelta: '' };
    if (!enabled || state === 'done' || delta.length === 0) {
      if (delta.length > 0) out.contentDelta = delta;
      return out;
    }
    for (const ch of delta) {
      if (state === 'none') {
        const candidate = held + ch;
        if (candidate === openTag) {
          // The open tag completed — consume it (including the partial prefix held so far) and
          // enter thinking. The tag itself is dropped from both channels.
          held = '';
          state = 'thinking';
          thinkingStartedAt = now();
        } else if (openTag.startsWith(candidate)) {
          held = candidate; // still a prefix of the open tag — hold for the next char
        } else {
          // Diverged from the open tag: everything held so far (plus this char) is content.
          out.contentDelta += candidate;
          held = '';
        }
      } else if (state === 'thinking') {
        // Every char is reasoning text unless it completes the close tag.
        const candidate = held + ch;
        if (candidate === closeTag) {
          // The close tag completed — consume it (the partial prefix held so far too) and enter
          // done. The tag itself is dropped from the reasoning channel.
          held = '';
          state = 'done';
          thinkingEndedAt = now();
        } else if (closeTag.startsWith(candidate)) {
          held = candidate; // still a prefix of the close tag — hold for the next char
        } else {
          // Diverged from the close tag: the held prefix and this char are reasoning text. (A
          // close-tag match can never start inside `held` — held is a strict prefix of closeTag
          // and candidate diverged, so no suffix of candidate is a prefix of closeTag either.)
          reasoning += candidate;
          // Relay it to the caller too — push()'s reasoningDelta is what streamingTurn.ts
          // forwards to onReasoningDelta (the live SSE frames) and accumulates for persistence;
          // `.reasoning` alone is only the final buffer.
          out.reasoningDelta += candidate;
          held = '';
        }
      } else {
        // state === 'done' — terminal mid-delta: everything from the first close tag onward is
        // ordinary content. A second open tag is passed through verbatim (the simple
        // single-span case this plan covers). The per-char branch exists so a whole-reply delta
        // classifies identically to the token-by-token stream — the loop must not keep routing
        // to reasoning just because the close tag landed mid-delta (delta-size agnosticism).
        out.contentDelta += ch;
      }
    }
    return out;
  }

  function finalize(): ReasoningSplit {
    const out: ReasoningSplit = { reasoningDelta: '', contentDelta: '' };
    if (!enabled) return out;
    if (state === 'thinking') {
      // The close tag never arrived — the plan's implicit close: whatever was buffered since
      // the open tag (including a partial close-tag prefix) becomes the persisted reasoning.
      // Only the newly-flushed held piece is returned — everything before it was already
      // relayed incrementally via push()'s reasoningDelta outputs.
      const flushed = held;
      reasoning += held;
      held = '';
      state = 'done';
      thinkingEndedAt = now();
      out.reasoningDelta = flushed;
      return out;
    }
    if (state === 'none' && held.length > 0) {
      // The stream ended mid-open-tag — an incomplete tag is ordinary literal text.
      out.contentDelta = held;
      held = '';
    }
    return out;
  }

  return {
    get state() {
      return state;
    },
    get reasoning() {
      return reasoning;
    },
    get thinkingStartedAt() {
      return thinkingStartedAt;
    },
    get thinkingEndedAt() {
      return thinkingEndedAt;
    },
    durationMs() {
      return thinkingStartedAt !== null && thinkingEndedAt !== null ? thinkingEndedAt - thinkingStartedAt : null;
    },
    push,
    finalize,
  };
}
