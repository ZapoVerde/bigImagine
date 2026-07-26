import { useEffect, useState } from 'react';
import { ApiError, callTool } from '../../api/client';
import type { DeleteListResult, ListItem } from '../../api/types';

interface ListsBrowserProps {
  apiKey: string | null;
  selectedListName: string | null;
  onSelect: (name: string) => void;
  onDeselect: () => void;
  /** Bumped by ListsView after a mutation that might add a new list name. */
  refreshKey: number;
}

// List names are derived from item data (there's no separate "list of all lists" view, and a list
// with zero items never shows up here) — but delete_list is a real tool, so this component does
// mutate now, unlike its old read-only-picker self.
export default function ListsBrowser({ apiKey, selectedListName, onSelect, onDeselect, refreshKey }: ListsBrowserProps) {
  const [listNames, setListNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const items = await callTool<ListItem[]>('get_list_items', { include_done: true }, apiKey);
      setListNames([...new Set(items.map((i) => i.listName))].sort());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load lists');
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, refreshKey]);

  async function removeList(name: string) {
    if (!window.confirm(`Delete the entire list "${name}" and everything on it? This cannot be undone.`)) return;
    setError(null);
    try {
      await callTool<DeleteListResult>('delete_list', { list_name: name }, apiKey);
      if (name === selectedListName) onDeselect();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete list');
    }
  }

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
            <button
              className="sidebar-row-delete"
              title="Delete list"
              onClick={(e) => {
                e.stopPropagation();
                removeList(name);
              }}
            >
              &times;
            </button>
          </div>
        ))}
        {listNames.length === 0 && <div className="empty-state small">No lists yet — add an item to create one.</div>}
      </div>
    </div>
  );
}
