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
// canonical, not this view — there's no edit surface here, only browsing, reading, clipping new
// pages in via ingest_url, and now searching/filtering. Self-contained (owns its own list +
// detail state), same shape as CalendarView/MealPlanView rather than routed through Sidebar,
// since documents have no sidebar browser of their own.
//
// search is list_documents' lexical full-text search (docs/spec.md §6.6) — a search box gets a
// short, deliberately-typed query, debounced here rather than fired on every keystroke. Tag
// selection re-queries immediately (no debounce — a click is already a deliberate action). The
// tag vocabulary for the picker comes from list_document_tags, the same query saveDocument.ts's
// auto-tagging is nudged with, so the picker never shows tags a save wasn't aware of.
export default function DocumentsView({ apiKey }: DocumentsViewProps) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocumentDetailResult | null>(null);
  const [clipUrl, setClipUrl] = useState('');
  const [clipping, setClipping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  function reload(search: string, tags: string[]) {
    callTool<DocumentSummary[]>(
      'list_documents',
      { search: search.trim() || undefined, tags: tags.length ? tags : undefined },
      apiKey,
    )
      .then(setDocuments)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load documents'));
  }

  function reloadTags() {
    callTool<string[]>('list_document_tags', {}, apiKey)
      .then(setAvailableTags)
      .catch(() => {}); // the picker is a nice-to-have; a failed vocabulary fetch shouldn't block browsing
  }

  useEffect(() => {
    reloadTags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => reload(searchText, selectedTags), 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, selectedTags]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    callTool<DocumentDetailResult>('get_document', { doc_id: selectedId }, apiKey)
      .then(setDetail)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load document'));
  }, [selectedId, apiKey]);

  function toggleTag(tag: string) {
    setSelectedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  async function clip() {
    const url = clipUrl.trim();
    if (!url || clipping) return;
    setError(null);
    setClipping(true);
    try {
      const result = await callTool<{ docId: string }>('ingest_url', { url }, apiKey);
      setClipUrl('');
      reload(searchText, selectedTags);
      reloadTags();
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
        <input
          className="documents-search-input"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search documents…"
        />
        {availableTags.length > 0 && (
          <div className="documents-tag-picker">
            {availableTags.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`tag-chip${selectedTags.includes(tag) ? ' selected' : ''}`}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
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
            {(detail.sourceUrl || detail.author || detail.publishedAt) && (
              <div className="document-detail-meta">
                {[
                  detail.sourceUrl && (
                    <a key="site" href={detail.sourceUrl} target="_blank" rel="noreferrer">
                      {detail.siteName ?? new URL(detail.sourceUrl).hostname}
                    </a>
                  ),
                  detail.author,
                  detail.publishedAt && new Date(detail.publishedAt).toLocaleDateString(),
                ]
                  .filter(Boolean)
                  .map((node, i) => (
                    <span key={i}>
                      {i > 0 && ' · '}
                      {node}
                    </span>
                  ))}
              </div>
            )}
            <div className="markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{detail.content}</ReactMarkdown>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
