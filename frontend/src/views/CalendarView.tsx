import { useEffect, useState } from 'react';
import { ApiError, callTool } from '../api/client';
import type { CalendarEvent } from '../api/types';
import './CalendarView.css';

interface CalendarViewProps {
  apiKey: string | null;
}

// Events arrive from get_calendar_schedule already sorted by start_time (getCalendarScheduleTool.ts),
// so grouping preserves that order via Map insertion order — deliberately not re-sorted here, since
// the locale-formatted date strings used as keys don't sort correctly as plain strings.
function groupByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const byDate = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = new Date(event.startTime).toLocaleDateString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(event);
  }
  return byDate;
}

function formatTime(event: CalendarEvent): string {
  if (event.allDay) return 'All day';
  const start = new Date(event.startTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const end = new Date(event.endTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${start} – ${end}`;
}

export default function CalendarView({ apiKey }: CalendarViewProps) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      setEvents(await callTool<CalendarEvent[]>('get_calendar_schedule', {}, apiKey));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load calendar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
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
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to add event');
    }
  }

  const grouped = groupByDate(events);

  return (
    <div className="calendar-view">
      {error && <div className="error-banner">{error}</div>}

      {loading && events.length === 0 && <div className="empty-state">Loading…</div>}
      {!loading && events.length === 0 && <div className="empty-state">Nothing on the calendar this week.</div>}

      {[...grouped.entries()].map(([dateLabel, dayEvents]) => (
        <section key={dateLabel} className="day-group">
          <h2>{dateLabel}</h2>
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
