import { useEffect, useState } from 'react';
import { callTool } from '../../api/client';
import type { ActiveTimer } from '../../api/types';
import { useTemporalState } from '../../hooks/useTemporalState';
import './TimerStrip.css';

interface TimerStripProps {
  apiKey: string | null;
}

function formatRemaining(endAt: string, nowMs: number): string {
  const remainingMs = Math.max(0, new Date(endAt).getTime() - nowMs);
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

// Minimal, always-visible countdown banner — no push channel exists (useTemporalState.ts polls
// every 5s), so the displayed time ticks locally every second between polls rather than jumping
// in 5s increments. Renders nothing when no timer is running — doesn't take up space when
// there's nothing to show.
export default function TimerStrip({ apiKey }: TimerStripProps) {
  const { state, refresh } = useTemporalState(apiKey);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (state.running.length === 0) return;
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [state.running.length]);

  if (state.running.length === 0) return null;

  const cancelTimer = (timer: ActiveTimer) => {
    callTool('cancel_timer', { timerId: timer.timerId }, apiKey)
      .then(refresh)
      .catch(() => {
        // Best-effort — a failed cancel just leaves the timer running; the user can retry.
      });
  };

  return (
    <div className="timer-strip">
      {state.running.map((timer) => (
        <div key={timer.timerId} className="timer-strip-item">
          <span className="timer-strip-label">{timer.label}</span>
          <span className="timer-strip-remaining">{formatRemaining(timer.endAt, nowMs)}</span>
          <button
            className="timer-strip-cancel"
            title="Cancel timer"
            onClick={() => cancelTimer(timer)}
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
