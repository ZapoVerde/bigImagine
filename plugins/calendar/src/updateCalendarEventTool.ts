/**
 * @file plugins/calendar/src/updateCalendarEventTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — edits a native (bigBrain-owned) calendar event
 * @description
 * Only ever touches source = 'native' rows — a Cozi/Outlook row is exclusively icsSync.ts's to
 * write, and a Google-originated row (source = 'google') is edited through this same tool once it
 * exists locally, since from bigBrain's side it's just another calendar_events row; the WHERE
 * clause below scopes by event_id + user_id (RLS-equivalent belt-and-braces, same pattern
 * deleteCalendarEventTool.ts uses), not by source, so both cases work identically.
 *
 * Added alongside create/delete specifically because real bidirectional Google sync needs edit
 * parity in both directions — docs/spec.md §6.7 deferred update/delete on native events "until
 * real use shows they're needed"; this is that use.
 *
 * Every field is optional except event_id — only the given fields are changed, same partial-patch
 * shape as adminServer.ts's settings setters. Best-effort pushed to Google afterward
 * (googleOutboundSync.ts's pushUpdateToGoogle), a no-op if this row was never mirrored.
 *
 * visibility ('private' | 'shared', db/migrations/0025_calendar_links_visibility.sql) is the one
 * field with side effects beyond its own column: flipping private → shared mints a Google mapping
 * for a row that was never pushed (pushCreateToGoogle, same as if it had been created shared from
 * the start); flipping shared → private pulls it back off Google (pushDeleteToGoogle) and drops
 * the now-stale calendar_google_sync_map row, so a demoted event doesn't linger on the household's
 * real Google Calendar. Staying shared with other fields edited still just calls
 * pushUpdateToGoogle as before; staying private skips Google entirely.
 *
 * @api-declaration
 * createUpdateCalendarEventTool(googleClient) — returns the update_calendar_event RegisteredTool
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
import { sourceMeta, type CalendarSource } from './sourceMeta.js';
import { pushCreateToGoogle, pushDeleteToGoogle, pushUpdateToGoogle, lookupGoogleEventId } from './googleOutboundSync.js';

const VALID_VISIBILITIES = ['private', 'shared'] as const;
type CalendarVisibility = (typeof VALID_VISIBILITIES)[number];

interface UpdateCalendarEventArgs {
  event_id: string;
  title?: string;
  start_time?: string;
  end_time?: string;
  description?: string;
  assigned_members?: string[];
  visibility?: CalendarVisibility;
}

function isUpdateCalendarEventArgs(value: unknown): value is UpdateCalendarEventArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.event_id !== 'string' || v.event_id === '') return false;
  if (v.title !== undefined && (typeof v.title !== 'string' || v.title === '')) return false;
  if (v.start_time !== undefined && typeof v.start_time !== 'string') return false;
  if (v.end_time !== undefined && typeof v.end_time !== 'string') return false;
  if (v.description !== undefined && typeof v.description !== 'string') return false;
  if (v.assigned_members !== undefined) {
    if (!Array.isArray(v.assigned_members) || !v.assigned_members.every((m) => typeof m === 'string')) return false;
  }
  if (v.visibility !== undefined && !VALID_VISIBILITIES.includes(v.visibility as CalendarVisibility)) return false;
  return true;
}

interface ExistingEventRow {
  source: CalendarSource;
  title: string;
  description: string | null;
  location: string | null;
  start_time: string;
  end_time: string;
  all_day: boolean;
  visibility: CalendarVisibility;
}

export function createUpdateCalendarEventTool(googleClient: GoogleCalendarClient | undefined): RegisteredTool {
  return {
    definition: {
      name: 'update_calendar_event',
      description: 'Edit an existing calendar event. Only the given fields are changed.',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'The event to update, from get_calendar_schedule.' },
          title: { type: 'string', description: 'New title.' },
          start_time: { type: 'string', description: 'New start time, as an ISO 8601 timestamp.' },
          end_time: { type: 'string', description: 'New end time, as an ISO 8601 timestamp.' },
          description: { type: 'string', description: 'New free-text details.' },
          assigned_members: {
            type: 'array',
            items: { type: 'string' },
            description: 'New informational household-member tags — replaces the existing list.',
          },
          visibility: {
            type: 'string',
            enum: [...VALID_VISIBILITIES],
            description: 'Change whether this event syncs to the household\'s external Google Calendar connection.',
          },
        },
        required: ['event_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isUpdateCalendarEventArgs(args)) {
        throw new Error('update_calendar_event requires event_id, and at least one field to change');
      }

      const existingRows = await ctx.db.query<ExistingEventRow>(
        `select source, title, description, location, start_time, end_time, all_day, visibility
         from calendar_events where event_id = $1 and user_id = $2`,
        [args.event_id, ctx.userId],
      );
      const existing = existingRows[0];
      if (!existing) throw new Error(`update_calendar_event: no event ${args.event_id} for this user`);

      let startTime = existing.start_time;
      let endTime = existing.end_time;
      if (args.start_time !== undefined) {
        const parsed = new Date(args.start_time);
        if (Number.isNaN(parsed.getTime())) throw new Error('update_calendar_event: start_time must be a valid ISO 8601 timestamp');
        startTime = parsed.toISOString();
      }
      if (args.end_time !== undefined) {
        const parsed = new Date(args.end_time);
        if (Number.isNaN(parsed.getTime())) throw new Error('update_calendar_event: end_time must be a valid ISO 8601 timestamp');
        endTime = parsed.toISOString();
      }
      if (new Date(endTime) < new Date(startTime)) throw new Error('update_calendar_event: end_time must not be before start_time');

      const title = args.title ?? existing.title;
      const description = args.description !== undefined ? args.description : existing.description;
      const previousVisibility = existing.visibility; // captured before the update below — a same-referenced fake-pool row in tests would otherwise appear already mutated by the time this is checked
      const visibility = args.visibility ?? previousVisibility;

      await ctx.db.query(
        `update calendar_events set title = $3, description = $4, start_time = $5, end_time = $6,
           assigned_members = coalesce($7, assigned_members), visibility = $8, updated_at = now()
         where event_id = $1 and user_id = $2`,
        [args.event_id, ctx.userId, title, description, startTime, endTime, args.assigned_members ?? null, visibility],
      );

      const pushInput = { title, description, location: existing.location, startTime, endTime, allDay: existing.all_day };
      if (visibility === 'shared' && previousVisibility === 'private') {
        // never mirrored — mint it now, same as a fresh create
        await pushCreateToGoogle(ctx.db, googleClient, args.event_id, pushInput);
      } else if (visibility === 'private' && previousVisibility === 'shared') {
        // pull it back off Google so a demoted event doesn't linger there
        const googleEventId = await lookupGoogleEventId(ctx.db, args.event_id);
        await pushDeleteToGoogle(googleClient, googleEventId);
        await ctx.db.query('delete from calendar_google_sync_map where event_id = $1', [args.event_id]);
      } else if (visibility === 'shared') {
        await pushUpdateToGoogle(ctx.db, googleClient, args.event_id, pushInput);
      }

      return {
        eventId: args.event_id,
        source: existing.source,
        ...sourceMeta(existing.source),
        title,
        startTime,
        endTime,
        visibility,
      };
    },
  };
}
