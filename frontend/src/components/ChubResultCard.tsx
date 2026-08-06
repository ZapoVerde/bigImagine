import type { ChubCharacterSummary } from '../api/types';
import ChubAvatarThumb from './ChubAvatarThumb';

export type ImportState = { status: 'idle' } | { status: 'importing' } | { status: 'imported' } | { status: 'error'; message: string };

function formatRelativeDate(iso: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffDays = Math.round((then - Date.now()) / (24 * 60 * 60 * 1000));
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(diffDays) < 1) return 'today';
  if (Math.abs(diffDays) < 30) return rtf.format(diffDays, 'day');
  if (Math.abs(diffDays) < 365) return rtf.format(Math.round(diffDays / 30), 'month');
  return rtf.format(Math.round(diffDays / 365), 'year');
}

interface ChubResultCardProps {
  card: ChubCharacterSummary;
  apiKey: string | null;
  importState: ImportState;
  onImport: () => void;
}

// One Browse Chub grid cell — pulled out of BrowseChubView.tsx to stay under the project's
// 300-line file budget (bi_principles.md §10). Purely presentational: every stat comes straight
// off ChubCharacterSummary (searchChubCharactersTool.ts's normalized shape), no fetching or state
// of its own beyond what ChubAvatarThumb already owns.
export default function ChubResultCard({ card, apiKey, importState, onImport }: ChubResultCardProps) {
  return (
    <div className="browse-chub-card">
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
        onClick={onImport}
      >
        {importState.status === 'importing' && 'Importing…'}
        {importState.status === 'imported' && 'Imported ✓'}
        {(importState.status === 'idle' || importState.status === 'error') && 'Import'}
      </button>
      {importState.status === 'error' && <div className="browse-chub-card-error">{importState.message}</div>}
    </div>
  );
}
