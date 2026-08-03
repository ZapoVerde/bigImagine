import { useEffect, useState } from 'react';
import { callTool } from '../api/client';
import type { TemporalState } from '../api/types';

// bigBrain has no server->client push channel (the only SSE is for an in-flight chat completion),
// so this polls list_temporal_state via the existing generic POST /v1/tools/:name route, not a
// bespoke endpoint. 5s is frequent enough that a timer finishing feels prompt without hammering
// the server; the visible countdown itself ticks locally every second between polls
// (TimerStrip.tsx), not from this hook.
const POLL_INTERVAL_MS = 5_000;

const EMPTY_STATE: TemporalState = { running: [], completed: [], cancelled: [], upcomingAlarms: [], recentlyFiredAlarms: [] };

export function useTemporalState(apiKey: string | null) {
  const [state, setState] = useState<TemporalState>(EMPTY_STATE);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      callTool<TemporalState>('list_temporal_state', {}, apiKey)
        .then((result) => {
          if (!cancelled) setState(result);
        })
        .catch(() => {
          // Best-effort: a failed poll leaves the last-known state on screen rather than clearing
          // a running timer's countdown out from under the user over a transient network blip.
        });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [apiKey, refreshKey]);

  return { state, refresh: () => setRefreshKey((k) => k + 1) };
}
