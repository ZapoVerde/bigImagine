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
import { pushUpdateToGoogle } from './googleOutboundSync.js';

interface UpdateCalendarEventArgs {
  event_id: string;
  title?: string;
  start_time?: string;
  end_time?: string;
  description?: string;
  assigned_members?: string[];
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
        `select source, title, description, location, start_time, end_time, all_day
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

      await ctx.db.query(
        `update calendar_events set title = $3, description = $4, start_time = $5, end_time = $6,
           assigned_members = coalesce($7, assigned_members), updated_at = now()
         where event_id = $1 and user_id = $2`,
        [args.event_id, ctx.userId, title, description, startTime, endTime, args.assigned_members ?? null],
      );

      await pushUpdateToGoogle(ctx.db, googleClient, args.event_id, {
        title,
        description,
        location: existing.location,
        startTime,
        endTime,
        allDay: existing.all_day,
      });

      return {
        eventId: args.event_id,
        source: existing.source,
        ...sourceMeta(existing.source),
        title,
        startTime,
        endTime,
      };
    },
  };
}
