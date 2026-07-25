import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { ApiError, callTool } from '../api/client';
import type { DocumentDetailResult, DocumentSummary } from '../api/types';
import './DocumentsView.css';

interface DocumentsViewProps {
  apiKey: string | null;
}

// Read-only by design (docs/spec.md §5/§6.6): the file in the user's own local git repo is
// canonical, not this view — there's no edit surface here, only browsing, reading, and clipping
// new pages in via ingest_url. Self-contained (owns its own list + detail state), same shape as
// CalendarView/MealPlanView rather than routed through Sidebar, since documents have no sidebar
// browser of their own.
export default function DocumentsView({ apiKey }: DocumentsViewProps) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocumentDetailResult | null>(null);
  const [clipUrl, setClipUrl] = useState('');
  const [clipping, setClipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reload() {
    callTool<DocumentSummary[]>('list_documents', {}, apiKey)
      .then(setDocuments)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load documents'));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    callTool<DocumentDetailResult>('get_document', { doc_id: selectedId }, apiKey)
      .then(setDetail)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load document'));
  }, [selectedId, apiKey]);

  async function clip() {
    const url = clipUrl.trim();
    if (!url || clipping) return;
    setError(null);
    setClipping(true);
    try {
      const result = await callTool<{ docId: string }>('ingest_url', { url }, apiKey);
      setClipUrl('');
      reload();
      setSelectedId(result.docId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to clip that page');
    } finally {
      setClipping(false);
    }
  }

  return (
    <div className="documents-view">
      <div className="documents-list">
        <form
          className="documents-clip-form"
          onSubmit={(e) => {
            e.preventDefault();
            clip();
          }}
        >
          <input value={clipUrl} onChange={(e) => setClipUrl(e.target.value)} placeholder="Clip a page: paste a URL…" />
          <button type="submit" disabled={clipping || !clipUrl.trim()}>
            {clipping ? 'Clipping…' : 'Clip'}
          </button>
        </form>
        {documents.length === 0 && <div className="empty-state">No documents yet.</div>}
        {documents.map((doc) => (
          <div
            key={doc.docId}
            className={`document-row${doc.docId === selectedId ? ' selected' : ''}`}
            onClick={() => setSelectedId(doc.docId)}
          >
            <span className="document-row-title">{doc.title ?? '(untitled)'}</span>
            {doc.status === 'stale' && <span className="document-row-stale">stale</span>}
          </div>
        ))}
      </div>
      <div className="document-detail">
        {error && <div className="error-banner">{error}</div>}
        {!selectedId && <div className="empty-state">Pick a document, or clip a page to get started.</div>}
        {selectedId && detail && !detail.found && <div className="empty-state">This document no longer exists.</div>}
        {selectedId && detail?.found && (
          <>
            <h2 className="document-detail-title">{detail.title}</h2>
            <div className="markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{detail.content}</ReactMarkdown>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
