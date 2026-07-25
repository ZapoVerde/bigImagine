/**
 * @file plugins/calendar/src/googleSync.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — inbound half of bidirectional Google Calendar sync
 * (docs/spec.md §6.7)
 * @description
 * Mirrors icsSync.ts's poll-loop shape (internal scheduled job, not an HTTP route — the
 * orchestrator accepts zero unauthenticated inbound traffic outside the one OAuth callback
 * exception documented in server/adminServer.ts), but talks to Google's API via a syncToken
 * instead of re-parsing a whole ICS feed every time. Cadence is minutes, not the ICS loop's 30 —
 * closer to real bidirectional without needing Google's push-channel webhooks (which need a
 * public, renewal-managed endpoint — against this codebase's consistent poll-over-webhook bias).
 *
 * calendar_google_sync_map (db/migrations/0018_google_calendar_oauth.sql) is the same
 * mint-and-stamp identity mechanism notion_sync_map already established for Lists: the only place
 * a calendar_events row is linked to a Google event id. Reconciliation logic here handles only the
 * *inbound* direction (a Google-originated create/update/delete arriving on a poll); the outbound
 * direction (a bigBrain-originated create/update/delete pushed to Google, minting the same mapping
 * row) lives in createCalendarEventTool.ts/updateCalendarEventTool.ts/deleteCalendarEventTool.ts,
 * right after their own local Postgres write succeeds.
 *
 * Conflict rule is plain last-write-wins by timestamp — Google's own `updated` on the event vs.
 * this row's calendar_events.updated_at — no merge logic, same "no LLM-guessed merges" stance
 * spec.md §6.4 already takes for Notion sync. A row where local is newer than what this poll saw
 * from Google is left alone (the intended edit either already reached Google via the outbound
 * push, or a prior outbound push failed and will retry next edit — same acceptable gap Notion sync
 * documents for its own best-effort outbound pushes).
 *
 * Unlike Notion sync (never deletes list_items inbound — an "orphan" there is always a legitimate
 * new item), a Google event reporting status: 'cancelled' *does* delete the local row here. This
 * is real, deliberate two-way delete propagation, new territory for this codebase.
 *
 * @api-declaration
 * syncGoogleOnce(db, client, ownerUserId, settings) — one full poll cycle: list changed events
 *   since the stored syncToken, reconcile each, persist the returned nextSyncToken
 * startGoogleSyncLoop(db, client, ownerUserId, settings, intervalMs) — runs an immediate sync,
 *   then returns the interval handle (unref'd so it never keeps the process alive on its own)
 *
 * @contract
 *   assertions:
 *     purity:          impure (network calls via client, Postgres IO, owns a timer)
 *     state_ownership: [the setInterval timer it starts]
 *     external_io:     [the Google Calendar API via client, Postgres, orchestrator_settings via
 *                      settings]
 */

import { log } from '@bigbrain/orchestrator/logger';
import type { PostgresClient, DbSession } from '@bigbrain/orchestrator/postgres';
import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { GoogleCalendarClient, GoogleCalendarEvent } from '@bigbrain/orchestrator/google-calendar';

type OrchestratorSettingsStore = PluginDeps['settings'];

const SYNC_TOKEN_KEY = 'google_calendar_sync_token';

interface MappedRow {
  event_id: string;
  updated_at: string;
}

async function reconcileOneEvent(session: DbSession, ownerUserId: string, event: GoogleCalendarEvent): Promise<void> {
  const mapped = await session.query<MappedRow>(
    `select ce.event_id, ce.updated_at
     from calendar_google_sync_map gsm
     join calendar_events ce on ce.event_id = gsm.event_id
     where gsm.google_event_id = $1`,
    [event.googleEventId],
  );
  const existing = mapped[0];

  if (existing) {
    if (event.status === 'cancelled') {
      await session.query('delete from calendar_events where event_id = $1', [existing.event_id]); // cascades the sync-map row
      return;
    }

    if (new Date(event.updatedAt) > new Date(existing.updated_at)) {
      await session.query(
        `update calendar_events set title = $2, description = $3, location = $4, start_time = $5, end_time = $6, all_day = $7, updated_at = now()
         where event_id = $1`,
        [existing.event_id, event.title, event.description, event.location, event.startTime, event.endTime, event.allDay],
      );
    } // else: local is newer — a pending or failed outbound push, not this poll's problem to overwrite

    await session.query(
      `update calendar_google_sync_map set google_updated_at = $2, last_synced_at = now() where event_id = $1`,
      [existing.event_id, event.updatedAt],
    );
    return;
  }

  if (event.status === 'cancelled') return; // an event we never knew about, already gone — nothing to adopt or delete

  const inserted = await session.query<{ event_id: string }>(
    `insert into calendar_events (user_id, source, external_id, title, description, location, start_time, end_time, all_day)
     values ($1, 'google', $2, $3, $4, $5, $6, $7, $8)
     returning event_id`,
    [ownerUserId, event.googleEventId, event.title, event.description, event.location, event.startTime, event.endTime, event.allDay],
  );
  const newEventId = inserted[0]!.event_id;

  // on conflict do nothing, not a hard failure: the rare window where an outbound create (tool
  // handler) mints this exact google_event_id's mapping in between this SELECT and this INSERT —
  // see this module's preamble. Logged loudly rather than silently dropped, since a duplicate
  // calendar_events row (this insert above, plus whatever the outbound path created) would then
  // need manual cleanup rather than being auto-merged (no LLM-guessed merges, same as elsewhere).
  const mapResult = await session.query(
    `insert into calendar_google_sync_map (event_id, google_event_id, google_updated_at)
     values ($1, $2, $3)
     on conflict (google_event_id) do nothing
     returning sync_id`,
    [newEventId, event.googleEventId, event.updatedAt],
  );
  if (mapResult.length === 0) {
    log.error(
      `google calendar sync: race adopting event ${event.googleEventId} — an outbound push already mapped it; ` +
        `local row ${newEventId} is now an unmapped duplicate and may need manual cleanup`,
    );
  }
}

export async function syncGoogleOnce(
  db: PostgresClient,
  client: GoogleCalendarClient,
  ownerUserId: string,
  settings: OrchestratorSettingsStore,
): Promise<void> {
  const storedToken = await settings.get(SYNC_TOKEN_KEY);
  const { events, nextSyncToken } = await client.listEvents(storedToken);

  await db.withUserScope(ownerUserId, async (session) => {
    for (const event of events) {
      try {
        await reconcileOneEvent(session, ownerUserId, event);
      } catch (err) {
        log.error(`failed to reconcile google calendar event ${event.googleEventId} (skipped, will retry next poll)`, err);
      }
    }
  });

  await settings.set(SYNC_TOKEN_KEY, nextSyncToken);
  log.info(`synced ${events.length} changed google calendar event(s)`);
}

export function startGoogleSyncLoop(
  db: PostgresClient,
  client: GoogleCalendarClient,
  ownerUserId: string,
  settings: OrchestratorSettingsStore,
  intervalMs: number,
): NodeJS.Timeout {
  syncGoogleOnce(db, client, ownerUserId, settings).catch((err) => log.error('initial google calendar sync failed', err));
  const timer = setInterval(() => {
    syncGoogleOnce(db, client, ownerUserId, settings).catch((err) => log.error('google calendar sync poll failed', err));
  }, intervalMs);
  timer.unref();
  return timer;
}
