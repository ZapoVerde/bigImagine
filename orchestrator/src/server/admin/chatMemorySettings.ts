/**
 * @file orchestrator/src/server/admin/chatMemorySettings.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (settings-store IO) — the
 * public chat-memory admin surface, composed from the three fault-line slices it was split into
 * (admin/chatMemorySyncSettings.ts, admin/chatMemoryRecallSettings.ts, admin/chatMemoryPromptSettings.ts);
 * behaviour, wire keys, defaults, and public names preserved exactly from the pre-split adminServer.ts
 * @description
 * The chat-memory admin surface's stable public API — one get/parse/set trio over the whole
 * settings group. The original single 410-line block substantially exceeded the 300-line budget,
 * so the implementation was decomposed along the plan's genuine fault lines (sync pipeline /
 * read-path recall / prompts); this module recomposes those three slices into the unchanged
 * public shapes, so existing callers of ChatMemorySettings/getChatMemorySettings/
 * parseSetChatMemorySettingsBody/setChatMemorySettings see no difference.
 *
 * @api-declaration
 * getChatMemorySettings(store) — the full ChatMemorySettings read (all 44 fields), each defaulting
 *   when unset, read live on every sync tick / RP prompt assembly (no restart)
 * parseSetChatMemorySettingsBody(raw) — validates the full snake_case patch body, at least one of
 *   the 29 wire keys present; undefined on any malformed shape or an empty body. Validation is
 *   atomic across the three composed groups — a body spanning more than one group with even one
 *   invalid field anywhere is rejected whole, same as the pre-split single parser
 * setChatMemorySettings(store, body) — upserts whichever of the 29 fields the body names
 *
 * @contract
 *   assertions:
 *     purity:          parseSetChatMemorySettingsBody is pure; the rest are impure (Postgres IO via
 *                      the injected settings store)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected OrchestratorSettingsStore)]
 */

import type { OrchestratorSettingsStore } from '../../io/orchestratorSettings.js';
import {
  getChatMemorySyncSettings,
  hasChatMemorySyncFields,
  parseSetChatMemorySyncSettingsBody,
  setChatMemorySyncSettings,
} from './chatMemorySyncSettings.js';
import {
  getChatMemoryRecallSettings,
  hasChatMemoryRecallFields,
  parseSetChatMemoryRecallSettingsBody,
  setChatMemoryRecallSettings,
} from './chatMemoryRecallSettings.js';
import {
  getChatMemoryPromptSettings,
  hasChatMemoryPromptFields,
  parseSetChatMemoryPromptSettingsBody,
  setChatMemoryPromptSettings,
} from './chatMemoryPromptSettings.js';

// --- Chat memory settings (docs/chat-memory.md) ---
// Mirrors SillyTavern-Canonize's own "Connections & Prompts" settings panel: a connection override
// for the rolling-sync pipeline's classification calls (unset = the household's active connection,
// same fallback shape as a chat's own params.profile), three timing knobs in turn-pairs (live
// window, sync-every, and digest-horizon — the last mirroring Canonize's own bridge-summary
// horizon), and a "default + bespoke" override per prompt. Read live on every sync tick
// (orchestrator/src/orchestrator/chatMemorySync.ts) — a save here takes effect on the next tick,
// no restart, same shape as notification settings above. profileNames isn't included here —
// httpServer.ts's route handler attaches it from deps.llmConnections.list(), same split as the
// Connections tab's own listing route.

export interface ChatMemorySettings {
  profile: string | null;
  liveWindowPairs: number | null;
  syncEveryPairs: number | null;
  digestHorizonPairs: number | null;
  // Chunk size in turn-pairs (migration 0099, docs/plans/completed/chunk-size-resize-plan.md) — read live
  // by the sync tick, the eager path, the recall decay SQL, and the admin-triggered re-chunk
  // backfill (orchestrator/chatChunkResize.ts). null = unset (built-in default of 2 pairs = the
  // classic 4-message chunk); a saved value only affects NEW chunks — existing archives keep
  // their old size until the resize backfill re-chunks them.
  chunkPairs: number | null;
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
  // Lead-in window (migration 0100, docs/plans/chunk-lead-in-context-plan.md) — how many
  // preceding chunks' summaries ride along with each recalled chunk (recallForPrompt.ts merges
  // them before injection; 0 disables; null = unset, built-in default 2, capped at 3), plus the
  // per-entry template those summaries render under in the narrator stack (empty string = the
  // built-in '[Just before: {{text}}]', same default+bespoke shape as the other prompt fields).
  autoRecallLeadInChunks: number | null;
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
  // RP read-path retrieval knobs (migration 0077, io/chatMemory/recallForPrompt.ts) — read live
  // on every RP prompt assembly, no restart. null = unset (use the built-in default).
  autoRecallEnabled: boolean;
  autoRecallPairs: number | null;
  autoRecallChunkTopK: number | null;
  // RAG dynamic-cutoff knobs (migration 0091, io/chatMemory/recallCutoff.ts —
  // docs/plans/completed/rag-dynamic-cutoff-plan.md, Stage 1 of the CNZ retrieval port) — read live on
  // every RP prompt assembly alongside the 0077 trio, no restart. autoRecallChunkTopK above is
  // the **Max** ceiling the cutoff clamps to; these three are the Min floor, the Pool Multiple P
  // (candidate pool = P × Max, min 6), and the strictness mode in raw-distance space where lower
  // is better. null = unset (use the built-in default).
  autoRecallMin: number | null;
  autoRecallPoolMultiple: number | null;
  autoRecallCutoffMode: 'mean' | 'mean+1sd' | 'mean+2sd' | null;
  // Ranked plot-arc lane knobs (migration 0097, io/chatMemory/recallPlotLane.ts —
  // docs/plans/plot-arc-recall-plan.md) — read live on every RP prompt assembly alongside the
  // others, no restart. plotRecallTopK is the **Max** ceiling for per-arc cards (default 6,
  // fewer than the fact lane's 8 since each card is multi-entry), plotRecallMin is the Min
  // floor (default 1), plotRecallFloorSyncs is the recency floor (default 2: an arc touched in
  // the chat's last N sync ticks stays visible regardless of score). The 0091 Pool Multiple /
  // Cutoff Mode are shared with the plot lane unchanged. null = unset (use the built-in default).
  plotRecallTopK: number | null;
  plotRecallMin: number | null;
  plotRecallFloorSyncs: number | null;
}

export async function getChatMemorySettings(store: OrchestratorSettingsStore): Promise<ChatMemorySettings> {
  const [sync, recall, prompts] = await Promise.all([
    getChatMemorySyncSettings(store),
    getChatMemoryRecallSettings(store),
    getChatMemoryPromptSettings(store),
  ]);
  return { ...sync, ...recall, ...prompts };
}

export interface SetChatMemorySettingsBody {
  profile?: string;
  liveWindowPairs?: number;
  syncEveryPairs?: number;
  digestHorizonPairs?: number;
  chunkPairs?: number;
  chunkSummaryPrompt?: string;
  distillPrompt?: string;
  bridgePrompt?: string;
  worldCuratorPrompt?: string;
  peopleCuratorPrompt?: string;
  autoRecallEnabled?: boolean;
  autoRecallPairs?: number;
  autoRecallChunkTopK?: number;
  autoRecallMin?: number;
  autoRecallPoolMultiple?: number;
  autoRecallCutoffMode?: string;
  plotRecallTopK?: number;
  plotRecallMin?: number;
  plotRecallFloorSyncs?: number;
  injectBridgePrompt?: string;
  injectPlotPrompt?: string;
  injectAutoRecallPrompt?: string;
  injectRecentHistoryPrompt?: string;
  autoRecallChunkPrompt?: string;
  /** Lead-in window: 0 disables (recallForPrompt.ts skips the walk), 1–3 = how many preceding
   *  chunks' summaries ride along. Negative rejects. */
  autoRecallLeadInChunks?: number;
  autoRecallLeadInPrompt?: string;
  /** Sync-summaries component (migration 0104): the outer wrapper and the per-entry bare-
   *  summary template. Empty string on either clears back to its built-in default. */
  injectSyncSummariesPrompt?: string;
  syncSummaryEntryPrompt?: string;
}

// Every field is optional and independently settable; an empty string on any prompt field clears
// the override back to its built-in default (there is no separate "reset" endpoint — see
// io/orchestratorSettings.ts's own doc on this). Wire keys are snake_case, same convention as
// every other parseSet*Body in this file. Validation is atomic across all three fault-line groups,
// same as the pre-split single parser: a hasX check tells "this group has no keys in the body"
// (fine — other groups may still apply) apart from "this group's keys are present but fail its own
// validation" (invalidates the whole body, even if the other groups would otherwise be valid) —
// without that distinction, a body mixing a valid field from one group with an invalid field from
// another would silently save the valid group and drop the invalid one instead of rejecting the
// whole request. An empty body (no key in any group) is undefined.
export function parseSetChatMemorySettingsBody(raw: unknown): SetChatMemorySettingsBody | undefined {
  const hasSync = hasChatMemorySyncFields(raw);
  const hasRecall = hasChatMemoryRecallFields(raw);
  const hasPrompts = hasChatMemoryPromptFields(raw);
  if (!hasSync && !hasRecall && !hasPrompts) return undefined;
  const sync = parseSetChatMemorySyncSettingsBody(raw);
  const recall = parseSetChatMemoryRecallSettingsBody(raw);
  const prompts = parseSetChatMemoryPromptSettingsBody(raw);
  if ((hasSync && !sync) || (hasRecall && !recall) || (hasPrompts && !prompts)) return undefined;
  return {
    ...(sync ?? {}),
    ...(recall ?? {}),
    ...(prompts ?? {}),
  };
}

export async function setChatMemorySettings(store: OrchestratorSettingsStore, body: SetChatMemorySettingsBody): Promise<void> {
  await setChatMemorySyncSettings(store, body);
  await setChatMemoryRecallSettings(store, body);
  await setChatMemoryPromptSettings(store, body);
}
