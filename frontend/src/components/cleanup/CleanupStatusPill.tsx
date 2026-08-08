import { useEffect, useState } from 'react';
import { getCleanupStatus, runCleanupNow } from '../../api/client';
import type { CleanupStatus } from '../../api/types';
import './CleanupStatusPill.css';

// Poll cadence — the subloop ticks every 5s (cleanupLoop.ts's POLL_INTERVAL_MS), so the pill is
// never more than one tick stale, matching useTemporalState.ts's house cadence. A failed poll
// keeps the last-known state (best-effort, like getChatTurnStatus) rather than flashing an error
// over a pill whose whole point is calm background confirmation.
const POLL_INTERVAL_MS = 5_000;

interface CleanupStatusPillProps {
  apiKey: string | null;
  chatId: string;
}

// The little floating status pill at the top of an RP chat — BigImagine's take on the TRG badge
// (SillyTavern-Triggeryze/badge.js), driven by the async cleanup subloop instead of push events:
// the loop rewrites the newest reply after it lands, and this pill shows where that rewrite is.
// States mirror the backend exactly (cleanupLoop.ts's CleanupMessageState): thinking = the reply
// landed but the loop hasn't covered it yet (red pulse, TRG's running state); unchanged = nothing
// needed fixing (muted gray); modified = the loop rewrote it, original kept as a swipe (green);
// flagged = a repair was needed but produced nothing / errored, left in place (amber warning).
// A pending count is shown alongside when the loop is still working through the backlog.
//
// Click = run-now for this chat (POST /v1/cleanup/run), same interaction as the TRG badge's
// click-to-re-run. Renders nothing when cleanup isn't enabled for the chat (status.enabled false
// — not opted in, non-RP, or archived), mirroring TRG's "no badge when the feature is off".
export default function CleanupStatusPill({ apiKey, chatId }: CleanupStatusPillProps) {
  const [status, setStatus] = useState<CleanupStatus | null>(null);
  const [runningNow, setRunningNow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getCleanupStatus(chatId, apiKey).then((s) => {
        if (!cancelled && s) setStatus(s);
      });
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [chatId, apiKey]);

  if (!status?.enabled) return null;

  const state = status.latest?.state ?? 'thinking';
  const label = state === 'thinking' ? (status.pending > 0 ? 'cleaning' : 'thinking') : state;

  const runNow = () => {
    setRunningNow(true);
    runCleanupNow(chatId, apiKey)
      .catch(() => {
        // Best-effort — a failed run-now leaves the poll tick to handle it; nothing to surface.
      })
      .finally(() => setRunningNow(false));
  };

  return (
    <button
      type="button"
      className={`cleanup-status-pill cleanup-status-${state}${runningNow ? ' running-now' : ''}`}
      title="Async cleanup status — click to clean this chat now"
      onClick={runNow}
    >
      <span className="cleanup-status-icon" aria-hidden="true">
        {state === 'thinking' ? '⟳' : state === 'flagged' ? '⚠' : state === 'modified' ? '✎' : '✓'}
      </span>
      <span className="cleanup-status-text">{label}</span>
      {status.pending > 1 && <span className="cleanup-status-pending">+{status.pending}</span>}
    </button>
  );
}
