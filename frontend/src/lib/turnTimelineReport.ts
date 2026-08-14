/**
 * @file frontend/src/lib/turnTimelineReport.ts
 * @stamp 2026-08-14
 * @architectural-role Pure Function (bi_principles.md §8) — turns turn_display_metrics timing
 * fields into the Gantt chart's report; no IO, no state, no UI
 * @description
 * The single definition of the turn-timeline graph's shape (docs/plans/turn-timeline-graph-plan.md):
 * six possible rows — waiting (dispatch=0 → firstTokenMs), streaming (firstTokenMs →
 * lastTokenMs), header/body/footer (their own start/stop pairs — they can and do overlap
 * streaming, which a Gantt handles natively by being separate rows), finalizing (lastTokenMs →
 * displaySettleMs) — plus five possible instant milestones (first-token / last-token /
 * display-land / display-settle / terminated). totalMs (the chart's x-axis span) is the max of
 * every present row-stop and milestone value. A row appears only when BOTH its ends are known
 * numbers AND the span is positive — never a zero-width or open-ended bar, and never an inverted
 * one.
 *
 * buildTurnTimelineReport maps one turn's fields straight through, no aggregation.
 * buildAverageTurnTimelineReport produces the same shape by averaging each row's startMs and
 * stopMs (and each milestone's atMs) INDEPENDENTLY across whichever turns in the input actually
 * reached that field — strictly per-kind, never mixing kinds — via aggregateRows.ts's meanOf
 * (nulls excluded, all-null → null), NOT a cursor-accumulated duration stack. This matters
 * because the phases overlap: averaging absolute ms-from-dispatch positions directly keeps the
 * averaged chart's row overlaps visually honest. A per-kind averaged row whose mean startMs ≥
 * mean stopMs is omitted (the start and stop populations can differ — a turn that started a
 * phase may be one that never finished it, and vice versa). A phase no turn ever reached is
 * simply absent. Both builders return null when nothing can be shown (the chart's "no timing
 * data reached" state) — the same "omit, don't fabricate" rule as everywhere else in the Stats
 * work.
 *
 * @api-declaration
 * buildTurnTimelineReport(record: TurnTimingFields): TurnTimelineReport | null
 * buildAverageTurnTimelineReport(records: TurnTimingFields[]): TurnTimelineReport | null
 * TurnTimingFields  — the *_ms subset TurnDisplayMetricRow and TurnDisplayMetricsInput share
 * TurnSnapshot      — the drawer's "last turn" wire: fields tagged with the chat they happened in
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import { meanOf } from './aggregateRows';

/** The timing fields both the single-turn and averaged builders read. The *_ms subset
 *  TurnDisplayMetricRow (number | null) and TurnDisplayMetricsInput (number | undefined) share —
 *  identical field names, differing only in nullability; number | null | undefined accepts both,
 *  so no per-source types are needed. */
export interface TurnTimingFields {
  firstTokenMs?: number | null;
  lastTokenMs?: number | null;
  displayLandMs?: number | null;
  displaySettleMs?: number | null;
  headerStartMs?: number | null;
  headerStopMs?: number | null;
  bodyStartMs?: number | null;
  bodyStopMs?: number | null;
  footerStartMs?: number | null;
  footerStopMs?: number | null;
  terminatedAtMs?: number | null;
}

/** The drawer's "last turn" wire: timing fields tagged with the chat they happened in, so the
 *  Timing section can refuse to show chat A's chart under chat B's cost line after a tab switch. */
export interface TurnSnapshot {
  chatId: string;
  fields: TurnTimingFields;
}

export type TurnTimelineRowKey = 'waiting' | 'streaming' | 'header' | 'body' | 'footer' | 'finalizing';
export type TurnTimelineMilestoneKey = 'first-token' | 'last-token' | 'display-land' | 'display-settle' | 'terminated';

export interface TurnTimelineRow {
  key: TurnTimelineRowKey;
  label: string;
  startMs: number;
  stopMs: number;
}

export interface TurnTimelineMilestone {
  key: TurnTimelineMilestoneKey;
  label: string;
  atMs: number;
}

export interface TurnTimelineReport {
  rows: TurnTimelineRow[]; // only rows with both ends known and a positive span
  milestones: TurnTimelineMilestone[]; // only milestones that were reached
  totalMs: number; // chart x-axis span — max of every present row-stop and milestone value
}

const ROW_LABELS: Record<TurnTimelineRowKey, string> = {
  waiting: 'Waiting for first token',
  streaming: 'Streaming',
  header: 'Header repair',
  body: 'Body repair',
  footer: 'Footer repair',
  finalizing: 'Finalizing',
};

const MILESTONE_LABELS: Record<TurnTimelineMilestoneKey, string> = {
  'first-token': 'First token',
  'last-token': 'Last token',
  'display-land': 'Display land',
  'display-settle': 'Display settle',
  terminated: 'Aborted',
};

/** One turn's fields in, one report out. Straight field mapping, no aggregation. null when the
 *  record has nothing to show at all (no row has both ends known) — e.g. a turn that aborted
 *  before its first delta. */
export function buildTurnTimelineReport(record: TurnTimingFields): TurnTimelineReport | null {
  const rows: TurnTimelineRow[] = [];
  const addRow = (key: TurnTimelineRowKey, startMs: number | null | undefined, stopMs: number | null | undefined): void => {
    if (typeof startMs === 'number' && typeof stopMs === 'number' && startMs < stopMs) {
      rows.push({ key, label: ROW_LABELS[key], startMs, stopMs });
    }
  };
  // dispatch is t0 — the "start" of waiting is a constant 0, not a recorded field.
  addRow('waiting', 0, record.firstTokenMs);
  addRow('streaming', record.firstTokenMs, record.lastTokenMs);
  addRow('header', record.headerStartMs, record.headerStopMs);
  addRow('body', record.bodyStartMs, record.bodyStopMs);
  addRow('footer', record.footerStartMs, record.footerStopMs);
  addRow('finalizing', record.lastTokenMs, record.displaySettleMs);

  if (rows.length === 0) return null;

  const milestones: TurnTimelineMilestone[] = [];
  const addMilestone = (key: TurnTimelineMilestoneKey, atMs: number | null | undefined): void => {
    if (typeof atMs === 'number') milestones.push({ key, label: MILESTONE_LABELS[key], atMs });
  };
  addMilestone('first-token', record.firstTokenMs);
  addMilestone('last-token', record.lastTokenMs);
  addMilestone('display-land', record.displayLandMs);
  addMilestone('display-settle', record.displaySettleMs);
  addMilestone('terminated', record.terminatedAtMs);

  const totalMs = Math.max(...rows.map((r) => r.stopMs), ...milestones.map((m) => m.atMs));
  return { rows, milestones, totalMs };
}

/** Same output shape, averaged across whichever turns in the input reached each field — strictly
 *  per-kind (a row/milestone averages only turns that reached that row/milestone, never mixing
 *  kinds), via meanOf's null-excluding per-column mean. null when no row survives (no turn in
 *  the set ever produced a positive span). */
export function buildAverageTurnTimelineReport(records: TurnTimingFields[]): TurnTimelineReport | null {
  const rows: TurnTimelineRow[] = [];
  const addMeanRow = (
    key: TurnTimelineRowKey,
    startField: keyof TurnTimingFields | null,
    stopField: keyof TurnTimingFields,
  ): void => {
    const startMs = startField === null ? 0 : meanOf(records, (r) => r[startField]);
    const stopMs = meanOf(records, (r) => r[stopField]);
    if (startMs !== null && stopMs !== null && startMs < stopMs) {
      rows.push({ key, label: ROW_LABELS[key], startMs, stopMs });
    }
  };
  // waiting's start is dispatch — a constant 0, same as the single-turn builder.
  addMeanRow('waiting', null, 'firstTokenMs');
  addMeanRow('streaming', 'firstTokenMs', 'lastTokenMs');
  addMeanRow('header', 'headerStartMs', 'headerStopMs');
  addMeanRow('body', 'bodyStartMs', 'bodyStopMs');
  addMeanRow('footer', 'footerStartMs', 'footerStopMs');
  addMeanRow('finalizing', 'lastTokenMs', 'displaySettleMs');

  if (rows.length === 0) return null;

  const milestones: TurnTimelineMilestone[] = [];
  const addMeanMilestone = (key: TurnTimelineMilestoneKey, field: keyof TurnTimingFields): void => {
    const atMs = meanOf(records, (r) => r[field]);
    if (atMs !== null) milestones.push({ key, label: MILESTONE_LABELS[key], atMs });
  };
  addMeanMilestone('first-token', 'firstTokenMs');
  addMeanMilestone('last-token', 'lastTokenMs');
  addMeanMilestone('display-land', 'displayLandMs');
  addMeanMilestone('display-settle', 'displaySettleMs');
  addMeanMilestone('terminated', 'terminatedAtMs');

  const totalMs = Math.max(...rows.map((r) => r.stopMs), ...milestones.map((m) => m.atMs));
  return { rows, milestones, totalMs };
}
