import { useEffect, useRef, useState } from 'react';
import { getCleanupStatus, runCleanupNow } from '../../api/client';
import type { CleanupRegionState, CleanupStatus } from '../../api/types';
import './CleanupStatusPill.css';

// Poll cadence — the subloop ticks every 5s (cleanupLoop.ts's POLL_INTERVAL_MS), so the pills are
// never more than one tick stale, matching useTemporalState.ts's house cadence. A failed poll
// keeps the last-known state (best-effort, like getChatTurnStatus) rather than flashing an error
// over pills whose whole point is calm background confirmation.
const POLL_INTERVAL_MS = 5_000;

/** The three regions' live states while a turn with in-stream cleanup is actively streaming —
 *  fed from the bigimagine_cleanup SSE frames (server-side cleanupLiveStatus.ts), so the pills
 *  update live with no polling. Once the stream ends the caller clears this and the settled poll
 *  becomes authoritative again (the same ambient-hint-then-canonical-record handoff the backend
 *  documents). */
export interface CleanupLivePillState {
  header: CleanupRegionState;
  body: CleanupRegionState;
  footer: CleanupRegionState;
}

const REGIONS: Array<{ key: keyof CleanupLivePillState; label: string; title: string }> = [
  { key: 'header', label: 'h', title: 'Header — scene-header repair' },
  { key: 'body', label: 'b', title: 'Body — antislop paragraph repair' },
  { key: 'footer', label: 'f', title: 'Footer — inner-thoughts block repair' },
];

const STATE_ICON: Record<CleanupRegionState, string> = {
  'not-called': '·',
  'in-flux': '⟳',
  deployed: '✎',
  flagged: '⚠',
};

interface CleanupStatusPillProps {
  apiKey: string | null;
  chatId: string;
  /** Live per-region override while a turn is streaming (see CleanupLivePillState); null/absent
   *  means "no live turn" and the settled poll is authoritative. A fresh turn can emit its first
   *  cleanup frame before the first poll response lands, so the pills render when either side
   *  says cleanup is on. */
  liveStatus?: CleanupLivePillState | null;
  /** Fired once per message the moment the loop first reports it fully settled (every region
   *  not-called | deployed | flagged — never while any is in-flux). Lets the owning view re-fetch
   *  the chat so a rewrite appears immediately; re-armed if the loop goes back to in-flux for the
   *  same message (a swipe/regeneration started a fresh pass), so that pass's settle fires again. */
  onSettled?: (messageId: string) => void;
}

export default function CleanupStatusPill({ apiKey, chatId, liveStatus, onSettled }: CleanupStatusPillProps) {
  const [status, setStatus] = useState<CleanupStatus | null>(null);
  const [runningNow, setRunningNow] = useState(false);
  // One-shot "settled" signal per message: once the loop reports a terminal state it keeps
  // reporting it on every poll, so without this we'd re-fire onSettled — and the owning view's
  // re-fetch — on every 5s tick. Reset when the newest message changes, or on chat/auth change
  // (effect below). Re-armed by the in-flux branch when a swipe starts a fresh pass.
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
        const regions = [latest.regions.header.state, latest.regions.body.state, latest.regions.footer.state];
        const track = settleTrackRef.current;
        if (regions.some((r) => r === 'in-flux')) {
          // The loop is still (re)working this message — if we'd already fired for it, re-arm so
          // a fresh settle (e.g. a swipe regenerated the content) fires again.
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

  // Renders nothing when cleanup isn't enabled for the chat (status.enabled false — not opted
  // in, non-RP, or archived). While a live stream is active its frames win (liveStatus present,
  // even before the first poll response confirms enabled).
  if (!status?.enabled && !liveStatus) return null;

  const runNow = () => {
    setRunningNow(true);
    runCleanupNow(chatId, apiKey)
      .catch(() => {
        // Best-effort — a failed run-now leaves the poll tick to handle it; nothing to surface.
      })
      .finally(() => setRunningNow(false));
  };

  return (
    <div className="cleanup-status-pills" role="group" aria-label="Async cleanup status — click to clean this chat now">
      {REGIONS.map(({ key, label, title }) => {
        const state = liveStatus?.[key] ?? status?.latest?.regions[key].state ?? 'not-called';
        return (
          <button
            key={key}
            type="button"
            className={`cleanup-status-pill cleanup-status-${state}${runningNow ? ' running-now' : ''}`}
            title={`${title}: ${state}`}
            aria-label={`${title}: ${state}`}
            onClick={runNow}
          >
            <span className="cleanup-status-icon" aria-hidden="true">
              {STATE_ICON[state]}
            </span>
            <span className="cleanup-status-text">{label}</span>
          </button>
        );
      })}
      {status && status.pending > 1 && <span className="cleanup-status-pending">+{status.pending}</span>}
    </div>
  );
}
