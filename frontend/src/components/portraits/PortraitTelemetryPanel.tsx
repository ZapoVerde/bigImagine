import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fetchPortraitRoundTelemetry } from '../../api/client';
import type { PortraitCallTelemetry, PortraitRoundStatus, PortraitRoundTelemetry } from '../../api/types';
import './PortraitTelemetryPanel.css';

// Portrait Studio round telemetry (docs/plans/portrait-studio-telemetry-plan.md) — the durable
// per-round receipt in the Studio's left-side panel, in the same spirit as RP chat's Prompt
// Inspector: per-call rows (Mutation / Wiki pull / Image render / Reflection), statuses, and the
// round's totals. Fetch immediately after generation/feedback/retry (refreshToken bumps), then
// poll while the round still has a running call; stop the moment the round is terminal. A
// historical episode with no round shows no linked data rather than inventing telemetry (plan
// §Edge cases). Provider errors render as escaped text (React text nodes) — never as HTML.

interface PortraitTelemetryPanelProps {
  apiKey: string | null;
  /** The active round's id (set after generate/feedback/retry, cleared on no round). */
  roundId: string | null;
  /** Bumped once per round action so the panel re-fetches immediately (plan §Endpoint and
   *  polling — the receipt is a live read, never cached beyond the fetch). */
  refreshToken: number;
  /** Optional: when absent (the studio-body mount), the × close button is hidden. */
  onClose?: () => void;
}

const POLL_MS = 2000;

export default function PortraitTelemetryPanel({ apiKey, roundId, refreshToken, onClose }: PortraitTelemetryPanelProps) {
  const [telemetry, setTelemetry] = useState<PortraitRoundTelemetry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Independently collapsible, default open (plan §Left-panel presentation); a collapsed
  // summary keeps the round status and compact totals visible.
  const [collapsed, setCollapsed] = useState(false);
  // The newest load closure lives in a ref so the polling effect always schedules the latest
  // fetch without re-arming itself; a monotonically increasing sequence discards stale,
  // out-of-order responses so polling can never let an old round overwrite the current one.
  const loadRef = useRef<() => void>(() => {});
  const requestSeq = useRef(0);

  const load = useCallback(() => {
    requestSeq.current += 1;
    const seq = requestSeq.current;
    setLoading(true);
    setError(null);
    if (!roundId) {
      setTelemetry(null);
      setLoading(false);
      return;
    }
    fetchPortraitRoundTelemetry(roundId, apiKey)
      .then((t) => {
        if (seq !== requestSeq.current) return;
        setTelemetry(t);
      })
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        setError(err instanceof ApiError ? err.message : 'failed to load round telemetry');
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }, [roundId, apiKey]);

  loadRef.current = load;

  useEffect(() => {
    load();
  }, [load, refreshToken]);

  // Poll while the round is still running; stop the moment it's terminal (plan §Endpoint and
  // polling — a running round with no further action must settle on its own).
  useEffect(() => {
    if (telemetry?.status !== 'running') return;
    const t = window.setTimeout(() => loadRef.current(), POLL_MS);
    return () => window.clearTimeout(t);
  }, [telemetry?.status, telemetry?.roundId]);

  return (
    <div className={`portrait-telemetry-panel${collapsed ? ' collapsed' : ''}`}>
      <div className="portrait-telemetry-header">
        <span className="portrait-telemetry-title">Round telemetry</span>
        <div className="portrait-telemetry-header-actions">
          <button
            type="button"
            className="portrait-telemetry-collapse"
            title={collapsed ? 'Expand round telemetry' : 'Collapse round telemetry'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? '▸' : '▾'}
          </button>
          <button type="button" className="portrait-telemetry-refresh" title="Re-fetch the round telemetry" onClick={load} disabled={loading || !roundId}>
            ↻
          </button>
          {onClose && (
            <button type="button" className="portrait-telemetry-close" title="Close round telemetry" onClick={onClose}>
              &times;
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="portrait-telemetry-content">
          {!roundId && (
            <p className="portrait-telemetry-empty">No round yet — a receipt appears here after you generate candidates.</p>
          )}
          {roundId && error && <div className="portrait-telemetry-error">{error}</div>}
          {roundId && loading && !telemetry && <div className="portrait-telemetry-loading">Loading…</div>}
          {telemetry && (
            <>
              <div className="portrait-telemetry-summary">
                <span className={`portrait-telemetry-status portrait-telemetry-status-${telemetry.status}`}>{statusLabel(telemetry.status)}</span>
              </div>
              <TotalsBlock telemetry={telemetry} />
              <div className="portrait-telemetry-calls">
                {telemetry.calls.length === 0 && (
                  <p className="portrait-telemetry-empty">No calls recorded for this round.</p>
                )}
                {telemetry.calls.map((call, i) => (
                  <CallRow key={call.callId} call={call} imageOrdinal={imageOrdinal(telemetry.calls, i)} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function statusLabel(status: PortraitRoundStatus): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'partial':
      return 'partial';
    case 'failed':
      return 'failed';
  }
}

function phaseTitle(call: PortraitCallTelemetry): string {
  switch (call.phase) {
    case 'mutation':
      return 'Mutation';
    case 'wiki_pull':
      return 'Wiki pull';
    case 'image_render':
      return 'Image render';
    case 'reflection':
      return 'Reflection';
  }
}

// "Candidate N" ordinal for image renders, in display (chronological) order (plan §Left-panel
// presentation) — index among image_render rows, not the uuid.
function imageOrdinal(calls: PortraitCallTelemetry[], index: number): number | null {
  if (calls[index].phase !== 'image_render') return null;
  return calls.slice(0, index + 1).filter((c) => c.phase === 'image_render').length;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// The totals block (plan §Left-panel presentation) separates LLM tokens, LLM duration, image
// duration, and wall-clock duration — parallel image work must never be mistaken for sequential
// elapsed time. cacheReadTokens appears only when a call reported cache accounting.
function TotalsBlock({ telemetry }: { telemetry: PortraitRoundTelemetry }) {
  const t = telemetry.totals;
  return (
    <div className="portrait-telemetry-totals">
      <div className="portrait-telemetry-totals-row">
        <span className="portrait-telemetry-totals-label">Tokens</span>
        <span className="portrait-telemetry-totals-value">
          {t.promptTokens.toLocaleString()} in · {t.completionTokens.toLocaleString()} out · {t.totalTokens.toLocaleString()} total
          {t.cacheReadTokens !== undefined && <span className="portrait-telemetry-totals-cache"> · {t.cacheReadTokens.toLocaleString()} cache hit</span>}
        </span>
      </div>
      <div className="portrait-telemetry-totals-row">
        <span className="portrait-telemetry-totals-label">LLM</span>
        <span className="portrait-telemetry-totals-value">{fmtMs(t.llmDurationMs)}</span>
      </div>
      <div className="portrait-telemetry-totals-row">
        <span className="portrait-telemetry-totals-label">Images</span>
        <span className="portrait-telemetry-totals-value">{fmtMs(t.imageDurationMs)}</span>
      </div>
      <div className="portrait-telemetry-totals-row">
        <span className="portrait-telemetry-totals-label">Wall clock</span>
        <span className="portrait-telemetry-totals-value">{fmtMs(t.wallClockDurationMs)}</span>
      </div>
    </div>
  );
}

// One row per call (plan §Left-panel presentation): phase title + candidate ordinal for image
// renders, per-call tokens and duration when the provider reported them, status. Failed rows
// open by default and display the exact error message, wrapped not truncated, rendered as
// escaped text (React text nodes — plan §Edge cases: provider error markup is never HTML).
function CallRow({ call, imageOrdinal: ordinal }: { call: PortraitCallTelemetry; imageOrdinal: number | null }) {
  const failed = call.status === 'failed';
  const parts: string[] = [];
  if (ordinal !== null) parts.push(`Candidate ${ordinal}`);
  if (call.durationMs !== undefined) parts.push(fmtMs(call.durationMs));
  if (call.providerKind || call.model) parts.push([call.providerKind, call.model].filter(Boolean).join(' · '));
  return (
    <details className={`portrait-telemetry-call${failed ? ' failed' : ''}`} open={failed}>
      <summary>
        <span className="portrait-telemetry-call-title">{phaseTitle(call)}</span>
        <span className={`portrait-telemetry-call-status portrait-telemetry-status-${call.status}`}>{call.status}</span>
        <span className="portrait-telemetry-call-meta">
          {call.promptTokens !== undefined && (
            <>
              {call.promptTokens.toLocaleString()} in · {call.completionTokens !== undefined ? call.completionTokens.toLocaleString() : '—'} out ·{' '}
              {call.totalTokens !== undefined ? call.totalTokens.toLocaleString() : '—'} total
            </>
          )}
          {call.cacheReadTokens !== undefined && <span className="portrait-telemetry-call-cache"> · {call.cacheReadTokens.toLocaleString()} cache</span>}
          {parts.length > 0 && <span className="portrait-telemetry-call-parts"> · {parts.join(' · ')}</span>}
        </span>
      </summary>
      {(call.errorMessage || call.errorCode) && (
        <p className="portrait-telemetry-call-error">
          {call.errorCode ? `${call.errorCode}: ` : ''}
          {call.errorMessage ?? 'unknown provider error'}
        </p>
      )}
    </details>
  );
}