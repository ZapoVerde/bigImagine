import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, callTool } from '../api/client';
import type { ChubCharacterSummary, ChubSearchResult, ImportedChubCharacter } from '../api/types';
import ChubFilterPanel, {
  CHUB_SORT_VALUES, RECENCY_BUCKETS, type ChubSort, type RecencyBucket, type TagState,
} from '../components/ChubFilterPanel';
import ChubCardModal from '../components/ChubCardModal';
import ChubResultCard, { type ImportState } from '../components/ChubResultCard';
import './BrowseChubView.css';

interface BrowseChubViewProps {
  apiKey: string | null;
  /** Called when an import succeeds — App.tsx bumps CharactersView's refreshKey so the card
   *  roster shows the newly imported card without a reload. */
  onCardImported: () => void;
}

// Must match searchChubCharactersTool.ts's own PAGE_SIZE — the tool doesn't echo it back in its
// response, so this is the one place that constant is duplicated rather than shared (no shared
// frontend/backend module exists to hold it).
const PAGE_SIZE = 48;

// Persisted like useTheme.ts's display preference — a per-device browsing filter, not household
// orchestrator config, so localStorage is the right home for it (bb_principles.md §13).
const TAG_STATES_STORAGE_KEY = 'bb_chub_tag_states';
const FILTERS_STORAGE_KEY = 'bb_chub_filters';

interface StoredFilters {
  sort: ChubSort;
  minTokens: number | undefined;
  maxTokens: number | undefined;
  minRating: number | undefined;
  recencyBucket: RecencyBucket;
}

const DEFAULT_FILTERS: StoredFilters = {
  sort: 'default', minTokens: undefined, maxTokens: undefined, minRating: undefined, recencyBucket: 'all',
};

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

function loadStoredFilters(): StoredFilters {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const p = JSON.parse(raw) as Record<string, unknown>;
    return {
      sort: (CHUB_SORT_VALUES as readonly string[]).includes(p.sort as string) ? (p.sort as ChubSort) : DEFAULT_FILTERS.sort,
      minTokens: typeof p.minTokens === 'number' ? p.minTokens : undefined,
      maxTokens: typeof p.maxTokens === 'number' ? p.maxTokens : undefined,
      minRating: typeof p.minRating === 'number' ? p.minRating : undefined,
      recencyBucket: RECENCY_BUCKETS.includes(p.recencyBucket as RecencyBucket) ? (p.recencyBucket as RecencyBucket) : DEFAULT_FILTERS.recencyBucket,
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

// Tri-state per tag: absent (neutral) -> include -> exclude -> absent, cycling on each tap.
function cycleTagState(current: TagState | undefined): TagState | undefined {
  if (current === undefined) return 'include';
  if (current === 'include') return 'exclude';
  return undefined;
}

const RECENCY_BUCKET_MS: Record<Exclude<RecencyBucket, 'all'>, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

function withinRecencyBucket(createdAt: string, bucket: RecencyBucket): boolean {
  if (bucket === 'all') return true;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return true; // no date to judge — don't hide it
  return Date.now() - created <= RECENCY_BUCKET_MS[bucket];
}

// The Browse Chub screen (plan: "search/filter, image grid, per-card Import button") — chub.ai
// blocks Australian IPs, so every search_chub_characters/import_character_card_from_url call here
// goes through pia-proxy server-side (searchChubCharactersTool.ts/importCharacterCardFromUrlTool.ts),
// same as pasting a chub.ai URL directly into chat. A grid, not CharactersView's master-detail
// list/editor split, since there's nothing to edit here — only to preview and import.
export default function BrowseChubView({ apiKey, onCardImported }: BrowseChubViewProps) {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [tagStates, setTagStates] = useState<Record<string, TagState>>(loadStoredTagStates);
  const [filters, setFilters] = useState<StoredFilters>(loadStoredFilters);
  const [filtersCollapsed, setFiltersCollapsed] = useState(true);
  const [topicVocab, setTopicVocab] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ChubSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importStates, setImportStates] = useState<Record<string, ImportState>>({});
  const [openCard, setOpenCard] = useState<ChubCharacterSummary | null>(null);

  const includeTags = useMemo(
    () => Object.entries(tagStates).filter(([, s]) => s === 'include').map(([t]) => t),
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
            sort: filters.sort === 'default' ? undefined : filters.sort,
            minTokens: filters.minTokens,
            maxTokens: filters.maxTokens,
            minRating: filters.minRating,
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
    [apiKey, includeTags, filters.sort, filters.minTokens, filters.maxTokens, filters.minRating],
  );

  useEffect(() => {
    void runSearch(submittedQuery, page);
  }, [runSearch, submittedQuery, page]);

  useEffect(() => {
    localStorage.setItem(TAG_STATES_STORAGE_KEY, JSON.stringify(tagStates));
  }, [tagStates]);

  useEffect(() => {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
  }, [filters]);

  // Grows across the session as new topics are seen — never reset on page change, never a fixed
  // guess-list (chub.ai has no "list all topics" endpoint, confirmed: GET /tags is 405).
  useEffect(() => {
    if (!result) return;
    setTopicVocab((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const card of result.results) {
        for (const topic of card.topics) {
          if (!next.has(topic)) {
            next.add(topic);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [result]);

  const visibleResults = useMemo<ChubCharacterSummary[]>(() => {
    if (!result) return [];
    return result.results.filter((card) => {
      if (card.topics.some((t) => tagStates[t] === 'exclude')) return false;
      return withinRecencyBucket(card.createdAt, filters.recencyBucket);
    });
  }, [result, tagStates, filters.recencyBucket]);

  // Case-insensitive so uppercase tags interleave with lowercase ones instead of
  // clustering separately (plain .sort() compares raw UTF-16 code units).
  const topicOptions = useMemo(
    () => Array.from(topicVocab).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    [topicVocab],
  );

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
      const imported = await callTool<ImportedChubCharacter>('import_character_card_from_url', { url: fullPath }, apiKey);
      setImportStates((prev) => ({
        ...prev,
        [fullPath]: { status: 'imported', lorebookEntriesImported: imported.lorebookEntriesImported },
      }));
      onCardImported();
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
      <div className="browse-chub-main">
        <div className="browse-chub-toolbar">
          <form className="browse-chub-search" onSubmit={onSubmitSearch}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chub.ai characters&hellip;"
            />
            <button type="submit">Search</button>
          </form>
          <button
            type="button"
            className="browse-chub-filter-summon mobile-only"
            title={filtersCollapsed ? 'Show filters' : 'Hide filters'}
            onClick={() => setFiltersCollapsed((c) => !c)}
          >
            ⚙ Filters
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {loading && <div className="empty-state">Loading&hellip;</div>}
        {!loading && result && visibleResults.length === 0 && <div className="empty-state">No results.</div>}

        {!loading && result && visibleResults.length > 0 && (
          <>
            <div className="browse-chub-grid">
              {visibleResults.map((card) => (
                <ChubResultCard
                  key={card.fullPath}
                  card={card}
                  apiKey={apiKey}
                  importState={importStates[card.fullPath] ?? { status: 'idle' }}
                  onImport={() => void importCharacter(card.fullPath)}
                  onOpen={() => setOpenCard(card)}
                />
              ))}
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

      <ChubFilterPanel
        collapsed={filtersCollapsed}
        onToggleCollapsed={() => setFiltersCollapsed((c) => !c)}
        topics={topicOptions}
        tagStates={tagStates}
        onTapTag={onTapTag}
        onClearAllTags={clearAllTags}
        sort={filters.sort}
        onSortChange={(sort) => { setPage(1); setFilters((f) => ({ ...f, sort })); }}
        minTokens={filters.minTokens}
        onMinTokensChange={(minTokens) => { setPage(1); setFilters((f) => ({ ...f, minTokens })); }}
        maxTokens={filters.maxTokens}
        onMaxTokensChange={(maxTokens) => { setPage(1); setFilters((f) => ({ ...f, maxTokens })); }}
        minRating={filters.minRating}
        onMinRatingChange={(minRating) => { setPage(1); setFilters((f) => ({ ...f, minRating })); }}
        recencyBucket={filters.recencyBucket}
        onRecencyBucketChange={(recencyBucket) => setFilters((f) => ({ ...f, recencyBucket }))}
      />

      {openCard && (
        <ChubCardModal
          card={openCard}
          apiKey={apiKey}
          importState={importStates[openCard.fullPath] ?? { status: 'idle' }}
          onImport={() => void importCharacter(openCard.fullPath)}
          onClose={() => setOpenCard(null)}
        />
      )}
    </div>
  );
}
