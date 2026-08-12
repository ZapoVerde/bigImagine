/**
 * @file orchestrator/src/orchestrator/cleanupLiveStatus.ts
 * @stamp 2026-08-12
 * @architectural-role Orchestrator — ambient per-chat, per-region live cleanup state
 * @description
 * The in-memory side of the live cleanup path (docs/plans/in-stream-cleanup-plan.md): while a
 * turn streams, the live engine writes the three regions' current pill states here and emits
 * them to the client as `bigimagine_cleanup` SSE frames. The polled read surface
 * (cleanupLoop.ts's getCleanupStatus) overlays this map on top of the settled job rows so a
 * polling client never shows stale state mid-stream, and the live path clears the entry once
 * finalizeCleanupResult writes the settled rows — the same ambient-hint-then-canonical-record
 * handoff turnStatus.ts models for the "thinking" indicator.
 *
 * Deliberately leaf: this module imports nothing but the shared CleanupRegionState type (a
 * type-only import, erased at compile time — no runtime edge back into cleanupLoop.ts), so
 * cleanupLoop → cleanupLiveStatus is acyclic.
 *
 * @api-declaration
 * updateCleanupLiveRegion(chatId, region, state)   — one region's live state (also emits the SSE frame via onCleanupEvent at the call site)
 * setCleanupLiveStatus(chatId, status)             — replace all three regions at once
 * clearCleanupLiveStatus(chatId)                   — the live span ended (settled rows now authoritative)
 * getCleanupLiveStatus(chatId)                     — read the overlay for one chat
 *
 * @contract
 *   assertions:
 *     purity:          impure (module-level mutable Map, same lifetime as the process — a bounce drops it)
 *     state_ownership: [the module-level Map keyed by chatId; one live turn per chat at a time]
 *     external_io:     none
 */

import type { CleanupRegionState } from './cleanupLoop.js';

/** One region's live state — same four-state vocabulary as the settled mapping. */
export interface CleanupLiveRegion {
  state: CleanupRegionState;
}

/** The three regions' live states for one chat. A missing region means "no live event yet". */
export interface CleanupLiveStatus {
  header: CleanupLiveRegion | undefined;
  body: CleanupLiveRegion | undefined;
  footer: CleanupLiveRegion | undefined;
}

const liveStatus = new Map<string, CleanupLiveStatus>();

/** Set one region's live state for a chat. */
export function updateCleanupLiveRegion(
  chatId: string,
  region: 'header' | 'body' | 'footer',
  state: CleanupRegionState,
): void {
  const current = liveStatus.get(chatId) ?? ({} as CleanupLiveStatus);
  liveStatus.set(chatId, { ...current, [region]: { state } });
}

/** Replace all three regions' live states for a chat at once. */
export function setCleanupLiveStatus(chatId: string, status: CleanupLiveStatus): void {
  liveStatus.set(chatId, status);
}

/** Drop a chat's live entry — called by the live path right after finalizeCleanupResult writes
 *  the settled rows, so the polled read becomes authoritative again. */
export function clearCleanupLiveStatus(chatId: string): void {
  liveStatus.delete(chatId);
}

/** Read a chat's live overlay; undefined when no live turn is in progress for it. */
export function getCleanupLiveStatus(chatId: string): CleanupLiveStatus | undefined {
  return liveStatus.get(chatId);
}
