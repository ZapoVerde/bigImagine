/**
 * @file orchestrator/src/server/admin/chatMemoryRecallSettings.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (settings-store IO) — one of
 * the three fault-line slices the chat-memory admin block was split into (admin/chatMemorySettings.ts
 * composes the full public API from these); behaviour, wire keys, defaults, and public names
 * preserved from the pre-split adminServer.ts
 * @description
 * The read-path retrieval half of the chat-memory settings: the auto-recall trio (enabled /
 * pairs / chunk top-K), the RAG dynamic-cutoff knobs (min floor, pool multiple, strictness mode),
 * the ranked plot-arc lane knobs (top-K ceiling, min floor, recency floor), and the lead-in
 * window. All are read live on every RP prompt assembly, no restart; null = unset (built-in
 * default).
 *
 * @api-declaration
 * getChatMemoryRecallSettings(store) — { autoRecallEnabled, autoRecallPairs, autoRecallChunkTopK,
 *   autoRecallMin, autoRecallPoolMultiple, autoRecallCutoffMode, plotRecallTopK, plotRecallMin,
 *   plotRecallFloorSyncs, autoRecallLeadInChunks }
 * parseSetChatMemoryRecallSettingsBody(raw) — validates { auto_recall_enabled?,
 *   auto_recall_pairs?, auto_recall_chunk_top_k?, auto_recall_chunk_min?, auto_recall_pool_multiple?,
 *   auto_recall_cutoff_mode?, plot_recall_top_k?, plot_recall_min?, plot_recall_floor_syncs?,
 *   auto_recall_lead_in_chunks? }, at least one present; undefined on any malformed shape
 * hasChatMemoryRecallFields(raw) — true iff raw carries any of this group's own wire keys; lets the
 *   composing parser (admin/chatMemorySettings.ts) tell "this group was absent" apart from "this
 *   group was present but invalid" for atomic whole-body validation
 * setChatMemoryRecallSettings(store, body) — upserts whichever fields the body names
 *
 * @contract
 *   assertions:
 *     purity:          parseSetChatMemoryRecallSettingsBody is pure; the rest are impure (Postgres
 *                      IO via the injected settings store)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected OrchestratorSettingsStore)]
 */

import type { OrchestratorSettingsStore } from '../../io/orchestratorSettings.js';

// RP read-path retrieval knobs (migration 0077, io/chatMemory/recallForPrompt.ts) — read live on
// every RP prompt assembly, no restart. null = unset (use the built-in default).
// RAG dynamic-cutoff knobs (migration 0091, io/chatMemory/recallCutoff.ts —
// docs/plans/completed/rag-dynamic-cutoff-plan.md, Stage 1 of the CNZ retrieval port) — read live on
// every RP prompt assembly alongside the 0077 trio, no restart. autoRecallChunkTopK is the
// **Max** ceiling the cutoff clamps to; these three are the Min floor, the Pool Multiple P
// (candidate pool = P × Max, min 6), and the strictness mode in raw-distance space where lower
// is better. null = unset (use the built-in default).
// Ranked plot-arc lane knobs (migration 0097, io/chatMemory/recallPlotLane.ts —
// docs/plans/plot-arc-recall-plan.md) — read live on every RP prompt assembly alongside the
// others, no restart. plotRecallTopK is the **Max** ceiling for per-arc cards (default 6,
// fewer than the fact lane's 8 since each card is multi-entry), plotRecallMin is the Min
// floor (default 1), plotRecallFloorSyncs is the recency floor (default 2: an arc touched in
// the chat's last N sync ticks stays visible regardless of score). The 0091 Pool Multiple /
// Cutoff Mode are shared with the plot lane unchanged. null = unset (use the built-in default).

export interface ChatMemoryRecallSettings {
  autoRecallEnabled: boolean;
  autoRecallPairs: number | null;
  autoRecallChunkTopK: number | null;
  autoRecallMin: number | null;
  autoRecallPoolMultiple: number | null;
  autoRecallCutoffMode: 'mean' | 'mean+1sd' | 'mean+2sd' | null;
  plotRecallTopK: number | null;
  plotRecallMin: number | null;
  plotRecallFloorSyncs: number | null;
  // Lead-in window (migration 0100, docs/plans/chunk-lead-in-context-plan.md) — how many
  // preceding chunks' summaries ride along with each recalled chunk (recallForPrompt.ts merges
  // them before injection; 0 disables; null = unset, built-in default 2, capped at 3).
  autoRecallLeadInChunks: number | null;
}

export async function getChatMemoryRecallSettings(store: OrchestratorSettingsStore): Promise<ChatMemoryRecallSettings> {
  const [
    autoRecallEnabledRaw,
    autoRecallPairsRaw,
    autoRecallChunkTopKRaw,
    autoRecallChunkMinRaw,
    autoRecallPoolMultipleRaw,
    autoRecallCutoffModeRaw,
    plotRecallTopKRaw,
    plotRecallMinRaw,
    plotRecallFloorRaw,
    autoRecallLeadInChunksRaw,
  ] = await Promise.all([
    store.get('chat_memory_auto_recall_enabled'),
    store.get('chat_memory_auto_recall_pairs'),
    store.get('chat_memory_auto_recall_chunk_top_k'),
    store.get('chat_memory_auto_recall_chunk_min'),
    store.get('chat_memory_auto_recall_pool_multiple'),
    store.get('chat_memory_auto_recall_cutoff_mode'),
    store.get('chat_memory_plot_recall_top_k'),
    store.get('chat_memory_plot_recall_min'),
    store.get('chat_memory_plot_recall_floor_syncs'),
    store.get('chat_memory_auto_recall_lead_in_chunks'),
  ]);
  return {
    // autoRecallEnabled: default true when unset — only the literal string 'false' turns the
    // silent per-turn recall off (recallForPrompt.ts treats any other value as on).
    autoRecallEnabled: autoRecallEnabledRaw !== 'false',
    autoRecallPairs: autoRecallPairsRaw ? Number(autoRecallPairsRaw) : null,
    autoRecallChunkTopK: autoRecallChunkTopKRaw ? Number(autoRecallChunkTopKRaw) : null,
    autoRecallMin: autoRecallChunkMinRaw ? Number(autoRecallChunkMinRaw) : null,
    autoRecallPoolMultiple: autoRecallPoolMultipleRaw ? Number(autoRecallPoolMultipleRaw) : null,
    autoRecallCutoffMode:
      autoRecallCutoffModeRaw === 'mean' || autoRecallCutoffModeRaw === 'mean+1sd' || autoRecallCutoffModeRaw === 'mean+2sd'
        ? autoRecallCutoffModeRaw
        : null,
    plotRecallTopK: plotRecallTopKRaw ? Number(plotRecallTopKRaw) : null,
    plotRecallMin: plotRecallMinRaw ? Number(plotRecallMinRaw) : null,
    plotRecallFloorSyncs: plotRecallFloorRaw ? Number(plotRecallFloorRaw) : null,
    autoRecallLeadInChunks: autoRecallLeadInChunksRaw ? Number(autoRecallLeadInChunksRaw) : null,
  };
}

export interface SetChatMemoryRecallSettingsBody {
  autoRecallEnabled?: boolean;
  autoRecallPairs?: number;
  autoRecallChunkTopK?: number;
  autoRecallMin?: number;
  autoRecallPoolMultiple?: number;
  autoRecallCutoffMode?: string;
  plotRecallTopK?: number;
  plotRecallMin?: number;
  plotRecallFloorSyncs?: number;
  /** Lead-in window: 0 disables (recallForPrompt.ts skips the walk), 1–3 = how many preceding
   *  chunks' summaries ride along. Negative rejects. */
  autoRecallLeadInChunks?: number;
}

// Every field is optional and independently settable; wire keys are snake_case, same convention as
// every other parseSet*Body in this file.
export function parseSetChatMemoryRecallSettingsBody(raw: unknown): SetChatMemoryRecallSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const {
    auto_recall_enabled,
    auto_recall_pairs,
    auto_recall_chunk_top_k,
    auto_recall_chunk_min,
    auto_recall_pool_multiple,
    auto_recall_cutoff_mode,
    plot_recall_top_k,
    plot_recall_min,
    plot_recall_floor_syncs,
    auto_recall_lead_in_chunks,
  } = raw as Record<string, unknown>;
  if (
    auto_recall_enabled === undefined &&
    auto_recall_pairs === undefined &&
    auto_recall_chunk_top_k === undefined &&
    auto_recall_chunk_min === undefined &&
    auto_recall_pool_multiple === undefined &&
    auto_recall_cutoff_mode === undefined &&
    plot_recall_top_k === undefined &&
    plot_recall_min === undefined &&
    plot_recall_floor_syncs === undefined &&
    auto_recall_lead_in_chunks === undefined
  ) {
    return undefined;
  }
  if (auto_recall_enabled !== undefined && typeof auto_recall_enabled !== 'boolean') return undefined;
  if (auto_recall_pairs !== undefined && (typeof auto_recall_pairs !== 'number' || auto_recall_pairs <= 0)) return undefined;
  if (auto_recall_chunk_top_k !== undefined && (typeof auto_recall_chunk_top_k !== 'number' || auto_recall_chunk_top_k <= 0)) return undefined;
  if (auto_recall_chunk_min !== undefined && (typeof auto_recall_chunk_min !== 'number' || auto_recall_chunk_min <= 0)) return undefined;
  if (auto_recall_pool_multiple !== undefined && (typeof auto_recall_pool_multiple !== 'number' || auto_recall_pool_multiple <= 0)) return undefined;
  if (auto_recall_cutoff_mode !== undefined && typeof auto_recall_cutoff_mode !== 'string') return undefined;
  if (plot_recall_top_k !== undefined && (typeof plot_recall_top_k !== 'number' || plot_recall_top_k <= 0)) return undefined;
  if (plot_recall_min !== undefined && (typeof plot_recall_min !== 'number' || plot_recall_min <= 0)) return undefined;
  if (plot_recall_floor_syncs !== undefined && (typeof plot_recall_floor_syncs !== 'number' || plot_recall_floor_syncs <= 0)) return undefined;
  // 0 is meaningful (disables lead-ins), so the check is `>= 0` — unlike the positive-only knobs.
  // Also requires an integer: unlike the other numeric knobs here, this one is read via parseInt
  // (recallForPrompt.ts), which would silently truncate a fractional value rather than reject it.
  if (
    auto_recall_lead_in_chunks !== undefined &&
    (typeof auto_recall_lead_in_chunks !== 'number' || !Number.isInteger(auto_recall_lead_in_chunks) || auto_recall_lead_in_chunks < 0)
  ) {
    return undefined;
  }
  return {
    autoRecallEnabled: auto_recall_enabled as boolean | undefined,
    autoRecallPairs: auto_recall_pairs as number | undefined,
    autoRecallChunkTopK: auto_recall_chunk_top_k as number | undefined,
    autoRecallMin: auto_recall_chunk_min as number | undefined,
    autoRecallPoolMultiple: auto_recall_pool_multiple as number | undefined,
    autoRecallCutoffMode: auto_recall_cutoff_mode as string | undefined,
    plotRecallTopK: plot_recall_top_k as number | undefined,
    plotRecallMin: plot_recall_min as number | undefined,
    plotRecallFloorSyncs: plot_recall_floor_syncs as number | undefined,
    autoRecallLeadInChunks: auto_recall_lead_in_chunks as number | undefined,
  };
}

// Presence check only — no validation. Lets the composing parser distinguish "this group has no
// keys in the body" (fine, other groups may still apply) from "this group's keys are present but
// fail its own validation" (must invalidate the whole body, same as the pre-split parser).
export function hasChatMemoryRecallFields(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const {
    auto_recall_enabled,
    auto_recall_pairs,
    auto_recall_chunk_top_k,
    auto_recall_chunk_min,
    auto_recall_pool_multiple,
    auto_recall_cutoff_mode,
    plot_recall_top_k,
    plot_recall_min,
    plot_recall_floor_syncs,
    auto_recall_lead_in_chunks,
  } = raw as Record<string, unknown>;
  return (
    auto_recall_enabled !== undefined ||
    auto_recall_pairs !== undefined ||
    auto_recall_chunk_top_k !== undefined ||
    auto_recall_chunk_min !== undefined ||
    auto_recall_pool_multiple !== undefined ||
    auto_recall_cutoff_mode !== undefined ||
    plot_recall_top_k !== undefined ||
    plot_recall_min !== undefined ||
    plot_recall_floor_syncs !== undefined ||
    auto_recall_lead_in_chunks !== undefined
  );
}

export async function setChatMemoryRecallSettings(store: OrchestratorSettingsStore, body: SetChatMemoryRecallSettingsBody): Promise<void> {
  if (body.autoRecallEnabled !== undefined) await store.set('chat_memory_auto_recall_enabled', body.autoRecallEnabled ? 'true' : 'false');
  if (body.autoRecallPairs !== undefined) await store.set('chat_memory_auto_recall_pairs', String(body.autoRecallPairs));
  if (body.autoRecallChunkTopK !== undefined) await store.set('chat_memory_auto_recall_chunk_top_k', String(body.autoRecallChunkTopK));
  if (body.autoRecallMin !== undefined) await store.set('chat_memory_auto_recall_chunk_min', String(body.autoRecallMin));
  if (body.autoRecallPoolMultiple !== undefined) await store.set('chat_memory_auto_recall_pool_multiple', String(body.autoRecallPoolMultiple));
  if (body.autoRecallCutoffMode !== undefined) await store.set('chat_memory_auto_recall_cutoff_mode', body.autoRecallCutoffMode);
  if (body.plotRecallTopK !== undefined) await store.set('chat_memory_plot_recall_top_k', String(body.plotRecallTopK));
  if (body.plotRecallMin !== undefined) await store.set('chat_memory_plot_recall_min', String(body.plotRecallMin));
  if (body.plotRecallFloorSyncs !== undefined) await store.set('chat_memory_plot_recall_floor_syncs', String(body.plotRecallFloorSyncs));
  if (body.autoRecallLeadInChunks !== undefined) await store.set('chat_memory_auto_recall_lead_in_chunks', String(body.autoRecallLeadInChunks));
}