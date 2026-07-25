/**
 * @file plugins/calendar/src/googleOutboundSync.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — outbound half of bidirectional Google Calendar sync
 * (docs/spec.md §6.7)
 * @description
 * The push counterpart to googleSync.ts's poll-based pull: called by
 * createCalendarEventTool.ts/updateCalendarEventTool.ts/deleteCalendarEventTool.ts right after
 * their own local calendar_events write succeeds, same "never fail the tool call if the external
 * write fails" rule plugins/lists/src/notionSync.ts already established for Notion. A client
 * (undefined when Google Calendar isn't configured) makes every function here a no-op — the
 * calendar keeps working fully without it.
 *
 * pushCreateToGoogle mints the calendar_google_sync_map row in the same flow as the Google
 * insert, closing the exact race window spec.md §6.4 Correction 5 found for Notion (there, the
 * fix — a unique constraint on the remote id — was applied only after the bug was caught live;
 * here it's already on calendar_google_sync_map.google_event_id from
 * 0018_google_calendar_oauth.sql, so the rare loser of this race is only ever logged, never a
 * silent duplicate).
 *
 * pushDeleteToGoogle takes an already-looked-up googleEventId rather than looking it up itself,
 * because the caller (deleteCalendarEventTool.ts) must resolve it *before* deleting the local
 * calendar_events row — that delete cascades the sync-map row away, so the mapping would already
 * be gone by the time a post-delete lookup ran.
 *
 * @api-declaration
 * lookupGoogleEventId(session, eventId) — the mapped Google event id, or undefined if this row
 *   was never mirrored (created before a connection existed, or Google-originated)
 * pushCreateToGoogle(session, client, eventId, input) — inserts on Google, mints the mapping
 * pushUpdateToGoogle(session, client, eventId, input) — no-ops if never mapped
 * pushDeleteToGoogle(client, googleEventId) — no-ops if given no id (never mapped)
 *
 * @contract
 *   assertions:
 *     purity:          impure (network calls via client, Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [the Google Calendar API via client, Postgres]
 */

import { log } from '@bigbrain/orchestrator/logger';
import type { DbSession } from '@bigbrain/orchestrator/postgres';
import type { GoogleCalendarClient, GoogleCalendarEventInput } from '@bigbrain/orchestrator/google-calendar';

export async function lookupGoogleEventId(session: DbSession, eventId: string): Promise<string | undefined> {
  const rows = await session.query<{ google_event_id: string }>(
    'select google_event_id from calendar_google_sync_map where event_id = $1',
    [eventId],
  );
  return rows[0]?.google_event_id;
}

export async function pushCreateToGoogle(
  session: DbSession,
  client: GoogleCalendarClient | undefined,
  eventId: string,
  input: GoogleCalendarEventInput,
): Promise<void> {
  if (!client) return;
  try {
    const { googleEventId, updatedAt } = await client.insertEvent(input);
    const mapped = await session.query(
      `insert into calendar_google_sync_map (event_id, google_event_id, google_updated_at)
       values ($1, $2, $3)
       on conflict (google_event_id) do nothing
       returning sync_id`,
      [eventId, googleEventId, updatedAt],
    );
    if (mapped.length === 0) {
      log.error(
        `google calendar sync: race creating event ${eventId} — an inbound poll already mapped google event ` +
          `${googleEventId} to a different local row; this local row is now unmirrored and may need manual cleanup`,
      );
    }
  } catch (err) {
    log.error(`failed to push newly created calendar event ${eventId} to Google (local write still succeeded, will not auto-retry)`, err);
  }
}

export async function pushUpdateToGoogle(
  session: DbSession,
  client: GoogleCalendarClient | undefined,
  eventId: string,
  input: GoogleCalendarEventInput,
): Promise<void> {
  if (!client) return;
  const googleEventId = await lookupGoogleEventId(session, eventId);
  if (!googleEventId) return;
  try {
    const { updatedAt } = await client.updateEvent(googleEventId, input);
    await session.query('update calendar_google_sync_map set google_updated_at = $2, last_synced_at = now() where event_id = $1', [
      eventId,
      updatedAt,
    ]);
  } catch (err) {
    log.error(`failed to push updated calendar event ${eventId} to Google (local write still succeeded, will not auto-retry)`, err);
  }
}

export async function pushDeleteToGoogle(client: GoogleCalendarClient | undefined, googleEventId: string | undefined): Promise<void> {
  if (!client || !googleEventId) return;
  try {
    await client.deleteEvent(googleEventId);
  } catch (err) {
    log.error(`failed to push deletion of google calendar event ${googleEventId} (local delete still succeeded, will not auto-retry)`, err);
  }
}
