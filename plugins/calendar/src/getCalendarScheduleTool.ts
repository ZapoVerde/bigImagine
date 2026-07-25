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
 * "Today" is computed in the household_timezone setting (orchestratorSettings.ts, same live-read-
 * per-request value util/dateContext.ts uses for the LLM's own sense of "today"), not the
 * server's own clock — a server running in UTC would otherwise flip to the next day up to many
 * hours before households west of it actually see midnight, silently filtering out events that
 * are plainly "today" locally.
 *
 * color_code/is_read_only are never stored (db/migrations/0013_calendar.sql) — sourceMeta.ts
 * derives them per row here, at read time, from source alone.
 *
 * @api-declaration
 * createGetCalendarScheduleTool(settings) — returns the get_calendar_schedule RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session; reads household_timezone
 *                      live via settings on every call)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), orchestrator_settings (via settings)]
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

type OrchestratorSettingsStore = PluginDeps['settings'];
import { sourceMeta, type CalendarSource } from './sourceMeta.js';

const VALID_SOURCES: CalendarSource[] = ['cozi', 'outlook', 'native'];
const DEFAULT_TIMEZONE = 'UTC'; // same safe default as adminServer.ts's getHouseholdTimezone

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

function isoDateInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Pure calendar-day arithmetic on a Y-M-D string, deliberately anchored to UTC internally so it's
// unaffected by the household's actual zone or DST — by the time we have startDate as a string,
// the zone conversion already happened once in isoDateInZone above.
function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function createGetCalendarScheduleTool(settings: OrchestratorSettingsStore): RegisteredTool {
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
      const timezone = (await settings.get('household_timezone')) ?? DEFAULT_TIMEZONE;
      const startDate = args.start_date ?? isoDateInZone(new Date(), timezone);
      const endDate = args.end_date ?? addDays(startDate, 6);
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
