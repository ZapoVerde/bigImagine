/**
 * @file frontend/src/components/timeline/TurnDrawerSection.tsx
 * @stamp 2026-08-14
 * @architectural-role Stateful Owner (bi_principles.md §8) — owns this section's collapsed state,
 * its own prompt-preview fetch, and its own latest-turn fetch; renders the pure TurnGanttChart
 * @description
 * The chat drawer's "Timing" section (docs/plans/turn-timeline-graph-plan.md), mounted as a
 * sibling of the Prompt Inspector in the RP sidebar: a header with its own collapse toggle
 * (default collapsed — new, opt-in, shouldn't push the established panel around), a one-line cost
 * summary for the last turn, and a TurnGanttChart of the last completed turn.
 *
 * The chart's source is the TABLE, not the session: the newest turn_display_metrics row for this
 * chat, fetched from GET /v1/chats/:chatId/turn-display-metrics/latest on first expand and again
 * per chat switch — so a reload still remembers the last turn (the drawer no longer goes blank
 * just because the in-memory snapshot died with the page). The snapshot prop stays as the instant
 * in-session overlay: a turn that just completed this chat renders immediately from it (its
 * fire-and-forget POST may still be in flight, so a fetch at that instant could race the insert),
 * and it wins while present because it is by definition newer than any row the fetch can return.
 * The row from the table covers every other case — reload, chat switch, deferred expand.
 *
 * The cost line comes from its OWN getPromptPreview call (same call the Prompt
 * Inspector makes, reading only the `main` group's usage/price) — deliberately not sharing the
 * Inspector's fetch, so the two sections stay fully independent of each other's
 * collapsed/expanded state; collapsing one must never block or delay the other's own data.
 * Fetching is lazy (first expand) and re-runs per completed turn while expanded.
 *
 * Empty states, in order of precedence: no turn completed this session AND none recorded for this
 * chat (snapshot undefined, fetched row null) → "Send a turn to see its timing."; a turn that
 * aborted before its first delta (report null) → the Gantt's own "no timing data reached" state.
 * Both are distinct, never a blank chart.
 *
 * @api-declaration
 * TurnDrawerSection({ apiKey, chatId, snapshot }) — snapshot: TurnTimingFields | undefined
 *
 * @contract
 *   assertions:
 *     purity:          impure (fetches, local state)
 *     state_ownership: [collapsed, preview, error, row, rowChatId, rowError]
 *     external_io:     [getPromptPreview, getLatestTurnDisplayMetric]
 */

import { useEffect, useState } from 'react';
import { ApiError, getPromptPreview, getLatestTurnDisplayMetric } from '../../api/client';
import type { PromptPreview, PromptPreviewGroup, TurnDisplayMetricRow } from '../../api/types';
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
  // The durable "last turn" read: the newest turn_display_metrics row for this chat, fetched on
  // expand and per chat switch. rowChatId tags which chat the row belongs to, so a stale row from
  // the previous chat is never shown under the new chat's drawer — the chat switch just shows the
  // empty state for the one fetch it takes, never someone else's (or the last chat's) turn.
  const [row, setRow] = useState<TurnDisplayMetricRow | null>(null);
  const [rowChatId, setRowChatId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

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

  // The durable read (turn-timeline-graph-plan.md's "remember the last turn across reloads"):
  // the table's newest row for this chat, fetched on first expand and re-fetched per chat switch.
  // Collapsed → no fetch. The row is only displayed when rowChatId matches the current chat.
  useEffect(() => {
    if (collapsed) return;
    let cancelled = false;
    setRowError(null);
    getLatestTurnDisplayMetric(chatId, apiKey)
      .then((t) => {
        if (cancelled) return;
        setRow(t);
        setRowChatId(chatId);
      })
      .catch((err) => {
        if (!cancelled) setRowError(err instanceof ApiError ? err.message : 'failed to load last turn');
      });
    return () => {
      cancelled = true;
    };
  }, [collapsed, chatId, apiKey]);

  const cost = costLine(preview);
  const visibleRow = rowChatId === chatId ? row : null;
  // The snapshot is by definition newer than anything the table can return (it's the turn that
  // just completed), so it wins while present; the fetched row covers reload/chat-switch/deferred
  // expand. Both feed the same report builder the Stats page uses.
  const report = snapshot ? buildTurnTimelineReport(snapshot) : visibleRow ? buildTurnTimelineReport(visibleRow) : null;

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
          {rowError && <div className="turn-drawer-error">{rowError}</div>}
          {cost && (
            <div className="turn-drawer-cost">
              <span>Last turn</span>
              <span className="turn-drawer-cost-tokens">{cost.tokens.toLocaleString()} tk</span>
              {cost.usd !== undefined && <span className="turn-drawer-cost-usd">{formatUsd(cost.usd)}</span>}
            </div>
          )}
          {snapshot || visibleRow ? (
            <TurnGanttChart
              report={report}
              emptyMessage={
                snapshot
                  ? 'No timing data reached — the turn ended before its first token.'
                  : 'No timing data reached for the last turn.'
              }
            />
          ) : (
            <div className="turn-drawer-empty">Send a turn to see its timing.</div>
          )}
        </div>
      )}
    </section>
  );
}
