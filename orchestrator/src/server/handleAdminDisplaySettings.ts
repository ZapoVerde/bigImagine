/**
 * @file orchestrator/src/server/handleAdminDisplaySettings.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — admin Settings-tab display/settings GET+SET route handlers
 * @description
 * The standalone admin settings pairs extracted from httpServer.ts
 * (docs/plans/completed/httpserver-breakdown-plan.md step 1): image settings, location settings + the
 * read-only known-locations browser, household timezone, chat background / text legibility
 * (write side only — the household read sides of those two still live in httpServer.ts's
 * handleMisc block and serve both the household and admin GET routes), chat-memory settings +
 * sync-status, location render status, canon settings, and lorebook settings. Every handler is
 * pure request/response — it reads/writes orchestrator_settings via adminServer.ts's getters and
 * setters and answers JSON, sharing no state with the rest of the server module. The dispatcher
 * (httpServer.ts's handleRequest) applies the admin gate before any of these run.
 *
 * No restart is needed for any of these: each setting is read live at the point of use (next chat
 * turn, next sync tick, next resolveLorebook call...), which is why every write here answers
 * immediately rather than the credentials routes' 202+restart.
 *
 * @api-declaration
 * handle{Image,Location,Timezone,ChatMemory,Canon,Lorebook}Settings{Get,Set}(req, res, deps)
 *   — GET/POST /v1/admin/<kind>-settings; each Set parses via adminServer.ts's parseSet*Body
 *   (400 on a malformed body), writes, and reads back the full settings object
 * handleLocationsGet(res, deps) — read-only GET /v1/admin/locations (cross-user roster)
 * handleChatMemorySyncStatusGet / handleLocationRenderStatusGet — read-only proof-it-ran GETs
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads/writes orchestrator_settings and db through deps)
 *     state_ownership: []
 *     external_io:     [Postgres (via deps.settings / deps.db), deps.llmConnections (profile list)]
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getCanonSettings,
  getChatBackgroundSettings,
  getChatLegibilitySettings,
  getChatMemorySettings,
  getChatMemorySyncStatus,
  getHouseholdTimezone,
  getImageSettings,
  getLocationRenderStatus,
  getLocationsAdmin,
  getLocationSettings,
  getLorebookSettings,
  parseSetCanonSettingsBody,
  parseSetChatMemorySettingsBody,
  parseSetChatBackgroundSettingsBody,
  parseSetChatLegibilitySettingsBody,
  parseSetImageSettingsBody,
  parseSetLocationSettingsBody,
  parseSetLorebookSettingsBody,
  parseSetTimezoneBody,
  setCanonSettings,
  setChatMemorySettings,
  setChatBackgroundSettings,
  setChatLegibilitySettings,
  setHouseholdTimezone,
  setImageSettings,
  setLocationSettings,
  setLorebookSettings,
} from './adminServer.js';
import { readJsonBody, sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';

export async function handleImageSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getImageSettings(deps.settings));
}

export async function handleImageSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const parsed = parseSetImageSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { template?: string, describer_prompt?: string, describer_history_pairs?: string }' });
    return;
  }
  await setImageSettings(deps.settings, parsed);
  sendJson(res, 200, await getImageSettings(deps.settings));
}

// location.md §6.3 — the Locations page's unified settings surface: the tracker's three keys
// plus the room describer's two (moved entirely from the Backgrounds page; the image-settings
// endpoint above still accepts the describer_* keys for back-compat). Same admin gate + live
// no-restart shape as every other settings pair.
export async function handleLocationSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getLocationSettings(deps.settings));
}

export async function handleLocationSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const parsed = parseSetLocationSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, {
      error: 'expected { split_enabled?, injection_enabled?, injection_prompt?, describer_prompt?, describer_history_pairs? }',
    });
    return;
  }
  await setLocationSettings(deps.settings, parsed);
  sendJson(res, 200, await getLocationSettings(deps.settings));
}

// location.md §6.2.4 — the Locations page's read-only known-locations browser (parent/sub
// grouping, lifecycle status, image thumbnail). Cross-user admin roster, same as the render-
// status table; read-only, no POST counterpart.
export async function handleLocationsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, { locations: await getLocationsAdmin(deps.db) });
}

export async function handleTimezoneGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const timezone = await getHouseholdTimezone(deps.settings);
  sendJson(res, 200, { timezone });
}

export async function handleTimezoneSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const value = parseSetTimezoneBody(raw);
  if (!value) {
    sendJson(res, 400, { error: 'expected { value: a valid IANA timezone name, e.g. "America/New_York" }' });
    return;
  }

  await setHouseholdTimezone(deps.settings, value);
  // No restart needed — the very next chat turn reads it live (handleChatCompletions).
  sendJson(res, 200, { timezone: value });
}

// parallax_fade_teststep.md §2.2's admin write side — the SettingsView "Chat Background" toggle.
// Same admin gate and no-restart shape as /v1/admin/timezone: the value is read live by ChatView
// at chat load, so flipping it takes effect on the next visit without a restart. (The read side
// lives in httpServer.ts's handleMisc block — one household-gated getter serves both routes.)
export async function handleChatBackgroundSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const value = parseSetChatBackgroundSettingsBody(raw);
  if (!value) {
    sendJson(res, 400, {
      error:
        'expected a partial { parallaxEnabled?, overlayOpacity?, overlayShade?, bubbleOpacity?, bubbleUserShade?, bubbleAssistantShade? } with at least one field',
    });
    return;
  }

  await setChatBackgroundSettings(deps.settings, value);
  sendJson(res, 200, await getChatBackgroundSettings(deps.settings));
}

// migration 0074's admin write side — the ChatView "Text legibility" collapsible menu in the
// chat settings rail (components/chat/LegibilityMenu.tsx). Same admin gate and no-restart shape
// as /v1/admin/timezone / the chat-background pair: each toggle POSTs its partial patch
// immediately (household-wide, applies to all chats), ChatView re-reads the set live at chat
// load, so there is no restart and no rebuild for a look change. (Read side: see the background
// pair's note above.)
export async function handleChatLegibilitySettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const value = parseSetChatLegibilitySettingsBody(raw);
  if (!value) {
    sendJson(res, 400, {
      error:
        'expected a partial { halo?, haloStrength?, outline?, solidCode?, weightBump?, hoverFocus? } with at least one field',
    });
    return;
  }

  await setChatLegibilitySettings(deps.settings, value);
  sendJson(res, 200, await getChatLegibilitySettings(deps.settings));
}

// docs/chat-memory.md — profileNames comes from deps.llmConnections.list() (the live, admin-managed
// set, io/llmConnections.ts), everything else is live-read via adminServer.ts.
export async function handleChatMemorySettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const settings = await getChatMemorySettings(deps.settings);
  const profileNames = (await deps.llmConnections.list()).map((c) => c.name);
  sendJson(res, 200, { ...settings, profileNames });
}

export async function handleChatMemorySettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetChatMemorySettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, {
      error:
        'expected at least one of { profile?, live_window_pairs?: positive number, sync_every_pairs?: positive number, ' +
        'digest_horizon_pairs?: positive number, chunk_summary_prompt?, distill_prompt?, household_memory_prompt? }',
    });
    return;
  }

  await setChatMemorySettings(deps.settings, parsed);
  // No restart needed — the next sync tick (orchestrator/src/orchestrator/chatMemorySync.ts) reads
  // every one of these live.
  const settings = await getChatMemorySettings(deps.settings);
  const profileNames = (await deps.llmConnections.list()).map((c) => c.name);
  sendJson(res, 200, { ...settings, profileNames });
}

// The review panel's actual data (bi_principles.md §11) — read-only, no POST counterpart, since
// this reports what the background sync loop (orchestrator/chatMemorySync.ts) already did rather
// than configuring anything.
export async function handleChatMemorySyncStatusGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, { chats: await getChatMemorySyncStatus(deps.db) });
}

// The Backgrounds tab's proof-it-ran read: which render stages each recent location actually
// completed (describeLocation.ts's described/defined halves, generateLocationImage.ts's
// rendered/hash), cross-user like getChatMemorySyncStatus above — admin-gated, read-only.
export async function handleLocationRenderStatusGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, { locations: await getLocationRenderStatus(deps.db) });
}

// docs/canonize-plan.md §6 — canon settings are live-read (recall_canon_facts reads
// canon_recall_top_k on every call), so a save here takes effect immediately, no restart, same
// shape as notification settings above.
export async function handleCanonSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getCanonSettings(deps.settings));
}

export async function handleCanonSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetCanonSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, {
      error: 'expected at least one of { recall_top_k?: positive integer, extraction_prompt?: string }',
    });
    return;
  }
  await setCanonSettings(deps.settings, parsed);
  // No restart needed — recall_canon_facts reads canon_recall_top_k live on every call.
  sendJson(res, 200, await getCanonSettings(deps.settings));
}

// docs/lorebook-plan.md §3d/§8a — the Lorebooks page's settings panel. Like canon settings,
// resolveLorebook reads the §3d keys live every turn, so a save here takes effect immediately.
export async function handleLorebookSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getLorebookSettings(deps.settings));
}

export async function handleLorebookSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetLorebookSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, {
      error:
        'expected at least one of { lorebook_mode?: "on" | "off", lorebook_token_budget?: positive number | null, ' +
        'lorebook_recall_top_k?: positive integer, lorebook_recursion_enabled?: boolean }',
    });
    return;
  }
  await setLorebookSettings(deps.settings, parsed);
  sendJson(res, 200, await getLorebookSettings(deps.settings));
}
