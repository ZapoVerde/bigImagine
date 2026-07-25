import { useEffect, useRef, useState } from 'react';
import { ApiError, callTool } from '../api/client';
import type { AddListItemResult, CompleteListItemResult, ListItem } from '../api/types';
import './ListsView.css';

interface ListsViewProps {
  apiKey: string | null;
  /** Which list to show — picked in the sidebar's ListsBrowser. Null = nothing picked yet. */
  selectedListName: string | null;
  /** Focuses a list — called after adding an item, so a brand-new list is shown immediately. */
  onSelectList: (name: string) => void;
  /** Tells the sidebar to re-derive its list-name picker after a mutation might have added one. */
  onChanged: () => void;
}

function groupBySection(items: ListItem[]): Map<string, ListItem[]> {
  const bySection = new Map<string, ListItem[]>();
  for (const item of items) {
    const section = item.section ?? '';
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section)!.push(item);
  }
  return bySection;
}

export default function ListsView({ apiKey, selectedListName, onSelectList, onChanged }: ListsViewProps) {
  const [items, setItems] = useState<ListItem[]>([]);
  const [includeDone, setIncludeDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newListName, setNewListName] = useState('');
  const [newItemName, setNewItemName] = useState('');
  const itemInputRef = useRef<HTMLInputElement>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const result = await callTool<ListItem[]>('get_list_items', { include_done: includeDone }, apiKey);
      setItems(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load lists');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDone]);

  async function addItem() {
    const listName = (newListName || selectedListName || '').trim();
    if (!listName || !newItemName.trim()) return;
    try {
      await callTool<AddListItemResult>(
        'add_list_item',
        { list_name: listName, item_name: newItemName.trim() },
        apiKey,
      );
      setNewItemName('');
      setNewListName('');
      onSelectList(listName);
      onChanged();
      await reload();
      itemInputRef.current?.focus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to add item');
    }
  }

  async function completeItem(item: ListItem) {
    try {
      await callTool<CompleteListItemResult>(
        'complete_list_item',
        { item_name: item.itemName, list_name: item.listName },
        apiKey,
      );
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to complete item');
    }
  }

  const knownListNames = [...new Set(items.map((i) => i.listName))].sort();
  const selectedItems = selectedListName ? items.filter((i) => i.listName === selectedListName) : [];
  const bySection = groupBySection(selectedItems);

  return (
    <div className="lists-view">
      {error && <div className="error-banner">{error}</div>}

      <div className="lists-toolbar">
        <label>
          <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} />
          show completed
        </label>
      </div>

      {loading && items.length === 0 && <div className="empty-state">Loading…</div>}
      {!loading && !selectedListName && (
        <div className="empty-state">Pick a list from the sidebar, or add an item below to start one.</div>
      )}
      {!loading && selectedListName && selectedItems.length === 0 && (
        <div className="empty-state">Nothing in "{selectedListName}" yet.</div>
      )}

      {selectedListName && (
        <section className="list-group">
          <h2>{selectedListName}</h2>
          {[...bySection.entries()].map(([section, sectionItems]) => (
            <div key={section} className="list-section">
              {section && <h3>{section}</h3>}
              <ul>
                {sectionItems.map((item) => (
                  <li key={item.itemId} className={item.status === 'done' ? 'done' : ''}>
                    <label>
                      <input
                        type="checkbox"
                        checked={item.status === 'done'}
                        disabled={item.status === 'done'}
                        onChange={() => completeItem(item)}
                      />
                      {item.itemName}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      <form
        className="add-item-form"
        onSubmit={(e) => {
          e.preventDefault();
          addItem();
        }}
      >
        {!selectedListName && (
          <>
            <input
              list="known-lists"
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              placeholder="List name"
            />
            <datalist id="known-lists">
              {knownListNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </>
        )}
        <input
          ref={itemInputRef}
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          placeholder="Item name"
        />
        <button type="submit">Add</button>
      </form>
    </div>
  );
}
