import { useEffect, useRef, useState } from 'react';
import { ApiError, callTool } from '../api/client';
import type { AddListItemResult, CompleteListItemResult, ListItem, ListItemPriority, UpdateListItemResult } from '../api/types';
import './ListsView.css';

const PRIORITIES: ListItemPriority[] = ['P1', 'P2', 'P3'];

// <input type="date"> wants/returns "YYYY-MM-DD"; dueAt is a full ISO timestamp. Truncating loses
// time-of-day on round-trip, same tradeoff TodayAgenda's isoDateInZone accepts elsewhere in this
// app — a due *date* is the common case, not a due time.
function toDateInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

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
  const [newItemPriority, setNewItemPriority] = useState('');
  const [newItemDueAt, setNewItemDueAt] = useState('');
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
        {
          list_name: listName,
          item_name: newItemName.trim(),
          ...(newItemPriority ? { priority: newItemPriority } : {}),
          ...(newItemDueAt ? { due_at: newItemDueAt } : {}),
        },
        apiKey,
      );
      setNewItemName('');
      setNewListName('');
      setNewItemPriority('');
      setNewItemDueAt('');
      onSelectList(listName);
      onChanged();
      await reload();
      itemInputRef.current?.focus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to add item');
    }
  }

  async function updateItem(item: ListItem, patch: { priority?: string; due_at?: string }) {
    try {
      await callTool<UpdateListItemResult>('update_list_item', { item_id: item.itemId, ...patch }, apiKey);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to update item');
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
                {sectionItems.map((item) => {
                  const overdue = item.status === 'pending' && !!item.dueAt && item.dueAt < new Date().toISOString();
                  return (
                    <li key={item.itemId} className={item.status === 'done' ? 'done' : ''}>
                      <label>
                        <input
                          type="checkbox"
                          checked={item.status === 'done'}
                          disabled={item.status === 'done'}
                          onChange={() => completeItem(item)}
                        />
                        {item.itemName}
                        {item.priority && item.priority !== 'P2' && (
                          <span className={`priority-badge ${item.priority.toLowerCase()}`}>{item.priority}</span>
                        )}
                        {item.dueAt && <span className={`due-badge${overdue ? ' overdue' : ''}`}>due {toDateInputValue(item.dueAt)}</span>}
                      </label>
                      {item.status === 'pending' && (
                        <div className="item-controls">
                          <select
                            value={item.priority ?? ''}
                            onChange={(e) => updateItem(item, { priority: e.target.value || 'P2' })}
                          >
                            <option value="">Priority…</option>
                            {PRIORITIES.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                          <input
                            type="date"
                            value={toDateInputValue(item.dueAt)}
                            onChange={(e) => e.target.value && updateItem(item, { due_at: e.target.value })}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
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
        <select value={newItemPriority} onChange={(e) => setNewItemPriority(e.target.value)}>
          <option value="">Priority…</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input type="date" value={newItemDueAt} onChange={(e) => setNewItemDueAt(e.target.value)} />
        <button type="submit">Add</button>
      </form>
    </div>
  );
}
