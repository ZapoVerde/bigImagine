/**
 * @file orchestrator/src/server/promptPreview.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — the Prompt Inspector's read surface from httpServer.ts
 * @description
 * docs/plans/prompt-inspector-* — the read-only twin of the narrator assembly path: the
 * PromptPreviewItem/Group/Prompt shapes (the inspector's granular per-slot item model, with
 * cache-coverage + per-subsection stability + usage/price receipts), the shared preview-item
 * helper (toPreviewItem + the chars/token estimate + latest-per-kind capture dedup), and
 * buildPromptPreview — the /v1/chats/:id/prompt-preview route's body, preferring the last
 * captured 'main' trace entry, falling back to a live reconstruction that shares the exact
 * assembly code a real turn runs (promptAssembly.ts), so a preview can never drift.
 * NOTE: imports the assembly helpers from promptAssembly.ts (which imports toPreviewItem back)
 * — a benign ESM cycle, function declarations used only at request time (same proven pattern
 * as the step-5 handleChats⇄httpServer cycle).
 *
 * @api-declaration
 * buildPromptPreview(deps, userId, chatId) — { ok: true, preview } | { ok: false, status, error }
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads chat rows + the in-memory prompt trace; no writes)
 *     state_ownership: []
 *     external_io:     [Postgres (via deps.chats/deps.db)]
 */

import { getPromptTrace } from '../io/promptTrace.js';
import { longestCommonPrefixLength } from '../util/commonPrefix.js';
import { computeSectionStability, type SectionStabilityResult } from '../util/sectionStability.js';
import type { LlmMessage, LlmUsage } from '../io/llm/types.js';
import type { RpMemoryContext } from '../io/chatMemory/memoryInjection.js';
import {
  buildChatMemorySystemPrompt,
  buildMacroSnapshot,
  buildNarratorStackItems,
  resolveMacrosInMessages,
  resolveMacrosInSystemPrompt,
  trimToLiveWindow,
} from './promptAssembly.js';
import type { HttpServerDeps } from './httpServer.js';

export interface PromptPreviewItem {
  /** Raw marker vocabulary key (assemblePromptStack.ts's MarkerKey) when this item came from a
   *  preset's marker slot — undefined for a custom slot, a date-context line, or a conversation
   *  message. The frontend maps this to a friendly name; the orchestrator has no business owning
   *  display copy. */
  markerKey?: string;
  /** A custom slot's own cosmetic label (migration 0060), when set. */
  label?: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  chars: number;
  /** ~4 chars/token, the same provider-agnostic heuristic truncateForContext.ts already documents
   *  and uses — bi_principles.md §6 rules out a real per-provider tokenizer at this seam. */
  estimatedTokens: number;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

// One captured group per prompt kind, the most recent capture of each (the trace keeps several
// turns' worth; the inspector shows the latest per kind — cleanup re-fires every turn, and only
// the last one is the useful one to audit). Map keeps first-seen order with last value winning,
// which is exactly "first-seen order, latest content".
function latestPerKind<T extends { kind: string }>(entries: T[]): T[] {
  const byKind = new Map<string, T>();
  for (const entry of entries) byKind.set(entry.kind, entry);
  return [...byKind.values()];
}

export function toPreviewItem(
  role: PromptPreviewItem['role'],
  content: string,
  extra?: { markerKey?: string; label?: string },
): PromptPreviewItem {
  return {
    markerKey: extra?.markerKey,
    label: extra?.label,
    role,
    content,
    chars: content.length,
    estimatedTokens: estimateTokens(content.length),
  };
}

export interface PromptPreviewGroup {
  /** Stable kind tag: 'main' (the last turn's main prompt, captured at send time — see below),
   *  or a captured background prompt's tag ('cleanup', 'title', …) from io/promptTrace.ts. */
  kind: string;
  /** Human heading shown in the inspector, e.g. 'Main Prompt' / 'Cleanup Prompt'. */
  title: string;
  /** True when this group is the actual text fired during a turn (captured at send time); false
   *  only for the main prompt's fallback — a live reconstruction of what the next turn would
   *  send, shown while no turn has been captured yet (fresh chat, or trace lost to a restart). */
  captured: boolean;
  /** The prompt's items in send order — system-stack/header items first, then conversation
   *  messages, each with a rough token estimate. */
  items: PromptPreviewItem[];
  /** Cache-coverage diff against the previous fired main (docs/plans/completed/prompt-inspector-tag-tree.md
   *  §3.2, revised): stablePrefixChars = length of the longest common prefix (UTF-16 code units)
   *  of this group's joined items text and the previous 'main' trace entry's; previousCallAt =
   *  when that previous main fired. A section of this group's tag tree is cache-covered iff
   *  section.end <= stablePrefixChars. Both entries are recorded at send time, so the badge is
   *  deterministic — no live reconstruction involved. Absent when fewer than two 'main' entries
   *  are on record (fresh chat, or the in-memory trace was lost to a restart) — the frontend
   *  then omits the cache badges rather than showing an unknown state. */
  stablePrefixChars?: number;
  previousCallAt?: number;
  /** Per-subsection identity stability over the last x calls on record (docs/
   *  prompt-inspector-tag-tree.md §3.3): the trace's main entries, oldest first, are replayed as
   *  consecutive pairs — each section (keyed by canonical tag name + occurrence index) counts one
   *  observation per call it existed in, identical when its full span is byte-identical to the
   *  previous call's same section. The percentage shown per section is identical / seen. Absent
   *  when fewer than two 'main' entries are on record — same omission rule as
   *  stablePrefixChars (fresh chat, or the in-memory trace was lost to a restart). */
  stability?: SectionStabilityResult;
  /** The model's reply to this prompt, when the trace captured one (io/promptTrace.ts's `reply` —
   *  cleanup repairs record it; the cleaned text replaces the raw output in the message, so this
   *  is the only place it survives). Rendered as its own collapsible block; deliberately kept OUT
   *  of `items` so the group's totals stay prompt-side (the reply was never sent to the model). */
  reply?: PromptPreviewItem;
  /** The last turn's vendor-reported token accounting (io/promptTrace.ts's `usage`), copied from
   *  the captured 'main' entry — present only when a turn has fired and resolved successfully
   *  against a connection that reports usage, undefined on the live-reconstruction fallback (no
   *  real call to report) or a turn that failed. Powers the receipt row under the group title
   *  (docs/plans/completed/prompt-inspector-usage-cost.md). */
  usage?: LlmUsage;
  /** The acting connection's USD-per-1M-token rates at that turn's send time — undefined end to
   *  end when no price was configured ("tokens only, never a fabricated $0.00"); a partially-set
   *  price keeps the $ figure off rather than pricing a tier at another tier's rate. */
  price?: { inputPerMillion?: number; outputPerMillion?: number; cacheHitPerMillion?: number };
}

export interface PromptPreview {
  /** One group per prompt this chat fires, in order: the last turn's main prompt (captured at
   *  send time, falling back to a live preview), then any captured background prompts from the
   *  last turns (cleanup pass, title generation, …). */
  groups: PromptPreviewGroup[];
  totalChars: number;
  totalEstimatedTokens: number;
}

// The read-only twin of assembleSessionTurnContext's 'rp' branch above. After a turn has fired,
// the 'main' entry handleChatCompletions/regenerateSwipe recorded in io/promptTrace.ts IS the
// exact text that turn sent — the inspector's primary path. The live assembly below (same
// memory/preset/legacy logic, same buildNarratorStackItems/resolveMacrosInSystemPrompt) is only
// the fallback for when no capture exists yet; it can never drift from what a real turn sends
// since both paths share that assembly. RP-only (docs/bi_principles.md's household-memory/canon
// scoping is what makes a 'chat'-kind session's system prompt uninteresting to audit this way —
// it's just the frozen params.system).
export async function buildPromptPreview(  deps: HttpServerDeps,
  userId: string,
  chatId: string,
): Promise<{ ok: true; preview: PromptPreview } | { ok: false; status: number; error: string }> {
  const detail = await deps.chats.getChat(userId, chatId);
  if (!detail) return { ok: false, status: 404, error: 'not found' };
  const { session } = detail;
  if (session.kind !== 'rp') {
    return { ok: false, status: 422, error: 'prompt preview is only available for rp chats' };
  }

  // io/promptTrace.ts's contract, applied to the main prompt too: the trace now holds 'main'
  // entries — the exact text handleChatCompletions/regenerateSwipe record just before the llm
  // call — and those are "the last turn that was sent", which is what the inspector exists to
  // show. Prefer the latest one; the live assembly below is the fallback for a chat that hasn't
  // fired a turn yet, or a restart that wiped the in-memory trace (and it stays useful while
  // composing, before the first send — bi_principles.md §13's live-read applied to this surface).
  // Either way the group's items stay granular (one per system-stack slot and history message) so
  // the frontend can render them individually, or join them into one block, as it prefers.
  const trace = getPromptTrace(chatId);
  const mains = [...trace].reverse().filter((e) => e.kind === 'main');
  const capturedMain = mains[0];
  const previousMain = mains[1];

  let mainGroup: PromptPreviewGroup;
  if (capturedMain) {
    mainGroup = {
      kind: 'main',
      title: 'Main Prompt',
      captured: true,
      items: capturedMain.items.map((i) => ({
        role: i.role,
        content: i.content,
        chars: i.chars,
        estimatedTokens: i.estimatedTokens,
      })),
    };
    // The turn's usage/cost receipt: copied from the trace entry the way `reply` is — absent
    // while the entry hasn't resolved yet, absent forever on the live-reconstruction fallback
    // below (no real call happened to report). Both fields are 'main'-only (see the plan).
    mainGroup.usage = capturedMain.usage;
    mainGroup.price = capturedMain.price;
    // Cache-coverage badges (§3.2, revised): diff the last fired main against the one before it.
    // Both are recorded bytes, so the badge is deterministic — no live reconstruction, unlike the
    // original design. stablePrefixChars = the longest common prefix of the two joined texts, in
    // the same UTF-16 code units the frontend's tag-tree offsets use (the tree slices the same
    // joined text). Omitted when only one (or zero) main is on record — the frontend then shows
    // no cache badges at all.
    if (previousMain) {
      const joinedNow = capturedMain.items.map((i) => i.content).join('\n\n');
      const joinedPrev = previousMain.items.map((i) => i.content).join('\n\n');
      mainGroup.stablePrefixChars = longestCommonPrefixLength(joinedNow, joinedPrev);
      mainGroup.previousCallAt = previousMain.capturedAt;
    }
    // Per-subsection stability (§3.3): replay the mains the trace holds (oldest first) as
    // consecutive pairs — the fixed last-x-calls window, data the trace already keeps (no new
    // state, no reset bookkeeping). Only reachable with a capture; requires ≥2 mains on record,
    // same omission rule as the cache badges above.
    if (mains.length >= 2) {
      mainGroup.stability = computeSectionStability(
        [...mains].reverse().map((m) => m.items.map((i) => i.content).join('\n\n')),
      );
    }
  } else {
    const messagesForLlm: LlmMessage[] = detail.messages.map((m) => ({ role: m.role, content: m.content }));
    let [memoryContext, trimmed] = await Promise.all([
      buildChatMemorySystemPrompt(deps.db, deps.settings, deps.embeddings, userId, chatId, session.kind, messagesForLlm),
      trimToLiveWindow(messagesForLlm, deps.settings),
    ]);

    // No date-context item — 'rp' turns no longer get formatCurrentDateContext prepended (see
    // assembleSessionTurnContext's 'rp' branch above), and this preview must never show something
    // an actual turn wouldn't send.
    const systemStack: PromptPreviewItem[] = [];

    // Same shared-snapshot shape as assembleSessionTurnContext — one frozen snapshot for the
    // system text (legacy branch only) and the message history (both branches; a real turn's
    // narrator path resolves messages the same way), docs/plans/prompt-macros.md §2.
    const systemNeedsMacros = !session.promptStackPresetId && !!session.params.system?.includes('{{');
    const historyNeedsMacros = trimmed.some((m) => m.content.includes('{{'));
    const macroSnapshot = systemNeedsMacros || historyNeedsMacros
      ? await buildMacroSnapshot(deps.db, deps.settings, userId, session.characterId)
      : undefined;

    if (session.kind === 'rp' && session.promptStackPresetId) {
      // Lorebook preview seed: no assistant message is being generated here, so the gate uses
      // the last assistant message's id (stable per chat head — the preview shows what the last
      // resolved turn saw); a chat that has never had an assistant message omits the slot.
      const lastAssistantMessageId = [...detail.messages].reverse().find((m) => m.role === 'assistant')?.messageId;
      systemStack.push(
        ...(await buildNarratorStackItems(deps.db, deps.settings, deps.embeddings, userId, chatId, session.characterId, session.promptStackPresetId, memoryContext as RpMemoryContext, trimmed, lastAssistantMessageId)).items,
      );
    } else {
      let system = session.params.system;
      if (system?.includes('{{') && macroSnapshot) {
        system = await resolveMacrosInSystemPrompt(system, macroSnapshot);
      }
      if (system) systemStack.push(toPreviewItem('system', system, { markerKey: 'system' }));
      // No-preset fallback: 'chat' lane returns the string directly, 'rp' lane the structured
      // context whose .fused is the legacy block — either way it previews as the memory item.
      const memoryText = typeof memoryContext === 'string' ? memoryContext : memoryContext.fused;
      if (memoryText) systemStack.push(toPreviewItem('system', memoryText, { markerKey: 'memory_recall' }));
    }
    // When the recent_history slot rendered, the live-window turns are INSIDE the stack — the
    // preview must not also list them as message items (mirrors the real turn: messagesForLlm is
    // emptied in assembleSessionTurnContext). resolveMacrosInMessages stays gated on !rendered:
    // the rendered block's own Stage-1 pass (buildNarratorStackItems) already resolved its macros.
    const historyInStack = systemStack.some((i) => i.markerKey === 'recent_history');
    const messages = historyInStack
      ? []
      : resolveMacrosInMessages(trimmed, historyNeedsMacros, macroSnapshot).map((m) => toPreviewItem(m.role as PromptPreviewItem['role'], m.content));
    mainGroup = { kind: 'main', title: 'Main Prompt', captured: false, items: [...systemStack, ...messages] };
  }

  // One group per prompt this chat fires. Main first (the captured last turn, or the live preview),
  // then every captured background prompt — the cleanup pass, title generation, … — in fire order.
  // 'main' entries in the trace are already surfaced as the first group, so they're filtered out
  // here rather than shown a second time.
  const groups: PromptPreviewGroup[] = [
    mainGroup,
    ...latestPerKind(trace)
      .filter((e) => e.kind !== 'main')
      .map((entry): PromptPreviewGroup => ({
        kind: entry.kind,
        title: entry.title,
        captured: true,
        items: entry.items.map((i) => ({
          role: i.role,
          content: i.content,
          chars: i.chars,
          estimatedTokens: i.estimatedTokens,
        })),
        // A captured background prompt's reply (cleanup repair outputs — otherwise unrecoverable),
        // when the trace recorded one. Separate from items so prompt-side totals stay prompt-side.
        reply: entry.reply
          ? { role: 'assistant', content: entry.reply, chars: entry.reply.length, estimatedTokens: estimateTokens(entry.reply.length) }
          : undefined,
      })),
  ];

  const allChars = groups.reduce((sum, g) => sum + g.items.reduce((s, i) => s + i.chars, 0), 0);
  return {
    ok: true,
    preview: {
      groups,
      totalChars: allChars,
      totalEstimatedTokens: estimateTokens(allChars),
    },
  };
}