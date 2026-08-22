/**
 * @file orchestrator/src/server/promptAssembly.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — the per-turn prompt-assembly business logic from httpServer.ts
 * @description
 * The prompt a turn actually sends, assembled fresh per turn (docs/plans/prompt-macros.md,
 * docs/plans/turn-loop-plan.md §3.2): the chat-memory digest (household / scene-events-plot /
 * CNZ auto-recall), the turn-scoped macro snapshot + system-text/message-history resolution
 * passes, the per-turn narrator stack (loadPromptStackSlots — the narrator-path slot loader
 * that must stay in sync with plugins/context-stack-presets/src/applyPromptStackToChatTool.ts —
 * buildNarratorStackItems, assembleNarratorSystemText), live-window trimming, the full
 * assembleSessionTurnContext (the shared seam handleChatCompletions and regenerateSwipe both
 * call), and decorateMessageForDisplay (the single-message resolvedContent twin).
 *
 * @api-declaration
 * assembleSessionTurnContext(db, settings, embeddings, userId, chatId, kind, characterId,
 *   presetId, params, messagesForLlm, timezone, lorebookSeedMessageId?) — { systemPrompt,
 *   messagesForLlm, lorebookActivatedEntryIds }
 * decorateMessageForDisplay(db, settings, userId, session, message) — display-resolved message
 * + the assembly helpers promptPreview.ts reuses for the live fallback
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads characters/persona/memory/preset/lorebook rows per turn)
 *     state_ownership: []
 *     external_io:     [Postgres (via db/settings), EmbeddingProvider (auto-recall retrieval)]
 */

import { buildAutoRecallParts, formatAutoRecallBlock, buildAutoRecallQuery, AUTO_RECALL_PAIRS } from '../io/chatMemory/recallForPrompt.js';
import {
  renderBridge,
  renderPlotThreads,
  renderAutoRecall,
  renderSyncSummaries,
  renderFusedMemoryBlock,
  formatRecentHistoryTurns,
  renderRecentHistory,
  type RpMemoryContext,
} from '../io/chatMemory/memoryInjection.js';
import { resolveLorebook } from '../orchestrator/resolveLorebook.js';
import { loadLocationBlock } from '../orchestrator/locationAndPresenceScraper.js';
import { formatCurrentDateContext } from '../util/dateContext.js';
import { interpolateMacros, type MacroSnapshot } from '../util/interpolateMacros.js';
import { groupTagsForRendered, wrapSlotContent, type MarkerKey, type PromptStackFields, type PromptStackSlot } from '../util/assemblePromptStack.js';
import { getPersonaSettings } from './adminServer.js';
import { toPreviewItem, type PromptPreviewItem } from './promptPreview.js';
import type { ChatParams, ChatSessionRow, StoredChatMessage } from '../io/chatSessions.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import type { LlmMessage } from '../io/llm/types.js';
import type { PostgresClient } from '../io/postgres.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';

// docs/chat-memory.md: the always-injected half of chat memory (small, unconditional — see
// recallChatHistoryTool.ts's own doc for why full-turn recall stays an explicit tool call instead,
// and recallForPrompt.ts for the CNZ-shaped auto-recall this module now also runs — the user
// chose CNZ parity for the RP read path: silent per-turn retrieval on top of the still-enabled
// tools). The two chat kinds diverge completely here, mirroring chatMemorySync.ts's own kind branch:
//
// A 'chat' (household) chat gets household_memory (every user's own row — RLS already scopes it)
// plus chat_memory_entries' flat key-ideas digest, byte-for-byte the original behavior, returned
// as a plain string.
//
// An 'rp' chat gets no household_memory at all (docs/bi_principles.md §4/§16,
// db/migrations/0049_chat_kind.sql — in-fiction details have no business leaking into unrelated
// chats, or vice versa) and instead gets the hookseeker-parity bridge's own output: the evolving
// SCENE and EVENTS chat_memory_entries rows (topic_key 'scene'/'events', written by
// bridgeChatMemory.ts) plus buildAutoRecallParts's CNZ-style auto-recall — the last
// AUTO_RECALL_PAIRS turn-pairs embedded as the query, returning this chat's archived full turns,
// non-rejected canon facts, and ranked plot-arc cards (io/chatMemory/recallPlotLane.ts: the
// ranked, bounded, recency-floored replacement for the old unconditional latest-per-arc plot
// dump — see docs/plans/plot-arc-recall-plan.md), all injected unconditionally (fail-open —
// empty parts on error or no match).
//
// The rp branch returns the *structured* RpMemoryContext (scene/events/plotThreads/chunks/facts
// plus the fused legacy string), not a formatted block — the narrator stack renders each
// component through its own user-editable template (io/chatMemory/memoryInjection.ts, the
// 2026-08-13 user direction), so bridge/plot_threads/auto_recall can be ordered independently in
// a preset, while `fused` keeps the deprecated memory_recall alias and the no-preset fallback
// byte-identical to the pre-split output.
export async function buildChatMemorySystemPrompt(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  embeddings: EmbeddingProvider,
  userId: string,
  chatId: string,
  kind: 'chat' | 'rp',
  messages: LlmMessage[],
): Promise<string | RpMemoryContext> {
  return db.withUserScope(userId, async (session) => {
    if (kind === 'rp') {
      // docs/chat-memory.md: the always-injected half (scene/events) plus the CNZ-shaped
      // auto-recall (io/chatMemory/recallForPrompt.ts) — the last AUTO_RECALL_PAIRS turn-pairs
      // become the query, embedded ONCE and shared across the chunk, fact, and plot lanes; the
      // chat's archived full turns, its non-rejected canon facts, and its ranked plot-arc cards
      // are all retrieved unconditionally (plot-arc-recall-plan.md: the plot lane replaces the
      // old unranked latest-per-arc dump with a ranked, bounded, recency-floored card set).
      // Fail-open: empty parts when nothing matched or retrieval errored, so memory can never
      // break a turn. Returned as raw parts — the narrator stack renders them through the
      // per-component templates (io/chatMemory/memoryInjection.ts).
      const [bridgeRows, autoRecall] = await Promise.all([
        session.query<{ topic_key: string; content: string }>(
          `select topic_key, content from chat_memory_entries where chat_id = $1 and topic_key in ('scene', 'events')`,
          [chatId],
        ),
        buildAutoRecallParts(session, settings, embeddings, userId, chatId, messages),
      ]);
      const scene = bridgeRows.find((r) => r.topic_key === 'scene')?.content;
      const events = bridgeRows.find((r) => r.topic_key === 'events')?.content;
      const plotThreads = autoRecall.plots;
      const fused = renderFusedMemoryBlock(scene, events, plotThreads, formatAutoRecallBlock(autoRecall.chunks, autoRecall.facts));
      return { scene, events, plotThreads, chunks: autoRecall.chunks, facts: autoRecall.facts, syncSummaries: autoRecall.syncSummaries, fused };
    }

    const [household, entries] = await Promise.all([
      session.query<{ content: string }>(
        'select content from household_memory where user_id = $1 order by updated_at desc',
        [userId],
      ),
      session.query<{ content: string }>(
        'select content from chat_memory_entries where chat_id = $1 order by updated_at',
        [chatId],
      ),
    ]);
    const parts: string[] = [];
    if (household.length) {
      parts.push(`What you remember about this household:\n${household.map((r) => `- ${r.content}`).join('\n')}`);
    }
    if (entries.length) {
      parts.push(
        `Key ideas from earlier in this conversation (no longer in view — call recall_chat_history for exact wording):\n${entries
          .map((r) => `- ${r.content}`)
          .join('\n')}`,
      );
    }
    return parts.join('\n\n');
  });
}

// docs/plans/prompt-macros.md's Stage 1 — the turn-scoped snapshot (docs §2) both the system-prompt and
// the message-history resolution passes share, built fresh per turn so a persona/card edit takes
// effect on the very next turn with no re-apply (bi_principles.md §13's live-read guarantee).
// Character fields (name/persona/scenario) are read live rather than trusted from whatever
// apply_prompt_stack_to_chat baked in at Apply time, same reasoning as household persona settings
// below. Callers gate on their text actually containing '{{' so this never runs for a macro-free
// turn — a wasted round-trip here is a real one (two reads per turn).
export async function buildMacroSnapshot(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  userId: string,
  characterId: string | null,
  cardId: string | null = null,
): Promise<MacroSnapshot> {
  const [source, persona] = await Promise.all([
    cardId
      ? db.withUserScope(userId, (session) =>
          session.query<{ name: string; persona: string; scenario: string }>(
            'select name, persona, scenario from cards where card_id = $1 and user_id = $2', [cardId, userId]),
        )
      : characterId
      ? db.withUserScope(userId, (session) =>
          session.query<{ name: string; persona: string; scenario: string }>(
            'select name, persona, scenario from characters where character_id = $1 and user_id = $2',
            [characterId, userId],
          ),
        )
      : Promise.resolve([]),
    getPersonaSettings(settings),
  ]);
  const characterRow = source[0];
  return {
    charName: characterRow?.name,
    userName: persona.name || undefined,
    persona: persona.description ? (persona.name ? `${persona.name}: ${persona.description}` : persona.description) : persona.name || undefined,
    description: characterRow?.persona || undefined,
    scenario: characterRow?.scenario || undefined,
  };
}

// docs/plans/prompt-macros.md's Stage 1 — only called when the caller already knows systemText contains
// at least one `{{`, so it always substitutes for real, never a wasted pass. The snapshot is
// built by the caller (buildMacroSnapshot) so a turn that also resolves message history reuses
// one frozen snapshot for both (docs §2's "resolved once, at the top of the turn").
export async function resolveMacrosInSystemPrompt(systemText: string, snapshot: MacroSnapshot): Promise<string> {
  return interpolateMacros(systemText, snapshot);
}

interface SlotDbRow {
  slot_type: string;
  marker_key: string | null;
  enabled: boolean;
  custom_role: string | null;
  custom_content: string | null;
  label: string | null;
  tag_enabled: boolean;
  group_name: string | null;
}

// PromptStackSlot already carries the cosmetic label column (migration 0060) and the tag toggle
// (migration 0085) — assembly needs both, so there is no separate "with label" type anymore; the
// prompt inspector below (buildNarratorStackItems) uses the same fields to label a slot the way
// PromptStacksView's own slotLabel() does.

interface NarratorCharacterFieldsRow {
  name: string;
  system_prompt: string;
  persona: string;
  scenario: string;
  example_dialogue: string;
}

// Shared by both per-turn narrator assembly and the cleanup pass below — the same
// context_stack_slots read applyPromptStackToChatTool.ts does, just usable from core without
// crossing the plugin/core dependency line (assemblePromptStack itself already lives in core,
// util/assemblePromptStack.ts, moved here 2026-08-06 for exactly this reason).
async function loadPromptStackSlots(db: PostgresClient, userId: string, presetId: string): Promise<PromptStackSlot[]> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<SlotDbRow>(
      `select slot_type, marker_key, enabled, custom_role, custom_content, label, tag_enabled, group_name
       from context_stack_slots where preset_id = $1 order by position`,
      [presetId],
    ),
  );
  return rows.map((row) => ({
    slotType: row.slot_type as 'marker' | 'custom',
    markerKey: row.marker_key ?? undefined,
    enabled: row.enabled,
    customRole: (row.custom_role as 'system' | 'user' | 'assistant' | null) ?? undefined,
    customContent: row.custom_content ?? undefined,
    label: row.label ?? undefined,
    tagEnabled: row.tag_enabled,
    groupName: row.group_name ?? undefined,
  }));
}

// docs/plans/turn-loop-plan.md §3.2: the per-turn replacement for apply_prompt_stack_to_chat's
// bake-once-at-Apply behavior. Same two-phase pattern that tool already uses (assemblePromptStack
// then interpolateMacros) — re-run fresh every turn instead of frozen into params.system. The RP
// memory split (2026-08-13 user direction): buildChatMemorySystemPrompt now returns structured
// parts (scene/events/plotThreads/chunks/facts) and each of the three component markers is
// rendered from its own user-editable template (io/chatMemory/memoryInjection.ts, CNZ-style
// {{var}}/{{#if}} interpolation) into a field the preset's own slot ordering places — so a preset
// can order `bridge`, `plot_threads` and `auto_recall` independently. The deprecated `memory_recall`
// alias still emits the fused legacy block (context.fused) for presets that haven't migrated,
// byte-identical to the pre-split behavior.
//
// canon_facts is deliberately left unset here even when a preset enables that slot:
// recall_canon_facts (plugins/canonize/src/recallCanonFactsTool.ts) scopes by scene_id via
// scene_presence/scenes.active_location_id. chat_sessions.scene_id now exists (migration 0067)
// and is kept stamped by the post-cleanup scraper (orchestrator/locationAndPresenceScraper.ts),
// so the cheap "this chat's current scene" read segway.md §2.2 promised is available here — and
// the location-tracker (docs/plans/vistalyze_integration/location.md §5.4) now uses it: the
// 'location' marker slot is populated every turn via loadLocationBlock (the known-locations
// <locations> block, eligibility-filtered + current-parent scoped), so a preset carrying that
// marker emits it verbatim in its own slot order. The tool stays live for the model to call
// mid-turn when it does have a scene_id.
// docs/bi_principles.md §17 ("every prompt is surfaced for manual tuning"): one labeled item per
// enabled, non-empty slot, in preset order — the same population assemblePromptStack itself would
// emit, just not yet collapsed into one joined string. Both assembleNarratorSystemText (the real
// per-turn call) and buildPromptPreview (the read-only inspector below) call this, so a preview
// can never drift from what a turn actually sends — there is exactly one place this assembly runs.
//
// recentHistoryMessages (the turn's trimmed live-window messages, or undefined for callers that
// don't have them) feeds the recent_history marker when that slot is enabled — the 2026-08-10 user
// direction: the active context (last sent turn + active turns) renders INSIDE the stack, wrapped
// by the preset's own HTML tags, and is NOT also appended as messages. The rendering is
// deterministic (formatRecentHistoryTurns) so an unchanged window produces
// identical bytes and the byte-prefix cache survives; the volatile block sits wherever the preset
// placed the slot, which is the author's cache-management control.
export async function buildNarratorStackItems(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  embeddings: EmbeddingProvider,
  userId: string,
  chatId: string,
  characterId: string | null,
  presetId: string,
  memoryContext: RpMemoryContext,
  recentHistoryMessages?: LlmMessage[],
  lorebookSeedMessageId?: string,
  cardId: string | null = null,
): Promise<{ items: PromptPreviewItem[]; lorebookActivatedEntryIds: string[] }> {
  const [slots, characterRows, persona, bridgeTemplate, plotTemplate, autoRecallTemplate, chunkTemplate, leadInTemplate, recentHistoryTemplate, syncSummariesTemplate, syncSummaryEntryTemplate, locationBlock, lorebookBlock] = await Promise.all([
    loadPromptStackSlots(db, userId, presetId),
    cardId
      ? db.withUserScope(userId, (session) =>
          session.query<NarratorCharacterFieldsRow>(
            'select name, system_prompt, persona, scenario, example_dialogue from cards where card_id = $1 and user_id = $2',
            [cardId, userId],
          ),
        )
      : characterId
      ? db.withUserScope(userId, (session) =>
          session.query<NarratorCharacterFieldsRow>(
            'select name, system_prompt, persona, scenario, example_dialogue from characters where character_id = $1 and user_id = $2',
            [characterId, userId],
          ),
        )
      : Promise.resolve([]),
    getPersonaSettings(settings),
    settings.get('chat_memory_inject_bridge_prompt'),
    settings.get('chat_memory_inject_plot_prompt'),
    settings.get('chat_memory_inject_auto_recall_prompt'),
    settings.get('chat_memory_auto_recall_chunk_prompt'),
    settings.get('chat_memory_auto_recall_lead_in_prompt'),
    settings.get('chat_memory_inject_recent_history_prompt'),
    // Sync-summaries component (docs/plans/completed/sync-summaries-plan.md Step 4) — the outer wrapper
    // and the per-entry bare-summary template, same live-read shape as the others. The chunk
    // template for INFLATED rows is the auto-recall chunk template already fetched above —
    // identical "what does a full recalled chunk look like" concept, so no fifth setting.
    settings.get('chat_memory_inject_sync_summaries_prompt'),
    settings.get('chat_memory_sync_summary_entry_prompt'),
    // location.md §5.4 — the known-locations block for the 'location' marker slot. Fail-open:
    // '' when disabled/empty, so an enabled slot with nothing to say emits nothing (the
    // assembler's non-empty filter drops it) — never an empty <locations> block in the prompt.
    loadLocationBlock({ db, settings }, userId, chatId),
    // docs/lorebook-plan.md §4/§7 — the lorebook slot text, resolved per-turn (recall → timed
    // state → gate → format, all fail-open inside resolveLorebook). Seeded deterministically by
    // the assistant message_id being generated, which only exists when the caller is actually
    // producing a turn — the inspector (no message being generated) passes the last assistant
    // message's id, or nothing for a chat that has never had one (slot simply omitted).
    lorebookSeedMessageId && recentHistoryMessages
      ? resolveLorebook({
          db,
          settings,
          embeddings,
          userId,
          chatId,
          characterId,
          queryText: buildAutoRecallQuery(recentHistoryMessages, AUTO_RECALL_PAIRS),
          assistantMessageId: lorebookSeedMessageId,
        })
      : Promise.resolve(undefined),
  ]);
  // The preset was deleted, or has no slots, since Apply — nothing to assemble against. Caller
  // falls back to formatCurrentDateContext alone rather than crashing the turn over stale config.
  if (slots.length === 0) return { items: [], lorebookActivatedEntryIds: [] };

  const character = characterRows[0];
  const personaText = persona.description
    ? persona.name
      ? `${persona.name}: ${persona.description}`
      : persona.description
    : persona.name || undefined;

  const fields: PromptStackFields = {
    system: character?.system_prompt || undefined,
    description: character?.persona || undefined,
    scenario: character?.scenario || undefined,
    mes_example: character?.example_dialogue || undefined,
    persona: personaText,
    // The three component markers — each rendered from its own template (CNZ-style {{var}}/{{#if}}),
    // empty when its component has no content so an enabled slot with nothing to say emits nothing.
    // Template settings follow the platform's "empty string = built-in default" contract (same as
    // the digest prompts: an empty override clears back to DEFAULT_*), so `|| undefined` — not
    // `?? undefined`, which would render an empty template and silently drop the marker.
    bridge: renderBridge(memoryContext.scene, memoryContext.events, bridgeTemplate || undefined) || undefined,
    plot_threads: renderPlotThreads(memoryContext.plotThreads, plotTemplate || undefined) || undefined,
    auto_recall:
      renderAutoRecall(
        memoryContext.chunks,
        memoryContext.facts,
        autoRecallTemplate || undefined,
        chunkTemplate || undefined,
        // Lead-in entries (docs/plans/chunk-lead-in-context-plan.md) render under their own
        // lighter template — `|| undefined` per the same empty-string-clears-to-default contract.
        leadInTemplate || undefined,
        character?.name,
      ) || undefined,
    // The sync_summaries component (docs/plans/completed/sync-summaries-plan.md) — every chunk under the
    // chat's open sync point, chronologically between bridge and recent_history. Bare rows
    // render through the entry template; a row RAG also selected (recallForPrompt.ts's inflate
    // merge) renders through the SAME chunk template as a normal auto-recall chunk, so it can
    // never appear twice across the two sections.
    sync_summaries:
      renderSyncSummaries(
        memoryContext.syncSummaries,
        syncSummariesTemplate || undefined,
        syncSummaryEntryTemplate || undefined,
        chunkTemplate || undefined,
        character?.name,
      ) || undefined,
    // The active context (2026-08-10 user direction): the live-window turns, last sent turn
    // included, rendered deterministically and placed wherever the preset ordered this slot —
    // inside the preset's own HTML wrapper tags when it authored them (e.g. Comfy 2's
    // <narrative_execution>). Empty window => undefined => the slot's non-empty filter drops it,
    // and the caller then keeps sending the window as plain messages (unchanged behavior).
    recent_history:
      recentHistoryMessages?.length
        ? renderRecentHistory(
            formatRecentHistoryTurns(recentHistoryMessages, character?.name ?? '', persona.name ?? ''),
            character?.name ?? '',
            persona.name ?? '',
            recentHistoryTemplate || undefined,
          ) || undefined
        : undefined,
    // location.md §5.4 — the known-locations block (known parents + the current parent's subs +
    // the TRG rules text), rendered by loadLocationBlock above. undefined when disabled/empty so
    // an enabled 'location' slot with nothing to say emits nothing.
    location: locationBlock.block || undefined,
    // Deprecated fused alias — presets that still carry a memory_recall slot get the legacy block.
    memory_recall: memoryContext.fused || undefined,
    // docs/lorebook-plan.md §7 — the dedicated lorebook slot, filled by resolveLorebook above.
    // undefined when mode is off, nothing activated, or the resolution failed (fail-open) — the
    // assembler's non-empty filter then drops the slot exactly as if it weren't in the preset.
    lorebook: lorebookBlock?.text || undefined,
  };

  const snapshot: MacroSnapshot = {
    charName: character?.name,
    userName: persona.name || undefined,
    persona: personaText,
    description: character?.persona || undefined,
    scenario: character?.scenario || undefined,
  };

  // Walks the same slots assemblePromptStack(fields, slots) would, in the same order, with the
  // same enabled/non-empty filter — kept as its own loop (rather than calling that pure function
  // and losing slot identity) purely so each emitted item can still carry the markerKey/label that
  // produced it. assemblePromptStack itself has no reason to know that; a display concern doesn't
  // belong in the platform's canonical prompt-assembly pure function.
  const items: PromptPreviewItem[] = [];
  const renderedIndices: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    if (!slot.enabled) continue;
    if (slot.slotType === 'custom') {
      if (!slot.customContent) continue;
      renderedIndices.push(i);
      items.push(toPreviewItem(slot.customRole ?? 'system', wrapSlotContent(interpolateMacros(slot.customContent, snapshot), slot), { label: slot.label }));
      continue;
    }
    const value = slot.markerKey ? fields[slot.markerKey as MarkerKey] : undefined;
    if (!value) continue;
    renderedIndices.push(i);
    items.push(toPreviewItem('system', wrapSlotContent(interpolateMacros(value, snapshot), slot), { markerKey: slot.markerKey, label: slot.label }));
  }
  // Migration 0086: same group-tag wrapping assemblePromptStack applies, so the real prompt and
  // the inspector can never drift — <Name> around the run's first rendered member, </Name> around
  // the last (groupTagsForRendered), outside the slot's own 0085 tags.
  const groupTags = groupTagsForRendered(slots, renderedIndices);
  for (let m = 0; m < items.length; m++) {
    const tags = groupTags.get(renderedIndices[m]!);
    if (!tags) continue;
    const { open, close } = tags;
    items[m] = {
      ...items[m]!,
      content: `${open ? `${open}\n` : ''}${items[m]!.content}${close ? `\n${close}` : ''}`,
    };
  }
  return { items, lorebookActivatedEntryIds: lorebookBlock?.activatedEntryIds ?? [] };
}

// Returns the joined system text plus whether the recent_history slot actually rendered this turn
// — when it did, the caller must NOT also append the live-window messages (they now live inside
// the stack; duplicating them would double the window's tokens and put a changed byte in the
// system block, defeating the cache prefix the user is managing).
async function assembleNarratorSystemText(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  embeddings: EmbeddingProvider,
  userId: string,
  chatId: string,
  characterId: string | null,
  cardId: string | null,
  presetId: string,
  memoryContext: RpMemoryContext,
  recentHistoryMessages?: LlmMessage[],
  lorebookSeedMessageId?: string,
): Promise<{ text: string; recentHistoryRendered: boolean; lorebookActivatedEntryIds: string[] }> {
  const { items, lorebookActivatedEntryIds } = await buildNarratorStackItems(db, settings, embeddings, userId, chatId, characterId, presetId, memoryContext, recentHistoryMessages, lorebookSeedMessageId, cardId);
  return {
    text: items.map((i) => i.content).join('\n\n'),
    recentHistoryRendered: items.some((i) => i.markerKey === 'recent_history'),
    lorebookActivatedEntryIds,
  };
}

// The other half: raw history older than the live window is never sent at all — only reachable via
// recall_chat_history. Same knob (chat_memory_live_window_pairs) orchestrator/src/orchestrator/
// chatMemorySync.ts's own sync pipeline uses for where the live window ends, read live so the two
// stay in agreement without coordinating a restart.
export async function trimToLiveWindow(messages: LlmMessage[], settings: OrchestratorSettingsStore): Promise<LlmMessage[]> {
  const raw = await settings.get('chat_memory_live_window_pairs');
  const pairs = raw ? Number(raw) : NaN;
  const liveMessages = (Number.isInteger(pairs) && pairs > 0 ? pairs : 8) * 2;
  return messages.length > liveMessages ? messages.slice(-liveMessages) : messages;
}

// Shared by handleChatCompletions and regenerateSwipe below — a persisted chat's system prompt
// assembly (memory digest + either per-turn narrator assembly or the legacy frozen params.system,
// macro-resolved for 'rp') is identical whichever of the two is producing the reply; only how the
// result gets persisted differs (append a new turn vs. recordSwipe in place).
export async function assembleSessionTurnContext(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  embeddings: EmbeddingProvider,
  userId: string,
  chatId: string,
  sessionKind: 'chat' | 'rp',
  sessionCharacterId: string | null,
  sessionCardId: string | null,
  sessionPromptStackPresetId: string | null,
  sessionParams: ChatParams,
  messagesForLlm: LlmMessage[],
  timezone: string,
  lorebookSeedMessageId?: string,
): Promise<{ systemPrompt: string; messagesForLlm: LlmMessage[]; lorebookActivatedEntryIds: string[] }> {
  const [memoryContext, trimmed] = await Promise.all([
    buildChatMemorySystemPrompt(db, settings, embeddings, userId, chatId, sessionKind, messagesForLlm),
    trimToLiveWindow(messagesForLlm, settings),
  ]);

  // docs/plans/prompt-macros.md's Stage 1, extended to message history: an RP chat's stored messages —
  // chiefly the character's seeded greeting, which apply_character_to_chat/apply_prompt_stack_to_chat
  // insert verbatim — can carry the same {{...}} tokens as its system text, and they'd otherwise
  // reach the LLM literally (and get echoed back into replies). Resolved here, at the same seam and
  // against the same frozen snapshot as the system text (docs §2: resolved once at the top of the
  // turn), never by rewriting the canonical message. Display-only resolution is a separate concern
  // served by GET /v1/chats/:id's resolvedContent (handleChatRoutes). Gated exactly like the
  // system pass below: 'rp' chats only (a 'chat'-kind session could legitimately discuss literal
  // `{{...}}`-looking text), and only when something actually contains '{{' — so a macro-free turn
  // pays for none of the reads.
  const systemNeedsMacros = sessionKind === 'rp' && !sessionPromptStackPresetId && !!sessionParams.system?.includes('{{');
  const historyNeedsMacros = sessionKind === 'rp' && trimmed.some((m) => m.content.includes('{{'));
  let macroSnapshot: MacroSnapshot | undefined;
  if (systemNeedsMacros || historyNeedsMacros) {
    macroSnapshot = await buildMacroSnapshot(db, settings, userId, sessionCharacterId, sessionCardId);
  }

  if (sessionKind === 'rp' && sessionPromptStackPresetId) {
    // Per-turn narrator assembly (docs/plans/turn-loop-plan.md §3.2): re-run assemblePromptStack fresh
    // every turn instead of replaying the frozen string apply_prompt_stack_to_chat baked once into
    // params.system at Apply-click — a character-card/persona/memory-digest edit takes effect on
    // the very next message, no re-apply needed. memory_recall is folded in as a field the preset's
    // own slot ordering places, not appended after the fact.
    // No formatCurrentDateContext here — unlike a 'chat'-kind session, an in-character narrator
    // has no business knowing the real-world wall-clock time unless the prompt stack itself surfaces
    // it (e.g. a scenario slot), so it's omitted for 'rp' rather than unconditionally prepended.
    // buildNarratorStackItems reads the character/persona once more for its own slot snapshot —
    // near-simultaneous with the turn-level buildMacroSnapshot above, so Stage 1's deterministic
    // lookups make the two byte-identical; a Stage 2 clock/RNG would want them merged into one.
    // recentHistoryRendered: the live-window turns (last sent turn included) moved INTO the stack
    // inside the preset's own tags (2026-08-10 user direction: "I do not want the messages
    // appended at the end"). When the slot rendered, the messages array is emptied — the stack
    // alone carries the context; the LLM adapters emit a single empty user message so providers
    // don't reject the request shape (the user's "send it as it is").
     const narrator = await assembleNarratorSystemText(db, settings, embeddings, userId, chatId, sessionCharacterId, sessionCardId, sessionPromptStackPresetId, memoryContext as RpMemoryContext, trimmed, lorebookSeedMessageId);
    return {
      systemPrompt: narrator.text,
      messagesForLlm: narrator.recentHistoryRendered ? [] : resolveMacrosInMessages(trimmed, historyNeedsMacros, macroSnapshot),
      // The activated entry ids ride up to the turn handler so it can append the
      // lorebook_activation_log rows after the turn completes (docs/lorebook-plan.md §3e/§4) —
      // the "write after, not during" shape that keeps sticky/cooldown resolvable next turn.
      lorebookActivatedEntryIds: narrator.lorebookActivatedEntryIds,
    };
  }

  // No applied preset — a 'chat'-kind chat, or an 'rp' chat that's never been through Apply:
  // unchanged legacy behavior, the frozen params.system, macro-resolved if 'rp'. Date context still
  // applies to 'chat'-kind sessions (household assistant use), just not 'rp' ones (see above).
  let system = sessionParams.system;
  if (sessionKind === 'rp' && system?.includes('{{') && macroSnapshot) {
    system = await resolveMacrosInSystemPrompt(system, macroSnapshot);
  }
  const dateContext = sessionKind === 'rp' ? undefined : formatCurrentDateContext(timezone);
  // The no-preset fallback gets the fused string either way: a 'chat' lane returns it directly,
  // an 'rp' lane returns the structured context whose .fused is the legacy block.
  const memoryText = typeof memoryContext === 'string' ? memoryContext : memoryContext.fused;
  return {
    systemPrompt: [dateContext, system, memoryText].filter(Boolean).join('\n\n'),
    messagesForLlm: resolveMacrosInMessages(trimmed, historyNeedsMacros, macroSnapshot),
    // No lorebook slot in the legacy path — resolveLorebook only runs through the preset branch.
    lorebookActivatedEntryIds: [],
  };
}

// The message-history half of the turn-scoped resolution pass above (and the Prompt Inspector's
// live fallback): substitute the turn's snapshot into every message whose text actually contains
// '{{', returning the original array untouched when nothing needs it. Per-message `includes('{{')`
// skips the regex for macro-free history; the array itself is never rewritten — new objects only
// for the messages that change, so callers holding the originals (chat persistence, the canon
// anchor) keep seeing verbatim content.
export function resolveMacrosInMessages(messages: LlmMessage[], needsMacros: boolean, snapshot: MacroSnapshot | undefined): LlmMessage[] {
  if (!needsMacros || !snapshot) return messages;
  return messages.map((m) => (m.content.includes('{{') ? { ...m, content: interpolateMacros(m.content, snapshot) } : m));
}

// Display-only single-message twin of handleChatRoutes' GET /v1/chats/:id decoration: the swipe
// routes return one StoredChatMessage (a stored alternate greeting, or a regenerated reply) that
// the client swaps into view in place, so it carries the same derived resolvedContent contract —
// canonical content untouched, display copy resolved against the live persona.
export async function decorateMessageForDisplay(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  userId: string,
  session: Pick<ChatSessionRow, 'kind' | 'characterId' | 'cardId'>,
  message: StoredChatMessage,
): Promise<StoredChatMessage> {
  if (session.kind !== 'rp' || !message.content.includes('{{')) return message;
  const snapshot = await buildMacroSnapshot(db, settings, userId, session.characterId, session.cardId);
  return { ...message, resolvedContent: interpolateMacros(message.content, snapshot) };
}
