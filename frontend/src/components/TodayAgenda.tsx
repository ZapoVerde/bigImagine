import { useEffect, useState } from 'react';
import { ApiError, callTool, getTimezone } from '../api/client';
import type { CalendarEvent } from '../api/types';
import './TodayAgenda.css';

interface TodayAgendaProps {
  apiKey: string | null;
}

function formatTime(event: CalendarEvent): string {
  if (event.allDay) return 'All day';
  return new Date(event.startTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Household-local "today", not the browser's own date — toISOString() is always UTC, and even a
// browser-local date would be wrong for anyone viewing from outside the household's timezone. The
// same date getCalendarScheduleTool.ts resolves server-side for its own default range.
function isoDateInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// What a blank tab shows above the type picker — a same-day glance so opening a new tab answers
// "what's today look like" without having to go pick Calendar first. Read-only: editing still
// happens from the Calendar tab itself.
export default function TodayAgenda({ apiKey }: TodayAgendaProps) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTimezone(apiKey)
      .then((timezone) => {
        const today = isoDateInZone(new Date(), timezone);
        return callTool<CalendarEvent[]>('get_calendar_schedule', { start_date: today, end_date: today }, apiKey);
      })
      .then(setEvents)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load today'))
      .finally(() => setLoading(false));
  }, [apiKey]);

  if (loading || error) return null; // a picker still works with no data — never block on this

  return (
    <div className="today-agenda">
      <h3>Today</h3>
      {events.length === 0 ? (
        <p className="today-agenda-empty">Nothing scheduled today.</p>
      ) : (
        <ul>
          {events.map((event) => (
            <li key={event.eventId} className="today-agenda-event">
              <span className="source-dot" style={{ backgroundColor: event.colorCode }} title={event.label} />
              <span className="today-agenda-time">{formatTime(event)}</span>
              <span className="today-agenda-title">{event.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
