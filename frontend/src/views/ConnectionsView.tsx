import { useCallback, useState } from 'react';
import { ApiError, adminListConnections, adminListImageConnections } from '../api/client';
import ImageConnectionEditor from '../components/connections/ImageConnectionEditor';
import TextConnectionEditor from '../components/connections/TextConnectionEditor';
import { useAdminUnlock } from '../hooks/useAdminUnlock';
import type { ImageConnectionSummary, LlmConnectionSummary } from '../api/types';
import './ConnectionsView.css';

const NEW_ID = 'new';

type ConnectionType = 'text' | 'image';

// The Connections tab's unified master-detail pane. The side panel lists *all* connections —
// text LLMs (io/llmConnections.ts, migration 0062) and image backends (io/imageConnections.ts,
// endpoint.md §3) — together, each row carrying a small type icon on the left. The toggle at the
// top switches which editor the pane shows (and what "+ New" creates); picking a row of the other
// type flips the toggle for you. Both editors own their own draft/save/test/activate/delete; this
// shell owns the combined list, the toggle, the two per-type selections, and the admin unlock.
function TypeIcon({ type }: { type: ConnectionType }) {
  return type === 'text' ? (
    <svg
      className="connections-row-icon connections-row-icon-text"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 2.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3.2 2.6a.5.5 0 0 1-.8-.4V10.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />
      <path d="M5.5 6h5" />
      <path d="M5.5 8h3" />
    </svg>
  ) : (
    <svg
      className="connections-row-icon connections-row-icon-image"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1.2" />
      <path d="M3.5 12.5 7 9l2.3 2.3 1.7-1.7 2 2.9" />
    </svg>
  );
}

export default function ConnectionsView() {
  const [textConnections, setTextConnections] = useState<LlmConnectionSummary[] | null>(null);
  const [imageConnections, setImageConnections] = useState<ImageConnectionSummary[] | null>(null);
  const [tab, setTab] = useState<ConnectionType>('text');
  const [textSelectedId, setTextSelectedId] = useState<string | null>(null);
  const [imageSelectedId, setImageSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mobileShowEditor, setMobileShowEditor] = useState(false);

  async function attemptLoad(key: string | null): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const [text, image] = await Promise.all([adminListConnections(key), adminListImageConnections(key)]);
      setTextConnections(text);
      setImageConnections(image);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  const { adminKey, setAdminKey, checking, unlocked, loadError, load } = useAdminUnlock(attemptLoad);

  const refreshText = useCallback(
    async (selectAfter?: string) => {
      try {
        const result = await adminListConnections(adminKey);
        setTextConnections(result);
        setError(null);
        if (selectAfter) setTextSelectedId(selectAfter);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'failed to load connections');
      }
    },
    [adminKey],
  );

  const refreshImage = useCallback(
    async (selectAfter?: string) => {
      try {
        const result = await adminListImageConnections(adminKey);
        setImageConnections(result);
        setError(null);
        if (selectAfter) setImageSelectedId(selectAfter);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'failed to load image connections');
      }
    },
    [adminKey],
  );

  const textSelected = textConnections?.find((c) => c.id === textSelectedId) ?? null;
  const imageSelected = imageConnections?.find((c) => c.id === imageSelectedId) ?? null;
  const textIsNew = textSelectedId === NEW_ID;
  const imageIsNew = imageSelectedId === NEW_ID;

  function createNew() {
    if (tab === 'text') {
      setTextSelectedId(NEW_ID);
    } else {
      setImageSelectedId(NEW_ID);
    }
    setMobileShowEditor(true);
  }

  function selectConnection(type: ConnectionType, id: string) {
    if (type === 'text') {
      setTab('text');
      setTextSelectedId(id);
    } else {
      setTab('image');
      setImageSelectedId(id);
    }
    setMobileShowEditor(true);
  }

  function handleTextDeleted() {
    setTextSelectedId(null);
    setMobileShowEditor(false);
    void refreshText();
  }

  function handleImageDeleted() {
    setImageSelectedId(null);
    setMobileShowEditor(false);
    void refreshImage();
  }

  if (checking) {
    return <div className="connections-view" />;
  }

  if (!unlocked) {
    return (
      <div className="connections-view">
        <h1>BigImagine — connections</h1>
        <label>
          Admin API key
          <br />
          <input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} />
        </label>
        <br />
        <button onClick={load}>Load</button>
        {loadError && <div className="error-banner">{loadError}</div>}
      </div>
    );
  }

  if (textConnections === null || imageConnections === null) {
    return <div className="connections-view loading">Loading connections&hellip;</div>;
  }

  return (
    <div className="connections-shell">
      <div className="connections-toggle" role="tablist" aria-label="Connection type">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'text'}
          className={`connections-toggle-btn${tab === 'text' ? ' active' : ''}`}
          onClick={() => setTab('text')}
        >
          <TypeIcon type="text" />
          Text LLMs
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'image'}
          className={`connections-toggle-btn${tab === 'image' ? ' active' : ''}`}
          onClick={() => setTab('image')}
        >
          <TypeIcon type="image" />
          Image LLMs
        </button>
      </div>

      <div className={`connections-view${mobileShowEditor ? ' mobile-editor' : ''}`}>
        <div className="connections-list">
          <div className="connections-list-header">
            <span>Connections</span>
            <button type="button" className="connections-new-btn" onClick={createNew}>
              + New
            </button>
          </div>
          {textConnections.length === 0 && imageConnections.length === 0 && (
            <div className="empty-state">No connections yet.</div>
          )}
          {textConnections.map((c) => (
            <div
              key={c.id}
              className={`connections-row${tab === 'text' && c.id === textSelectedId ? ' selected' : ''}`}
              onClick={() => selectConnection('text', c.id)}
            >
              <TypeIcon type="text" />
              <span className="connections-row-name" title="Text LLM">
                {c.name}
              </span>
              <span className="connections-row-badge">{c.kind}</span>
              {c.isActive && <span className="connections-row-badge connections-row-badge-active">active</span>}
            </div>
          ))}
          {imageConnections.map((c) => (
            <div
              key={c.id}
              className={`connections-row${tab === 'image' && c.id === imageSelectedId ? ' selected' : ''}`}
              onClick={() => selectConnection('image', c.id)}
            >
              <TypeIcon type="image" />
              <span className="connections-row-name" title="Image LLM">
                {c.name}
              </span>
              <span className="connections-row-badge">{c.kind}</span>
              {c.isActive && <span className="connections-row-badge connections-row-badge-active">active</span>}
            </div>
          ))}
        </div>

        <div className="connections-editor">
          <button type="button" className="connections-back" onClick={() => setMobileShowEditor(false)}>
            &larr; Connections
          </button>

          {error && <div className="error-banner">{error}</div>}

          {/* Both editors stay mounted — switching the toggle only hides one, so an in-progress
              draft survives a tab switch instead of being thrown away. */}
          <div className="connections-editor-pane" hidden={tab === 'image'}>
            <TextConnectionEditor
              connections={textConnections}
              selected={textSelected}
              isNew={textIsNew}
              adminKey={adminKey}
              onRefresh={refreshText}
              onDeleted={handleTextDeleted}
            />
          </div>
          <div className="connections-editor-pane" hidden={tab === 'text'}>
            <ImageConnectionEditor
              selected={imageSelected}
              isNew={imageIsNew}
              adminKey={adminKey}
              onRefresh={refreshImage}
              onDeleted={handleImageDeleted}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
