/**
 * @file orchestrator/src/server/adminServer.ts
 * @stamp 2026-08-20
 * @architectural-role Public façade (index) over the admin-domain server helpers in server/admin/ —
 * contains no implementation of its own
 * @description
 * The stable import surface for the admin-only HTTP surface's helper layer. This file was split
 * along its domain fault lines into the modules under server/admin/ (credentials, connections,
 * settings groups, lorebooks, diagnostics); it now only re-exports their public API. It owns no
 * parsing logic, no database access, no provider calls, no helpers, and no runtime state — every
 * existing caller that does `import { ... } from './adminServer.js'` is unchanged.
 *
 * Domain ownership map:
 *   credentials.ts             — provider credential administration
 *   llmConnections.ts          — LLM connection CRUD parsing + catalog/provider/test helpers
 *   imageConnections.ts        — image-connection CRUD parsing + diagnostic probe
 *   householdSettings.ts       — timezone / notifications / screen lock / persona / pia-proxy
 *   displaySettings.ts         — chat background + legibility presentation settings
 *   locationSettings.ts        — location tracker + describer + legacy image-settings block
 *   characterSettings.ts       — character describer settings
 *   portraitSettings.ts        — portrait subject describer + background prompt settings
 *   chatMemorySettings.ts      — chat-memory settings (composed from the chatMemorySyncSettings/
 *                                chatMemoryRecallSettings/chatMemoryPromptSettings slices)
 *   cleanupSettings.ts         — cleanup header/footer regexes, slop rules, reasoning tags
 *   canonSettings.ts           — Canonize recall limits + extraction prompt
 *   lorebooks.ts               — lorebook settings + book CRUD
 *   lorebookEntries.ts         — lorebook entry CRUD
 *   lorebookInterchange.ts     — ST world-info import/export
 *   diagnostics.ts             — chat-memory sync status, location render status/browser, llm stats
 *
 * @api-declaration
 * See each server/admin/* module's own preamble for per-function contracts; this façade exports
 * exactly the pre-split surface of this file — every exported name is preserved, none added.
 *
 * @contract
 *   assertions:
 *     purity:          re-exports only — no implementation here
 *     state_ownership: []
 *     external_io:     []
 */

// --- Provider credentials (server/admin/credentials.ts) ---
export { listCredentials, parseSetCredentialBody, setCredential } from './admin/credentials.js';
export type { SetCredentialBody } from './admin/credentials.js';

// --- LLM connections (server/admin/llmConnections.ts) ---
export {
  listModelsForConnection,
  listProvidersForConnection,
  parseCreateConnectionBody,
  parseReliabilitySweepBody,
  parseUpdateConnectionBody,
  parseVisionCapableProfiles,
  testConnection,
} from './admin/llmConnections.js';
export type {
  ConnectionTestResult,
  ModelProvidersResult,
  ProfileModelsResult,
  ReliabilitySweepBody,
} from './admin/llmConnections.js';

// --- Image connections (server/admin/imageConnections.ts) ---
export { parseCreateImageConnectionBody, parseUpdateImageConnectionBody, testImageConnection } from './admin/imageConnections.js';
export type { ImageConnectionTestResult } from './admin/imageConnections.js';

// --- Location-domain settings incl. the legacy image-settings block (server/admin/locationSettings.ts) ---
export { getImageSettings, getLocationSettings, parseSetImageSettingsBody, parseSetLocationSettingsBody, setImageSettings, setLocationSettings } from './admin/locationSettings.js';
export type { ImageSettings, LocationSettings } from './admin/locationSettings.js';

// --- Chat UI presentation settings (server/admin/displaySettings.ts) ---
export {
  getChatBackgroundSettings,
  getChatLegibilitySettings,
  parseSetChatBackgroundSettingsBody,
  parseSetChatLegibilitySettingsBody,
  setChatBackgroundSettings,
  setChatLegibilitySettings,
} from './admin/displaySettings.js';
export type { ChatBackgroundSettings, ChatBackgroundSettingsPatch, ChatLegibilitySettings, ChatLegibilitySettingsPatch } from './admin/displaySettings.js';

// --- Character describer settings (server/admin/characterSettings.ts) ---
export { getCharacterSettings, parseSetCharacterSettingsBody, setCharacterSettings } from './admin/characterSettings.js';
export type { CharacterSettings } from './admin/characterSettings.js';

// --- Portrait/studio prompt settings (server/admin/portraitSettings.ts) ---
export {
  getPortraitBackgroundPromptsSettings,
  getPortraitSubjectDescriberSettings,
  parseSetPortraitBackgroundPromptsSettingsBody,
  parseSetPortraitSubjectDescriberSettingsBody,
  setPortraitBackgroundPromptsSettings,
  setPortraitSubjectDescriberSettings,
} from './admin/portraitSettings.js';
export type { PortraitBackgroundPromptsSettings, PortraitSubjectDescriberSettings } from './admin/portraitSettings.js';

// --- Household-wide operational settings (server/admin/householdSettings.ts) ---
export {
  getHouseholdTimezone,
  getNotificationSettings,
  getPersonaSettings,
  getPiaProxyUrl,
  getScreenLockSettings,
  parseSetNotificationSettingsBody,
  parseSetPersonaSettingsBody,
  parseSetPiaProxyUrlBody,
  parseSetScreenLockSettingsBody,
  parseSetTimezoneBody,
  setHouseholdTimezone,
  setNotificationSettings,
  setPersonaSettings,
  setPiaProxyUrl,
  setScreenLockSettings,
} from './admin/householdSettings.js';
export type {
  NotificationSettings,
  PersonaSettings,
  ScreenLockSettings,
  SetNotificationSettingsBody,
  SetPersonaSettingsBody,
  SetScreenLockSettingsBody,
} from './admin/householdSettings.js';

// --- Chat-memory settings (server/admin/chatMemorySettings.ts) ---
export { getChatMemorySettings, parseSetChatMemorySettingsBody, setChatMemorySettings } from './admin/chatMemorySettings.js';
export type { ChatMemorySettings, SetChatMemorySettingsBody } from './admin/chatMemorySettings.js';

// --- Cleanup + live-reasoning settings (server/admin/cleanupSettings.ts) ---
export { getCleanupSettings, parseSetCleanupSettingsBody, setCleanupSettings } from './admin/cleanupSettings.js';
export type { CleanupSettings, SetCleanupSettingsBody } from './admin/cleanupSettings.js';

// --- Canonize settings (server/admin/canonSettings.ts) ---
export { getCanonSettings, parseSetCanonSettingsBody, setCanonSettings } from './admin/canonSettings.js';
export type { CanonSettings, SetCanonSettingsBody } from './admin/canonSettings.js';

// --- Lorebook settings + book CRUD (server/admin/lorebooks.ts) ---
export {
  createLorebookAdmin,
  deleteLorebookAdmin,
  getLorebooksAdmin,
  getLorebookSettings,
  parseSetLorebookSettingsBody,
  setLorebookSettings,
  updateLorebookAdmin,
} from './admin/lorebooks.js';
export type { LorebookAdminRow, LorebookSettings, SetLorebookSettingsBody, UpdateLorebookPatch } from './admin/lorebooks.js';

// --- Lorebook entry CRUD (server/admin/lorebookEntries.ts) ---
export { createLorebookEntryAdmin, deleteLorebookEntryAdmin, updateLorebookEntryAdmin } from './admin/lorebookEntries.js';
export type { LorebookEntryAdminRow, LorebookEntryInput, LorebookEntryPatch } from './admin/lorebookEntries.js';

// --- ST world-info interchange (server/admin/lorebookInterchange.ts) ---
export { exportLorebookWorldInfo, importLorebookWorldInfo } from './admin/lorebookInterchange.js';
export type { WorldInfoImportResult } from './admin/lorebookInterchange.js';

// --- Admin diagnostics / read models (server/admin/diagnostics.ts) ---
export { getChatMemorySyncStatus, getLocationRenderStatus, getLocationsAdmin, listLlmStats, listTurnDisplayStats } from './admin/diagnostics.js';
export type { ChatMemorySyncStatusRow, LlmCallStatRow, LocationAdminRow, LocationRenderStatusRow } from './admin/diagnostics.js';