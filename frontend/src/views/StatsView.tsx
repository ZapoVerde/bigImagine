/**
 * @file frontend/src/views/StatsView.tsx
 * @stamp 2026-08-14
 * @architectural-role Stateful Owner — the Stats specialist view (docs/plans/
 * llm-stats-page-plan.md), admin-gated exactly like ConnectionsView.tsx
 * @description
 * Two "group by X, show Y" sections over flat admin row lists, each a dropdown + dropdown +
 * filter chips over StatBarList (the plan's "news-site pattern, not a drag-and-drop pivot grid"
 * — chosen for §18 phone-width survivability):
 *
 *   Usage & Cost (GET /v1/admin/llm-stats) — group by provider/model/kind/outcome/day; metric
 *   cost (sum of costUsd) or one of the token counts or call count; outcome filter chips. Bars
 *   stack by outcome so a group's ok/error/refused share is visible at a glance. Pre-migration
 *   rows surface as '(pre-tracking)' groups; null numeric columns drop out of sums (aggregateRows
 *   returns null → the bar shows "no data"), never a fabricated zero.
 *
 *   Timing (GET /v1/admin/turn-display-stats) — group by day/outcome/chat; metric is the mean of
 *   one elapsed span (first-token, display-settle, or a header/body/footer start→stop window, or
 *   the full stop time). Same outcome chips; bars stack by outcome share. A second "Turn graph"
 *   mode (docs/plans/turn-timeline-graph-plan.md) swaps the grouped bar-list for the waterfall
 *   Gantt: "Last turn" (pick one filtered turn) or "Averages" (per-kind means across the whole
 *   filtered set) — both built by the shared turnTimelineReport builders, zero new fetches.
 *
 * A shared `days` lookback dropdown (7/30/90/365) re-fetches both lists — the endpoints' bounded
 * [1, 365] window is the plan's unbounded-growth answer.
 *
 * @api-declaration
 * StatsView() — no props; unlocks via useAdminUnlock (probe with no key first, Access may cover
 * it), then loads both lists.
 *
 * @contract
 *   assertions:
 *     purity:          impure (fetch, React state)
 *     state_ownership: [call rows, turn rows, groupBy/metric/chips/days selections, graph mode,
 *                       selected turn]
 *     external_io:     [GET /v1/admin/llm-stats, GET /v1/admin/turn-display-stats]
 */

import { useMemo, useRef, useState } from 'react';
import { ApiError, adminListLlmStats, adminListTurnDisplayStats } from '../api/client';
import { useAdminUnlock } from '../hooks/useAdminUnlock';
import type { LlmCallStatRow, TurnDisplayMetricRow } from '../api/types';
import { groupRows, meanOf, spanMs, sumOf } from '../lib/aggregateRows';
import { buildAverageTurnTimelineReport, buildTurnTimelineReport } from '../lib/turnTimelineReport';
import StatBarList, { type StatBarItem, type StatBarSegment } from '../components/stats/StatBarList';
import TurnGanttChart from '../components/timeline/TurnGanttChart';
import './StatsView.css';

// --- Usage & Cost ---

type UsageGroupBy = 'provider' | 'model' | 'kind' | 'call-type' | 'outcome' | 'day';
type UsageMetric = 'cost' | 'tokens' | 'prompt' | 'completion' | 'cache' | 'calls';

const USAGE_GROUP_OPTIONS: { value: UsageGroupBy; label: string }[] = [
  { value: 'provider', label: 'Provider' },
  { value: 'model', label: 'Model' },
  { value: 'kind', label: 'Kind' },
  // One level deeper than Kind (docs/plans/llm-call-label-breakdown-plan.md): 'system' alone
  // already covers cleanup repairs, chat-memory sync's six LLM steps, location descriptions,
  // and title generation, indistinguishable from each other. The call_label string carries its
  // category in itself (cleanup:header, sync:bridge, …), so one flat group-by option is enough
  // — no second-level UI.
  { value: 'call-type', label: 'Call type' },
  { value: 'outcome', label: 'Outcome' },
  { value: 'day', label: 'Day' },
];

const USAGE_METRIC_OPTIONS: { value: UsageMetric; label: string }[] = [
  { value: 'cost', label: 'Cost (USD)' },
  { value: 'tokens', label: 'Total tokens' },
  { value: 'prompt', label: 'Prompt tokens' },
  { value: 'completion', label: 'Completion tokens' },
  { value: 'cache', label: 'Cache-read tokens' },
  { value: 'calls', label: 'Calls' },
];

const USAGE_OUTCOMES = ['ok', 'error', 'refused'] as const;

function usageKeyOf(groupBy: UsageGroupBy): (row: LlmCallStatRow) => string | null {
  switch (groupBy) {
    case 'provider':
      return (r) => r.providerKind;
    case 'model':
      return (r) => r.model;
    case 'kind':
      return (r) => r.kind;
    case 'call-type':
      // The finer breakdown: a labeled row groups by its call_label (cleanup:header,
      // sync:bridge, …); an unlabeled one falls back to its own kind — 'main' for chat, the
      // kind verbatim otherwise. A pre-0103 'system' row thus lands in its own 'system' bucket,
      // distinct from every labeled group rather than silently merging into one of them
      // (llm-call-label-breakdown-plan.md Edge Cases).
      return (r) => r.callLabel ?? (r.kind === 'chat' ? 'main' : r.kind);
    case 'outcome':
      return (r) => r.outcome;
    case 'day':
      return (r) => r.createdAt.slice(0, 10);
  }
}

/** The per-row numeric for the chosen metric — null when the row has no value (pre-tracking
 *  rows' cost is null), which the aggregates then exclude. */
function usagePick(metric: UsageMetric): (row: LlmCallStatRow) => number | null {
  switch (metric) {
    case 'cost':
      return (r) => r.costUsd;
    case 'tokens':
      return (r) => r.totalTokens;
    case 'prompt':
      return (r) => r.promptTokens;
    case 'completion':
      return (r) => r.completionTokens;
    case 'cache':
      return (r) => r.cacheReadTokens;
    case 'calls':
      return () => 1; // every row counts as one call
  }
}

// --- Timing ---

type TimingGroupBy = 'day' | 'outcome' | 'chat';
type TimingMetric = 'first-token' | 'display-settle' | 'header' | 'body' | 'footer' | 'stop';

const TIMING_GROUP_OPTIONS: { value: TimingGroupBy; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'outcome', label: 'Outcome' },
  { value: 'chat', label: 'Chat' },
];

const TIMING_METRIC_OPTIONS: { value: TimingMetric; label: string }[] = [
  { value: 'first-token', label: 'Time to first token' },
  { value: 'display-settle', label: 'Time to display settle' },
  { value: 'header', label: 'Header repair span' },
  { value: 'body', label: 'Body repair span' },
  { value: 'footer', label: 'Footer repair span' },
  { value: 'stop', label: 'Turn stop time' },
];

const TIMING_OUTCOMES = ['ok', 'aborted', 'error'] as const;

function timingKeyOf(groupBy: TimingGroupBy): (row: TurnDisplayMetricRow) => string | null {
  switch (groupBy) {
    case 'day':
      return (r) => r.createdAt.slice(0, 10);
    case 'outcome':
      return (r) => r.outcome;
    case 'chat':
      return (r) => r.chatId;
  }
}

/** The per-row elapsed value for the chosen timing metric, or null when that span was never
 *  reached (an aborted turn has no display-settle, a no-cleanup turn no body span). */
function timingPick(metric: TimingMetric): (row: TurnDisplayMetricRow) => number | null {
  switch (metric) {
    case 'first-token':
      return (r) => r.firstTokenMs;
    case 'display-settle':
      return (r) => r.displaySettleMs;
    case 'header':
      return (r) => spanMs(r.headerStartMs, r.headerStopMs);
    case 'body':
      return (r) => spanMs(r.bodyStartMs, r.bodyStopMs);
    case 'footer':
      return (r) => spanMs(r.footerStartMs, r.footerStopMs);
    case 'stop':
      return (r) => r.terminatedAtMs ?? r.displaySettleMs;
  }
}

// --- formatting ---

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatMs(value: number): string {
  return `${Math.round(value).toLocaleString()} ms`;
}

// Turn-graph picker label (docs/plans/turn-timeline-graph-plan.md): local time, a short chat id
// prefix, and the outcome — enough to identify the turn without a second fetch.
function turnOptionLabel(t: TurnDisplayMetricRow): string {
  return `${new Date(t.dispatchAt).toLocaleTimeString()} · ${t.chatId.slice(0, 8)} · ${t.outcome}`;
}

const DAYS_OPTIONS = [7, 30, 90, 365];

export default function StatsView() {
  const [calls, setCalls] = useState<LlmCallStatRow[] | null>(null);
  const [turns, setTurns] = useState<TurnDisplayMetricRow[] | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);

  const [usageGroupBy, setUsageGroupBy] = useState<UsageGroupBy>('provider');
  const [usageMetric, setUsageMetric] = useState<UsageMetric>('cost');
  const [usageOutcomes, setUsageOutcomes] = useState<Set<LlmCallStatRow['outcome']>>(new Set(USAGE_OUTCOMES));

  const [timingGroupBy, setTimingGroupBy] = useState<TimingGroupBy>('day');
  const [timingMetric, setTimingMetric] = useState<TimingMetric>('display-settle');
  const [timingOutcomes, setTimingOutcomes] = useState<Set<TurnDisplayMetricRow['outcome']>>(new Set(TIMING_OUTCOMES));
  // Timing section "Turn graph" mode (docs/plans/turn-timeline-graph-plan.md): grouped bars (the
  // existing view, default) vs the waterfall Gantt; inside the graph, one selected historical
  // turn vs per-kind averages across the whole filtered set.
  const [timingMode, setTimingMode] = useState<'grouped' | 'graph'>('grouped');
  const [graphMode, setGraphMode] = useState<'last' | 'averages'>('last');
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);

  // useAdminUnlock fixes attemptLoad at mount; the days dropdown re-fetches through it, so the
  // current selection rides in a ref read by that same closure.
  const daysRef = useRef(days);
  daysRef.current = days;

  async function attemptLoad(key: string | null): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const [loadedCalls, loadedTurns] = await Promise.all([
        adminListLlmStats(key, daysRef.current),
        adminListTurnDisplayStats(key, daysRef.current),
      ]);
      setCalls(loadedCalls);
      setTurns(loadedTurns);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  const { adminKey, setAdminKey, checking, unlocked, loadError, load } = useAdminUnlock(attemptLoad);

  async function changeDays(next: number) {
    setDays(next);
    setError(null);
    try {
      const [loadedCalls, loadedTurns] = await Promise.all([
        adminListLlmStats(adminKey, next),
        adminListTurnDisplayStats(adminKey, next),
      ]);
      setCalls(loadedCalls);
      setTurns(loadedTurns);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to reload stats');
    }
  }

  function toggleChip<T extends string>(setter: (next: Set<T>) => void, current: Set<T>, value: T) {
    const next = new Set(current);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    setter(next);
  }

  const usageItems = useMemo<StatBarItem[]>(() => {
    if (!calls) return [];
    const filtered = calls.filter((r) => usageOutcomes.has(r.outcome));
    const groups = groupRows(filtered, usageKeyOf(usageGroupBy));
    const pick = usagePick(usageMetric);
    const items: StatBarItem[] = groups.map((group) => {
      const total = usageMetric === 'calls' ? group.rows.length : sumOf(group.rows, pick);
      const segments: StatBarSegment[] = USAGE_OUTCOMES.map((outcome) => {
        const outcomeRows = group.rows.filter((r) => r.outcome === outcome);
        const value = usageMetric === 'calls' ? outcomeRows.length : sumOf(outcomeRows, pick) ?? 0;
        return { label: outcome, value };
      });
      if (total === null) {
        return { key: group.key, label: group.label, value: 0, valueText: 'no data', segments };
      }
      const average = usageMetric === 'calls' ? null : meanOf(group.rows, pick);
      const valueText = usageMetric === 'cost' ? formatUsd(total) : formatCount(total);
      return {
        key: group.key,
        label: group.label,
        value: total,
        valueText,
        sublabel: `${group.rows.length} call${group.rows.length === 1 ? '' : 's'}${
          average !== null ? ` · avg ${usageMetric === 'cost' ? formatUsd(average) : formatCount(average)}` : ''
        }`,
        segments,
      };
    });
    return items.sort((a, b) => b.value - a.value);
  }, [calls, usageGroupBy, usageMetric, usageOutcomes]);

  const timingItems = useMemo<StatBarItem[]>(() => {
    if (!turns) return [];
    const filtered = turns.filter((r) => timingOutcomes.has(r.outcome));
    const groups = groupRows(filtered, timingKeyOf(timingGroupBy));
    const pick = timingPick(timingMetric);
    const items: StatBarItem[] = groups.map((group) => {
      const average = meanOf(group.rows, pick);
      const segments: StatBarSegment[] = TIMING_OUTCOMES.map((outcome) => {
        const outcomeRows = group.rows.filter((r) => r.outcome === outcome);
        return { label: outcome, value: meanOf(outcomeRows, pick) ?? 0 };
      });
      if (average === null) {
        return { key: group.key, label: group.label, value: 0, valueText: 'no data', segments };
      }
      return {
        key: group.key,
        label: group.label,
        value: average,
        valueText: formatMs(average),
        sublabel: `${group.rows.length} turn${group.rows.length === 1 ? '' : 's'}`,
        segments,
      };
    });
    return items.sort((a, b) => b.value - a.value);
  }, [turns, timingGroupBy, timingMetric, timingOutcomes]);

  // --- Timing "Turn graph" mode (docs/plans/turn-timeline-graph-plan.md) ---

  // The turn rows the graph works off: same outcome chips (and the top-level days lookback,
  // which the fetch already applied) the grouped-bars mode respects. Arrival order is newest
  // first, so the picker reads newest→oldest with no extra sort.
  const filteredTurns = useMemo<TurnDisplayMetricRow[]>(() => {
    if (!turns) return [];
    return turns.filter((r) => timingOutcomes.has(r.outcome));
  }, [turns, timingOutcomes]);

  // Selection tracks the filtered set: when the selected turn falls out of a new filter (outcome
  // chip or days change re-fetched), fall back to the new set's newest entry rather than pointing
  // at a turn no longer listed.
  const selectedTurn = useMemo<TurnDisplayMetricRow | null>(() => {
    if (filteredTurns.length === 0) return null;
    return filteredTurns.find((t) => t.turnDisplayMetricId === selectedTurnId) ?? filteredTurns[0];
  }, [filteredTurns, selectedTurnId]);

  if (checking) {
    return <div className="stats-view" />;
  }

  if (!unlocked) {
    return (
      <div className="stats-view">
        <h1>BigImagine — stats</h1>
        <label>
          Admin API key
          <br />
          <input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} />
        </label>
        <br />
        <button onClick={load}>Load</button>
        {loadError && <div className="stats-error">{loadError}</div>}
      </div>
    );
  }

  if (calls === null || turns === null) {
    return <div className="stats-view stats-loading">Loading stats&hellip;</div>;
  }

  return (
    <div className="stats-view">
      <div className="stats-days">
        <label htmlFor="stats-days-select">Lookback</label>
        <select id="stats-days-select" value={days} onChange={(e) => void changeDays(Number(e.target.value))}>
          {DAYS_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </select>
      </div>
      {error && <div className="stats-error">{error}</div>}

      <section className="stats-section">
        <h2>Usage &amp; Cost</h2>
        <div className="stats-controls">
          <label>
            Group by
            <select value={usageGroupBy} onChange={(e) => setUsageGroupBy(e.target.value as UsageGroupBy)}>
              {USAGE_GROUP_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Metric
            <select value={usageMetric} onChange={(e) => setUsageMetric(e.target.value as UsageMetric)}>
              {USAGE_METRIC_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="stats-chips" role="group" aria-label="Outcome filter">
            {USAGE_OUTCOMES.map((outcome) => (
              <button
                key={outcome}
                type="button"
                className={`stats-chip${usageOutcomes.has(outcome) ? ' active' : ''}`}
                onClick={() => toggleChip(setUsageOutcomes, usageOutcomes, outcome)}
              >
                {outcome}
              </button>
            ))}
          </div>
        </div>
        <StatBarList items={usageItems} emptyMessage="No LLM calls in this window." />
      </section>

      <section className="stats-section">
        <h2>Timing</h2>
        <div className="stats-controls">
          <label>
            View
            <select value={timingMode} onChange={(e) => setTimingMode(e.target.value as 'grouped' | 'graph')}>
              <option value="grouped">Grouped bars</option>
              <option value="graph">Turn graph</option>
            </select>
          </label>
          {timingMode === 'grouped' && (
            <>
              <label>
                Group by
                <select value={timingGroupBy} onChange={(e) => setTimingGroupBy(e.target.value as TimingGroupBy)}>
                  {TIMING_GROUP_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Metric
                <select value={timingMetric} onChange={(e) => setTimingMetric(e.target.value as TimingMetric)}>
                  {TIMING_METRIC_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <div className="stats-chips" role="group" aria-label="Outcome filter">
            {TIMING_OUTCOMES.map((outcome) => (
              <button
                key={outcome}
                type="button"
                className={`stats-chip${timingOutcomes.has(outcome) ? ' active' : ''}`}
                onClick={() => toggleChip(setTimingOutcomes, timingOutcomes, outcome)}
              >
                {outcome}
              </button>
            ))}
          </div>
        </div>
        {timingMode === 'grouped' ? (
          <StatBarList items={timingItems} emptyMessage="No RP turns in this window." />
        ) : (
          <>
            <div className="stats-controls">
              <div className="stats-mode-toggle" role="group" aria-label="Turn graph mode">
                <button
                  type="button"
                  className={`stats-mode-btn${graphMode === 'last' ? ' active' : ''}`}
                  onClick={() => setGraphMode('last')}
                >
                  Last turn
                </button>
                <button
                  type="button"
                  className={`stats-mode-btn${graphMode === 'averages' ? ' active' : ''}`}
                  onClick={() => setGraphMode('averages')}
                >
                  Averages
                </button>
              </div>
              {graphMode === 'last' && filteredTurns.length > 0 && (
                <label>
                  Turn
                  <select
                    value={selectedTurn?.turnDisplayMetricId ?? ''}
                    onChange={(e) => setSelectedTurnId(e.target.value)}
                  >
                    {filteredTurns.map((t) => (
                      <option key={t.turnDisplayMetricId} value={t.turnDisplayMetricId}>
                        {turnOptionLabel(t)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {graphMode === 'last' ? (
              <TurnGanttChart
                report={selectedTurn ? buildTurnTimelineReport(selectedTurn) : null}
                emptyMessage={
                  filteredTurns.length === 0 ? 'No RP turns in this window.' : 'No timing data reached for this turn.'
                }
              />
            ) : (
              <TurnGanttChart
                report={buildAverageTurnTimelineReport(filteredTurns)}
                emptyMessage={
                  filteredTurns.length === 0 ? 'No RP turns in this window.' : 'No timing data reached in this window.'
                }
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}
