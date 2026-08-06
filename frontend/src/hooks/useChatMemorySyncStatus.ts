import { useEffect, useState } from 'react';
import { adminGetChatMemorySyncStatus } from '../api/client';
import type { ChatMemorySyncStatusRow } from '../api/types';

// The review panel's ongoing refresh, once unlocked — 30s to match the backend sync loop's own
// tick cadence (orchestrator/chatMemorySync.ts's POLL_INTERVAL_MS), same poll/cleanup shape as
// useTemporalState.ts. A transient poll failure leaves the last-known table on screen rather than
// flashing an error over a dashboard whose whole point is calm confirmation, not alarm — the
// initial unlock/auth handshake (ReviewPanelView's own attemptLoad) is what surfaces a real error.
const POLL_INTERVAL_MS = 30_000;

export function useChatMemorySyncStatus(adminKey: string | null, enabled: boolean) {
  const [rows, setRows] = useState<ChatMemorySyncStatusRow[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const poll = () => {
      adminGetChatMemorySyncStatus(adminKey)
        .then((result) => {
          if (!cancelled) setRows(result);
        })
        .catch(() => {
          // Best-effort — see file doc above.
        });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [adminKey, enabled, refreshKey]);

  return { rows, refresh: () => setRefreshKey((k) => k + 1) };
}
