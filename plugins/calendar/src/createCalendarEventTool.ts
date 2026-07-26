/**
 * @file plugins/calendar/src/createCalendarEventTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — creates a native (bigBrain-owned) calendar event
 * @description
 * Always source = 'native': the only calendar_events rows this tool ever writes are ones bigBrain
 * itself owns, never a Cozi/Outlook/Google row (those are exclusively icsSync.ts's/googleSync.ts's
 * to write). external_id has no feed to key against for a native event, so a fresh random id is
 * minted per insert — unique-per-source-and-external_id (db/migrations/0013_calendar.sql) still
 * holds, it just never collides with anything since nothing else ever produces a 'native'
 * external_id.
 *
 * linked_list_item_id/linked_note_id (db/migrations/0025_calendar_links_visibility.sql) let this
 * event point back at the list item or note it was promoted from — set once here, never kept in
 * sync afterward (see that migration's comment for why). At most one of the two may be given.
 *
 * Idempotent when linked: before inserting, this checks for an existing event already linked to
 * the given list item/note (for this user) and returns that one instead of creating a second —
 * the frontend's "📅 Add to calendar" button (NoteEditor.tsx/ListsView.tsx) has no other way to
 * know a promotion already happened, and re-clicking it (or the LLM calling this tool twice for
 * the same deadline) would otherwise silently duplicate the event. `created: false` on the
 * response distinguishes a reused row from a freshly-made one. An unlinked create is never
 * deduplicated — a plain "Add" is always a genuinely new event, same as before this existed.
 *
 * visibility defaults to 'shared' (preserves the pre-existing behavior of every plain "Add" from
 * CalendarView: push to Google when configured) UNLESS a link is given and visibility is omitted,
 * in which case it defaults to 'private' — promoting a task/note deadline to the calendar
 * shouldn't silently flood the household's real Google Calendar with private to-do deadlines. The
 * caller can always override either default explicitly.
 *
 * When the resolved visibility is 'shared' and a Google Calendar connection is configured
 * (googleClient given, undefined otherwise), the new event is also best-effort pushed to Google
 * right after the local insert succeeds (googleOutboundSync.ts's pushCreateToGoogle — same "never
 * fail the tool call if the external write fails" rule Notion sync already established) — a native
 * event created in bigBrain now shows up in the household's real Google Calendar, and becomes
 * editable/deletable from either side (docs/spec.md §6.7). A 'private' event skips this push
 * entirely, never touching the Google API.
 *
 * @api-declaration
 * createCreateCalendarEventTool(googleClient) — returns the create_calendar_event RegisteredTool
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
import { sourceMeta } from './sourceMeta.js';
import { pushCreateToGoogle } from './googleOutboundSync.js';

const VALID_VISIBILITIES = ['private', 'shared'] as const;
type CalendarVisibility = (typeof VALID_VISIBILITIES)[number];

interface CreateCalendarEventArgs {
  title: string;
  start_time: string;
  end_time: string;
  description?: string;
  assigned_members?: string[];
  linked_list_item_id?: string;
  linked_note_id?: string;
  visibility?: CalendarVisibility;
}

function isCreateCalendarEventArgs(value: unknown): value is CreateCalendarEventArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.title !== 'string' || v.title === '') return false;
  if (typeof v.start_time !== 'string' || typeof v.end_time !== 'string') return false;
  if (v.description !== undefined && typeof v.description !== 'string') return false;
  if (v.assigned_members !== undefined) {
    if (!Array.isArray(v.assigned_members) || !v.assigned_members.every((m) => typeof m === 'string')) return false;
  }
  if (v.linked_list_item_id !== undefined && (typeof v.linked_list_item_id !== 'string' || v.linked_list_item_id === '')) return false;
  if (v.linked_note_id !== undefined && (typeof v.linked_note_id !== 'string' || v.linked_note_id === '')) return false;
  if (v.linked_list_item_id !== undefined && v.linked_note_id !== undefined) return false;
  if (v.visibility !== undefined && !VALID_VISIBILITIES.includes(v.visibility as CalendarVisibility)) return false;
  return true;
}

export function createCreateCalendarEventTool(googleClient: GoogleCalendarClient | undefined): RegisteredTool {
  return {
    definition: {
      name: 'create_calendar_event',
      description: 'Create a new event or reminder directly on the household calendar.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The event title.' },
          start_time: { type: 'string', description: 'Start time, as an ISO 8601 timestamp.' },
          end_time: { type: 'string', description: 'End time, as an ISO 8601 timestamp.' },
          description: { type: 'string', description: 'Optional free-text details.' },
          assigned_members: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional informational household-member tags (e.g. ["Kids", "Wife"]) — not an access-control list.',
          },
          linked_list_item_id: {
            type: 'string',
            description: 'Optional: promote this list item\'s deadline to a real calendar event, linked back to it. Mutually exclusive with linked_note_id.',
          },
          linked_note_id: {
            type: 'string',
            description: 'Optional: promote this note\'s reminder to a real calendar event, linked back to it. Mutually exclusive with linked_list_item_id.',
          },
          visibility: {
            type: 'string',
            enum: [...VALID_VISIBILITIES],
            description:
              'Whether this event syncs to the household\'s external Google Calendar connection. Defaults to "shared", unless linked_list_item_id/linked_note_id is given, in which case it defaults to "private".',
          },
        },
        required: ['title', 'start_time', 'end_time'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isCreateCalendarEventArgs(args)) {
        throw new Error(
          'create_calendar_event requires title, start_time, and end_time as strings; linked_list_item_id and linked_note_id are mutually exclusive',
        );
      }
      const startTime = new Date(args.start_time);
      const endTime = new Date(args.end_time);
      if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
        throw new Error('create_calendar_event: start_time/end_time must be valid ISO 8601 timestamps');
      }
      if (endTime < startTime) {
        throw new Error('create_calendar_event: end_time must not be before start_time');
      }

      const isLinked = args.linked_list_item_id !== undefined || args.linked_note_id !== undefined;
      const visibility: CalendarVisibility = args.visibility ?? (isLinked ? 'private' : 'shared');

      if (args.linked_list_item_id !== undefined || args.linked_note_id !== undefined) {
        const existingRows = await ctx.db.query<{
          event_id: string;
          title: string;
          start_time: string;
          end_time: string;
          visibility: CalendarVisibility;
        }>(
          args.linked_list_item_id !== undefined
            ? 'select event_id, title, start_time, end_time, visibility from calendar_events where user_id = $1 and linked_list_item_id = $2'
            : 'select event_id, title, start_time, end_time, visibility from calendar_events where user_id = $1 and linked_note_id = $2',
          [ctx.userId, args.linked_list_item_id ?? args.linked_note_id],
        );
        const existing = existingRows[0];
        if (existing) {
          return {
            eventId: existing.event_id,
            source: 'native' as const,
            ...sourceMeta('native'),
            title: existing.title,
            startTime: existing.start_time,
            endTime: existing.end_time,
            visibility: existing.visibility,
            linkedListItemId: args.linked_list_item_id ?? null,
            linkedNoteId: args.linked_note_id ?? null,
            created: false,
          };
        }
      }

      const rows = await ctx.db.query<{ event_id: string }>(
        `insert into calendar_events (user_id, source, external_id, title, description, start_time, end_time, assigned_members, visibility, linked_list_item_id, linked_note_id)
         values ($1, 'native', gen_random_uuid()::text, $2, $3, $4, $5, $6, $7, $8, $9)
         returning event_id`,
        [
          ctx.userId,
          args.title,
          args.description ?? null,
          startTime.toISOString(),
          endTime.toISOString(),
          args.assigned_members ?? [],
          visibility,
          args.linked_list_item_id ?? null,
          args.linked_note_id ?? null,
        ],
      );
      const eventId = rows[0]!.event_id;

      if (visibility === 'shared') {
        await pushCreateToGoogle(ctx.db, googleClient, eventId, {
          title: args.title,
          description: args.description ?? null,
          location: null,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          allDay: false,
        });
      }

      return {
        eventId,
        source: 'native' as const,
        ...sourceMeta('native'),
        title: args.title,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        visibility,
        linkedListItemId: args.linked_list_item_id ?? null,
        linkedNoteId: args.linked_note_id ?? null,
        created: true,
      };
    },
  };
}
