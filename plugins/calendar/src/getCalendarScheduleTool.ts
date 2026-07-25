/**
 * @file plugins/calendar/src/getCalendarScheduleTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — reads calendar events within a date range
 * @description
 * start_date/end_date default to today through six days out when omitted, same convention as
 * plugins/recipes' get_meal_plan — the common "what's on this week" ask shouldn't require the
 * model to compute a range itself. Filters by overlap (an event overlaps the range if it starts
 * before the range ends and ends after the range starts), not by start_time alone, so a
 * multi-day event that started before the window still shows up.
 *
 * color_code/is_read_only are never stored (db/migrations/0013_calendar.sql) — sourceMeta.ts
 * derives them per row here, at read time, from source alone.
 *
 * @api-declaration
 * createGetCalendarScheduleTool() — returns the get_calendar_schedule RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { sourceMeta, type CalendarSource } from './sourceMeta.js';

const VALID_SOURCES: CalendarSource[] = ['cozi', 'outlook', 'native'];

interface GetCalendarScheduleArgs {
  start_date?: string;
  end_date?: string;
  sources?: CalendarSource[];
}

function isGetCalendarScheduleArgs(value: unknown): value is GetCalendarScheduleArgs {
  if (typeof value !== 'object' || value === null) return true;
  const v = value as Record<string, unknown>;
  if (v.start_date !== undefined && typeof v.start_date !== 'string') return false;
  if (v.end_date !== undefined && typeof v.end_date !== 'string') return false;
  if (v.sources !== undefined) {
    if (!Array.isArray(v.sources)) return false;
    if (!v.sources.every((s) => VALID_SOURCES.includes(s as CalendarSource))) return false;
  }
  return true;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function createGetCalendarScheduleTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_calendar_schedule',
      description:
        'List calendar events overlapping a date range, across all sources (family, work, and bigBrain-native events) unless filtered. Defaults to today through the next 6 days if no dates are given.',
      parameters: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'Range start, as YYYY-MM-DD. Defaults to today.' },
          end_date: { type: 'string', description: 'Range end, as YYYY-MM-DD. Defaults to 6 days after start.' },
          sources: {
            type: 'array',
            items: { type: 'string', enum: VALID_SOURCES },
            description: 'Optional: restrict to these sources only. Defaults to all sources.',
          },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isGetCalendarScheduleArgs(args)) {
        throw new Error('get_calendar_schedule: start_date/end_date must be strings (YYYY-MM-DD), sources must be an array of valid source names');
      }
      const today = new Date();
      const startDate = args.start_date ?? isoDate(today);
      const defaultEnd = new Date(today);
      defaultEnd.setDate(defaultEnd.getDate() + 6);
      const endDate = args.end_date ?? isoDate(defaultEnd);
      const sources = args.sources ?? VALID_SOURCES;

      const rows = await ctx.db.query<{
        event_id: string;
        source: CalendarSource;
        title: string;
        description: string | null;
        location: string | null;
        start_time: string;
        end_time: string;
        all_day: boolean;
        assigned_members: string[];
      }>(
        `select event_id, source, title, description, location, start_time, end_time, all_day, assigned_members
         from calendar_events
         where user_id = $1
           and source = any($2)
           and start_time < ($3::date + interval '1 day')
           and end_time > $4::date
         order by start_time`,
        [ctx.userId, sources, endDate, startDate],
      );

      return rows.map((r) => ({
        eventId: r.event_id,
        source: r.source,
        ...sourceMeta(r.source),
        title: r.title,
        description: r.description,
        location: r.location,
        startTime: r.start_time,
        endTime: r.end_time,
        allDay: r.all_day,
        assignedMembers: r.assigned_members,
      }));
    },
  };
}
