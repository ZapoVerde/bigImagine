/**
 * @file orchestrator/src/server/admin/chatMemorySyncSettings.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (settings-store IO) — one of
 * the three fault-line slices the chat-memory admin block was split into (admin/chatMemorySettings.ts
 * composes the full public API from these); behaviour, wire keys, defaults, and public names
 * preserved from the pre-split adminServer.ts
 * @description
 * The sync-pipeline half of the chat-memory settings: the classification connection override
 * (profile), the three timing knobs in turn-pairs (live window, sync-every, digest horizon), and
 * the chunk size. These keys are read live on every sync tick (orchestrator/chatMemorySync.ts) —
 * a save here takes effect on the next tick, no restart.
 *
 * @api-declaration
 * getChatMemorySyncSettings(store) — { profile, liveWindowPairs, syncEveryPairs, digestHorizonPairs,
 *   chunkPairs }, each null when unset (built-in defaults)
 * parseSetChatMemorySyncSettingsBody(raw) — validates { profile?, live_window_pairs?,
 *   sync_every_pairs?, digest_horizon_pairs?, chunk_pairs? }, at least one present; undefined on
 *   any malformed shape
 * hasChatMemorySyncFields(raw) — true iff raw carries any of this group's own wire keys; lets the
 *   composing parser (admin/chatMemorySettings.ts) tell "this group was absent" apart from "this
 *   group was present but invalid" for atomic whole-body validation
 * setChatMemorySyncSettings(store, body) — upserts whichever fields the body names
 *
 * @contract
 *   assertions:
 *     purity:          parseSetChatMemorySyncSettingsBody is pure; the rest are impure (Postgres
 *                      IO via the injected settings store)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected OrchestratorSettingsStore)]
 */

import type { OrchestratorSettingsStore } from '../../io/orchestratorSettings.js';

// --- Chat memory sync settings (docs/chat-memory.md) ---
// Mirrors SillyTavern-Canonize's own "Connections & Prompts" settings panel: a connection override
// for the rolling-sync pipeline's classification calls (unset = the household's active connection,
// same fallback shape as a chat's own params.profile) and three timing knobs in turn-pairs (live
// window, sync-every, and digest-horizon — the last mirroring Canonize's own bridge-summary
// horizon). Read live on every sync tick (orchestrator/src/orchestrator/chatMemorySync.ts) — a
// save here takes effect on the next tick, no restart, same shape as notification settings.
// profileNames isn't included here — httpServer.ts's route handler attaches it from
// deps.llmConnections.list(), same split as the Connections tab's own listing route.

export interface ChatMemorySyncSettings {
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
}

export async function getChatMemorySyncSettings(store: OrchestratorSettingsStore): Promise<ChatMemorySyncSettings> {
  const [profile, liveRaw, syncRaw, digestHorizonRaw, chunkPairsRaw] = await Promise.all([
    store.get('chat_memory_profile'),
    store.get('chat_memory_live_window_pairs'),
    store.get('chat_memory_sync_every_pairs'),
    store.get('chat_memory_digest_horizon_pairs'),
    store.get('chat_memory_chunk_pairs'),
  ]);
  return {
    profile: profile || null,
    liveWindowPairs: liveRaw ? Number(liveRaw) : null,
    syncEveryPairs: syncRaw ? Number(syncRaw) : null,
    digestHorizonPairs: digestHorizonRaw ? Number(digestHorizonRaw) : null,
    chunkPairs: chunkPairsRaw ? Number(chunkPairsRaw) : null,
  };
}

export interface SetChatMemorySyncSettingsBody {
  profile?: string;
  liveWindowPairs?: number;
  syncEveryPairs?: number;
  digestHorizonPairs?: number;
  chunkPairs?: number;
}

// Every field is optional and independently settable; wire keys are snake_case, same convention as
// every other parseSet*Body in this file.
export function parseSetChatMemorySyncSettingsBody(raw: unknown): SetChatMemorySyncSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { profile, live_window_pairs, sync_every_pairs, digest_horizon_pairs, chunk_pairs } = raw as Record<string, unknown>;
  if (
    profile === undefined &&
    live_window_pairs === undefined &&
    sync_every_pairs === undefined &&
    digest_horizon_pairs === undefined &&
    chunk_pairs === undefined
  ) {
    return undefined;
  }
  if (profile !== undefined && typeof profile !== 'string') return undefined;
  if (live_window_pairs !== undefined && (typeof live_window_pairs !== 'number' || live_window_pairs <= 0)) return undefined;
  if (sync_every_pairs !== undefined && (typeof sync_every_pairs !== 'number' || sync_every_pairs <= 0)) return undefined;
  if (digest_horizon_pairs !== undefined && (typeof digest_horizon_pairs !== 'number' || digest_horizon_pairs <= 0)) return undefined;
  if (chunk_pairs !== undefined && (typeof chunk_pairs !== 'number' || chunk_pairs <= 0)) return undefined;
  return {
    profile: profile as string | undefined,
    liveWindowPairs: live_window_pairs as number | undefined,
    syncEveryPairs: sync_every_pairs as number | undefined,
    digestHorizonPairs: digest_horizon_pairs as number | undefined,
    chunkPairs: chunk_pairs as number | undefined,
  };
}

// Presence check only — no validation. Lets the composing parser distinguish "this group has no
// keys in the body" (fine, other groups may still apply) from "this group's keys are present but
// fail its own validation" (must invalidate the whole body, same as the pre-split parser).
export function hasChatMemorySyncFields(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const { profile, live_window_pairs, sync_every_pairs, digest_horizon_pairs, chunk_pairs } = raw as Record<string, unknown>;
  return (
    profile !== undefined ||
    live_window_pairs !== undefined ||
    sync_every_pairs !== undefined ||
    digest_horizon_pairs !== undefined ||
    chunk_pairs !== undefined
  );
}

export async function setChatMemorySyncSettings(store: OrchestratorSettingsStore, body: SetChatMemorySyncSettingsBody): Promise<void> {
  if (body.profile !== undefined) await store.set('chat_memory_profile', body.profile);
  if (body.liveWindowPairs !== undefined) await store.set('chat_memory_live_window_pairs', String(body.liveWindowPairs));
  if (body.syncEveryPairs !== undefined) await store.set('chat_memory_sync_every_pairs', String(body.syncEveryPairs));
  if (body.digestHorizonPairs !== undefined) await store.set('chat_memory_digest_horizon_pairs', String(body.digestHorizonPairs));
  if (body.chunkPairs !== undefined) await store.set('chat_memory_chunk_pairs', String(body.chunkPairs));
}