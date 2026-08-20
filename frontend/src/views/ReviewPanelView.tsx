import { useEffect, useState } from 'react';
import { ApiError, adminGetChatMemorySyncStatus } from '../api/client';
import { ADMIN_API_KEY_STORAGE_KEY } from '../api/authStorage';
import { useChatMemorySyncStatus } from '../hooks/useChatMemorySyncStatus';
import type { ChatMemorySyncStatusRow } from '../api/types';
import ChatMemorySyncErrorModal from '../components/ChatMemorySyncErrorModal';
import './ReviewPanelView.css';

// The actual point of a "review panel," per the user: confirmation that each background pipeline
// stage (chunk/embed/distill — orchestrator/chatMemorySync.ts) is really working, not an editing
// surface. Canon-fact approve/reject already has its own view (CanonQueueView) and isn't touched
// here. Admin-gated like Settings, so it needs the same Cloudflare-Access-or-stored-key handshake
// SettingsView.tsx uses — reimplemented small and scoped to this file's own single endpoint rather
// than sharing SettingsView's much larger multi-endpoint attemptLoad.
export default function ReviewPanelView() {
  const [adminKey, setAdminKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState(() => localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY) ?? '');
  const [checking, setChecking] = useState(true);
  const [unlocked, setUnlocked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailChatId, setDetailChatId] = useState<string | null>(null);

  const { rows, refresh } = useChatMemorySyncStatus(adminKey, unlocked);

  async function attemptLoad(key: string | null): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      await adminGetChatMemorySyncStatus(key);
      setAdminKey(key);
      setUnlocked(true);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  // Mount-time only: probe with no key (covers a Cloudflare Access-protected deployment), then a
  // previously-saved key, before falling back to the key-entry form below — same order as
  // SettingsView.tsx's own attemptLoad probe.
  useEffect(() => {
    (async () => {
      if ((await attemptLoad(null)).ok) {
        setChecking(false);
        return;
      }
      const stored = localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY);
      if (stored) {
        if ((await attemptLoad(stored)).ok) {
          setChecking(false);
          return;
        }
        localStorage.removeItem(ADMIN_API_KEY_STORAGE_KEY);
      }
      setChecking(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (checking) {
    return <div className="review-panel-view" />;
  }

  async function load() {
    setLoadError(null);
    const result = await attemptLoad(keyInput);
    if (result.ok) {
      localStorage.setItem(ADMIN_API_KEY_STORAGE_KEY, keyInput);
      return;
    }
    const err = result.error;
    setLoadError(err instanceof ApiError && err.status === 401 ? 'invalid admin key' : 'error loading sync status');
  }

  if (!unlocked) {
    return (
      <div className="review-panel-view">
        <h1>Review panel</h1>
        <label>
          Admin API key
          <br />
          <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
        </label>
        <br />
        <button onClick={() => void load()}>Load</button>
        {loadError && <div className="error-banner">{loadError}</div>}
      </div>
    );
  }

  if (rows === null) {
    return <div className="review-panel-view loading">Loading sync status&hellip;</div>;
  }

  const healthy = rows.filter((r) => r.lastStatus === 'ok').length;
  const skipped = rows.filter((r) => r.lastStatus === 'skipped').length;
  const errored = rows.filter((r) => r.lastStatus === 'error').length;
  const lastTick = rows.reduce<string | null>(
    (latest, r) => (latest === null || r.lastAttemptAt > latest ? r.lastAttemptAt : latest),
    null,
  );

  return (
    <div className="review-panel-view">
      <div className="review-panel-header">
        <h1>Review panel</h1>
        <button className="review-refresh" onClick={refresh}>
          Refresh
        </button>
      </div>
      <div className="review-summary">
        {rows.length === 0
          ? 'No chats have gone through the memory sync loop yet.'
          : `${healthy} healthy / ${skipped} skipped / ${errored} errored` +
            (lastTick ? ` — last tick ${new Date(lastTick).toLocaleString()}` : '')}
      </div>
      {rows.length > 0 && (
        <table className="review-table">
          <thead>
            <tr>
              <th>Chat</th>
              <th>Status</th>
              <th>Last attempt</th>
              <th>Last success</th>
              <th>Chunks / entries</th>
              <th>Canon facts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <ReviewRow key={r.chatId} row={r} onOpenDetail={() => setDetailChatId(r.chatId)} />
            ))}
          </tbody>
        </table>
      )}
      {detailChatId &&
        (() => {
          const detailRow = rows.find((r) => r.chatId === detailChatId);
          return detailRow ? <ChatMemorySyncErrorModal row={detailRow} onClose={() => setDetailChatId(null)} /> : null;
        })()}
    </div>
  );
}

function ReviewRow({ row, onOpenDetail }: { row: ChatMemorySyncStatusRow; onOpenDetail: () => void }) {
  const badgeClass =
    row.lastStatus === 'ok' ? 'review-badge-ok' : row.lastStatus === 'error' ? 'review-badge-error' : 'review-badge-skipped';
  return (
    <tr className={row.lastStatus === 'error' ? 'review-row-error' : undefined} onClick={row.lastError ? onOpenDetail : undefined}>
      <td>{row.chatTitle}</td>
      <td>
        <span className={badgeClass}>{row.lastStatus}</span>
        {row.consecutiveErrors > 1 && <span className="review-consecutive"> ×{row.consecutiveErrors}</span>}
      </td>
      <td>{new Date(row.lastAttemptAt).toLocaleString()}</td>
      <td>{row.lastSuccessAt ? new Date(row.lastSuccessAt).toLocaleString() : '—'}</td>
      <td>
        {row.lastChunksAdded ?? '—'} / {row.lastEntriesUpdated ?? '—'}
      </td>
      <td>
        {row.canonProposedCount} proposed / {row.canonApprovedCount} approved
      </td>
    </tr>
  );
}
