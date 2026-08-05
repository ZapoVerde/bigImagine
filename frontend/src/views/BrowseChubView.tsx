import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, callTool } from '../api/client';
import type { ChubSearchResult, ImportedChubCharacter } from '../api/types';
import ChubAvatarThumb from '../components/ChubAvatarThumb';
import './BrowseChubView.css';

interface BrowseChubViewProps {
  apiKey: string | null;
}

type ImportState = { status: 'idle' } | { status: 'importing' } | { status: 'imported' } | { status: 'error'; message: string };

// Must match searchChubCharactersTool.ts's own PAGE_SIZE — the tool doesn't echo it back in its
// response, so this is the one place that constant is duplicated rather than shared (no shared
// frontend/backend module exists to hold it).
const PAGE_SIZE = 24;

// The Browse Chub screen (plan: "search/filter, image grid, per-card Import button") — chub.ai
// blocks Australian IPs, so every search_chub_characters/import_character_card_from_url call here
// goes through pia-proxy server-side (searchChubCharactersTool.ts/importCharacterCardFromUrlTool.ts),
// same as pasting a chub.ai URL directly into chat. A grid, not CharactersView's master-detail
// list/editor split, since there's nothing to edit here — only to preview and import.
export default function BrowseChubView({ apiKey }: BrowseChubViewProps) {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ChubSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importStates, setImportStates] = useState<Record<string, ImportState>>({});

  const runSearch = useCallback(
    async (searchQuery: string, searchPage: number) => {
      setLoading(true);
      setError(null);
      try {
        const searchResult = await callTool<ChubSearchResult>(
          'search_chub_characters',
          { query: searchQuery || undefined, page: searchPage },
          apiKey,
        );
        setResult(searchResult);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'failed to search chub.ai');
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [apiKey],
  );

  useEffect(() => {
    void runSearch(submittedQuery, page);
  }, [runSearch, submittedQuery, page]);

  function onSubmitSearch(e: FormEvent) {
    e.preventDefault();
    setPage(1);
    setSubmittedQuery(query.trim());
  }

  async function importCharacter(fullPath: string) {
    setImportStates((prev) => ({ ...prev, [fullPath]: { status: 'importing' } }));
    try {
      await callTool<ImportedChubCharacter>('import_character_card_from_url', { url: fullPath }, apiKey);
      setImportStates((prev) => ({ ...prev, [fullPath]: { status: 'imported' } }));
    } catch (err) {
      setImportStates((prev) => ({
        ...prev,
        [fullPath]: { status: 'error', message: err instanceof ApiError ? err.message : 'import failed' },
      }));
    }
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.count / PAGE_SIZE)) : 1;

  return (
    <div className="browse-chub-view">
      <form className="browse-chub-search" onSubmit={onSubmitSearch}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chub.ai characters&hellip;"
        />
        <button type="submit">Search</button>
      </form>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="empty-state">Loading&hellip;</div>}
      {!loading && result && result.results.length === 0 && <div className="empty-state">No results.</div>}

      {!loading && result && result.results.length > 0 && (
        <>
          <div className="browse-chub-grid">
            {result.results.map((card) => {
              const state = importStates[card.fullPath] ?? { status: 'idle' };
              return (
                <div key={card.fullPath} className="browse-chub-card">
                  <ChubAvatarThumb avatarUrl={card.avatarUrl} apiKey={apiKey} className="browse-chub-card-avatar" />
                  <div className="browse-chub-card-name">{card.name}</div>
                  <div className="browse-chub-card-tagline">{card.tagline}</div>
                  <button
                    type="button"
                    className="browse-chub-import-btn"
                    disabled={state.status === 'importing' || state.status === 'imported'}
                    onClick={() => void importCharacter(card.fullPath)}
                  >
                    {state.status === 'importing' && 'Importing…'}
                    {state.status === 'imported' && 'Imported ✓'}
                    {(state.status === 'idle' || state.status === 'error') && 'Import'}
                  </button>
                  {state.status === 'error' && <div className="browse-chub-card-error">{state.message}</div>}
                </div>
              );
            })}
          </div>

          <div className="browse-chub-pagination">
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              &larr; Prev
            </button>
            <span>
              Page {page} of {totalPages} &mdash; {result.count} results
            </span>
            <button type="button" onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages}>
              Next &rarr;
            </button>
          </div>
        </>
      )}
    </div>
  );
}
