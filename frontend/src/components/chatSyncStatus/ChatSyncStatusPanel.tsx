import { useCallback, useEffect, useState } from 'react';
import { ApiError, getChatSyncInspection, getChatSyncStatus } from '../../api/client';
import type { ChatSyncInspection, ChatSyncStatus } from '../../api/types';
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
          <SyncStatusBody status={status} archived={archived} chatId={chatId} apiKey={apiKey} />
        )}
      </div>
    </div>
  );
}

function SyncStatusBody({
  status,
  archived,
  chatId,
  apiKey,
}: {
  status: ChatSyncStatus;
  archived: boolean;
  chatId: string;
  apiKey: string | null;
}) {
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

      <SyncHistory chatId={chatId} apiKey={apiKey} syncs={status.syncs} />
    </>
  );
}

// The "click a sync and play it back" list: every sync point this chat has produced, newest
// first. Rows render from the cheap summary the status poll returns; expanding a row fetches that
// sync's full inspection record (getChatSyncInspection — 0079) on demand: the memory entries it
// created or changed (chat_memory_entries re-points sync_id on every update, so the list is
// exactly "touched by this sync"), the canon-fact proposals it wrote, and the fully-rendered
// bridge prompt it sent the model (null for non-rp chats and pre-0079 syncs).
function SyncHistory({ chatId, apiKey, syncs }: { chatId: string; apiKey: string | null; syncs: ChatSyncStatus['syncs'] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Map<string, ChatSyncInspection>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());

  const toggle = (syncId: string) => {
    const isExpanding = !expanded.has(syncId);
    // Pure updater — the fetch must not live inside it (React StrictMode double-invokes
    // updaters in dev, which would fire two duplicate GETs per expand).
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(syncId)) {
        next.delete(syncId);
      } else {
        next.add(syncId);
      }
      return next;
    });
    if (isExpanding && !details.has(syncId) && !loading.has(syncId)) {
      setLoading((l) => new Set(l).add(syncId));
      getChatSyncInspection(chatId, syncId, apiKey)
        .then((inspection) => {
          setDetails((d) => new Map(d).set(syncId, inspection));
          setErrors((e) => {
            const nextErr = new Map(e);
            nextErr.delete(syncId);
            return nextErr;
          });
        })
        .catch((err) =>
          setErrors((e) =>
            new Map(e).set(syncId, err instanceof ApiError ? err.message : 'failed to load sync detail'),
          ),
        )
        .finally(() => {
          setLoading((l) => {
            const nextLoading = new Set(l);
            nextLoading.delete(syncId);
            return nextLoading;
          });
        });
    }
  };

  if (syncs.length === 0) {
    return (
      <div className="chat-sync-history">
        <div className="chat-sync-history-title">Sync history</div>
        <div className="chat-sync-status-note">
          No sync passes yet — this chat's rolling memory sync hasn't produced a sync point.
        </div>
      </div>
    );
  }

  return (
    <div className="chat-sync-history">
      <div className="chat-sync-history-title">Sync history</div>
      <ul className="chat-sync-history-list">
        {syncs.map((sync) => {
          const isOpen = expanded.has(sync.syncId);
          return (
            <li key={sync.syncId} className="chat-sync-history-item">
              <button type="button" className="chat-sync-history-row" onClick={() => toggle(sync.syncId)}>
                <span className="chat-sync-history-chevron" aria-hidden>
                  {isOpen ? '▾' : '▸'}
                </span>
                <span className="chat-sync-history-ordinal">Sync #{sync.ordinal}</span>
                <span className="chat-sync-history-meta">
                  {sync.entryCount} {sync.entryCount === 1 ? 'entry' : 'entries'}
                  {sync.factCount > 0 ? ` · ${sync.factCount} fact${sync.factCount === 1 ? '' : 's'}` : ''}
                </span>
                <span className="chat-sync-history-time" title={new Date(sync.createdAt).toLocaleString()}>
                  {relativeTime(sync.createdAt)}
                </span>
              </button>
              {isOpen && (
                <SyncHistoryDetail detail={details.get(sync.syncId)} loading={loading.has(sync.syncId)} error={errors.get(sync.syncId) ?? null} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SyncHistoryDetail({
  detail,
  loading,
  error,
}: {
  detail: ChatSyncInspection | undefined;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="chat-sync-history-detail">
        <div className="chat-sync-status-loading">Loading sync detail&hellip;</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="chat-sync-history-detail">
        <div className="chat-sync-status-error">{error}</div>
      </div>
    );
  }
  if (!detail) return null;

  return (
    <div className="chat-sync-history-detail">
      <div className="chat-sync-history-section-title">Memories created / changed</div>
      {detail.entries.length === 0 ? (
        <div className="chat-sync-status-note">None — this sync only produced chunks/canon facts.</div>
      ) : (
        <ul className="chat-sync-history-entries">
          {detail.entries.map((e) => (
            <li key={e.topicKey} className="chat-sync-history-entry">
              <div className="chat-sync-history-entry-topic">{e.topicKey}</div>
              <div className="chat-sync-history-entry-content">{e.content}</div>
            </li>
          ))}
        </ul>
      )}

      {detail.canonFacts.length > 0 && (
        <>
          <div className="chat-sync-history-section-title">Canon fact proposals</div>
          <ul className="chat-sync-history-facts">
            {detail.canonFacts.map((f) => (
              <li key={f.factId} className="chat-sync-history-fact">
                <div className="chat-sync-history-fact-head">
                  <span className={`chat-sync-fact-cat chat-sync-fact-cat-${f.category}`}>{f.category}</span>
                  <span className="chat-sync-fact-status">{f.status}</span>
                </div>
                <div className="chat-sync-history-fact-summary">{f.summary}</div>
                {f.detail && f.detail !== f.summary && (
                  <div className="chat-sync-history-fact-detail">{f.detail}</div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="chat-sync-history-section-title">Bridge prompt</div>
      {detail.bridgePrompt ? (
        <pre className="chat-sync-history-prompt">{detail.bridgePrompt}</pre>
      ) : (
        <div className="chat-sync-status-note">
          Not recorded — this sync predates prompt capture (0079), or no bridge prompt was produced.
        </div>
      )}
    </div>
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
