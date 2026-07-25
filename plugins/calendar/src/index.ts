/**
 * @file plugins/calendar/src/index.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as lists/recipes/notes): an `info`
 * object, an async `registerTools`, and an optional `startBackgroundJobs`. Neither tool needs
 * deps.llm/embeddings/cipher/notion — only ctx.db/ctx.userId, supplied per-call.
 *
 * ICS feed config (Cozi/Outlook URLs, the owning user, the work-calendar masking flag) is read
 * directly from process.env here rather than threaded through PluginDeps — it's calendar-specific
 * config no other plugin needs, unlike the cross-cutting clients (llm/notion/etc.) index.ts
 * constructs centrally. Best-effort like Notion sync: any feed with no URL configured is simply
 * skipped, and the whole poll loop never starts if neither feed nor an owner user id is set.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [get_calendar_schedule, create_calendar_event]
 * startBackgroundJobs(deps) — starts the ICS poll loop (icsSync.ts) if configured
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO; starts a background poll timer when
 *                      at least one ICS feed is configured)
 *     state_ownership: [the ICS sync poll timer, when started]
 *     external_io:     []
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

export async function registerTools(_deps: PluginDeps): Promise<RegisteredTool[]> {
  return [createGetCalendarScheduleTool(), createCreateCalendarEventTool()];
}

export function startBackgroundJobs(deps: PluginDeps): void {
  const ownerUserId = process.env.BIGBRAIN_CALENDAR_OWNER_USER_ID;
  if (!ownerUserId) {
    log.info('calendar: BIGBRAIN_CALENDAR_OWNER_USER_ID unset, ICS sync disabled (native events via create_calendar_event still work)');
    return;
  }

  const feeds: IcsFeedConfig[] = [];
  if (process.env.BIGBRAIN_COZI_ICS_URL) feeds.push({ source: 'cozi', url: process.env.BIGBRAIN_COZI_ICS_URL });
  if (process.env.BIGBRAIN_OUTLOOK_ICS_URL) feeds.push({ source: 'outlook', url: process.env.BIGBRAIN_OUTLOOK_ICS_URL });

  if (feeds.length === 0) {
    log.info('calendar: no BIGBRAIN_COZI_ICS_URL/BIGBRAIN_OUTLOOK_ICS_URL configured, ICS sync disabled');
    return;
  }

  startIcsSyncLoop(
    deps.db,
    { ownerUserId, feeds, maskWorkCalendar: process.env.BIGBRAIN_MASK_WORK_CALENDAR === 'true' },
    ICS_POLL_INTERVAL_MS,
  );
}
