/**
 * @file orchestrator/src/util/nextOccurrence.ts
 * @stamp 2026-07-28
 * @architectural-role Pure Function — IANA-timezone-aware "next daily occurrence" arithmetic
 * @description
 * Moved here from plugins/temporal (its original home) once orchestrator/src/orchestrator/
 * agentRoutineDispatch.ts needed the exact same "daily" next_run_at arithmetic scheduled_jobs'
 * alarm dispatch (plugins/temporal/src/jobPoll.ts) already relied on — a plugin can depend on
 * @bigbrain/orchestrator but never the reverse (orchestrator/pluginLoader.ts's own doc), so core
 * code needing this couldn't import it from the plugin. Rather than fork the DST-aware math into
 * two copies that could silently drift, this is now the one copy; plugins/temporal imports it
 * back via @bigbrain/orchestrator/next-occurrence like any other cross-package dependency here.
 *
 * Unlike plugins/math-utils' date_math (deliberately abstract calendar-day arithmetic with no
 * real timezone conversion involved), a recurring "8:30 AM in America/New_York" genuinely needs
 * to know that zone's UTC offset on a given date, including across a DST transition — that's a
 * real timezone-database lookup, not just day counting. No library dependency for it, though:
 * Intl.DateTimeFormat already carries the IANA tz database (the same guarantee
 * orchestrator/src/util/dateContext.ts relies on), so zonedTimeToUtc below
 * uses the standard "guess as UTC, see what wall-clock time that guess actually shows in the
 * target zone, correct by the difference" technique — the same approach date-fns-tz/luxon use
 * internally, just inlined here since the corrected guess converges in at most two iterations
 * (offsets only ever differ by whole minutes, and only change at a DST boundary itself).
 *
 * @api-declaration
 * nextDailyOccurrence(timeOfDay, timeZone, after) — the next UTC instant, strictly after `after`,
 *   at which the wall clock in timeZone reads timeOfDay ('HH:MM')
 *
 * @contract
 *   assertions:
 *     purity:          pure (Intl.DateTimeFormat only; no external IO)
 *     state_ownership: []
 *     external_io:     []
 */

const DAY_MS = 86_400_000;

function calendarPartsInZone(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const formatted = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const [year, month, day] = formatted.split('-').map(Number);
  return { year: year!, month: month!, day: day! };
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const targetMs = Date.UTC(year, month - 1, day, hour, minute);
  let guessMs = targetMs;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(guessMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    const shownMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    const diff = targetMs - shownMs;
    if (diff === 0) break;
    guessMs += diff;
  }
  return new Date(guessMs);
}

export function nextDailyOccurrence(timeOfDay: string, timeZone: string, after: Date): Date {
  const match = /^(\d{2}):(\d{2})$/.exec(timeOfDay);
  if (!match) throw new Error(`time_of_day must be HH:MM, got "${timeOfDay}"`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`time_of_day must be a valid 24h HH:MM, got "${timeOfDay}"`);

  let { year, month, day } = calendarPartsInZone(after, timeZone);
  let candidate = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
  while (candidate.getTime() <= after.getTime()) {
    const nextDay = new Date(Date.UTC(year, month - 1, day) + DAY_MS);
    year = nextDay.getUTCFullYear();
    month = nextDay.getUTCMonth() + 1;
    day = nextDay.getUTCDate();
    candidate = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
  }
  return candidate;
}
