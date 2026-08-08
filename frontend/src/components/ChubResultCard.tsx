import type { KeyboardEvent } from 'react';
import type { ChubCharacterSummary } from '../api/types';
import { formatRelativeDate } from '../lib/formatRelativeDate';
import ChubAvatarThumb from './ChubAvatarThumb';

export type ImportState = { status: 'idle' } | { status: 'importing' } | { status: 'imported' } | { status: 'error'; message: string };

interface ChubResultCardProps {
  card: ChubCharacterSummary;
  apiKey: string | null;
  importState: ImportState;
  onImport: () => void;
  /** Opens the embiggened card modal (ChubCardModal.tsx). */
  onOpen: () => void;
}

// One Browse Chub grid cell — pulled out of BrowseChubView.tsx to stay under the project's
// 300-line file budget (bi_principles.md §10). Purely presentational: every stat comes straight
// off ChubCharacterSummary (searchChubCharactersTool.ts's normalized shape), no fetching or state
// of its own beyond what ChubAvatarThumb already owns. The whole card is one click target that
// opens the detail modal; the Import button inside stops propagation so it stays its own target
// (a div-with-role="button" rather than a <button> wrapping a <button>, which would be invalid
// nesting).
export default function ChubResultCard({ card, apiKey, importState, onImport, onOpen }: ChubResultCardProps) {
  function onCardKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Only the card itself (not a focused child like the Import button) opens the modal with the
    // keyboard — Enter on the Import button must import, not embiggen.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  }

  return (
    <div
      className="browse-chub-card"
      role="button"
      tabIndex={0}
      title="Click to view full description and definition"
      onClick={onOpen}
      onKeyDown={onCardKeyDown}
    >
      <ChubAvatarThumb avatarUrl={card.avatarUrl} apiKey={apiKey} className="browse-chub-card-avatar" />
      <div className="browse-chub-card-name">{card.name}</div>
      <div className="browse-chub-card-tagline">{card.tagline}</div>
      <div className="browse-chub-card-stats">
        <span title="Downloads">⬇ {card.starCount}</span>
        <span title="Rating">★ {card.rating.toFixed(1)} ({card.ratingCount})</span>
        <span title="Chats">💬 {card.nChats}</span>
        <span title="Messages">✉ {card.nMessages}</span>
        <span title="Tokens">🪙 {card.nTokens}</span>
        {card.createdAt && <span title="Created">{formatRelativeDate(card.createdAt)}</span>}
      </div>
      {card.topics.length > 0 && (
        <div className="browse-chub-card-topics">
          {card.topics.map((t) => <span key={t} className="browse-chub-card-topic">{t}</span>)}
        </div>
      )}
      <button
        type="button"
        className="browse-chub-import-btn"
        disabled={importState.status === 'importing' || importState.status === 'imported'}
        onClick={(e) => {
          e.stopPropagation();
          onImport();
        }}
      >
        {importState.status === 'importing' && 'Importing…'}
        {importState.status === 'imported' && 'Imported ✓'}
        {(importState.status === 'idle' || importState.status === 'error') && 'Import'}
      </button>
      {importState.status === 'error' && <div className="browse-chub-card-error">{importState.message}</div>}
    </div>
  );
}
