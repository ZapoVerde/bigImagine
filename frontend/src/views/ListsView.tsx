import { useEffect, useState } from 'react';
import { ApiError, callTool } from '../api/client';
import type { AddListItemResult, CompleteListItemResult, ListItem } from '../api/types';
import './ListsView.css';

interface ListsViewProps {
  apiKey: string | null;
}

function groupBySectionThenList(items: ListItem[]): Map<string, Map<string, ListItem[]>> {
  const byList = new Map<string, Map<string, ListItem[]>>();
  for (const item of items) {
    if (!byList.has(item.listName)) byList.set(item.listName, new Map());
    const bySection = byList.get(item.listName)!;
    const section = item.section ?? '';
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section)!.push(item);
  }
  return byList;
}

export default function ListsView({ apiKey }: ListsViewProps) {
  const [items, setItems] = useState<ListItem[]>([]);
  const [includeDone, setIncludeDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newListName, setNewListName] = useState('');
  const [newItemName, setNewItemName] = useState('');

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
    if (!newListName.trim() || !newItemName.trim()) return;
    try {
      await callTool<AddListItemResult>(
        'add_list_item',
        { list_name: newListName.trim(), item_name: newItemName.trim() },
        apiKey,
      );
      setNewItemName('');
      await reload();
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

  const grouped = groupBySectionThenList(items);
  const knownListNames = [...grouped.keys()];

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
      {!loading && items.length === 0 && <div className="empty-state">No list items yet.</div>}

      {[...grouped.entries()].map(([listName, bySection]) => (
        <section key={listName} className="list-group">
          <h2>{listName}</h2>
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
      ))}

      <form
        className="add-item-form"
        onSubmit={(e) => {
          e.preventDefault();
          addItem();
        }}
      >
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
        <input
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          placeholder="Item name"
        />
        <button type="submit">Add</button>
      </form>
    </div>
  );
}
