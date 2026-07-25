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
 *                      isValidTimeZone/parseSetCalendarSettingsBody/parseSetNotionSettingsBody
 *                      are pure; the rest are impure (Postgres IO via the injected store, or a
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
