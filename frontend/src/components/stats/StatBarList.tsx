/**
 * @file frontend/src/components/stats/StatBarList.tsx
 * @stamp 2026-08-14
 * @architectural-role dumb module (bi_principles.md §8) — pure presentational renderer, no data
 * loading, no state
 * @description
 * The stacked bar-list both Stats sections render on (docs/plans/llm-stats-page-plan.md: "the
 * news-site pattern, not a drag-and-drop pivot grid, so it holds up at phone width with no
 * library"). Each item is one group-by bucket: a label + total on the top row, a stacked
 * horizontal bar underneath whose segments are the breakdown within the bucket (Usage & Cost
 * stacks by outcome, Timing by outcome too), and a compact legend. Bar widths are relative to the
 * largest total in the list; an all-null group is passed with value 0 and "no data" text by the
 * caller, never as a fabricated zero here.
 *
 * @api-declaration
 * StatBarList({ items, emptyMessage }) — items: StatBarItem[]
 *   StatBarItem { key, label, value, valueText, sublabel?, segments: StatBarSegment[] }
 *   StatBarSegment { label, value }   // label drives the color: ok/error/refused/aborted/other
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

const SEGMENT_CLASS: Record<string, string> = {
  ok: 'stat-bar-seg-ok',
  error: 'stat-bar-seg-error',
  refused: 'stat-bar-seg-refused',
  aborted: 'stat-bar-seg-aborted',
};

function segmentClass(label: string): string {
  return SEGMENT_CLASS[label] ?? 'stat-bar-seg-other';
}

export interface StatBarSegment {
  label: string;
  value: number;
}

export interface StatBarItem {
  key: string;
  label: string;
  /** Bar total (sum of segments) — drives the width relative to the list's largest total. */
  value: number;
  /** Pre-formatted total for the top-right display (caller owns formatting/currency). */
  valueText: string;
  /** Optional small muted line under the label, e.g. "3 calls · avg 1.2 s". */
  sublabel?: string;
  segments: StatBarSegment[];
}

interface StatBarListProps {
  items: StatBarItem[];
  emptyMessage?: string;
}

export default function StatBarList({ items, emptyMessage = 'No data in this window.' }: StatBarListProps) {
  if (items.length === 0) {
    return <div className="stat-bar-list stat-bar-list-empty">{emptyMessage}</div>;
  }
  const maxValue = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="stat-bar-list">
      {items.map((item) => (
        <div className="stat-bar-item" key={item.key}>
          <div className="stat-bar-item-head">
            <span className="stat-bar-item-label" title={item.label}>
              {item.label}
            </span>
            <span className="stat-bar-item-value">{item.valueText}</span>
          </div>
          {item.sublabel ? <div className="stat-bar-item-sublabel">{item.sublabel}</div> : null}
          <div className="stat-bar-track" role="img" aria-label={`${item.label}: ${item.valueText}`}>
            {item.segments.map((seg, i) =>
              seg.value > 0 ? (
                <div
                  key={`${seg.label}-${i}`}
                  className={`stat-bar-seg ${segmentClass(seg.label)}`}
                  style={{ width: `${(seg.value / maxValue) * 100}%` }}
                  title={`${seg.label}: ${seg.value}`}
                />
              ) : null,
            )}
          </div>
          {item.segments.some((s) => s.value > 0) ? (
            <div className="stat-bar-legend">
              {item.segments
                .filter((s) => s.value > 0)
                .map((seg, i) => (
                  <span className="stat-bar-legend-entry" key={`${seg.label}-${i}`}>
                    <span className={`stat-bar-legend-dot ${segmentClass(seg.label)}`} />
                    {seg.label}
                  </span>
                ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
