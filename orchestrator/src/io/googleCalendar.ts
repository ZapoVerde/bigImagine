/**
 * @file orchestrator/src/io/googleCalendar.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — Google Calendar API access for the household calendar's
 * bidirectional sync (docs/spec.md §6.7)
 * @description
 * The OAuth counterpart to io/notion.ts's best-effort external-mirror shape: config is optional
 * (createGoogleCalendarClient returns undefined when the refresh token/client id/secret aren't
 * all resolved), never load-bearing — the calendar works fully without it, same as Notion sync
 * for lists.
 *
 * Unlike Notion's static integration token, Google's OAuth requires a short-lived access token
 * minted from a long-lived refresh token before every API call. getAccessToken() caches that
 * access token in a closure (same shape as notion.ts's closured throttle state) and only re-hits
 * Google's token endpoint once the cached one is within EXPIRY_SKEW_MS of expiring — cheap for
 * household-scale traffic (one poll every few minutes plus the occasional tool call), no need for
 * anything heavier.
 *
 * exchangeAuthCode is the one-shot half of the OAuth dance, used only by
 * server/adminServer.ts's callback route handler during the initial "Connect Google Calendar"
 * flow — everything else here assumes a refresh token already exists.
 *
 * Recurring events are expanded server-side (singleEvents=true on events.list) rather than
 * parsed from RRULE/EXDATE here, same outcome as icsSync.ts's node-ical expansion but done by
 * Google instead of a local library — one row per occurrence either way.
 *
 * @api-declaration
 * exchangeAuthCode(code, redirectUri, clientId, clientSecret) -> { accessToken, refreshToken,
 *   expiresAt } — throws on a non-2xx response; refreshToken is only present on Google's first
 *   grant for a given consent (offline access + prompt=consent forces this), never on later calls
 * createGoogleCalendarClient(config) -> GoogleCalendarClient | undefined — undefined unless
 *   clientId/clientSecret/refreshToken are all given
 *   .listEvents(syncToken?) -> { events, nextSyncToken } — full sync (bounded to now-forward) when
 *     syncToken is omitted or Google reports it expired (410); incremental otherwise
 *   .insertEvent(input) -> { googleEventId, updatedAt }
 *   .updateEvent(googleEventId, input) -> { updatedAt }
 *   .deleteEvent(googleEventId) -> void (a 404/410 from Google — already gone — is not an error)
 *
 * @contract
 *   assertions:
 *     purity:          impure (network calls)
 *     state_ownership: [the cached access token + its expiry, per client instance]
 *     external_io:     [Google's OAuth token endpoint, the Calendar API]
 */

import { fetchWithRetry } from './httpRetry.js';
import { log } from './logger.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';
const EXPIRY_SKEW_MS = 60_000; // refresh a bit before actual expiry rather than racing it
const EVENT_FIELDS = 'nextSyncToken,nextPageToken,items(id,status,summary,description,location,start,end,updated)';

export interface GoogleTokenResult {
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: number; // epoch ms
}

async function requestToken(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const response = await fetchWithRetry(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google OAuth token endpoint error ${response.status}: ${errorBody}`);
  }
  return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
}

export async function exchangeAuthCode(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<GoogleTokenResult> {
  const payload = await requestToken({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  };
}

export interface GoogleCalendarEvent {
  googleEventId: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  title: string;
  description: string | null;
  location: string | null;
  startTime: string;
  endTime: string;
  allDay: boolean;
  updatedAt: string;
}

export interface GoogleCalendarEventInput {
  title: string;
  description?: string | null;
  location?: string | null;
  startTime: string;
  endTime: string;
  allDay: boolean;
}

export interface GoogleCalendarClientConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
}

export interface GoogleCalendarClient {
  readonly calendarId: string;
  listEvents(syncToken?: string): Promise<{ events: GoogleCalendarEvent[]; nextSyncToken: string }>;
  insertEvent(input: GoogleCalendarEventInput): Promise<{ googleEventId: string; updatedAt: string }>;
  updateEvent(googleEventId: string, input: GoogleCalendarEventInput): Promise<{ updatedAt: string }>;
  deleteEvent(googleEventId: string): Promise<void>;
}

// date-only (all-day) uses YYYY-MM-DD; timed events use a full RFC3339 dateTime. calendar_events
// only stores timestamptz + an allDay flag (db/migrations/0013_calendar.sql), so the boundary
// between the two Google shapes is decided here, once, same as icsSync.ts's own allDay handling.
function toGoogleTime(iso: string, allDay: boolean): { date: string } | { dateTime: string } {
  return allDay ? { date: iso.slice(0, 10) } : { dateTime: iso };
}

function fromGoogleTime(value: { date?: string; dateTime?: string }): { iso: string; allDay: boolean } {
  if (value.date) return { iso: `${value.date}T00:00:00.000Z`, allDay: true };
  return { iso: value.dateTime ?? new Date().toISOString(), allDay: false };
}

interface RawGoogleEvent {
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  updated: string;
}

function parseEvent(raw: RawGoogleEvent): GoogleCalendarEvent {
  const start = fromGoogleTime(raw.start ?? {});
  const end = fromGoogleTime(raw.end ?? {});
  return {
    googleEventId: raw.id,
    status: raw.status,
    title: raw.summary ?? '(untitled event)',
    description: raw.description ?? null,
    location: raw.location ?? null,
    startTime: start.iso,
    endTime: end.iso,
    allDay: start.allDay,
    updatedAt: raw.updated,
  };
}

function eventBody(input: GoogleCalendarEventInput) {
  return {
    summary: input.title,
    description: input.description ?? undefined,
    location: input.location ?? undefined,
    start: toGoogleTime(input.startTime, input.allDay),
    end: toGoogleTime(input.endTime, input.allDay),
  };
}

export function createGoogleCalendarClient(config: Partial<GoogleCalendarClientConfig>): GoogleCalendarClient | undefined {
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    log.info('Google Calendar sync not configured (client id/secret/refresh token not all resolved) — calendar will not sync to Google');
    return undefined;
  }
  const { clientId, clientSecret, refreshToken } = config;
  const calendarId = config.calendarId ?? 'primary';

  let cachedAccessToken: string | undefined;
  let cachedExpiresAt = 0;

  async function getAccessToken(): Promise<string> {
    if (cachedAccessToken && Date.now() < cachedExpiresAt - EXPIRY_SKEW_MS) return cachedAccessToken;
    const payload = await requestToken({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    });
    cachedAccessToken = payload.access_token;
    cachedExpiresAt = Date.now() + payload.expires_in * 1000;
    return cachedAccessToken;
  }

  async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const accessToken = await getAccessToken();
    return fetchWithRetry(`${API_BASE}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    });
  }

  return {
    calendarId,

    async listEvents(syncToken?: string) {
      const events: GoogleCalendarEvent[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | undefined;
      let effectiveSyncToken = syncToken;
      let didFullResyncFallback = false;

      for (;;) {
        const params = new URLSearchParams({ singleEvents: 'true', showDeleted: 'true', fields: EVENT_FIELDS });
        if (effectiveSyncToken) {
          params.set('syncToken', effectiveSyncToken);
        } else {
          params.set('timeMin', new Date().toISOString()); // forward-looking only, same convention as icsSync.ts's 90-day window
        }
        if (pageToken) params.set('pageToken', pageToken);

        const response = await apiFetch(`/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`);

        if (response.status === 410 && effectiveSyncToken && !didFullResyncFallback) {
          // Expired/invalid sync token — Google's documented recovery is to drop it and do one
          // full resync from scratch, exactly like icsSync.ts already treats every ICS poll as a
          // full reparse (no incremental concept there at all).
          log.warn('Google Calendar sync token expired (410) — falling back to a full resync');
          effectiveSyncToken = undefined;
          didFullResyncFallback = true;
          pageToken = undefined;
          events.length = 0;
          continue;
        }
        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Google Calendar events.list error ${response.status}: ${errorBody}`);
        }

        const payload = (await response.json()) as { items?: RawGoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };
        events.push(...(payload.items ?? []).map(parseEvent));
        pageToken = payload.nextPageToken;
        if (payload.nextSyncToken) nextSyncToken = payload.nextSyncToken;
        if (!pageToken) break;
      }

      if (!nextSyncToken) throw new Error('Google Calendar events.list never returned a nextSyncToken');
      return { events, nextSyncToken };
    },

    async insertEvent(input) {
      const response = await apiFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
        method: 'POST',
        body: JSON.stringify(eventBody(input)),
      });
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Google Calendar events.insert error ${response.status}: ${errorBody}`);
      }
      const payload = (await response.json()) as { id: string; updated: string };
      return { googleEventId: payload.id, updatedAt: payload.updated };
    },

    async updateEvent(googleEventId, input) {
      const response = await apiFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`, {
        method: 'PATCH',
        body: JSON.stringify(eventBody(input)),
      });
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Google Calendar events.update error ${response.status}: ${errorBody}`);
      }
      const payload = (await response.json()) as { updated: string };
      return { updatedAt: payload.updated };
    },

    async deleteEvent(googleEventId) {
      const response = await apiFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`, {
        method: 'DELETE',
      });
      if (!response.ok && response.status !== 404 && response.status !== 410) {
        const errorBody = await response.text();
        throw new Error(`Google Calendar events.delete error ${response.status}: ${errorBody}`);
      }
    },
  };
}
