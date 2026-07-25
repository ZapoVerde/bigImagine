/**
 * @file plugins/calendar/src/icsSync.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — background ICS polling for the household calendar (docs/spec.md §6.7)
 * @description
 * Internal scheduled poll, not an HTTP route — the orchestrator accepts zero unauthenticated
 * inbound traffic (docs/spec.md §6.4 Correction 6), so this mirrors plugins/lists'
 * notionReconcile.ts poll shape rather than a webhook receiver. Cadence is minutes, not seconds
 * (unlike Notion's ~30s reconcile): ICS feeds publish on Cozi/Outlook's own schedule regardless of
 * how often this polls, and a household calendar doesn't need near-real-time.
 *
 * Recurring events (RRULE) are expanded via node-ical's own expandRecurringEvent(), which already
 * applies RECURRENCE-ID overrides and EXDATE exclusions — a single moved/cancelled occurrence of a
 * recurring event is handled by the library, not re-derived here. One calendar_events row per
 * occurrence, external_id disambiguated by that occurrence's own start time.
 *
 * Each feed is fetched/parsed/upserted independently and best-effort, same isolation as
 * notionReconcile.ts's per-page transactions: a Cozi failure never blocks Outlook, and one bad
 * event within a feed never blocks the rest of that feed.
 *
 * @api-declaration
 * syncFeedOnce(db, ownerUserId, feed, shouldMask) — fetches+parses+upserts one feed, exported for
 *   deterministic verification (same reasoning as notionReconcile.ts's reconcileOnce)
 * syncAllFeedsOnce(db, config) — runs every configured feed once
 * startIcsSyncLoop(db, config, intervalMs) — runs an immediate sync, then returns the interval
 *   handle (unref'd so it never keeps the process alive on its own)
 *
 * @contract
 *   assertions:
 *     purity:          impure (network fetch, Postgres IO, owns a timer)
 *     state_ownership: [the setInterval timer it starts]
 *     external_io:     [whichever ICS URL it's given, Postgres (via PostgresClient)]
 */

import { expandRecurringEvent, parseICS } from 'node-ical';
import type { ParameterValue, VEvent } from 'node-ical';
import { fetchWithRetry } from '@bigbrain/orchestrator/http-retry';
import { log } from '@bigbrain/orchestrator/logger';
import type { PostgresClient } from '@bigbrain/orchestrator/postgres';
import { applyPrivacyMask, type ParsedIcsEvent } from './parseWorkEvent.js';

const EXPANSION_WINDOW_DAYS = 90;

export type IcsSource = 'cozi' | 'outlook';

export interface IcsFeedConfig {
  source: IcsSource;
  url: string;
}

export interface IcsSyncConfig {
  ownerUserId: string;
  feeds: IcsFeedConfig[];
  maskWorkCalendar: boolean;
}

function textValue(value: ParameterValue<string> | undefined): string | null {
  if (value === undefined) return null;
  return typeof value === 'string' ? value : value.val;
}

function toParsedEvents(icsText: string): ParsedIcsEvent[] {
  const parsed = parseICS(icsText);
  const windowStart = new Date();
  const windowEnd = new Date(windowStart.getTime() + EXPANSION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const events: ParsedIcsEvent[] = [];

  for (const component of Object.values(parsed)) {
    if (!component || (component as { type?: string }).type !== 'VEVENT') continue;
    const vevent = component as VEvent;
    if (!vevent.uid || !vevent.start) continue;

    if (vevent.rrule) {
      const instances = expandRecurringEvent(vevent, { from: windowStart, to: windowEnd });
      for (const instance of instances) {
        events.push({
          externalId: `${vevent.uid}::${instance.start.toISOString()}`,
          title: textValue(instance.summary) ?? '(untitled event)',
          description: textValue(instance.event.description),
          location: textValue(instance.event.location),
          startTime: instance.start.toISOString(),
          endTime: instance.end.toISOString(),
          allDay: instance.isFullDay,
        });
      }
      continue;
    }

    if (!vevent.end || vevent.end < windowStart) continue; // a one-off event fully in the past — it never recurs into range
    events.push({
      externalId: vevent.uid,
      title: textValue(vevent.summary) ?? '(untitled event)',
      description: textValue(vevent.description),
      location: textValue(vevent.location),
      startTime: vevent.start.toISOString(),
      endTime: vevent.end.toISOString(),
      allDay: vevent.datetype === 'date',
    });
  }

  return events;
}

async function upsertEvent(db: PostgresClient, ownerUserId: string, source: IcsSource, event: ParsedIcsEvent): Promise<void> {
  await db.withUserScope(ownerUserId, (session) =>
    session.query(
      `insert into calendar_events (user_id, source, external_id, title, description, location, start_time, end_time, all_day)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (source, external_id) do update set
         title = excluded.title,
         description = excluded.description,
         location = excluded.location,
         start_time = excluded.start_time,
         end_time = excluded.end_time,
         all_day = excluded.all_day,
         updated_at = now()`,
      [ownerUserId, source, event.externalId, event.title, event.description, event.location, event.startTime, event.endTime, event.allDay],
    ),
  );
}

export async function syncFeedOnce(db: PostgresClient, ownerUserId: string, feed: IcsFeedConfig, shouldMask: boolean): Promise<void> {
  const response = await fetchWithRetry(feed.url, {});
  if (!response.ok) {
    throw new Error(`fetching ${feed.source} ICS feed failed: ${response.status} ${response.statusText}`);
  }
  const icsText = await response.text();
  const events = toParsedEvents(icsText);
  const toWrite = feed.source === 'outlook' ? events.map((e) => applyPrivacyMask(e, shouldMask)) : events;

  for (const event of toWrite) {
    try {
      await upsertEvent(db, ownerUserId, feed.source, event);
    } catch (err) {
      log.error(`failed to upsert ${feed.source} calendar event ${event.externalId} (skipped, will retry next poll)`, err);
    }
  }

  log.info(`synced ${toWrite.length} event(s) from ${feed.source} calendar feed`);
}

export async function syncAllFeedsOnce(db: PostgresClient, config: IcsSyncConfig): Promise<void> {
  for (const feed of config.feeds) {
    try {
      await syncFeedOnce(db, config.ownerUserId, feed, config.maskWorkCalendar);
    } catch (err) {
      log.error(`${feed.source} calendar sync failed (will retry next interval)`, err);
    }
  }
}

export function startIcsSyncLoop(db: PostgresClient, config: IcsSyncConfig, intervalMs: number): NodeJS.Timeout {
  syncAllFeedsOnce(db, config).catch((err) => log.error('initial calendar sync failed', err));
  const timer = setInterval(() => {
    syncAllFeedsOnce(db, config).catch((err) => log.error('calendar sync poll failed', err));
  }, intervalMs);
  timer.unref();
  return timer;
}
