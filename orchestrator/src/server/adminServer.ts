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
 * Also backs two more boot-time settings groups (docs/bb_principles.md §13 — non-secret runtime
 * config belongs in the database, not .env), same restart-on-save shape as the connection picker
 * rather than timezone's live-update one, since each is only read once when the thing it
 * configures is constructed: GET/POST /v1/admin/calendar-settings (calendar_owner_user_id,
 * mask_work_calendar — plugins/calendar) and GET/POST /v1/admin/notion-settings
 * (notion_owner_user_id, notion_lists_data_source_id — io/notion.ts). Each getter falls back to
 * its legacy BIGBRAIN_*-prefixed env var when the DB has no value yet, so an existing deployment
 * keeps working unchanged until someone actually visits Settings.
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
 *
 * @contract
 *   assertions:
 *     purity:          parseSetCredentialBody/parseSetActiveProfileBody/parseSetTimezoneBody/
 *                      isValidTimeZone/parseSetCalendarSettingsBody/parseSetNotionSettingsBody
 *                      are pure; the rest are impure (Postgres IO via the injected store, or a
 *                      network call to the named provider for listModelsForProfile)
 *     state_ownership: []
 *     external_io:     [Postgres (via the stores it's given); the configured LLM provider APIs]
 */

import type { CredentialName, CredentialSummary, ProviderCredentialStore } from '../io/providerCredentials.js';
import { CREDENTIAL_NAMES } from '../io/providerCredentials.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { createLlmProviderForProfile, type LlmProfile } from '../io/llm/index.js';

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

export interface ActiveProfileSetting {
  activeProfile: string;
  activeModel: string;
  profileNames: string[];
}

export async function getActiveProfileSetting(
  store: OrchestratorSettingsStore,
  profiles: Record<string, LlmProfile>,
  envActiveProfile: string,
): Promise<ActiveProfileSetting> {
  const activeProfile = (await store.get('active_llm_profile')) ?? envActiveProfile;
  const storedModel = await store.get('active_llm_model');
  const activeModel = storedModel ?? profiles[activeProfile]?.model ?? '';
  return { activeProfile, activeModel, profileNames: Object.keys(profiles) };
}

export interface SetActiveProfileBody {
  profile: string;
  model?: string;
}

export function parseSetActiveProfileBody(raw: unknown, profileNames: string[]): SetActiveProfileBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { value, model } = raw as Record<string, unknown>;
  if (typeof value !== 'string' || !profileNames.includes(value)) return undefined;
  if (model !== undefined && (typeof model !== 'string' || model.length === 0)) return undefined;
  return { profile: value, model: typeof model === 'string' ? model : undefined };
}

export async function setActiveProfile(store: OrchestratorSettingsStore, body: SetActiveProfileBody): Promise<void> {
  await store.set('active_llm_profile', body.profile);
  if (body.model) await store.set('active_llm_model', body.model);
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
