/**
 * @file orchestrator/src/server/admin/householdSettings.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (settings-store IO) — the same
 * dual-role split the original adminServer.ts settings blocks used; moved here verbatim as part of
 * the adminServer domain split
 * @description
 * The household-wide operational settings of the Settings tab — timezone, notifications, screen
 * lock, persona, and the pia-proxy URL. Each is a small getter/parser/setter trio over the
 * injected OrchestratorSettingsStore with the same live-read, no-restart shape: a save here takes
 * effect on the very next reader, never requiring a restart.
 *
 * This module deliberately owns none of the chat-presentation, location, portrait, or connection
 * settings — those live in their own admin/ modules. Behaviour, wire keys, defaults, and public
 * names are preserved exactly from the pre-split adminServer.ts.
 *
 * @api-declaration
 * getHouseholdTimezone(store) — the stored IANA zone name, or 'UTC' if never set
 * parseSetTimezoneBody(raw) — validates {value} is a real IANA zone name Intl recognizes;
 *   undefined on any malformed shape or unrecognized name
 * setHouseholdTimezone(store, value) — upserts household_timezone
 * getNotificationSettings(store) — { serverUrl, enabled }, no env fallback
 * parseSetNotificationSettingsBody(raw) — validates {server_url?, enabled?}, at least one present;
 *   undefined on any malformed shape
 * setNotificationSettings(store, body) — upserts whichever of ntfy_server_url/
 *   notifications_enabled was given
 * getScreenLockSettings(store) — { password, timeoutMinutes }, defaults timeoutMinutes to 5 when
 *   unset; password defaults to '' (feature off)
 * parseSetScreenLockSettingsBody(raw) — validates {password?, timeout_minutes?: positive number},
 *   at least one present; undefined on any malformed shape
 * setScreenLockSettings(store, body) — upserts whichever of screen_lock_password/
 *   screen_lock_timeout_minutes was given
 * getPersonaSettings(store) — { name, description }, each '' if never set
 * parseSetPersonaSettingsBody(raw) — validates {name?, description?: string}, at least one present;
 *   undefined on any malformed shape
 * setPersonaSettings(store, body) — upserts whichever of persona_name/persona_description was given
 * getPiaProxyUrl(store) — the stored pia-proxy URL, or null if never set
 * parseSetPiaProxyUrlBody(raw) — validates {value: a non-empty http(s) URL}; undefined on any
 *   malformed shape
 * setPiaProxyUrl(store, value) — upserts pia_proxy_url
 *
 * @contract
 *   assertions:
 *     purity:          parseSetTimezoneBody/isValidTimeZone/parseSetNotificationSettingsBody/
 *                      parseSetScreenLockSettingsBody/parseSetPiaProxyUrlBody/
 *                      parseSetPersonaSettingsBody are pure; the rest are impure (Postgres IO via
 *                      the injected settings store)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected OrchestratorSettingsStore)]
 */

import type { OrchestratorSettingsStore } from '../../io/orchestratorSettings.js';

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

// --- Notification settings (docs/bb_principles.md §13, §2 — neither value is reasoning, one's a
// selector and the other a toggle) ---
// Live-read shape, same as timezone: sendPushNotificationTool.ts reads both fresh
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

// --- Screen lock settings (docs/bi_principles.md §12, §13 — ported from SillyTavern-Playground's
// driver/ui/lockScreen.js) ---
// password isn't a secret by §12's own test: it protects nothing the real household-key/Access
// auth in App.tsx hasn't already gated, purely a privacy shield for an unattended screen. Read
// back and displayed in full, same shape as timezone/notifications above, not write-only like a
// provider credential. Empty password (the default) means the feature is off.

export interface ScreenLockSettings {
  password: string;
  timeoutMinutes: number;
}

const DEFAULT_SCREEN_LOCK_TIMEOUT_MINUTES = 5;

export async function getScreenLockSettings(store: OrchestratorSettingsStore): Promise<ScreenLockSettings> {
  const password = (await store.get('screen_lock_password')) ?? '';
  const rawTimeout = await store.get('screen_lock_timeout_minutes');
  const timeoutMinutes = rawTimeout ? Number(rawTimeout) : DEFAULT_SCREEN_LOCK_TIMEOUT_MINUTES;
  return { password, timeoutMinutes: Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes : DEFAULT_SCREEN_LOCK_TIMEOUT_MINUTES };
}

export interface SetScreenLockSettingsBody {
  password?: string;
  timeoutMinutes?: number;
}

export function parseSetScreenLockSettingsBody(raw: unknown): SetScreenLockSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { password, timeout_minutes } = raw as Record<string, unknown>;
  if (password === undefined && timeout_minutes === undefined) return undefined;
  if (password !== undefined && typeof password !== 'string') return undefined;
  if (timeout_minutes !== undefined && (typeof timeout_minutes !== 'number' || !Number.isFinite(timeout_minutes) || timeout_minutes <= 0)) {
    return undefined;
  }
  return {
    password: typeof password === 'string' ? password : undefined,
    timeoutMinutes: typeof timeout_minutes === 'number' ? timeout_minutes : undefined,
  };
}

export async function setScreenLockSettings(store: OrchestratorSettingsStore, body: SetScreenLockSettingsBody): Promise<void> {
  if (body.password !== undefined) await store.set('screen_lock_password', body.password);
  if (body.timeoutMinutes !== undefined) await store.set('screen_lock_timeout_minutes', String(body.timeoutMinutes));
}

// --- Persona settings (migration 0053, docs/plans/prompt-macros.md's Stage 1) ---
// The household's own name and self-description — read back and displayed in full, same shape as
// screen lock/notifications above, not write-only like a provider credential. Empty (the default)
// means the 'persona' prompt-stack marker slot has nothing to inject even if a preset enables it
// (assemblePromptStack.ts already treats an empty/undefined field as "skip this slot").

export interface PersonaSettings {
  name: string;
  description: string;
}

export async function getPersonaSettings(store: OrchestratorSettingsStore): Promise<PersonaSettings> {
  const name = (await store.get('persona_name')) ?? '';
  const description = (await store.get('persona_description')) ?? '';
  return { name, description };
}

export interface SetPersonaSettingsBody {
  name?: string;
  description?: string;
}

export function parseSetPersonaSettingsBody(raw: unknown): SetPersonaSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, description } = raw as Record<string, unknown>;
  if (name === undefined && description === undefined) return undefined;
  if (name !== undefined && typeof name !== 'string') return undefined;
  if (description !== undefined && typeof description !== 'string') return undefined;
  return {
    name: typeof name === 'string' ? name : undefined,
    description: typeof description === 'string' ? description : undefined,
  };
}

export async function setPersonaSettings(store: OrchestratorSettingsStore, body: SetPersonaSettingsBody): Promise<void> {
  if (body.name !== undefined) await store.set('persona_name', body.name);
  if (body.description !== undefined) await store.set('persona_description', body.description);
}

// --- pia-proxy settings (io/piaProxyFetch.ts, migration 0052) ---
// Same live-read, no-restart shape as ntfy_server_url — a plain internal container address, not a
// secret, so it's read back and displayed in full rather than only reported as "configured".

export async function getPiaProxyUrl(store: OrchestratorSettingsStore): Promise<string | null> {
  return (await store.get('pia_proxy_url')) ?? null;
}

export function parseSetPiaProxyUrlBody(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { value } = raw as Record<string, unknown>;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }
  return value;
}

export function setPiaProxyUrl(store: OrchestratorSettingsStore, value: string): Promise<void> {
  return store.set('pia_proxy_url', value);
}