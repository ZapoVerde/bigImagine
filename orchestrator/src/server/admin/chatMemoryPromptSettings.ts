/**
 * @file orchestrator/src/server/admin/chatMemoryPromptSettings.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (settings-store IO) — one of
 * the three fault-line slices the chat-memory admin block was split into (admin/chatMemorySettings.ts
 * composes the full public API from these); behaviour, wire keys, defaults, and public names
 * preserved from the pre-split adminServer.ts
 * @description
 * The prompt half of the chat-memory settings — every "default + bespoke" prompt override for the
 * digest pipeline and the RP read-path injection wrappers: chunk summary, distillation, household/
 * world/people curator, bridge, the inject_* component wrappers, auto-recall chunk + lead-in, and
 * the sync-summaries pair. Empty string = built-in default, the same contract as every other
 * prompt field (bi_principles.md §17 — there is no separate reset endpoint).
 *
 * @api-declaration
 * getChatMemoryPromptSettings(store) — the full prompt set with an IsDefault flag per field,
 *   each defaulting to its built-in when unset
 * parseSetChatMemoryPromptSettingsBody(raw) — validates { chunk_summary_prompt?, distill_prompt?,
 *   bridge_prompt?, world_curator_prompt?, people_curator_prompt?,
 *   inject_bridge_prompt?, inject_plot_prompt?, inject_auto_recall_prompt?,
 *   inject_recent_history_prompt?, auto_recall_chunk_prompt?, auto_recall_lead_in_prompt?,
 *   inject_sync_summaries_prompt?, sync_summary_entry_prompt? }, at least one present; undefined on
 *   any malformed shape
 * hasChatMemoryPromptFields(raw) — true iff raw carries any of this group's own wire keys; lets the
 *   composing parser (admin/chatMemorySettings.ts) tell "this group was absent" apart from "this
 *   group was present but invalid" for atomic whole-body validation
 * setChatMemoryPromptSettings(store, body) — upserts whichever fields the body names
 *
 * @contract
 *   assertions:
 *     purity:          parseSetChatMemoryPromptSettingsBody is pure; the rest are impure (Postgres
 *                      IO via the injected settings store)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected OrchestratorSettingsStore)]
 */

import type { OrchestratorSettingsStore } from '../../io/orchestratorSettings.js';
import { DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT } from '../../io/chatMemory/classifyChatChunk.js';
import { DEFAULT_DISTILL_CHAT_MEMORY_PROMPT } from '../../io/chatMemory/distillChatMemory.js';
import { DEFAULT_BRIDGE_PROMPT } from '../../io/chatMemory/bridgeChatMemory.js';
import { DEFAULT_WORLD_MEMORY_CURATOR_PROMPT } from '../../io/chatMemory/curateWorldMemory.js';
import { DEFAULT_PEOPLE_CURATOR_PROMPT } from '../../io/chatMemory/curatePeople.js';
import {
  DEFAULT_INJECT_BRIDGE_PROMPT,
  DEFAULT_INJECT_PLOT_PROMPT,
  DEFAULT_INJECT_AUTO_RECALL_PROMPT,
  DEFAULT_AUTO_RECALL_CHUNK_PROMPT,
  DEFAULT_AUTO_RECALL_LEAD_IN_PROMPT,
  DEFAULT_INJECT_RECENT_HISTORY_PROMPT,
  DEFAULT_INJECT_SYNC_SUMMARIES_PROMPT,
  DEFAULT_SYNC_SUMMARY_ENTRY_PROMPT,
} from '../../io/chatMemory/memoryInjection.js';

// The "default + bespoke" prompt overrides behind the chat-memory admin surface: empty string =
// built-in default, the same contract as every other prompt field (bi_principles.md §17).
export interface ChatMemoryPromptSettings {
  chunkSummaryPrompt: string;
  chunkSummaryPromptIsDefault: boolean;
  distillPrompt: string;
  distillPromptIsDefault: boolean;
  bridgePrompt: string;
  bridgePromptIsDefault: boolean;
  worldCuratorPrompt: string;
  worldCuratorPromptIsDefault: boolean;
  peopleCuratorPrompt: string;
  peopleCuratorPromptIsDefault: boolean;
  // RP read-path injection templates (2026-08-13 component split, io/chatMemory/memoryInjection.ts)
  // — the per-component prompt wrappers rendered by the narrator stack for the bridge /
  // plot_threads / auto_recall markers. Same "default + bespoke" shape as the digest prompts
  // above: empty string = built-in CNZ-shaped default.
  injectBridgePrompt: string;
  injectBridgePromptIsDefault: boolean;
  injectPlotPrompt: string;
  injectPlotPromptIsDefault: boolean;
  injectAutoRecallPrompt: string;
  injectAutoRecallPromptIsDefault: boolean;
  injectRecentHistoryPrompt: string;
  injectRecentHistoryPromptIsDefault: boolean;
  autoRecallChunkPrompt: string;
  autoRecallChunkPromptIsDefault: boolean;
  // Lead-in per-entry template (migration 0100, docs/plans/chunk-lead-in-context-plan.md) — the
  // template those summaries render under in the narrator stack (empty string = the built-in
  // '[Just before: {{text}}]', same default+bespoke shape as the other prompt fields).
  autoRecallLeadInPrompt: string;
  autoRecallLeadInPromptIsDefault: boolean;
  // Sync-summaries component (migration 0104, docs/plans/completed/sync-summaries-plan.md) — the
  // unconditional open-sync-point section between bridge and recent_history: the outer wrapper
  // (mirrors injectAutoRecallPrompt's shape) and the per-entry bare-summary template (its own
  // setting — lead-ins stay reserved for auto_recall's deep-archive picks). Empty string =
  // built-in default, same contract as the other prompt fields.
  injectSyncSummariesPrompt: string;
  injectSyncSummariesPromptIsDefault: boolean;
  syncSummaryEntryPrompt: string;
  syncSummaryEntryPromptIsDefault: boolean;
}

export async function getChatMemoryPromptSettings(store: OrchestratorSettingsStore): Promise<ChatMemoryPromptSettings> {
  const [
    chunkSummaryPrompt,
    distillPrompt,
    bridgePrompt,
    worldCuratorPrompt,
    peopleCuratorPrompt,
    injectBridgePrompt,
    injectPlotPrompt,
    injectAutoRecallPrompt,
    injectRecentHistoryPrompt,
    autoRecallChunkPrompt,
    autoRecallLeadInPrompt,
    injectSyncSummariesPrompt,
    syncSummaryEntryPrompt,
  ] = await Promise.all([
    store.get('chat_memory_chunk_summary_prompt'),
    store.get('chat_memory_distill_prompt'),
    store.get('chat_memory_bridge_prompt'),
    store.get('chat_memory_world_curator_prompt'),
    store.get('chat_memory_people_curator_prompt'),
    store.get('chat_memory_inject_bridge_prompt'),
    store.get('chat_memory_inject_plot_prompt'),
    store.get('chat_memory_inject_auto_recall_prompt'),
    store.get('chat_memory_inject_recent_history_prompt'),
    store.get('chat_memory_auto_recall_chunk_prompt'),
    store.get('chat_memory_auto_recall_lead_in_prompt'),
    store.get('chat_memory_inject_sync_summaries_prompt'),
    store.get('chat_memory_sync_summary_entry_prompt'),
  ]);
  return {
    chunkSummaryPrompt: chunkSummaryPrompt || DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT,
    chunkSummaryPromptIsDefault: !chunkSummaryPrompt,
    distillPrompt: distillPrompt || DEFAULT_DISTILL_CHAT_MEMORY_PROMPT,
    distillPromptIsDefault: !distillPrompt,
    bridgePrompt: bridgePrompt || DEFAULT_BRIDGE_PROMPT,
    bridgePromptIsDefault: !bridgePrompt,
    worldCuratorPrompt: worldCuratorPrompt || DEFAULT_WORLD_MEMORY_CURATOR_PROMPT,
    worldCuratorPromptIsDefault: !worldCuratorPrompt,
    peopleCuratorPrompt: peopleCuratorPrompt || DEFAULT_PEOPLE_CURATOR_PROMPT,
    peopleCuratorPromptIsDefault: !peopleCuratorPrompt,
    injectBridgePrompt: injectBridgePrompt || DEFAULT_INJECT_BRIDGE_PROMPT,
    injectBridgePromptIsDefault: !injectBridgePrompt,
    injectPlotPrompt: injectPlotPrompt || DEFAULT_INJECT_PLOT_PROMPT,
    injectPlotPromptIsDefault: !injectPlotPrompt,
    injectAutoRecallPrompt: injectAutoRecallPrompt || DEFAULT_INJECT_AUTO_RECALL_PROMPT,
    injectAutoRecallPromptIsDefault: !injectAutoRecallPrompt,
    injectRecentHistoryPrompt: injectRecentHistoryPrompt || DEFAULT_INJECT_RECENT_HISTORY_PROMPT,
    injectRecentHistoryPromptIsDefault: !injectRecentHistoryPrompt,
    autoRecallChunkPrompt: autoRecallChunkPrompt || DEFAULT_AUTO_RECALL_CHUNK_PROMPT,
    autoRecallChunkPromptIsDefault: !autoRecallChunkPrompt,
    autoRecallLeadInPrompt: autoRecallLeadInPrompt || DEFAULT_AUTO_RECALL_LEAD_IN_PROMPT,
    autoRecallLeadInPromptIsDefault: !autoRecallLeadInPrompt,
    injectSyncSummariesPrompt: injectSyncSummariesPrompt || DEFAULT_INJECT_SYNC_SUMMARIES_PROMPT,
    injectSyncSummariesPromptIsDefault: !injectSyncSummariesPrompt,
    syncSummaryEntryPrompt: syncSummaryEntryPrompt || DEFAULT_SYNC_SUMMARY_ENTRY_PROMPT,
    syncSummaryEntryPromptIsDefault: !syncSummaryEntryPrompt,
  };
}

export interface SetChatMemoryPromptSettingsBody {
  chunkSummaryPrompt?: string;
  distillPrompt?: string;
  bridgePrompt?: string;
  worldCuratorPrompt?: string;
  peopleCuratorPrompt?: string;
  injectBridgePrompt?: string;
  injectPlotPrompt?: string;
  injectAutoRecallPrompt?: string;
  injectRecentHistoryPrompt?: string;
  autoRecallChunkPrompt?: string;
  autoRecallLeadInPrompt?: string;
  /** Sync-summaries component (migration 0104): the outer wrapper and the per-entry bare-
   *  summary template. Empty string on either clears back to its built-in default. */
  injectSyncSummariesPrompt?: string;
  syncSummaryEntryPrompt?: string;
}

// Every field is optional and independently settable; an empty string on any prompt field clears
// the override back to its built-in default (there is no separate "reset" endpoint — see
// io/orchestratorSettings.ts's own doc on this). Wire keys are snake_case, same convention as
// every other parseSet*Body in this file.
export function parseSetChatMemoryPromptSettingsBody(raw: unknown): SetChatMemoryPromptSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const {
    chunk_summary_prompt,
    distill_prompt,
    bridge_prompt,
    world_curator_prompt,
    people_curator_prompt,
    inject_bridge_prompt,
    inject_plot_prompt,
    inject_auto_recall_prompt,
    inject_recent_history_prompt,
    auto_recall_chunk_prompt,
    auto_recall_lead_in_prompt,
    inject_sync_summaries_prompt,
    sync_summary_entry_prompt,
  } = raw as Record<string, unknown>;
  if (
    chunk_summary_prompt === undefined &&
    distill_prompt === undefined &&
    bridge_prompt === undefined &&
    world_curator_prompt === undefined &&
    people_curator_prompt === undefined &&
    inject_bridge_prompt === undefined &&
    inject_plot_prompt === undefined &&
    inject_auto_recall_prompt === undefined &&
    inject_recent_history_prompt === undefined &&
    auto_recall_chunk_prompt === undefined &&
    auto_recall_lead_in_prompt === undefined &&
    inject_sync_summaries_prompt === undefined &&
    sync_summary_entry_prompt === undefined
  ) {
    return undefined;
  }
  if (chunk_summary_prompt !== undefined && typeof chunk_summary_prompt !== 'string') return undefined;
  if (distill_prompt !== undefined && typeof distill_prompt !== 'string') return undefined;
  if (bridge_prompt !== undefined && typeof bridge_prompt !== 'string') return undefined;
  if (world_curator_prompt !== undefined && typeof world_curator_prompt !== 'string') return undefined;
  if (people_curator_prompt !== undefined && typeof people_curator_prompt !== 'string') return undefined;
  if (inject_bridge_prompt !== undefined && typeof inject_bridge_prompt !== 'string') return undefined;
  if (inject_plot_prompt !== undefined && typeof inject_plot_prompt !== 'string') return undefined;
  if (inject_auto_recall_prompt !== undefined && typeof inject_auto_recall_prompt !== 'string') return undefined;
  if (inject_recent_history_prompt !== undefined && typeof inject_recent_history_prompt !== 'string') return undefined;
  if (auto_recall_chunk_prompt !== undefined && typeof auto_recall_chunk_prompt !== 'string') return undefined;
  if (auto_recall_lead_in_prompt !== undefined && typeof auto_recall_lead_in_prompt !== 'string') return undefined;
  if (inject_sync_summaries_prompt !== undefined && typeof inject_sync_summaries_prompt !== 'string') return undefined;
  if (sync_summary_entry_prompt !== undefined && typeof sync_summary_entry_prompt !== 'string') return undefined;
  return {
    chunkSummaryPrompt: chunk_summary_prompt as string | undefined,
    distillPrompt: distill_prompt as string | undefined,
    bridgePrompt: bridge_prompt as string | undefined,
    worldCuratorPrompt: world_curator_prompt as string | undefined,
    peopleCuratorPrompt: people_curator_prompt as string | undefined,
    injectBridgePrompt: inject_bridge_prompt as string | undefined,
    injectPlotPrompt: inject_plot_prompt as string | undefined,
    injectAutoRecallPrompt: inject_auto_recall_prompt as string | undefined,
    injectRecentHistoryPrompt: inject_recent_history_prompt as string | undefined,
    autoRecallChunkPrompt: auto_recall_chunk_prompt as string | undefined,
    autoRecallLeadInPrompt: auto_recall_lead_in_prompt as string | undefined,
    injectSyncSummariesPrompt: inject_sync_summaries_prompt as string | undefined,
    syncSummaryEntryPrompt: sync_summary_entry_prompt as string | undefined,
  };
}

// Presence check only — no validation. Lets the composing parser distinguish "this group has no
// keys in the body" (fine, other groups may still apply) from "this group's keys are present but
// fail its own validation" (must invalidate the whole body, same as the pre-split parser).
const PROMPT_WIRE_KEYS = [
  'chunk_summary_prompt',
  'distill_prompt',
  'bridge_prompt',
  'world_curator_prompt',
  'people_curator_prompt',
  'inject_bridge_prompt',
  'inject_plot_prompt',
  'inject_auto_recall_prompt',
  'inject_recent_history_prompt',
  'auto_recall_chunk_prompt',
  'auto_recall_lead_in_prompt',
  'inject_sync_summaries_prompt',
  'sync_summary_entry_prompt',
] as const;

export function hasChatMemoryPromptFields(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return PROMPT_WIRE_KEYS.some((key) => obj[key] !== undefined);
}

export async function setChatMemoryPromptSettings(store: OrchestratorSettingsStore, body: SetChatMemoryPromptSettingsBody): Promise<void> {
  if (body.chunkSummaryPrompt !== undefined) await store.set('chat_memory_chunk_summary_prompt', body.chunkSummaryPrompt);
  if (body.distillPrompt !== undefined) await store.set('chat_memory_distill_prompt', body.distillPrompt);
  if (body.bridgePrompt !== undefined) await store.set('chat_memory_bridge_prompt', body.bridgePrompt);
  if (body.worldCuratorPrompt !== undefined) await store.set('chat_memory_world_curator_prompt', body.worldCuratorPrompt);
  if (body.peopleCuratorPrompt !== undefined) await store.set('chat_memory_people_curator_prompt', body.peopleCuratorPrompt);
  if (body.injectBridgePrompt !== undefined) await store.set('chat_memory_inject_bridge_prompt', body.injectBridgePrompt);
  if (body.injectPlotPrompt !== undefined) await store.set('chat_memory_inject_plot_prompt', body.injectPlotPrompt);
  if (body.injectAutoRecallPrompt !== undefined) await store.set('chat_memory_inject_auto_recall_prompt', body.injectAutoRecallPrompt);
  if (body.injectRecentHistoryPrompt !== undefined) await store.set('chat_memory_inject_recent_history_prompt', body.injectRecentHistoryPrompt);
  if (body.autoRecallChunkPrompt !== undefined) await store.set('chat_memory_auto_recall_chunk_prompt', body.autoRecallChunkPrompt);
  if (body.autoRecallLeadInPrompt !== undefined) await store.set('chat_memory_auto_recall_lead_in_prompt', body.autoRecallLeadInPrompt);
  if (body.injectSyncSummariesPrompt !== undefined) await store.set('chat_memory_inject_sync_summaries_prompt', body.injectSyncSummariesPrompt);
  if (body.syncSummaryEntryPrompt !== undefined) await store.set('chat_memory_sync_summary_entry_prompt', body.syncSummaryEntryPrompt);
}
