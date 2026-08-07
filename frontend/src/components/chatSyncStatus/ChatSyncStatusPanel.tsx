import { useCallback, useEffect, useState } from 'react';
import { ApiError, getChatSyncStatus } from '../../api/client';
import type { ChatSyncStatus } from '../../api/types';
import './ChatSyncStatusPanel.css';

// Poll cadence — matches orchestrator/chatMemorySync.ts's own POLL_INTERVAL_MS, so "when did the
// last attempt land" and "is it due yet" are never more than one tick stale while the panel is
// open. A transient poll failure keeps the last-known readout on screen (same best-effort shape
// as useChatMemorySyncStatus.ts) rather than flashing an error over a panel whose whole point is
// calm confirmation.
const POLL_INTERVAL_MS = 30_000;

interface ChatSyncStatusPanelProps {
  apiKey: string | null;
  chatId: string;
  /** Archived chats are excluded from the rolling sync loop's due-check (findDueChats filters on
   *  archived_at is null) — passed in so the panel can say "archived — rolling sync stopped"
   *  instead of "due now" for one. */
  archived: boolean;
  onClose: () => void;
}

// The RP chat header menu's "Sync status" panel (ChatView.tsx) — the per-chat, user-scoped slice
// of the admin Review Panel's sync record (bi_principles.md §11's read surface, narrowed to this
// chat via GET /v1/chats/:id/sync-status, no admin key). Shows the last sync attempt's outcome,
// the last successful run's chunk/entry counts, the canon-fact proposals this chat's bridge/
// lorebook/people curators have produced, and — the "is a sync actually happening" part — how
// many more unsynced messages the loop is waiting for before its next tick does anything.
export default function ChatSyncStatusPanel({ apiKey, chatId, archived, onClose }: ChatSyncStatusPanelProps) {
  const [status, setStatus] = useState<ChatSyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getChatSyncStatus(chatId, apiKey)
      .then(setStatus)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load sync status'))
      .finally(() => setLoading(false));
  }, [chatId, apiKey]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <div className="chat-sync-status-panel">
      <div className="chat-sync-status-header">
        <span className="chat-sync-status-title">Sync Status</span>
        <div className="chat-sync-status-header-actions">
          <button
            type="button"
            className="chat-sync-status-refresh"
            title="Re-fetch this chat's sync status"
            onClick={load}
            disabled={loading}
          >
            ↻
          </button>
          <button type="button" className="chat-sync-status-close" title="Close sync status" onClick={onClose}>
            &times;
          </button>
        </div>
      </div>
      <div className="chat-sync-status-content">
        {error && status === null ? (
          <div className="chat-sync-status-error">{error}</div>
        ) : status === null ? (
          <div className="chat-sync-status-loading">Loading sync status&hellip;</div>
        ) : (
          <SyncStatusBody status={status} archived={archived} />
        )}
      </div>
    </div>
  );
}

function SyncStatusBody({ status, archived }: { status: ChatSyncStatus; archived: boolean }) {
  const badgeClass =
    status.lastStatus === 'ok'
      ? 'chat-sync-badge-ok'
      : status.lastStatus === 'error'
        ? 'chat-sync-badge-error'
        : status.lastStatus === 'skipped'
          ? 'chat-sync-badge-skipped'
          : 'chat-sync-badge-none';

  const dueLine = archived
    ? 'Archived — rolling sync stopped.'
    : status.unsyncedMessages >= status.dueAfterMessages
      ? 'Due now — the loop runs every ~30s.'
      : `${status.dueAfterMessages - status.unsyncedMessages} more message${status.dueAfterMessages - status.unsyncedMessages === 1 ? '' : 's'} until the next sync (of ${status.dueAfterMessages}).`;

  return (
    <>
      <div className="chat-sync-status-line">
        <span className={badgeClass}>{status.lastStatus ?? 'never'}</span>
        {status.consecutiveErrors > 1 && <span className="chat-sync-consecutive"> ×{status.consecutiveErrors} in a row</span>}
      </div>

      {status.lastStatus === null && (
        <div className="chat-sync-status-note">
          No sync attempt yet — the rolling memory sync kicks in once this chat passes its live
          window plus a full sync window of messages.
        </div>
      )}

      <dl className="chat-sync-status-dl">
        <dt>Last attempt</dt>
        <dd title={status.lastAttemptAt ? new Date(status.lastAttemptAt).toLocaleString() : undefined}>
          {relativeTime(status.lastAttemptAt)}
        </dd>
        <dt>Last success</dt>
        <dd title={status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : undefined}>
          {relativeTime(status.lastSuccessAt)}
        </dd>
        <dt>Last run</dt>
        <dd>
          {status.lastStatus === 'ok' ? `${status.lastChunksAdded ?? 0} chunks / ${status.lastEntriesUpdated ?? 0} entries` : '—'}
        </dd>
        <dt>Canon facts</dt>
        <dd>
          {status.canonProposedCount} proposed / {status.canonApprovedCount} approved
          {status.canonLastProposedAt ? ` · last ${relativeTime(status.canonLastProposedAt)}` : ''}
        </dd>
        <dt>Next sync</dt>
        <dd>{dueLine}</dd>
      </dl>

      {status.lastStatus === 'error' && status.lastError && (
        <div className="chat-sync-status-error">
          <strong>{status.lastStep ?? 'unknown step'}:</strong> {status.lastError}
        </div>
      )}
    </>
  );
}

/** Compact "2m ago"-style formatting; the poll above re-renders every 30s so these stay fresh
 *  while the panel is open. Absolute timestamps ride in each row's title attribute. */
function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
