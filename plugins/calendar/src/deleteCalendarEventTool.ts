/**
 * @file plugins/calendar/src/deleteCalendarEventTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — deletes a calendar event
 * @description
 * Deletes any calendar_events row this user owns, scoped by event_id + user_id — same reasoning
 * as updateCalendarEventTool.ts for why this isn't restricted to source = 'native'. A Cozi/Outlook
 * row can also be deleted here (it'll simply reappear on the next ICS poll if the feed still has
 * it — that poll is the actual source of truth, deleting a read-only row locally is just a
 * temporary hide, same as it always implicitly was even before this tool existed).
 *
 * The Google event id must be looked up *before* the local delete, not after — deleting
 * calendar_events cascades away its calendar_google_sync_map row (db/migrations/
 * 0018_google_calendar_oauth.sql's on delete cascade), so a post-delete lookup would always find
 * nothing. See googleOutboundSync.ts's preamble for the same point from the other side.
 *
 * @api-declaration
 * createDeleteCalendarEventTool(googleClient) — returns the delete_calendar_event RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session; network IO via googleClient
 *                      when configured)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), the Google Calendar API when
 *                      googleClient is configured]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import type { GoogleCalendarClient } from '@bigbrain/orchestrator/google-calendar';
import { lookupGoogleEventId, pushDeleteToGoogle } from './googleOutboundSync.js';

interface DeleteCalendarEventArgs {
  event_id: string;
}

function isDeleteCalendarEventArgs(value: unknown): value is DeleteCalendarEventArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.event_id === 'string' && v.event_id !== '';
}

export function createDeleteCalendarEventTool(googleClient: GoogleCalendarClient | undefined): RegisteredTool {
  return {
    definition: {
      name: 'delete_calendar_event',
      description: 'Permanently remove a calendar event.',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'The event to delete, from get_calendar_schedule.' },
        },
        required: ['event_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isDeleteCalendarEventArgs(args)) {
        throw new Error('delete_calendar_event requires event_id');
      }

      const googleEventId = await lookupGoogleEventId(ctx.db, args.event_id);

      const deleted = await ctx.db.query<{ event_id: string }>(
        'delete from calendar_events where event_id = $1 and user_id = $2 returning event_id',
        [args.event_id, ctx.userId],
      );
      if (deleted.length === 0) throw new Error(`delete_calendar_event: no event ${args.event_id} for this user`);

      await pushDeleteToGoogle(googleClient, googleEventId);

      return { eventId: args.event_id, deleted: true };
    },
  };
}
