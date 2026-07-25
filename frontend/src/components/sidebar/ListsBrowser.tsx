import { useEffect, useState } from 'react';
import { ApiError, callTool } from '../../api/client';
import type { ListItem } from '../../api/types';

interface ListsBrowserProps {
  apiKey: string | null;
  selectedListName: string | null;
  onSelect: (name: string) => void;
  /** Bumped by ListsView after a mutation that might add a new list name. */
  refreshKey: number;
}

// Read-only picker: list names are derived from item data (there's no standalone "create/delete
// list" tool — a list exists exactly as long as it has at least one item), so this never mutates
// anything itself, unlike ChatBrowser/NotesBrowser.
export default function ListsBrowser({ apiKey, selectedListName, onSelect, refreshKey }: ListsBrowserProps) {
  const [listNames, setListNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    callTool<ListItem[]>('get_list_items', { include_done: true }, apiKey)
      .then((items) => setListNames([...new Set(items.map((i) => i.listName))].sort()))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load lists'));
  }, [apiKey, refreshKey]);

  return (
    <div className="sidebar-browser">
      {error && <div className="error-banner">{error}</div>}
      <div className="sidebar-list">
        {listNames.map((name) => (
          <div
            key={name}
            className={`sidebar-row${name === selectedListName ? ' active' : ''}`}
            onClick={() => onSelect(name)}
          >
            <span className="sidebar-row-title">{name}</span>
          </div>
        ))}
        {listNames.length === 0 && <div className="empty-state small">No lists yet — add an item to create one.</div>}
      </div>
    </div>
  );
}
