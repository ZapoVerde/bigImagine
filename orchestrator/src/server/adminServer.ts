/**
 * @file orchestrator/src/server/adminServer.ts
 * @stamp 2026-07-24
 * @architectural-role Pure Function (request parsing) + IO Wrapper (credential store IO) — same
 * dual-role split already established by openApiToolServer.ts for this codebase's other
 * additive HTTP surface
 * @description
 * The admin-only counterpart to openApiToolServer.ts: instead of letting an external caller
 * invoke a household-scoped tool, this lets the one admin rotate a provider credential
 * (io/providerCredentials.ts) without a rebuild. Gated by a single static admin bearer key
 * (BIGBRAIN_ADMIN_API_KEY), checked in httpServer.ts via isAdminAuthenticated — deliberately not
 * ApiKeyStore/BIGBRAIN_API_KEYS, since this isn't user data and there is no admin/regular
 * distinction in that per-household-member map (nor should there be one bolted on for this).
 *
 * Never returns a plaintext or ciphertext credential value — listCredentials only ever reports
 * whether each fixed name (CREDENTIAL_NAMES) is configured and when it was last touched. Write-
 * only by construction (docs/bb_principles.md §12): the Settings tab is built around that —
 * credentials can be set/rotated, never viewed back.
 *
 * Also backs the Settings tab's connection picker (GET/POST /v1/admin/settings, and
 * GET /v1/admin/settings/models for the model dropdown within whichever connection is
 * selected) — unlike credentials, a connection profile/model *name* isn't a secret, so
 * getActiveProfileSetting reads it back in full rather than only reporting "configured".
 * parseSetActiveProfileBody validates against the caller-supplied list of profile names actually
 * defined in BIGBRAIN_LLM_PROFILES, so an admin can't set the active profile to a name that
 * doesn't exist. listModelsForProfile builds a throwaway LlmProvider for any configured profile —
 * even one that isn't currently active — purely to call its listModels(), so the model dropdown
 * can preview a connection's catalog before switching to it.
 *
 * Also backs the Settings tab's timezone field (GET/POST /v1/admin/timezone) — the household's
 * IANA zone name, read fresh on every chat turn (server/httpServer.ts's handleChatCompletions via
 * util/dateContext.ts) to tell the LLM the actual current date/time. Unlike the connection
 * picker, this needs no restart to take effect (getHouseholdTimezone's caller just reads it live
 * per request), so its POST route responds 200 immediately rather than 202/restarting.
 * parseSetTimezoneBody validates the given name is one Intl actually recognizes, rejecting a typo
 * before it's stored rather than failing later inside dateContext.ts.
 *
 * Also backs the Settings tab's default recipe scale field (GET/POST /v1/admin/recipe-settings) —
 * the household-wide default target serving count plugins/recipes/src/scaleRecipeTool.ts falls
 * back to whenever scale_recipe is called with no explicit target_servings ("always show recipes
 * scaled for 6"). Same live-update shape as timezone, not calendar/Notion's restart-on-save one:
 * scale_recipe reads it fresh on every call, so a change takes effect on the next scale.
 *
 * Also backs two more boot-time settings groups (docs/bb_principles.md §13 — non-secret runtime
 * config belongs in the database, not .env), same restart-on-save shape as the connection picker
 * rather than timezone's live-update one, since each is only read once when the thing it
 * configures is constructed: GET/POST /v1/admin/calendar-settings (calendar_owner_user_id,
 * mask_work_calendar — plugins/calendar) and GET/POST /v1/admin/notion-settings
 * (notion_owner_user_id, notion_lists_data_source_id — io/notion.ts). Each getter falls back to
 * its legacy BIGBRAIN_*-prefixed env var when the DB has no value yet, so an existing deployment
 * keeps working unchanged until someone actually visits Settings.
 *
 * Also backs the Settings tab's notification fields (GET/POST /v1/admin/notification-settings) —
 * ntfy_server_url and notifications_enabled (plugins/notifications). Live-update shape like
 * timezone/recipe-settings, not calendar/Notion's restart-on-save one: sendPushNotificationTool.ts
 * reads both fresh on every send_push_notification call, so a Settings-tab edit (including
 * flipping the kill switch off) takes effect on the very next call, no restart. No legacy env
 * fallback here — this is a new feature with no pre-existing env-only deployment to stay
 * compatible with.
 *
 * @api-declaration
 * parseSetCredentialBody(raw) — validates {name, value}; undefined on any malformed shape
 * listCredentials(store) — CredentialSummary[] for every fixed name in CREDENTIAL_NAMES
 * setCredential(store, name, value) — encrypts + upserts the one named credential
 * getActiveProfileSetting(store, profiles, envActiveProfile) — DB value if set, else the
 *   boot-time env fallback, for both the active profile and its model, alongside every
 *   selectable profile name
 * parseSetActiveProfileBody(raw, profileNames) — validates {value, model?}; undefined on any
 *   malformed shape or unknown profile name
 * setActiveProfile(store, body) — upserts active_llm_profile, and active_llm_model when given
 * listModelsForProfile(profiles, profileName) — the live model catalog for one named profile
 *   (or its single static model if the provider kind has no listModels), for the picker to show
 *   before an admin commits to switching
 * getHouseholdTimezone(store) — the stored IANA zone name, or 'UTC' if never set
 * parseSetTimezoneBody(raw) — validates {value} is a real IANA zone name Intl recognizes;
 *   undefined on any malformed shape or unrecognized name
 * setHouseholdTimezone(store, value) — upserts household_timezone
 * getDefaultRecipeServings(store) — the stored default target serving count, or null if never set
 * parseSetDefaultRecipeServingsBody(raw) — validates {value} is a positive number; undefined on
 *   any malformed shape
 * setDefaultRecipeServings(store, value) — upserts default_recipe_servings
 * getCalendarSettings(store) — { ownerUserId, maskWorkCalendar }, DB value or env fallback
 * parseSetCalendarSettingsBody(raw) — validates {owner_user_id?, mask_work_calendar?}, at least
 *   one present; undefined on any malformed shape
 * setCalendarSettings(store, body) — upserts whichever of calendar_owner_user_id/
 *   mask_work_calendar was given
 * getNotionSettings(store) — { ownerUserId, listsDataSourceId }, DB value or env fallback
 * parseSetNotionSettingsBody(raw) — validates {owner_user_id?, lists_data_source_id?}, at least
 *   one present; undefined on any malformed shape
 * setNotionSettings(store, body) — upserts whichever of notion_owner_user_id/
 *   notion_lists_data_source_id was given
 * getNotificationSettings(store) — { serverUrl, enabled }, no env fallback
 * parseSetNotificationSettingsBody(raw) — validates {server_url?, enabled?}, at least one present;
 *   undefined on any malformed shape
 * setNotificationSettings(store, body) — upserts whichever of ntfy_server_url/
 *   notifications_enabled was given
 *
 * Also backs Google Calendar's OAuth connection flow (docs/spec.md §6.7): same restart-on-save
 * settings shape for GET/POST /v1/admin/google-calendar-settings (client id/owner user id/
 * calendar id — client secret and refresh token stay in provider_credentials, §12). The
 * connection itself is a two-step redirect dance the Settings tab drives:
 * mintGoogleOauthState()/buildGoogleAuthUrl() build the consent URL httpServer.ts's auth-url
 * route hands back for the browser to open; Google redirects back to the callback route with a
 * code and that same state, which consumeGoogleOauthState() single-use-verifies before
 * completeGoogleCalendarOauth() exchanges the code and writes the resulting refresh token. The
 * state nonce store is intentionally in-memory here (module-level, mirrors io/notion.ts's own
 * closured throttle state) — it only needs to survive the few minutes between minting and
 * consumption, not a process restart.
 *
 * mintGoogleOauthState() — mints and stores a single-use nonce, TTL-bounded, opportunistically
 *   sweeping expired entries on each call
 * consumeGoogleOauthState(nonce) — true iff the nonce exists and hasn't expired; always deletes it
 *   (single-use regardless of outcome)
 * buildGoogleAuthUrl(clientId, redirectUri, state) — Google's OAuth consent URL, offline access +
 *   forced re-consent so a refresh token is issued even on a second connection attempt
 * getGoogleCalendarSettings(store) / parseSetGoogleCalendarSettingsBody(raw) /
 *   setGoogleCalendarSettings(store, body) — same shape as the Calendar/Notion settings trio above
 * completeGoogleCalendarOauth(credentials, settings, code, redirectUri) — resolves client
 *   id/secret, exchanges the code, and writes the refresh token; throws if Google didn't return
 *   one (already-granted access — the caller should tell the admin to revoke and reconnect)
 *
 * @contract
 *   assertions:
 *     purity:          parseSetCredentialBody/parseSetActiveProfileBody/parseSetTimezoneBody/
 *                      isValidTimeZone/parseSetCalendarSettingsBody/parseSetNotionSettingsBody/
 *                      parseSetNotificationSettingsBody are pure; the rest are impure (Postgres
 *                      IO via the injected store, or a
 *                      network call to the named provider for listModelsForProfile)
 *     state_ownership: []
 *     external_io:     [Postgres (via the stores it's given); the configured LLM provider APIs]
 */

import { randomUUID } from 'node:crypto';
import type { CredentialName, CredentialSummary, ProviderCredentialStore } from '../io/providerCredentials.js';
import { CREDENTIAL_NAMES } from '../io/providerCredentials.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { createLlmProviderForProfile, type LlmProfile } from '../io/llm/index.js';
import { exchangeAuthCode } from '../io/googleCalendar.js';
import { DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT } from '../io/chatMemory/classifyChatChunk.js';
import { DEFAULT_DISTILL_CHAT_MEMORY_PROMPT } from '../io/chatMemory/distillChatMemory.js';
import { DEFAULT_HOUSEHOLD_MEMORY_PROMPT } from '../io/chatMemory/classifyHouseholdMemory.js';

export interface SetCredentialBody {
  name: CredentialName;
  value: string;
}

export function parseSetCredentialBody(raw: unknown): SetCredentialBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, value } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !(CREDENTIAL_NAMES as readonly string[]).includes(name)) return undefined;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return { name: name as CredentialName, value };
}

export function listCredentials(store: ProviderCredentialStore): Promise<CredentialSummary[]> {
  return store.list();
}

export function setCredential(store: ProviderCredentialStore, name: CredentialName, value: string): Promise<void> {
  return store.set(name, value);
}

// llm_vision_capable_profiles' value is a JSON array of profile names, the one setting here that
// isn't a bare scalar (io/orchestratorSettings.ts's own preamble explains why) — parsed
// defensively since it's operator/admin-set indirectly via this route, not hand-edited. Exported
// so index.ts's boot sequence can reuse the exact same parse when splicing the flag onto every
// profile via profiles.ts's withOverriddenSupportsVision, rather than a second copy of this logic.
export function parseVisionCapableProfiles(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((name) => typeof name === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

export interface ActiveProfileSetting {
  activeProfile: string;
  activeModel: string;
  profileNames: string[];
  /** Every configured profile name an admin has marked vision-capable — not just the active
   *  one, since the Settings tab's picker can preview any configured profile's own flag before
   *  committing to it (io/llm/profiles.ts's LlmProfile.supportsVision). */
  visionCapableProfiles: string[];
}

export async function getActiveProfileSetting(
  store: OrchestratorSettingsStore,
  profiles: Record<string, LlmProfile>,
  envActiveProfile: string,
): Promise<ActiveProfileSetting> {
  const activeProfile = (await store.get('active_llm_profile')) ?? envActiveProfile;
  const storedModel = await store.get('active_llm_model');
  const activeModel = storedModel ?? profiles[activeProfile]?.model ?? '';
  const visionCapableProfiles = parseVisionCapableProfiles(await store.get('llm_vision_capable_profiles'));
  return { activeProfile, activeModel, profileNames: Object.keys(profiles), visionCapableProfiles };
}

export interface SetActiveProfileBody {
  profile: string;
  model?: string;
  /** Undefined leaves this profile's stored vision flag untouched — same "only touch what's
   *  given" shape as model. Set (true or false) to add/remove `profile` from the stored
   *  llm_vision_capable_profiles list. */
  supportsVision?: boolean;
}

export function parseSetActiveProfileBody(raw: unknown, profileNames: string[]): SetActiveProfileBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { value, model, supportsVision } = raw as Record<string, unknown>;
  if (typeof value !== 'string' || !profileNames.includes(value)) return undefined;
  if (model !== undefined && (typeof model !== 'string' || model.length === 0)) return undefined;
  if (supportsVision !== undefined && typeof supportsVision !== 'boolean') return undefined;
  return {
    profile: value,
    model: typeof model === 'string' ? model : undefined,
    supportsVision: typeof supportsVision === 'boolean' ? supportsVision : undefined,
  };
}

export async function setActiveProfile(store: OrchestratorSettingsStore, body: SetActiveProfileBody): Promise<void> {
  await store.set('active_llm_profile', body.profile);
  if (body.model) await store.set('active_llm_model', body.model);
  if (body.supportsVision !== undefined) {
    const current = parseVisionCapableProfiles(await store.get('llm_vision_capable_profiles'));
    const next = body.supportsVision
      ? Array.from(new Set([...current, body.profile]))
      : current.filter((name) => name !== body.profile);
    await store.set('llm_vision_capable_profiles', JSON.stringify(next));
  }
}

export interface ProfileModelsResult {
  models: { id: string; pricing?: { prompt: string; completion: string } }[];
  defaultModel: string;
}

export async function listModelsForProfile(
  profiles: Record<string, LlmProfile>,
  profileName: string,
): Promise<ProfileModelsResult | undefined> {
  const profile = profiles[profileName];
  if (!profile) return undefined;
  const provider = createLlmProviderForProfile(profile);
  const models = provider.listModels ? await provider.listModels() : [{ id: profile.model }];
  return { models, defaultModel: profile.model };
}

// UTC is a deliberate, safe default — not a real guess at where the household is, just a value
// that keeps the date/time this backs (util/dateContext.ts) well-defined before anyone's set it.
const DEFAULT_TIMEZONE = 'UTC';

export async function getHouseholdTimezone(store: OrchestratorSettingsStore): Promise<string> {
  return (await store.get('household_timezone')) ?? DEFAULT_TIMEZONE;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function parseSetTimezoneBody(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { value } = raw as Record<string, unknown>;
  if (typeof value !== 'string' || value.length === 0 || !isValidTimeZone(value)) return undefined;
  return value;
}

export function setHouseholdTimezone(store: OrchestratorSettingsStore, value: string): Promise<void> {
  return store.set('household_timezone', value);
}

// --- Default recipe scale (docs/bb_principles.md §13, §2 — the target serving count itself is
// not reasoning, just a stored number scale_recipe's arithmetic uses) ---
// Live-read shape, same as timezone: null (not a hardcoded number, unlike DEFAULT_TIMEZONE) means
// scale_recipe should fall back further, to the recipe's own base_servings — there's no household-
// wide default that's a safe guess the way UTC is for timezone.

export async function getDefaultRecipeServings(store: OrchestratorSettingsStore): Promise<number | null> {
  const raw = await store.get('default_recipe_servings');
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseSetDefaultRecipeServingsBody(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { value } = raw as Record<string, unknown>;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

export function setDefaultRecipeServings(store: OrchestratorSettingsStore, value: number): Promise<void> {
  return store.set('default_recipe_servings', String(value));
}

// --- Notification settings (docs/bb_principles.md §13, §2 — neither value is reasoning, one's a
// selector and the other a toggle) ---
// Live-read shape, same as timezone/recipe-settings: sendPushNotificationTool.ts reads both fresh
// on every call, so a Settings-tab edit — including turning the kill switch off — takes effect on
// the very next send_push_notification call, no restart.

export interface NotificationSettings {
  serverUrl: string | null;
  enabled: boolean;
}

export async function getNotificationSettings(store: OrchestratorSettingsStore): Promise<NotificationSettings> {
  const serverUrl = (await store.get('ntfy_server_url')) ?? null;
  const enabled = (await store.get('notifications_enabled')) === 'true';
  return { serverUrl, enabled };
}

export interface SetNotificationSettingsBody {
  serverUrl?: string;
  enabled?: boolean;
}

export function parseSetNotificationSettingsBody(raw: unknown): SetNotificationSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { server_url, enabled } = raw as Record<string, unknown>;
  if (server_url === undefined && enabled === undefined) return undefined;
  if (server_url !== undefined && (typeof server_url !== 'string' || server_url.length === 0)) return undefined;
  if (enabled !== undefined && typeof enabled !== 'boolean') return undefined;
  return {
    serverUrl: typeof server_url === 'string' ? server_url : undefined,
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
  };
}

export async function setNotificationSettings(store: OrchestratorSettingsStore, body: SetNotificationSettingsBody): Promise<void> {
  if (body.serverUrl !== undefined) await store.set('ntfy_server_url', body.serverUrl);
  if (body.enabled !== undefined) await store.set('notifications_enabled', String(body.enabled));
}

// --- Chat memory settings (docs/chat-memory.md) ---
// Mirrors SillyTavern-Canonize's own "Connections & Prompts" settings panel: a connection override
// for the rolling-sync pipeline's classification calls (unset = the household's active connection,
// same fallback shape as a chat's own params.profile), two timing knobs in turn-pairs, and a
// "default + bespoke" override per prompt. Read live on every sync tick
// (orchestrator/src/orchestrator/chatMemorySync.ts) — a save here takes effect on the next tick,
// no restart, same shape as notification/recipe settings above. profileNames isn't included here —
// httpServer.ts's route handler attaches it from deps.llmProfiles, same split as
// getActiveProfileSetting/ActiveProfileSetting.

export interface ChatMemorySettings {
  profile: string | null;
  liveWindowPairs: number | null;
  syncEveryPairs: number | null;
  chunkSummaryPrompt: string;
  chunkSummaryPromptIsDefault: boolean;
  distillPrompt: string;
  distillPromptIsDefault: boolean;
  householdMemoryPrompt: string;
  householdMemoryPromptIsDefault: boolean;
}

export async function getChatMemorySettings(store: OrchestratorSettingsStore): Promise<ChatMemorySettings> {
  const [profile, liveRaw, syncRaw, chunkSummaryPrompt, distillPrompt, householdMemoryPrompt] = await Promise.all([
    store.get('chat_memory_profile'),
    store.get('chat_memory_live_window_pairs'),
    store.get('chat_memory_sync_every_pairs'),
    store.get('chat_memory_chunk_summary_prompt'),
    store.get('chat_memory_distill_prompt'),
    store.get('chat_memory_household_memory_prompt'),
  ]);
  return {
    profile: profile || null,
    liveWindowPairs: liveRaw ? Number(liveRaw) : null,
    syncEveryPairs: syncRaw ? Number(syncRaw) : null,
    chunkSummaryPrompt: chunkSummaryPrompt || DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT,
    chunkSummaryPromptIsDefault: !chunkSummaryPrompt,
    distillPrompt: distillPrompt || DEFAULT_DISTILL_CHAT_MEMORY_PROMPT,
    distillPromptIsDefault: !distillPrompt,
    householdMemoryPrompt: householdMemoryPrompt || DEFAULT_HOUSEHOLD_MEMORY_PROMPT,
    householdMemoryPromptIsDefault: !householdMemoryPrompt,
  };
}

export interface SetChatMemorySettingsBody {
  profile?: string;
  liveWindowPairs?: number;
  syncEveryPairs?: number;
  chunkSummaryPrompt?: string;
  distillPrompt?: string;
  householdMemoryPrompt?: string;
}

// Every field is optional and independently settable; an empty string on any prompt field clears
// the override back to its built-in default (there is no separate "reset" endpoint — see
// io/orchestratorSettings.ts's own doc on this). Wire keys are snake_case, same convention as
// every other parseSet*Body in this file (server_url, mask_work_calendar, ...).
export function parseSetChatMemorySettingsBody(raw: unknown): SetChatMemorySettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { profile, live_window_pairs, sync_every_pairs, chunk_summary_prompt, distill_prompt, household_memory_prompt } =
    raw as Record<string, unknown>;
  if (
    profile === undefined &&
    live_window_pairs === undefined &&
    sync_every_pairs === undefined &&
    chunk_summary_prompt === undefined &&
    distill_prompt === undefined &&
    household_memory_prompt === undefined
  ) {
    return undefined;
  }
  if (profile !== undefined && typeof profile !== 'string') return undefined;
  if (live_window_pairs !== undefined && (typeof live_window_pairs !== 'number' || live_window_pairs <= 0)) return undefined;
  if (sync_every_pairs !== undefined && (typeof sync_every_pairs !== 'number' || sync_every_pairs <= 0)) return undefined;
  if (chunk_summary_prompt !== undefined && typeof chunk_summary_prompt !== 'string') return undefined;
  if (distill_prompt !== undefined && typeof distill_prompt !== 'string') return undefined;
  if (household_memory_prompt !== undefined && typeof household_memory_prompt !== 'string') return undefined;
  return {
    profile: profile as string | undefined,
    liveWindowPairs: live_window_pairs as number | undefined,
    syncEveryPairs: sync_every_pairs as number | undefined,
    chunkSummaryPrompt: chunk_summary_prompt as string | undefined,
    distillPrompt: distill_prompt as string | undefined,
    householdMemoryPrompt: household_memory_prompt as string | undefined,
  };
}

export async function setChatMemorySettings(store: OrchestratorSettingsStore, body: SetChatMemorySettingsBody): Promise<void> {
  if (body.profile !== undefined) await store.set('chat_memory_profile', body.profile);
  if (body.liveWindowPairs !== undefined) await store.set('chat_memory_live_window_pairs', String(body.liveWindowPairs));
  if (body.syncEveryPairs !== undefined) await store.set('chat_memory_sync_every_pairs', String(body.syncEveryPairs));
  if (body.chunkSummaryPrompt !== undefined) await store.set('chat_memory_chunk_summary_prompt', body.chunkSummaryPrompt);
  if (body.distillPrompt !== undefined) await store.set('chat_memory_distill_prompt', body.distillPrompt);
  if (body.householdMemoryPrompt !== undefined) await store.set('chat_memory_household_memory_prompt', body.householdMemoryPrompt);
}

// --- Calendar settings (docs/bb_principles.md §13) ---
// Boot-time, restart-on-save, same shape as the connection picker above — unlike timezone, these
// are only ever read once (plugins/calendar/src/index.ts's startBackgroundJobs), so a live update
// with no restart would silently do nothing until the next boot anyway.

export interface CalendarSettings {
  ownerUserId: string | null;
  maskWorkCalendar: boolean;
}

export async function getCalendarSettings(store: OrchestratorSettingsStore): Promise<CalendarSettings> {
  const ownerUserId = (await store.get('calendar_owner_user_id')) ?? process.env.BIGBRAIN_CALENDAR_OWNER_USER_ID ?? null;
  const maskRaw = (await store.get('mask_work_calendar')) ?? process.env.BIGBRAIN_MASK_WORK_CALENDAR;
  return { ownerUserId, maskWorkCalendar: maskRaw === 'true' };
}

export interface SetCalendarSettingsBody {
  ownerUserId?: string;
  maskWorkCalendar?: boolean;
}

export function parseSetCalendarSettingsBody(raw: unknown): SetCalendarSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { owner_user_id, mask_work_calendar } = raw as Record<string, unknown>;
  if (owner_user_id === undefined && mask_work_calendar === undefined) return undefined;
  if (owner_user_id !== undefined && (typeof owner_user_id !== 'string' || owner_user_id.length === 0)) return undefined;
  if (mask_work_calendar !== undefined && typeof mask_work_calendar !== 'boolean') return undefined;
  return {
    ownerUserId: typeof owner_user_id === 'string' ? owner_user_id : undefined,
    maskWorkCalendar: typeof mask_work_calendar === 'boolean' ? mask_work_calendar : undefined,
  };
}

export async function setCalendarSettings(store: OrchestratorSettingsStore, body: SetCalendarSettingsBody): Promise<void> {
  if (body.ownerUserId !== undefined) await store.set('calendar_owner_user_id', body.ownerUserId);
  if (body.maskWorkCalendar !== undefined) await store.set('mask_work_calendar', String(body.maskWorkCalendar));
}

// --- Notion settings (docs/bb_principles.md §13) ---
// Same boot-time restart-on-save shape — read once when io/notion.ts's client is constructed
// (index.ts). BIGBRAIN_NOTION_TOKEN stays entirely separate, in provider_credentials (§12): it's
// the one secret in this trio, these two are identifiers.

export interface NotionSettings {
  ownerUserId: string | null;
  listsDataSourceId: string | null;
}

export async function getNotionSettings(store: OrchestratorSettingsStore): Promise<NotionSettings> {
  const ownerUserId = (await store.get('notion_owner_user_id')) ?? process.env.BIGBRAIN_NOTION_OWNER_USER_ID ?? null;
  const listsDataSourceId =
    (await store.get('notion_lists_data_source_id')) ?? process.env.BIGBRAIN_NOTION_LISTS_DATA_SOURCE_ID ?? null;
  return { ownerUserId, listsDataSourceId };
}

export interface SetNotionSettingsBody {
  ownerUserId?: string;
  listsDataSourceId?: string;
}

export function parseSetNotionSettingsBody(raw: unknown): SetNotionSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { owner_user_id, lists_data_source_id } = raw as Record<string, unknown>;
  if (owner_user_id === undefined && lists_data_source_id === undefined) return undefined;
  if (owner_user_id !== undefined && (typeof owner_user_id !== 'string' || owner_user_id.length === 0)) return undefined;
  if (lists_data_source_id !== undefined && (typeof lists_data_source_id !== 'string' || lists_data_source_id.length === 0)) {
    return undefined;
  }
  return {
    ownerUserId: typeof owner_user_id === 'string' ? owner_user_id : undefined,
    listsDataSourceId: typeof lists_data_source_id === 'string' ? lists_data_source_id : undefined,
  };
}

export async function setNotionSettings(store: OrchestratorSettingsStore, body: SetNotionSettingsBody): Promise<void> {
  if (body.ownerUserId !== undefined) await store.set('notion_owner_user_id', body.ownerUserId);
  if (body.listsDataSourceId !== undefined) await store.set('notion_lists_data_source_id', body.listsDataSourceId);
}

// --- Google Calendar OAuth (docs/bb_principles.md §12-13, docs/spec.md §6.7) ---

const OAUTH_STATE_TTL_MS = 10 * 60_000; // long enough for a human to complete Google's consent screen
const pendingOauthStates = new Map<string, number>(); // nonce -> expiresAt

export function mintGoogleOauthState(): string {
  const now = Date.now();
  for (const [nonce, expiresAt] of pendingOauthStates) {
    if (expiresAt < now) pendingOauthStates.delete(nonce); // opportunistic sweep, not a timer — this process rarely mints more than one at a time
  }
  const nonce = randomUUID();
  pendingOauthStates.set(nonce, now + OAUTH_STATE_TTL_MS);
  return nonce;
}

export function consumeGoogleOauthState(nonce: string | undefined): boolean {
  if (!nonce) return false;
  const expiresAt = pendingOauthStates.get(nonce);
  pendingOauthStates.delete(nonce); // single-use regardless of outcome — a replayed callback must never succeed twice
  return expiresAt !== undefined && expiresAt > Date.now();
}

const GOOGLE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export function buildGoogleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPE,
    access_type: 'offline',
    prompt: 'consent', // forces a refresh_token even if this Google account already granted access once before
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface GoogleCalendarSettings {
  clientId: string | null;
  ownerUserId: string | null;
  calendarId: string;
}

const DEFAULT_GOOGLE_CALENDAR_ID = 'primary';

export async function getGoogleCalendarSettings(store: OrchestratorSettingsStore): Promise<GoogleCalendarSettings> {
  const clientId = (await store.get('google_calendar_client_id')) ?? null;
  const ownerUserId = (await store.get('google_calendar_owner_user_id')) ?? null;
  const calendarId = (await store.get('google_calendar_id')) ?? DEFAULT_GOOGLE_CALENDAR_ID;
  return { clientId, ownerUserId, calendarId };
}

export interface SetGoogleCalendarSettingsBody {
  clientId?: string;
  ownerUserId?: string;
  calendarId?: string;
}

export function parseSetGoogleCalendarSettingsBody(raw: unknown): SetGoogleCalendarSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { client_id, owner_user_id, calendar_id } = raw as Record<string, unknown>;
  if (client_id === undefined && owner_user_id === undefined && calendar_id === undefined) return undefined;
  if (client_id !== undefined && (typeof client_id !== 'string' || client_id.length === 0)) return undefined;
  if (owner_user_id !== undefined && (typeof owner_user_id !== 'string' || owner_user_id.length === 0)) return undefined;
  if (calendar_id !== undefined && (typeof calendar_id !== 'string' || calendar_id.length === 0)) return undefined;
  return {
    clientId: typeof client_id === 'string' ? client_id : undefined,
    ownerUserId: typeof owner_user_id === 'string' ? owner_user_id : undefined,
    calendarId: typeof calendar_id === 'string' ? calendar_id : undefined,
  };
}

export async function setGoogleCalendarSettings(store: OrchestratorSettingsStore, body: SetGoogleCalendarSettingsBody): Promise<void> {
  if (body.clientId !== undefined) await store.set('google_calendar_client_id', body.clientId);
  if (body.ownerUserId !== undefined) await store.set('google_calendar_owner_user_id', body.ownerUserId);
  if (body.calendarId !== undefined) await store.set('google_calendar_id', body.calendarId);
}

export async function completeGoogleCalendarOauth(
  credentials: ProviderCredentialStore,
  settings: OrchestratorSettingsStore,
  code: string,
  redirectUri: string,
): Promise<void> {
  const clientId = await settings.get('google_calendar_client_id');
  const clientSecret = await credentials.resolve('google_calendar_client_secret', undefined);
  if (!clientId || !clientSecret) {
    throw new Error('google_calendar_client_id and google_calendar_client_secret must both be configured before connecting');
  }

  const tokens = await exchangeAuthCode(code, redirectUri, clientId, clientSecret);
  if (!tokens.refreshToken) {
    throw new Error(
      'Google did not return a refresh token — this account likely already has an active grant for this app; revoke it at https://myaccount.google.com/permissions and reconnect',
    );
  }
  await credentials.set('google_calendar_refresh_token', tokens.refreshToken);
}
