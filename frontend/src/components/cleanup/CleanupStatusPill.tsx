import { useEffect, useRef, useState } from 'react';
import { getCleanupStatus, runCleanupNow } from '../../api/client';
import type { CleanupStatus } from '../../api/types';
import './CleanupStatusPill.css';

// Poll cadence — the subloop ticks every 5s (cleanupLoop.ts's POLL_INTERVAL_MS), so the pill is
// never more than one tick stale, matching useTemporalState.ts's house cadence. A failed poll
// keeps the last-known state (best-effort, like getChatTurnStatus) rather than flashing an error
// over a pill whose whole point is calm background confirmation.
const POLL_INTERVAL_MS = 5_000;

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
//
// The pill is deliberately read-only about the message list: when the loop first reports the
// newest message settled (unchanged | modified | flagged) it signals the owning view once via
// onSettled, and the view re-fetches the chat so a rewrite shows up straightaway instead of
// waiting for a manual refresh. The pill itself never holds or mutates message state.

interface CleanupStatusPillProps {
  apiKey: string | null;
  chatId: string;
  /** Fired once per message the moment the loop first reports it settled (unchanged | modified |
   *  flagged) — never for 'thinking'. Lets the owning view re-fetch the chat so a rewrite
   *  appears immediately; re-armed if the loop goes back to 'thinking' for the same message (a
   *  swipe/regeneration started a fresh pass), so that pass's settle fires again. */
  onSettled?: (messageId: string) => void;
}

export default function CleanupStatusPill({ apiKey, chatId, onSettled }: CleanupStatusPillProps) {
  const [status, setStatus] = useState<CleanupStatus | null>(null);
  const [runningNow, setRunningNow] = useState(false);
  // One-shot "settled" signal per message: once the loop reports a terminal state it keeps
  // reporting it on every poll, so without this we'd re-fire onSettled — and the owning view's
  // re-fetch — on every 5s tick. Reset when the newest message changes, or on chat/auth change
  // (effect below). Re-armed by the 'thinking' branch when a swipe starts a fresh pass.
  const settleTrackRef = useRef<{ messageId: string | null; fired: Set<string> }>({
    messageId: null,
    fired: new Set(),
  });
  // Latest callback without re-running the poll effect on every parent render (ChatView passes a
  // fresh inline arrow each render).
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    let cancelled = false;
    settleTrackRef.current = { messageId: null, fired: new Set() };
    const poll = () => {
      getCleanupStatus(chatId, apiKey).then((s) => {
        if (cancelled || !s) return;
        setStatus(s);
        const latest = s.latest;
        if (!latest) return;
        const track = settleTrackRef.current;
        if (latest.state === 'thinking') {
          // Loop is still (re)working this message — if we'd already fired for it, re-arm so a
          // fresh settle (e.g. a swipe regenerated the content) fires again.
          if (track.messageId === latest.messageId) track.fired.delete(latest.messageId);
          else track.messageId = latest.messageId;
          return;
        }
        if (track.messageId !== latest.messageId) {
          track.messageId = latest.messageId;
          track.fired = new Set();
        }
        if (!track.fired.has(latest.messageId)) {
          track.fired.add(latest.messageId);
          onSettledRef.current?.(latest.messageId);
        }
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
