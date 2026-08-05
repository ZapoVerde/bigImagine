import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
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

// chub.ai exposes no "list all topics" endpoint (confirmed: GET /tags is 405) — a curated pick of
// commonly-seen topics (from live search responses inspected while building this) stands in for a
// dynamic vocabulary. Case-sensitive, matches chub's own topic spelling exactly.
const CHUB_TAG_OPTIONS = [
  'Fantasy', 'Sci-Fi', 'Romance', 'Adventure', 'Comedy', 'Horror', 'Drama', 'Slice of Life',
  'Isekai', 'RPG', 'Anime', 'Multiple Characters', 'Male', 'Female', 'Non-Human', 'Villain',
  'Dominant', 'Submissive', 'Wholesome', 'Dark',
];

type TagState = 'include' | 'exclude';

// Persisted like useTheme.ts's display preference — a per-device browsing filter, not household
// orchestrator config, so localStorage is the right home for it (bb_principles.md §13).
const TAG_STATES_STORAGE_KEY = 'bb_chub_tag_states';

function loadStoredTagStates(): Record<string, TagState> {
  try {
    const raw = localStorage.getItem(TAG_STATES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, TagState] => entry[1] === 'include' || entry[1] === 'exclude',
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

// Tri-state per tag: absent (neutral) -> include -> exclude -> absent, cycling on each tap.
function cycleTagState(current: TagState | undefined): TagState | undefined {
  if (current === undefined) return 'include';
  if (current === 'include') return 'exclude';
  return undefined;
}

// The Browse Chub screen (plan: "search/filter, image grid, per-card Import button") — chub.ai
// blocks Australian IPs, so every search_chub_characters/import_character_card_from_url call here
// goes through pia-proxy server-side (searchChubCharactersTool.ts/importCharacterCardFromUrlTool.ts),
// same as pasting a chub.ai URL directly into chat. A grid, not CharactersView's master-detail
// list/editor split, since there's nothing to edit here — only to preview and import.
export default function BrowseChubView({ apiKey }: BrowseChubViewProps) {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [tagStates, setTagStates] = useState<Record<string, TagState>>(loadStoredTagStates);
  const [result, setResult] = useState<ChubSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importStates, setImportStates] = useState<Record<string, ImportState>>({});

  const includeTags = useMemo(
    () => Object.entries(tagStates).filter(([, s]) => s === 'include').map(([t]) => t),
    [tagStates],
  );
  const excludeTags = useMemo(
    () => Object.entries(tagStates).filter(([, s]) => s === 'exclude').map(([t]) => t),
    [tagStates],
  );

  const runSearch = useCallback(
    async (searchQuery: string, searchPage: number) => {
      setLoading(true);
      setError(null);
      try {
        const searchResult = await callTool<ChubSearchResult>(
          'search_chub_characters',
          {
            query: searchQuery || undefined,
            page: searchPage,
            tags: includeTags.length > 0 ? includeTags : undefined,
            excludeTags: excludeTags.length > 0 ? excludeTags : undefined,
          },
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
    [apiKey, includeTags, excludeTags],
  );

  useEffect(() => {
    void runSearch(submittedQuery, page);
  }, [runSearch, submittedQuery, page]);

  useEffect(() => {
    localStorage.setItem(TAG_STATES_STORAGE_KEY, JSON.stringify(tagStates));
  }, [tagStates]);

  function onSubmitSearch(e: FormEvent) {
    e.preventDefault();
    setPage(1);
    setSubmittedQuery(query.trim());
  }

  function onTapTag(tag: string) {
    setPage(1);
    setTagStates((prev) => {
      const next = { ...prev };
      const nextState = cycleTagState(prev[tag]);
      if (nextState === undefined) delete next[tag];
      else next[tag] = nextState;
      return next;
    });
  }

  function clearAllTags() {
    setPage(1);
    setTagStates({});
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

      <div className="browse-chub-tags">
        {CHUB_TAG_OPTIONS.map((tag) => {
          const state = tagStates[tag];
          return (
            <button
              key={tag}
              type="button"
              className={`tag-chip chub-tag-chip${state ? ` ${state}` : ''}`}
              onClick={() => onTapTag(tag)}
            >
              {tag}
            </button>
          );
        })}
        {Object.keys(tagStates).length > 0 && (
          <button type="button" className="browse-chub-clear-tags" onClick={clearAllTags}>
            Clear tags
          </button>
        )}
      </div>

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
