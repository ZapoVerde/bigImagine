/**
 * @file frontend/src/components/timeline/TurnDrawerSection.tsx
 * @stamp 2026-08-14
 * @architectural-role Stateful Owner (bi_principles.md §8) — owns this section's collapsed state
 * and its own prompt-preview fetch; renders the pure TurnGanttChart
 * @description
 * The chat drawer's "Timing" section (docs/plans/turn-timeline-graph-plan.md), mounted as a
 * sibling of the Prompt Inspector in the RP sidebar: a header with its own collapse toggle
 * (default collapsed — new, opt-in, shouldn't push the established panel around), a one-line cost
 * summary for the last turn, and a TurnGanttChart fed by the live snapshot ChatView captured at
 * finalize. The cost line comes from its OWN getPromptPreview call (same call the Prompt
 * Inspector makes, reading only the `main` group's usage/price) — deliberately not sharing the
 * Inspector's fetch, so the two sections stay fully independent of each other's
 * collapsed/expanded state; collapsing one must never block or delay the other's own data.
 * Fetching is lazy (first expand) and re-runs per completed turn while expanded.
 *
 * Empty states, in order of precedence: no turn completed this session (snapshot undefined) →
 * "Send a turn to see its timing."; a turn that aborted before its first delta (report null) →
 * the Gantt's own "no timing data reached" state. Both are distinct, never a blank chart.
 *
 * @api-declaration
 * TurnDrawerSection({ apiKey, chatId, snapshot }) — snapshot: TurnTimingFields | undefined
 *
 * @contract
 *   assertions:
 *     purity:          impure (fetch, local collapsed state)
 *     state_ownership: [collapsed, preview, error]
 *     external_io:     [getPromptPreview]
 */

import { useEffect, useState } from 'react';
import { ApiError, getPromptPreview } from '../../api/client';
import type { PromptPreview, PromptPreviewGroup } from '../../api/types';
import { buildTurnTimelineReport, type TurnTimingFields } from '../../lib/turnTimelineReport';
import { computeReceiptCost, formatUsd } from '../../lib/promptReceipt';
import TurnGanttChart from './TurnGanttChart';
import './TurnDrawerSection.css';

interface TurnDrawerSectionProps {
  apiKey: string | null;
  chatId: string;
  /** The last completed turn's timing fields, captured client-side after each finalize().
   *  undefined = no turn has completed this session (or the snapshot belongs to another chat —
   *  Sidebar refuses to pass it across). */
  snapshot: TurnTimingFields | undefined;
}

/** The last turn's cost line, from the prompt preview's `main` group — the same usage/price the
 *  Prompt Inspector's receipt reads. Tokens-only when no price is configured (never a
 *  fabricated $0.00); absent entirely on a failed turn or live-reconstruction fallback. */
function costLine(preview: PromptPreview | null): { tokens: number; usd?: number } | null {
  const main: PromptPreviewGroup | undefined = preview?.groups.find((g) => g.kind === 'main');
  if (!main?.usage) return null;
  const usd = main.price ? computeReceiptCost(main.usage, main.price) : undefined;
  return { tokens: main.usage.totalTokens, usd };
}

export default function TurnDrawerSection({ apiKey, chatId, snapshot }: TurnDrawerSectionProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Lazy + per-turn: fetch only while expanded, and again whenever the snapshot changes (a new
  // completed turn → a new cost). Collapsed → no fetch at all, so a collapsed Timing section
  // never fires a request it can't show.
  useEffect(() => {
    if (collapsed || !snapshot) return;
    let cancelled = false;
    setError(null);
    getPromptPreview(chatId, apiKey)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'failed to load cost');
      });
    return () => {
      cancelled = true;
    };
  }, [collapsed, snapshot, chatId, apiKey]);

  const cost = costLine(preview);

  return (
    <section className="turn-drawer-section">
      <div className="turn-drawer-header">
        <button
          type="button"
          className="turn-drawer-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand timing' : 'Collapse timing'}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span className="turn-drawer-chevron">{collapsed ? '▸' : '▾'}</span>
          <span>Timing</span>
        </button>
      </div>
      {!collapsed && (
        <div className="turn-drawer-content">
          {error && <div className="turn-drawer-error">{error}</div>}
          {cost && (
            <div className="turn-drawer-cost">
              <span>Last turn</span>
              <span className="turn-drawer-cost-tokens">{cost.tokens.toLocaleString()} tk</span>
              {cost.usd !== undefined && <span className="turn-drawer-cost-usd">{formatUsd(cost.usd)}</span>}
            </div>
          )}
          {snapshot ? (
            <TurnGanttChart
              report={buildTurnTimelineReport(snapshot)}
              emptyMessage="No timing data reached — the turn ended before its first token."
            />
          ) : (
            <div className="turn-drawer-empty">Send a turn to see its timing.</div>
          )}
        </div>
      )}
    </section>
  );
}
