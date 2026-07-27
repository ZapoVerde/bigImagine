/**
 * @file plugins/math-utils/src/dateMathTool.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — the date_math RegisteredTool
 * @description
 * bb_principles.md §2: date arithmetic is exactly the kind of "off-by-one, wrong month-length,
 * forgot the leap year" mistake an LLM makes silently. This tool does the actual day-counting;
 * the model only extracts the operation and the dates involved.
 *
 * Deliberately NOT built on date-fns' Date-object arithmetic (addDays/differenceInCalendarDays
 * etc.): those read a Date's *local* calendar fields (getFullYear/getMonth/getDate), which
 * depend on the orchestrator process's own TZ env var — not a value this tool should have any
 * opinion about. "90 days from March 15th" is abstract calendar-day arithmetic (a fixed elapsed
 * count of calendar days), not a real-time/timezone question, so every date here is anchored to
 * UTC midnight internally and never converted to any local wall clock. The one place a real
 * timezone matters is resolving "today" when `date` is omitted — same household_timezone setting
 * and the same Intl `en-CA` (YYYY-MM-DD) formatting trick util/dateContext.ts already uses for
 * the LLM's own "today" system message, so this tool's default agrees with what the model was
 * already told "today" is.
 *
 * @api-declaration
 * createDateMathTool(settings) — returns the date_math RegisteredTool; settings resolves
 *   household_timezone fresh on every call (only used when `date` is omitted)
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads household_timezone via settings; no other IO)
 *     state_ownership: []
 *     external_io:     [orchestrator_settings (via settings)]
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

type OrchestratorSettingsStore = PluginDeps['settings'];

const DAY_MS = 86_400_000;
const MAX_SPAN_DAYS = 3660; // ~10 years — business-day counting below walks day by day

function parseCalendarDate(input: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) throw new Error(`date must be in YYYY-MM-DD form, got "${input}"`);
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const epochMs = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(epochMs);
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day) {
    throw new Error(`"${input}" is not a valid calendar date`);
  }
  return epochMs;
}

function formatCalendarDate(epochMs: number): string {
  const d = new Date(epochMs);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function weekdayName(epochMs: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(epochMs));
}

function isWeekendUtc(epochMs: number): boolean {
  const day = new Date(epochMs).getUTCDay();
  return day === 0 || day === 6;
}

function todayInTimeZone(timeZone: string): string {
  // en-CA formats as YYYY-MM-DD — same trick orchestrator/src/util/dateContext.ts uses.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function addBusinessDays(startMs: number, amount: number): number {
  const step = amount >= 0 ? 1 : -1;
  let remaining = Math.abs(amount);
  let current = startMs;
  while (remaining > 0) {
    current += step * DAY_MS;
    if (!isWeekendUtc(current)) remaining -= 1;
  }
  return current;
}

function countBusinessDaysBetween(startMs: number, endMs: number): number {
  const step = endMs >= startMs ? 1 : -1;
  let count = 0;
  let current = startMs;
  while (current !== endMs) {
    current += step * DAY_MS;
    if (!isWeekendUtc(current)) count += step;
  }
  return count;
}

type DateUnit = 'days' | 'weeks' | 'business_days';

interface DateMathArgs {
  operation: 'add' | 'diff';
  date?: string;
  amount?: number;
  unit?: DateUnit;
  endDate?: string;
}

function isDateMathArgs(value: unknown): value is DateMathArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.operation !== 'add' && v.operation !== 'diff') return false;
  if (v.date !== undefined && typeof v.date !== 'string') return false;
  if (v.operation === 'add') {
    if (typeof v.amount !== 'number' || !Number.isFinite(v.amount)) return false;
    if (v.unit !== undefined && v.unit !== 'days' && v.unit !== 'weeks' && v.unit !== 'business_days') return false;
  }
  if (v.operation === 'diff') {
    if (typeof v.endDate !== 'string') return false;
  }
  return true;
}

export function createDateMathTool(settings: OrchestratorSettingsStore): RegisteredTool {
  return {
    definition: {
      name: 'date_math',
      description:
        'Exact calendar date arithmetic — add/subtract days, weeks, or business days to a date, or compute the exact number of calendar/business days between two dates. `date` defaults to today (household timezone) if omitted. Never compute date offsets or durations yourself — hand them to this tool.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['add', 'diff'], description: '"add" to offset a date, "diff" to compare two dates.' },
          date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today if omitted.' },
          amount: { type: 'number', description: 'Signed amount to add (negative subtracts). Required for "add".' },
          unit: { type: 'string', enum: ['days', 'weeks', 'business_days'], description: 'Unit for "amount" (default "days").' },
          endDate: { type: 'string', description: 'YYYY-MM-DD. Required for "diff".' },
        },
        required: ['operation'],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      if (!isDateMathArgs(args)) {
        throw new Error('date_math requires operation: "add"|"diff", with amount/unit for "add" or endDate for "diff"');
      }

      const timeZone = (await settings.get('household_timezone')) ?? 'UTC';
      const dateStr = args.date ?? todayInTimeZone(timeZone);
      const startMs = parseCalendarDate(dateStr);

      if (args.operation === 'add') {
        const unit = args.unit ?? 'days';
        const amount = args.amount as number;
        let resultMs: number;
        if (unit === 'business_days') {
          resultMs = addBusinessDays(startMs, amount);
        } else {
          const days = unit === 'weeks' ? amount * 7 : amount;
          resultMs = startMs + days * DAY_MS;
        }
        return {
          date: dateStr,
          amount,
          unit,
          resultDate: formatCalendarDate(resultMs),
          resultWeekday: weekdayName(resultMs),
        };
      }

      const endMs = parseCalendarDate(args.endDate as string);
      if (Math.abs(endMs - startMs) / DAY_MS > MAX_SPAN_DAYS) {
        throw new Error(`date range exceeds the ${MAX_SPAN_DAYS}-day maximum this tool supports`);
      }
      const calendarDays = Math.round((endMs - startMs) / DAY_MS);
      return {
        date: dateStr,
        endDate: args.endDate,
        calendarDays,
        weeks: Number((calendarDays / 7).toFixed(2)),
        businessDays: countBusinessDaysBetween(startMs, endMs),
      };
    },
  };
}
