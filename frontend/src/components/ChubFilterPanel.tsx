import './ChubFilterPanel.css';

export type TagState = 'include' | 'exclude';
export type RecencyBucket = 'day' | 'week' | 'month' | 'year' | 'all';
export const RECENCY_BUCKETS: RecencyBucket[] = ['day', 'week', 'month', 'year', 'all'];
const RECENCY_LABELS: Record<RecencyBucket, string> = {
  day: 'Last day', week: 'Last week', month: 'Last month', year: 'Last year', all: 'All dates',
};

// The subset of chub.ai's real `sort` enum (see searchChubCharactersTool.ts's own preamble for how
// it was confirmed) that's a meaningful UI sort choice — must match that file's CHUB_SORT_VALUES.
// No shared frontend/backend module exists to hold this, same duplication as PAGE_SIZE.
export const CHUB_SORT_VALUES = [
  'download_count', 'star_count', 'rating', 'n_favorites', 'created_at',
  'last_activity_at', 'n_tokens', 'trending', 'random', 'default',
] as const;
export type ChubSort = (typeof CHUB_SORT_VALUES)[number];
const SORT_LABELS: Record<ChubSort, string> = {
  download_count: 'Downloads', star_count: 'Stars', rating: 'Rating', n_favorites: 'Favorites',
  created_at: 'Newest', last_activity_at: 'Recently active', n_tokens: 'Token count',
  trending: 'Trending', random: 'Random', default: 'Default',
};

interface ChubFilterPanelProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  topics: string[];
  tagStates: Record<string, TagState>;
  onTapTag: (tag: string) => void;
  onClearAllTags: () => void;
  sort: ChubSort;
  onSortChange: (sort: ChubSort) => void;
  minTokens: number | undefined;
  onMinTokensChange: (v: number | undefined) => void;
  maxTokens: number | undefined;
  onMaxTokensChange: (v: number | undefined) => void;
  minRating: number | undefined;
  onMinRatingChange: (v: number | undefined) => void;
  recencyBucket: RecencyBucket;
  onRecencyBucketChange: (v: RecencyBucket) => void;
}

function parseFilterNumber(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// The eBay-style per-signal filter rail for Browse Chub, pulled out of BrowseChubView.tsx to stay
// under the project's 300-line file budget (bi_principles.md §10) — mirrors CanvasPanel.tsx's role
// as an extracted side panel, but with the collapsible-rail/mobile-overlay-drawer shell (see
// ChubFilterPanel.css) copied from ChatView.tsx's chat-settings-rail, the project's one existing
// pattern for exactly this kind of panel.
export default function ChubFilterPanel({
  collapsed, onToggleCollapsed, topics, tagStates, onTapTag, onClearAllTags,
  sort, onSortChange, minTokens, onMinTokensChange, maxTokens, onMaxTokensChange,
  minRating, onMinRatingChange, recencyBucket, onRecencyBucketChange,
}: ChubFilterPanelProps) {
  return (
    <div className={`chub-filter-rail${collapsed ? ' collapsed' : ''}`}>
      <div className="chub-filter-rail-header">
        <button
          className="chub-filter-toggle"
          title={collapsed ? 'Show filters' : 'Hide filters'}
          onClick={onToggleCollapsed}
        >
          {collapsed ? '«' : '»'}
        </button>
      </div>
      {!collapsed && (
        <div className="chub-filter-rail-content">
          <section className="chub-filter-section">
            <h3>Sort by</h3>
            <select value={sort} onChange={(e) => onSortChange(e.target.value as ChubSort)}>
              {CHUB_SORT_VALUES.map((value) => (
                <option key={value} value={value}>{SORT_LABELS[value]}</option>
              ))}
            </select>
          </section>

          <section className="chub-filter-section">
            <h3>Token count</h3>
            <div className="chub-filter-minmax">
              <input
                type="number"
                min={0}
                placeholder="Min"
                value={minTokens ?? ''}
                onChange={(e) => onMinTokensChange(parseFilterNumber(e.target.value))}
              />
              <span>&ndash;</span>
              <input
                type="number"
                min={0}
                placeholder="Max"
                value={maxTokens ?? ''}
                onChange={(e) => onMaxTokensChange(parseFilterNumber(e.target.value))}
              />
            </div>
          </section>

          <section className="chub-filter-section">
            <h3>Min rating</h3>
            <input
              type="number"
              min={0}
              max={5}
              placeholder="Any"
              value={minRating ?? ''}
              onChange={(e) => onMinRatingChange(parseFilterNumber(e.target.value))}
            />
          </section>

          <section className="chub-filter-section">
            <h3>Recency</h3>
            <select value={recencyBucket} onChange={(e) => onRecencyBucketChange(e.target.value as RecencyBucket)}>
              {RECENCY_BUCKETS.map((bucket) => (
                <option key={bucket} value={bucket}>{RECENCY_LABELS[bucket]}</option>
              ))}
            </select>
          </section>

          <section className="chub-filter-section">
            <h3>Topics</h3>
            <div className="chub-filter-topics">
              {topics.map((topic) => {
                const state = tagStates[topic];
                return (
                  <button
                    key={topic}
                    type="button"
                    className={`tag-chip chub-tag-chip${state ? ` ${state}` : ''}`}
                    onClick={() => onTapTag(topic)}
                  >
                    {topic}
                  </button>
                );
              })}
              {topics.length === 0 && <div className="chub-filter-topics-empty">Topics appear here as results load.</div>}
            </div>
            {Object.keys(tagStates).length > 0 && (
              <button type="button" className="browse-chub-clear-tags" onClick={onClearAllTags}>
                Clear topics
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
