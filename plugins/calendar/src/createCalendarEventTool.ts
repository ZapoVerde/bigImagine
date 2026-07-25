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
 * When a Google Calendar connection is configured (googleClient given, undefined otherwise), the
 * new event is also best-effort pushed to Google right after the local insert succeeds
 * (googleOutboundSync.ts's pushCreateToGoogle — same "never fail the tool call if the external
 * write fails" rule Notion sync already established) — a native event created in bigBrain now
 * shows up in the household's real Google Calendar, and becomes editable/deletable from either
 * side (docs/spec.md §6.7).
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

interface CreateCalendarEventArgs {
  title: string;
  start_time: string;
  end_time: string;
  description?: string;
  assigned_members?: string[];
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
        },
        required: ['title', 'start_time', 'end_time'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isCreateCalendarEventArgs(args)) {
        throw new Error('create_calendar_event requires title, start_time, and end_time as strings');
      }
      const startTime = new Date(args.start_time);
      const endTime = new Date(args.end_time);
      if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
        throw new Error('create_calendar_event: start_time/end_time must be valid ISO 8601 timestamps');
      }
      if (endTime < startTime) {
        throw new Error('create_calendar_event: end_time must not be before start_time');
      }

      const rows = await ctx.db.query<{ event_id: string }>(
        `insert into calendar_events (user_id, source, external_id, title, description, start_time, end_time, assigned_members)
         values ($1, 'native', gen_random_uuid()::text, $2, $3, $4, $5, $6)
         returning event_id`,
        [ctx.userId, args.title, args.description ?? null, startTime.toISOString(), endTime.toISOString(), args.assigned_members ?? []],
      );
      const eventId = rows[0]!.event_id;

      await pushCreateToGoogle(ctx.db, googleClient, eventId, {
        title: args.title,
        description: args.description ?? null,
        location: null,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        allDay: false,
      });

      return {
        eventId,
        source: 'native' as const,
        ...sourceMeta('native'),
        title: args.title,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      };
    },
  };
}
