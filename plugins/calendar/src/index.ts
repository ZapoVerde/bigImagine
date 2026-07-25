/**
 * @file plugins/calendar/src/index.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as lists/recipes/notes): an `info`
 * object, an async `registerTools`, and an optional `startBackgroundJobs`. get_calendar_schedule
 * closes over deps.settings to resolve household_timezone live on every call
 * (getCalendarScheduleTool.ts) — everything else is ctx.db/ctx.userId, supplied per-call.
 *
 * ICS feed URLs are secrets (docs/bb_principles.md §12: a capability URL grants access on its
 * own, same as an API key) — resolved via deps.credentials ('cozi_ics_url'/'outlook_ics_url',
 * db/migrations/0014_calendar_ics_credentials.sql), same encrypted write-only store index.ts uses
 * for the LLM/Notion keys, editable from the Settings tab rather than a .env round-trip. The
 * owning user id and the masking flag are NOT secrets — neither grants access on its own — but
 * per docs/bb_principles.md §13 they're still DB-backed (orchestrator_settings via deps.settings,
 * db/migrations/0015_settings_owner_ids.sql), Settings-tab-editable, plaintext, not .env-only:
 * only the legacy BIGBRAIN_CALENDAR_OWNER_USER_ID/BIGBRAIN_MASK_WORK_CALENDAR env vars remain, as
 * the fallback when the DB has no value yet.
 *
 * Google Calendar (docs/spec.md §6.7) is a separate, OAuth-based connection, not an ICS feed — its
 * client id/owner user id/calendar id come from deps.settings, its client secret/refresh token
 * (secrets, §12) from deps.credentials ('google_calendar_client_secret'/
 * 'google_calendar_refresh_token', db/migrations/0018_google_calendar_oauth.sql). No PluginDeps
 * change was needed for this — unlike io/notion.ts's client (shared with plugins/recipes, so
 * index.ts constructs it once and threads it through PluginDeps), nothing outside this plugin
 * needs a Google Calendar client, so resolveGoogleCalendarClient below is called independently by
 * both registerTools (to inject into create/update/delete) and startBackgroundJobs (to start
 * googleSync.ts's poll loop) — same self-resolving pattern the Cozi/Outlook ICS URLs already use.
 *
 * Best-effort like Notion sync: any feed/connection that fails to resolve (unset, or explicitly
 * unmanaged) is simply skipped — ICS sync and Google sync are independent and either, both, or
 * neither can be configured; native events via create/update/delete_calendar_event always work
 * regardless.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [get_calendar_schedule, create_calendar_event,
 *   update_calendar_event, delete_calendar_event]
 * startBackgroundJobs(deps) — resolves ICS feed credentials and the Google Calendar connection,
 *   then starts whichever poll loop(s) (icsSync.ts, googleSync.ts) have what they need configured
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO; resolves credentials/settings; starts
 *                      background poll timers when configured)
 *     state_ownership: [the ICS sync poll timer and the Google sync poll timer, when started]
 *     external_io:     [Postgres, via deps.credentials/deps.settings, before either poll timer
 *                      itself starts]
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { log } from '@bigbrain/orchestrator/logger';
import { createGoogleCalendarClient, type GoogleCalendarClient } from '@bigbrain/orchestrator/google-calendar';
import { createGetCalendarScheduleTool } from './getCalendarScheduleTool.js';
import { createCreateCalendarEventTool } from './createCalendarEventTool.js';
import { createUpdateCalendarEventTool } from './updateCalendarEventTool.js';
import { createDeleteCalendarEventTool } from './deleteCalendarEventTool.js';
import { startIcsSyncLoop, type IcsFeedConfig } from './icsSync.js';
import { startGoogleSyncLoop } from './googleSync.js';

const ICS_POLL_INTERVAL_MS = 30 * 60_000; // ICS feeds publish on their own schedule; unlike Notion's ~30s reconcile, near-real-time isn't needed
const GOOGLE_POLL_INTERVAL_MS = 5 * 60_000; // closer to real bidirectional than ICS, without needing Google's push-channel webhooks

export const info = {
  id: 'calendar',
  name: 'Calendar',
  description: 'Household calendar: read-only Cozi/Outlook feeds and bidirectional Google Calendar sync, aggregated with native bigBrain events.',
};

async function resolveGoogleCalendarClient(deps: PluginDeps): Promise<GoogleCalendarClient | undefined> {
  const [clientId, clientSecret, refreshToken, calendarId] = await Promise.all([
    deps.settings.get('google_calendar_client_id'),
    deps.credentials.resolve('google_calendar_client_secret', undefined),
    deps.credentials.resolve('google_calendar_refresh_token', undefined),
    deps.settings.get('google_calendar_id'),
  ]);
  return createGoogleCalendarClient({ clientId, clientSecret, refreshToken, calendarId });
}

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  const googleClient = await resolveGoogleCalendarClient(deps);
  return [
    createGetCalendarScheduleTool(deps.settings),
    createCreateCalendarEventTool(googleClient),
    createUpdateCalendarEventTool(googleClient),
    createDeleteCalendarEventTool(googleClient),
  ];
}

export async function startBackgroundJobs(deps: PluginDeps): Promise<void> {
  const ownerUserId = (await deps.settings.get('calendar_owner_user_id')) ?? process.env.BIGBRAIN_CALENDAR_OWNER_USER_ID;
  if (!ownerUserId) {
    log.info('calendar: no owning user configured (Settings tab or BIGBRAIN_CALENDAR_OWNER_USER_ID), ICS/Google sync disabled (native events via create/update/delete_calendar_event still work)');
  } else {
    const [coziUrl, outlookUrl, maskSetting] = await Promise.all([
      deps.credentials.resolve('cozi_ics_url', process.env.BIGBRAIN_COZI_ICS_URL),
      deps.credentials.resolve('outlook_ics_url', process.env.BIGBRAIN_OUTLOOK_ICS_URL),
      deps.settings.get('mask_work_calendar'),
    ]);

    const feeds: IcsFeedConfig[] = [];
    if (coziUrl) feeds.push({ source: 'cozi', url: coziUrl });
    if (outlookUrl) feeds.push({ source: 'outlook', url: outlookUrl });

    if (feeds.length === 0) {
      log.info('calendar: neither cozi_ics_url nor outlook_ics_url is configured (Settings tab or BIGBRAIN_*_ICS_URL seed), ICS sync disabled');
    } else {
      const maskWorkCalendar = (maskSetting ?? process.env.BIGBRAIN_MASK_WORK_CALENDAR) === 'true';
      startIcsSyncLoop(deps.db, { ownerUserId, feeds, maskWorkCalendar }, ICS_POLL_INTERVAL_MS);
    }
  }

  const googleOwnerUserId = await deps.settings.get('google_calendar_owner_user_id');
  if (!googleOwnerUserId) {
    log.info('calendar: no google_calendar_owner_user_id configured, Google Calendar sync disabled');
    return;
  }
  const googleClient = await resolveGoogleCalendarClient(deps);
  if (!googleClient) {
    log.info('calendar: Google Calendar not fully configured (client id/secret/refresh token), sync disabled');
    return;
  }
  startGoogleSyncLoop(deps.db, googleClient, googleOwnerUserId, deps.settings, GOOGLE_POLL_INTERVAL_MS);
}
