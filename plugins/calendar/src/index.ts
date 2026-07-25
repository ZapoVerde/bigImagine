/**
 * @file plugins/calendar/src/index.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as lists/recipes/notes): an `info`
 * object, an async `registerTools`, and an optional `startBackgroundJobs`. Neither tool needs
 * deps.llm/embeddings/cipher/notion. get_calendar_schedule closes over deps.settings to resolve
 * household_timezone live on every call (getCalendarScheduleTool.ts) — everything else is
 * ctx.db/ctx.userId, supplied per-call.
 *
 * ICS feed URLs are secrets (docs/bb_principles.md §12: a capability URL grants access on its
 * own, same as an API key) — resolved via deps.credentials ('cozi_ics_url'/'outlook_ics_url',
 * db/migrations/0014_calendar_ics_credentials.sql), same encrypted write-only store index.ts uses
 * for the LLM/Notion keys, editable from the Settings tab rather than a .env round-trip.
 * BIGBRAIN_COZI_ICS_URL/BIGBRAIN_OUTLOOK_ICS_URL env vars still exist purely as resolve()'s
 * one-time seed-on-first-boot fallback (io/providerCredentials.ts), not the ongoing source of
 * truth. The owning user id and the masking flag are NOT secrets — neither grants access on its
 * own — but per docs/bb_principles.md §13 they're still DB-backed (orchestrator_settings via
 * deps.settings, db/migrations/0015_settings_owner_ids.sql), Settings-tab-editable, plaintext, not
 * .env-only: only the legacy BIGBRAIN_CALENDAR_OWNER_USER_ID/BIGBRAIN_MASK_WORK_CALENDAR env vars
 * remain, as the fallback when the DB has no value yet.
 *
 * Best-effort like Notion sync: any feed that fails to resolve (unset, or explicitly unmanaged) is
 * simply skipped, and the whole poll loop never starts if neither feed nor an owner user id
 * resolves.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [get_calendar_schedule, create_calendar_event]
 * startBackgroundJobs(deps) — resolves ICS feed credentials, then starts the poll loop
 *   (icsSync.ts) if at least one feed configured
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO; resolves credentials; starts a
 *                      background poll timer when at least one ICS feed is configured)
 *     state_ownership: [the ICS sync poll timer, when started]
 *     external_io:     [Postgres, via deps.credentials, before the poll timer itself starts]
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { log } from '@bigbrain/orchestrator/logger';
import { createGetCalendarScheduleTool } from './getCalendarScheduleTool.js';
import { createCreateCalendarEventTool } from './createCalendarEventTool.js';
import { startIcsSyncLoop, type IcsFeedConfig } from './icsSync.js';

const ICS_POLL_INTERVAL_MS = 30 * 60_000; // ICS feeds publish on their own schedule; unlike Notion's ~30s reconcile, near-real-time isn't needed

export const info = {
  id: 'calendar',
  name: 'Calendar',
  description: 'Household calendar: read-only Cozi/Outlook feeds aggregated with native bigBrain events.',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  return [createGetCalendarScheduleTool(deps.settings), createCreateCalendarEventTool()];
}

export async function startBackgroundJobs(deps: PluginDeps): Promise<void> {
  const ownerUserId = (await deps.settings.get('calendar_owner_user_id')) ?? process.env.BIGBRAIN_CALENDAR_OWNER_USER_ID;
  if (!ownerUserId) {
    log.info('calendar: no owning user configured (Settings tab or BIGBRAIN_CALENDAR_OWNER_USER_ID), ICS sync disabled (native events via create_calendar_event still work)');
    return;
  }

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
    return;
  }

  const maskWorkCalendar = (maskSetting ?? process.env.BIGBRAIN_MASK_WORK_CALENDAR) === 'true';
  startIcsSyncLoop(deps.db, { ownerUserId, feeds, maskWorkCalendar }, ICS_POLL_INTERVAL_MS);
}
