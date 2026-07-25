/**
 * @file plugins/calendar/src/sourceMeta.ts
 * @stamp 2026-07-25
 * @architectural-role Pure Function — derives display metadata from a calendar_events.source value
 * @description
 * color_code/is_read_only are deliberately not stored columns (db/migrations/0013_calendar.sql) —
 * both are entirely determined by `source`, so this is the one place that fact lives. Anything
 * that needs a badge color or an editability check (getCalendarScheduleTool.ts,
 * frontend/src/views/CalendarView.tsx) calls this instead of re-deriving it.
 *
 * @api-declaration
 * sourceMeta(source) — { colorCode, isReadOnly, label } for a given calendar_events.source
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export type CalendarSource = 'cozi' | 'outlook' | 'native';

export interface CalendarSourceMeta {
  colorCode: string;
  isReadOnly: boolean;
  label: string;
}

const SOURCE_META: Record<CalendarSource, CalendarSourceMeta> = {
  cozi: { colorCode: '#8B5CF6', isReadOnly: true, label: 'Cozi (Family)' },
  outlook: { colorCode: '#0284C7', isReadOnly: true, label: 'Outlook (Work)' },
  native: { colorCode: '#10B981', isReadOnly: false, label: 'bigBrain' },
};

export function sourceMeta(source: CalendarSource): CalendarSourceMeta {
  return SOURCE_META[source];
}
