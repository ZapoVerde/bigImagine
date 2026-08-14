/**
 * @file frontend/src/components/timeline/TurnGanttChart.tsx
 * @stamp 2026-08-14
 * @architectural-role dumb module (bi_principles.md §8) — pure presentational renderer of a
 * TurnTimelineReport; no data loading, no state
 * @description
 * The turn-timeline graph (docs/plans/turn-timeline-graph-plan.md): one labeled row per report
 * row, each a CSS-positioned floating bar whose left/width are percentages of the report's
 * totalMs — the same no-library, container-scaling approach StatBarList already established, so
 * it holds up at phone width (bi_principles.md §18) with no fixed pixel math. Instant milestones
 * render as absolutely-positioned dashed vertical lines spanning each track's full height; the
 * abort instant is visually distinct (red). Each row carries its own duration label, and the
 * chart ends with a total-time line (max of every row-stop/milestone, same totalMs the bars are
 * scaled against). Native title tooltips carry the exact ms/duration on
 * hover — no charting library, no canvas. A null report, or one with an empty rows array (a turn
 * that dispatched but never got a first token), renders the "no timing data reached" state, not
 * a blank chart.
 *
 * @api-declaration
 * TurnGanttChart({ report, emptyMessage? }) — report: TurnTimelineReport | null
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import type { TurnTimelineReport } from '../../lib/turnTimelineReport';
import './TurnGanttChart.css';

interface TurnGanttChartProps {
  report: TurnTimelineReport | null;
  /** Shown instead of the chart when report is null or has no rows. */
  emptyMessage?: string;
}

/** Sub-second durations as whole ms (the values here are always well under a second — a phase
 *  longer than that is the exception, not the common case), everything else in seconds so the
 *  total doesn't read as an unbroken wall of digits. */
function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export default function TurnGanttChart({ report, emptyMessage = 'No timing data reached.' }: TurnGanttChartProps) {
  if (!report || report.rows.length === 0) {
    return <div className="turn-gantt-empty">{emptyMessage}</div>;
  }
  const { rows, milestones, totalMs } = report;
  // Clamped defensively: rows guarantee start < stop and every milestone ≤ totalMs, so the
  // percentages are in-bounds by construction — the clamp only guards against a future caller.
  const pct = (ms: number): string => `${Math.max(0, Math.min(100, (ms / totalMs) * 100))}%`;
  return (
    <div className="turn-gantt" role="img" aria-label={`Turn timeline, total ${formatMs(totalMs)}`}>
      {rows.map((row) => (
        <div className="turn-gantt-row" key={row.key}>
          <span className="turn-gantt-label">{row.label}</span>
          <div className="turn-gantt-track">
            <div
              className={`turn-gantt-bar turn-gantt-bar-${row.key}`}
              style={{ left: pct(row.startMs), width: pct(row.stopMs - row.startMs) }}
              title={`${row.label} — ${row.startMs} ms → ${row.stopMs} ms (${row.stopMs - row.startMs} ms)`}
            />
            {milestones.map((m) => (
              <div
                key={m.key}
                className={`turn-gantt-milestone${m.key === 'terminated' ? ' turn-gantt-milestone-terminated' : ''}`}
                style={{ left: pct(m.atMs) }}
                title={`${m.label} — ${m.atMs} ms`}
              />
            ))}
          </div>
          <span className="turn-gantt-duration">{formatMs(row.stopMs - row.startMs)}</span>
        </div>
      ))}
      <div className="turn-gantt-total">
        <span>Total</span>
        <span className="turn-gantt-total-value">{formatMs(totalMs)}</span>
      </div>
    </div>
  );
}
