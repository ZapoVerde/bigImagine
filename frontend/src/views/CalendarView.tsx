import { useEffect, useState } from 'react';
import { ApiError, callTool, getTimezone } from '../api/client';
import type { CalendarEvent } from '../api/types';
import './CalendarView.css';

interface CalendarViewProps {
  apiKey: string | null;
}

// Household-local calendar day, not the browser's own — same reasoning as
// components/TodayAgenda.tsx and getCalendarScheduleTool.ts's own default range.
function isoDateInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Pure calendar-day arithmetic on a Y-M-D string, same as getCalendarScheduleTool.ts's addDays —
// anchored to UTC internally so it's unaffected by the household's actual zone or DST.
function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// isoDay is already the correct calendar day (from isoDateInZone above) — format it as a fixed
// UTC midnight instant so no further timezone conversion can shift it to a neighboring day.
function formatDayHeading(isoDay: string): string {
  return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Every calendar day an event should appear under. A plain (non-all-day) event lives on the single
// day it starts. A multi-day all-day event (icsSync.ts stores start/end per the ICS DTEND
// convention — end is exclusive) belongs on every day from its start through the day before its
// end, matching Cozi's own app, which repeats a multi-day banner event on each day it spans rather
// than showing it once under its first day.
function daysSpanned(event: CalendarEvent, timezone: string): string[] {
  const startDay = isoDateInZone(new Date(event.startTime), timezone);
  if (!event.allDay) return [startDay];
  const endDayExclusive = isoDateInZone(new Date(event.endTime), timezone);
  const days: string[] = [];
  for (let day = startDay; day < endDayExclusive; day = addDays(day, 1)) days.push(day);
  return days.length > 0 ? days : [startDay];
}

// One entry per calendar day in [rangeStart, rangeEnd] inclusive, always present even with nothing
// scheduled, so the agenda reads as a continuous week rather than only the days that happen to have
// events. Multi-day events are repeated into every day they touch within that window (daysSpanned
// above); a span is clamped to the window simply by only ever writing into days already seeded here.
function buildDayGroups(events: CalendarEvent[], timezone: string, rangeStart: string, rangeEnd: string): Map<string, CalendarEvent[]> {
  const days = new Map<string, CalendarEvent[]>();
  for (let day = rangeStart; day <= rangeEnd; day = addDays(day, 1)) days.set(day, []);
  for (const event of events) {
    for (const day of daysSpanned(event, timezone)) {
      days.get(day)?.push(event);
    }
  }
  return days;
}

function formatTime(event: CalendarEvent): string {
  if (event.allDay) return 'All day';
  const start = new Date(event.startTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const end = new Date(event.endTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${start} – ${end}`;
}

const VISIBLE_DAYS = 7; // matches getCalendarScheduleTool.ts's own default range (today through +6)

export default function CalendarView({ apiKey }: CalendarViewProps) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timezone, setTimezone] = useState('UTC');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');

  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  async function reload(startDate: string, endDate: string) {
    setLoading(true);
    setError(null);
    try {
      setEvents(await callTool<CalendarEvent[]>('get_calendar_schedule', { start_date: startDate, end_date: endDate }, apiKey));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load calendar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      const tz = await getTimezone(apiKey).catch(() => 'UTC');
      const start = isoDateInZone(new Date(), tz);
      const end = addDays(start, VISIBLE_DAYS - 1);
      setTimezone(tz);
      setRangeStart(start);
      setRangeEnd(end);
      await reload(start, end);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addEvent() {
    if (!title.trim() || !date || !startTime || !endTime) return;
    setError(null);
    try {
      await callTool(
        'create_calendar_event',
        {
          title: title.trim(),
          start_time: new Date(`${date}T${startTime}`).toISOString(),
          end_time: new Date(`${date}T${endTime}`).toISOString(),
        },
        apiKey,
      );
      setTitle('');
      await reload(rangeStart, rangeEnd);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to add event');
    }
  }

  const grouped = rangeStart && rangeEnd ? buildDayGroups(events, timezone, rangeStart, rangeEnd) : new Map<string, CalendarEvent[]>();

  return (
    <div className="calendar-view">
      {error && <div className="error-banner">{error}</div>}

      {loading && events.length === 0 && <div className="empty-state">Loading…</div>}

      {!loading &&
        [...grouped.entries()].map(([isoDay, dayEvents]) => (
          <section key={isoDay} className="day-group">
            <h2>{formatDayHeading(isoDay)}</h2>
            {dayEvents.length === 0 ? (
              <p className="empty-day">Nothing scheduled.</p>
            ) : (
              <ul>
                {dayEvents.map((event) => (
                  <li key={event.eventId} className="calendar-event">
                    <span className="source-dot" style={{ backgroundColor: event.colorCode }} title={event.label} />
                    <span className="event-time">{formatTime(event)}</span>
                    <span className="event-title">{event.title}</span>
                    {event.location && <span className="event-location">{event.location}</span>}
                    {event.isReadOnly && (
                      <span className="read-only-badge" title={`Synced from ${event.label} (read-only)`}>
                        🔒
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}

      <form
        className="add-event-form"
        onSubmit={(e) => {
          e.preventDefault();
          addEvent();
        }}
      >
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event title" />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
        <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
        <button type="submit">Add</button>
      </form>
    </div>
  );
}
