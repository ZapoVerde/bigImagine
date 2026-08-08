import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ApiError, fetchChubCardDetail, fetchChubCardPng } from '../api/client';
import type { ChubCardDetail, ChubCharacterSummary } from '../api/types';
import { formatRelativeDate } from '../lib/formatRelativeDate';
import ChubAvatarThumb from './ChubAvatarThumb';
import './ChubCardModal.css';

interface ChubCardModalProps {
  card: ChubCharacterSummary;
  apiKey: string | null;
  onClose: () => void;
}

// chub's bespoke definition object uses these keys (a different, non-spec shape than the card
// PNG's chara chunk — see importCharacterCardFromUrlTool.ts's preamble). Known keys get stable
// human labels in a fixed reading order; anything else renders after them, key-title-cased.
const DEFINITION_FIELD_ORDER: Array<[string, string]> = [
  ['first_message', 'First message'],
  ['example_dialogs', 'Example dialogs'],
  ['personality', 'Personality'],
  ['scenario', 'Scenario'],
  ['system_prompt', 'System prompt'],
  ['post_history_instructions', 'Post-history instructions'],
];

function formatDefinitionValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

function humanizeKey(key: string): string {
  return key
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function textareaRows(text: string): number {
  return Math.min(Math.max(text.split('\n').length, 2), 20);
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^\w\- ]+/g, '_').trim().replace(/\s+/g, '_');
  return cleaned.length > 0 ? cleaned : 'chub-card';
}

// One labeled, read-only text box for a detail field — "see all the details of it in various
// text boxes" is exactly this. readOnly + value (not defaultValue) so a re-render with new
// detail content always reflects it.
function FieldBox({ label, text }: { label: string; text: string }) {
  return (
    <label className="chub-card-modal-field">
      <span className="chub-card-modal-field-label">{label}</span>
      <textarea className="chub-card-modal-field-box" readOnly value={text} rows={textareaRows(text)} spellCheck={false} />
    </label>
  );
}

// The embiggened chub card: clicking a Browse Chub grid cell opens this overlay, which lazily
// fetches the full detail (description + bespoke definition) through /v1/characters/chub-detail
// and renders it as labeled text boxes, with a Download button for the card PNG itself (fetched
// through the same allowlisted chub-avatar proxy). Header/stats render instantly from the grid
// card; only the body waits on the detail fetch.
export default function ChubCardModal({ card, apiKey, onClose }: ChubCardModalProps) {
  const [detail, setDetail] = useState<ChubCardDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloadState, setDownloadState] = useState<'idle' | 'downloading' | 'error'>('idle');
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Latest-ref pattern so the mount effect below can depend on nothing and still see the current
  // onClose — without it, BrowseChubView's inline arrow re-creates the prop each render and the
  // effect would re-run (re-locking body scroll, re-stealing focus) on every parent re-render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setDetail(null);
    setLoadError(null);
    try {
      setDetail(await fetchChubCardDetail(card.fullPath, apiKey));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'failed to load card details');
    }
  }, [card.fullPath, apiKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // Mount-time dialog plumbing: lock background scroll, close on Escape, move focus into the
  // dialog (and restore it to the triggering card on close), and keep Tab from escaping into the
  // grid behind — the standard modal contract (bi_principles.md §19 applies to the layout, but
  // keyboard focus is the same deal: the dialog is the only thing the user is operating).
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
      previouslyFocused?.focus();
    };
  }, []);

  function onPanelKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], textarea, input, select, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    // The dialog itself (tabIndex=-1) is reachable by mouse click; treat it as the wrap edge so
    // Tab/Shift+Tab from it can't escape into the grid behind. Everything else (Tab from the
    // first focusable, middle elements) keeps the browser's natural forward order — no jump.
    const onPanelItself = document.activeElement === panelRef.current;
    if ((e.shiftKey && (document.activeElement === first || onPanelItself)) || (!e.shiftKey && document.activeElement === last)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  const definitionFields = useMemo(() => {
    if (!detail) return [];
    const fields: Array<[string, string]> = [];
    const pushIfNonEmpty = (label: string, text: string) => {
      if (text.trim().length > 0) fields.push([label, text]);
    };
    for (const [key, label] of DEFINITION_FIELD_ORDER) {
      if (key in detail.definition) pushIfNonEmpty(label, formatDefinitionValue(detail.definition[key]));
    }
    const known = new Set(DEFINITION_FIELD_ORDER.map(([key]) => key));
    for (const key of Object.keys(detail.definition).filter((k) => !known.has(k)).sort()) {
      pushIfNonEmpty(humanizeKey(key), formatDefinitionValue(detail.definition[key]));
    }
    return fields;
  }, [detail]);

  // chub's detail node normalizes missing stats to 0 (handleChubCardDetail.ts), which would
  // clobber the real values the grid search already had — fall back per-field, not wholesale.
  const stats = detail
    ? {
        starCount: detail.starCount || card.starCount,
        rating: detail.rating || card.rating,
        ratingCount: detail.ratingCount || card.ratingCount,
        nChats: detail.nChats || card.nChats,
        nMessages: detail.nMessages || card.nMessages,
        nTokens: detail.nTokens || card.nTokens,
        createdAt: detail.createdAt || card.createdAt,
      }
    : card;

  async function onDownload() {
    if (!detail?.maxResUrl) {
      setDownloadState('error');
      setDownloadError('This card has no downloadable PNG.');
      return;
    }
    setDownloadState('downloading');
    setDownloadError(null);
    try {
      const blob = await fetchChubCardPng(detail.maxResUrl, apiKey);
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = `${sanitizeFilename(detail.name || card.fullPath)}.png`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      setDownloadState('idle');
    } catch (err) {
      setDownloadState('error');
      setDownloadError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'download failed');
    }
  }

  const hasBodyContent =
    (detail?.description.trim().length ?? 0) > 0 || definitionFields.length > 0 || (detail?.topics.length ?? 0) > 0;

  return (
    <div
      className="chub-card-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="chub-card-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${card.name} card details`}
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        <header className="chub-card-modal-header">
          <ChubAvatarThumb avatarUrl={card.avatarUrl} apiKey={apiKey} className="chub-card-modal-avatar" />
          <div className="chub-card-modal-heading">
            <div className="chub-card-modal-name">{card.name}</div>
            <div className="chub-card-modal-tagline">{card.tagline}</div>
          </div>
          <button
            type="button"
            className="chub-card-modal-close"
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="Close card details"
          >
            ✕
          </button>
        </header>

        <div className="chub-card-modal-stats">
          <span title="Downloads">⬇ {stats.starCount}</span>
          <span title="Rating">★ {stats.rating.toFixed(1)} ({stats.ratingCount})</span>
          <span title="Chats">💬 {stats.nChats}</span>
          <span title="Messages">✉ {stats.nMessages}</span>
          <span title="Tokens">🪙 {stats.nTokens}</span>
          {stats.createdAt && <span title="Created">{formatRelativeDate(stats.createdAt)}</span>}
        </div>

        <div className="chub-card-modal-body">
          {!detail && !loadError && <div className="chub-card-modal-status">Loading card details&hellip;</div>}
          {loadError && (
            <div className="chub-card-modal-status chub-card-modal-status-error">
              {loadError}
              <button type="button" onClick={() => void load()}>
                Retry
              </button>
            </div>
          )}
          {detail && !hasBodyContent && (
            <div className="chub-card-modal-status">No description or definition on this card.</div>
          )}
          {detail?.description.trim() && <FieldBox label="Description" text={detail.description.trim()} />}
          {definitionFields.map(([label, text]) => (
            <FieldBox key={label} label={label} text={text} />
          ))}
          {detail && detail.topics.length > 0 && (
            <div className="chub-card-modal-topics">
              {detail.topics.map((topic) => (
                <span key={topic} className="chub-card-modal-topic">
                  {topic}
                </span>
              ))}
            </div>
          )}
        </div>

        <footer className="chub-card-modal-footer">
          <button
            type="button"
            className="chub-card-modal-download"
            disabled={downloadState === 'downloading' || !detail}
            onClick={() => void onDownload()}
          >
            {downloadState === 'downloading' ? 'Downloading…' : '⬇ Download card'}
          </button>
          {downloadError && <span className="chub-card-modal-download-error">{downloadError}</span>}
        </footer>
      </div>
    </div>
  );
}
