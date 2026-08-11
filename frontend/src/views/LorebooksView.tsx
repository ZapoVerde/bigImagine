// docs/lorebook-plan.md §8a — the Lorebooks management page (step 5, minus the import/export
// hub). Admin-gated like RagView (useAdminUnlock, no apiKey prop): the settings panel drives the
// §3d keys, the library lists every user's books with their entries (books/entries are
// user-scoped RLS rows; each row carries its owning userId, echoed back on every write so the
// update/delete runs under that user's scope), and the per-entry editor covers the §3c
// activation-mechanics fields. `lorebook_mode` default is off (§2) — the page's own panel is the
// on-ramp.
import { useState } from 'react';
import {
  adminCreateLorebook,
  adminCreateLorebookEntry,
  adminDeleteLorebook,
  adminDeleteLorebookEntry,
  adminGetLorebookSettings,
  adminListLorebooks,
  adminSetLorebookSettings,
  adminUpdateLorebook,
  adminUpdateLorebookEntry,
} from '../api/client';
import type { LorebookAdminRow, LorebookEntryAdminRow, LorebookSettings } from '../api/types';
import { ApiError } from '../api/client';
import { useAdminUnlock } from '../hooks/useAdminUnlock';

interface EntryDraft {
  entryId: string;
  content: string;
  key: string;
  comment: string;
  constant: boolean;
  disable: boolean;
  orderValue: string;
  probability: string;
  useProbability: boolean;
  groupName: string;
  groupWeight: string;
  groupOverride: boolean;
  sticky: string;
  cooldown: string;
  delay: string;
}

function toDraft(e: LorebookEntryAdminRow): EntryDraft {
  return {
    entryId: e.entryId,
    content: e.content,
    key: e.key.join(', '),
    comment: e.comment,
    constant: e.constant,
    disable: e.disable,
    orderValue: String(e.orderValue),
    probability: String(e.probability),
    useProbability: e.useProbability,
    groupName: e.groupName,
    groupWeight: String(e.groupWeight),
    groupOverride: e.groupOverride,
    sticky: String(e.sticky),
    cooldown: String(e.cooldown),
    delay: String(e.delay),
  };
}

function nonNegInt(s: string, fallback: number): number {
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export default function LorebooksView() {
  const [settings, setSettingsState] = useState<LorebookSettings | null>(null);
  const [selectedMode, setSelectedMode] = useState<'on' | 'off'>('off');
  const [selectedBudget, setSelectedBudget] = useState('');
  const [selectedTopK, setSelectedTopK] = useState('');
  const [selectedRecursion, setSelectedRecursion] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState('');

  const [books, setBooks] = useState<LorebookAdminRow[] | null>(null);
  const [libraryStatus, setLibraryStatus] = useState('');
  const [expandedBookId, setExpandedBookId] = useState<string | null>(null);
  const [newBookName, setNewBookName] = useState('');
  const [newBookUserId, setNewBookUserId] = useState('');
  const [newEntryText, setNewEntryText] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, EntryDraft>>({});
  const [savingEntryId, setSavingEntryId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function applySettings(s: LorebookSettings) {
    setSettingsState(s);
    setSelectedMode(s.lorebookMode);
    setSelectedBudget(s.lorebookTokenBudget === null ? '' : String(s.lorebookTokenBudget));
    setSelectedTopK(String(s.lorebookRecallTopK));
    setSelectedRecursion(s.lorebookRecursionEnabled);
  }

  function applyBooks(rows: LorebookAdminRow[]) {
    setBooks(rows);
    const allDrafts: Record<string, EntryDraft> = {};
    for (const book of rows) {
      for (const e of book.entries) allDrafts[e.entryId] = toDraft(e);
    }
    setDrafts(allDrafts);
    setNewBookUserId((prev) => prev || rows[0]?.userId || '');
  }

  async function attemptLoad(key: string | null): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const [settingsResult, booksResult] = await Promise.all([adminGetLorebookSettings(key), adminListLorebooks(key)]);
      applySettings(settingsResult);
      applyBooks(booksResult);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  const { adminKey, setAdminKey, checking, unlocked, loadError, load } = useAdminUnlock(attemptLoad);

  async function saveSettings() {
    if (!settings) return;
    const patch: {
      lorebook_mode?: 'on' | 'off';
      lorebook_token_budget?: number | null;
      lorebook_recall_top_k?: number;
      lorebook_recursion_enabled?: boolean;
    } = {};
    if (selectedMode !== settings.lorebookMode) patch.lorebook_mode = selectedMode;
    const budget = selectedBudget === '' ? null : Number(selectedBudget);
    const storedBudget = settings.lorebookTokenBudget;
    if ((budget === null ? null : Number.isFinite(budget) && budget > 0 ? budget : storedBudget) !== storedBudget || selectedBudget === '') {
      if (selectedBudget === '' ? storedBudget !== null : budget !== storedBudget) patch.lorebook_token_budget = selectedBudget === '' ? null : budget;
    }
    const topK = Number(selectedTopK);
    if (Number.isInteger(topK) && topK > 0 && topK !== settings.lorebookRecallTopK) patch.lorebook_recall_top_k = topK;
    if (selectedRecursion !== settings.lorebookRecursionEnabled) patch.lorebook_recursion_enabled = selectedRecursion;
    setSettingsStatus('');
    try {
      if (Object.keys(patch).length === 0) {
        setSettingsStatus('No changes to save.');
        return;
      }
      applySettings(await adminSetLorebookSettings(patch, adminKey));
      setSettingsStatus('Saved — resolveLorebook reads these live, so the next turn sees it.');
    } catch (error) {
      setSettingsStatus(error instanceof ApiError ? 'error: ' + error.message : 'failed to save');
    }
  }

  async function createBook() {
    if (!newBookName.trim() || !newBookUserId) return;
    setLibraryStatus('');
    try {
      await adminCreateLorebook({ user_id: newBookUserId, name: newBookName.trim() }, adminKey);
      setNewBookName('');
      applyBooks(await adminListLorebooks(adminKey));
    } catch (error) {
      setLibraryStatus(error instanceof ApiError ? 'error: ' + error.message : 'failed to create book');
    }
  }

  async function toggleGlobalScope(book: LorebookAdminRow) {
    setLibraryStatus('');
    try {
      await adminUpdateLorebook(book.lorebookId, { user_id: book.userId, global_scope: !book.globalScope }, adminKey);
      applyBooks(await adminListLorebooks(adminKey));
    } catch (error) {
      setLibraryStatus(error instanceof ApiError ? 'error: ' + error.message : 'failed to update book');
    }
  }

  async function deleteBook(book: LorebookAdminRow) {
    setDeletingId(book.lorebookId);
    setLibraryStatus('');
    try {
      await adminDeleteLorebook(book.lorebookId, book.userId, adminKey);
      setExpandedBookId((prev) => (prev === book.lorebookId ? null : prev));
      applyBooks(await adminListLorebooks(adminKey));
    } catch (error) {
      setLibraryStatus(error instanceof ApiError ? 'error: ' + error.message : 'failed to delete book');
    } finally {
      setDeletingId(null);
    }
  }

  async function createEntry(book: LorebookAdminRow) {
    const text = (newEntryText[book.lorebookId] ?? '').trim();
    if (!text) return;
    setSavingEntryId(`new:${book.lorebookId}`);
    setLibraryStatus('');
    try {
      await adminCreateLorebookEntry({ user_id: book.userId, lorebook_id: book.lorebookId, content: text }, adminKey);
      setNewEntryText((prev) => ({ ...prev, [book.lorebookId]: '' }));
      applyBooks(await adminListLorebooks(adminKey));
    } catch (error) {
      setLibraryStatus(error instanceof ApiError ? 'error: ' + error.message : 'failed to create entry');
    } finally {
      setSavingEntryId(null);
    }
  }

  async function saveEntry(book: LorebookAdminRow, draft: EntryDraft) {
    setSavingEntryId(draft.entryId);
    setLibraryStatus('');
    try {
      await adminUpdateLorebookEntry(
        draft.entryId,
        {
          user_id: book.userId,
          content: draft.content,
          key: draft.key.split(',').map((k) => k.trim()).filter(Boolean),
          comment: draft.comment,
          constant: draft.constant,
          disable: draft.disable,
          order_value: nonNegInt(draft.orderValue, 100),
          probability: nonNegInt(draft.probability, 100),
          use_probability: draft.useProbability,
          group_name: draft.groupName,
          group_weight: nonNegInt(draft.groupWeight, 1),
          group_override: draft.groupOverride,
          sticky: nonNegInt(draft.sticky, 0),
          cooldown: nonNegInt(draft.cooldown, 0),
          delay: nonNegInt(draft.delay, 0),
        },
        adminKey,
      );
      applyBooks(await adminListLorebooks(adminKey));
      setLibraryStatus('Saved.');
    } catch (error) {
      setLibraryStatus(error instanceof ApiError ? 'error: ' + error.message : 'failed to save entry');
    } finally {
      setSavingEntryId(null);
    }
  }

  async function deleteEntry(book: LorebookAdminRow, entryId: string) {
    setDeletingId(entryId);
    setLibraryStatus('');
    try {
      await adminDeleteLorebookEntry(entryId, book.userId, adminKey);
      applyBooks(await adminListLorebooks(adminKey));
    } catch (error) {
      setLibraryStatus(error instanceof ApiError ? 'error: ' + error.message : 'failed to delete entry');
    } finally {
      setDeletingId(null);
    }
  }

  function setDraft(entryId: string, patch: Partial<EntryDraft>) {
    setDrafts((prev) => ({ ...prev, [entryId]: { ...prev[entryId]!, ...patch } }));
  }

  if (checking) return <div className="rag-view" />;
  if (!unlocked) {
    return (
      <div className="rag-view">
        <h1>Lorebooks</h1>
        <div className="status rag-view-intro">
          The Lorebook management page — settings, the library (books with their entries and
          character links), and the per-entry editor. Admin-gated like the RAG view.
        </div>
        {loadError && <div className="status">{String(loadError)}</div>}
        <label>
          Admin key
          <br />
          <input type="password" value={adminKey ?? ''} onChange={(e) => setAdminKey(e.target.value)} />
        </label>
        <button type="button" onClick={() => load()}>
          Load
        </button>
      </div>
    );
  }

  return (
    <div className="rag-view">
      <h1>Lorebooks</h1>
      <div className="status rag-view-intro">
        The plan's §3d settings (mode, recall top-K, token budget — recursion is a registered row
        that does nothing yet per §9) and the library: every user's books, each with its entries.
        A book is in scope for a chat via its global-scope flag or character links; per-chat
        on/off lives in the chat sidebar's overrides.
      </div>

      <fieldset>
        <legend>Lorebook settings</legend>
        <label>
          Mode
          <br />
          <select value={selectedMode} onChange={(e) => setSelectedMode(e.target.value as 'on' | 'off')}>
            <option value="off">Off (default)</option>
            <option value="on">On</option>
          </select>
          <span className="model-connection-note">
            Off by default (§2). When on, each narrator turn recalls candidates and the gate decides
            what lands in the <code>lorebook</code> slot.
          </span>
          {settings?.lorebookModeIsDefault && <em> (default)</em>}
        </label>
        <br />
        <label>
          Recall top-K
          <br />
          <input
            type="number"
            min={1}
            max={50}
            value={selectedTopK}
            onChange={(e) => setSelectedTopK(e.target.value)}
            placeholder="8"
          />
          <span className="model-connection-note">
            How many ranked candidates the recall step cuts at (constants are always included,
            never cut). Mirrors <code>canon_recall_top_k</code>'s default of 8, capped at 50.
          </span>
          {settings?.lorebookRecallTopKIsDefault && <em> (default)</em>}
        </label>
        <br />
        <label>
          Token budget
          <br />
          <input
            type="number"
            min={1}
            value={selectedBudget}
            onChange={(e) => setSelectedBudget(e.target.value)}
            placeholder="unlimited"
          />
          <span className="model-connection-note">
            How many tokens of entry content may land in the slot; blank = no limit. Later entries
            beyond the budget are cut in array order.
          </span>
          {settings?.lorebookTokenBudgetIsDefault && <em> (default)</em>}
        </label>
        <br />
        <label>
          <input type="checkbox" checked={selectedRecursion} onChange={(e) => setSelectedRecursion(e.target.checked)} />
          Recursion (lore triggering lore)
          <span className="model-connection-note">Ships as a settings row that does nothing yet (§9) — turning it on later is a logic change, not a schema change.</span>
          {settings?.lorebookRecursionEnabledIsDefault && <em> (default)</em>}
        </label>
        <br />
        <button type="button" onClick={() => saveSettings()}>
          Save settings
        </button>
        {settingsStatus && <span className="status"> {settingsStatus}</span>}
      </fieldset>

      <fieldset>
        <legend>Library</legend>
        {libraryStatus && <div className="status">{libraryStatus}</div>}
        <div>
          <input value={newBookName} onChange={(e) => setNewBookName(e.target.value)} placeholder="New book name" />
          <select value={newBookUserId} onChange={(e) => setNewBookUserId(e.target.value)}>
            {(books ?? []).filter((b, i, arr) => arr.findIndex((x) => x.userId === b.userId) === i).map((b) => (
              <option key={b.userId} value={b.userId}>
                user {b.userId.slice(0, 8)}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => createBook()} disabled={!newBookName.trim() || !newBookUserId}>
            Create book
          </button>
        </div>
        <br />
        {(books ?? []).length === 0 && <div className="status">No books yet — create one above. (Import from a SillyTavern world-info export arrives with the import/export hub.)</div>}
        {(books ?? []).map((book) => (
          <div key={book.lorebookId} style={{ margin: '8px 0', padding: '8px', border: '1px solid #444' }}>
            <div>
              <button type="button" onClick={() => setExpandedBookId((prev) => (prev === book.lorebookId ? null : book.lorebookId))}>
                {expandedBookId === book.lorebookId ? '▾' : '▸'} {book.name}
              </button>{' '}
              <label>
                <input type="checkbox" checked={book.globalScope} onChange={() => toggleGlobalScope(book)} /> Global scope
              </label>{' '}
              <span className="status">
                {book.entries.length} entr{book.entries.length === 1 ? 'y' : 'ies'}, {book.characterIds.length} character
                {book.characterIds.length === 1 ? '' : 's'} linked, {book.chatOverrideCount} chat override
                {book.chatOverrideCount === 1 ? '' : 's'}
              </span>{' '}
              <button type="button" onClick={() => deleteBook(book)} disabled={deletingId === book.lorebookId}>
                Delete book
              </button>
            </div>
            {expandedBookId === book.lorebookId && (
              <div style={{ marginTop: '8px' }}>
                {book.entries.map((e) => {
                  const draft = drafts[e.entryId] ?? toDraft(e);
                  return (
                    <div key={e.entryId} style={{ margin: '6px 0', padding: '6px', border: '1px dashed #555' }}>
                      <label>
                        <input type="checkbox" checked={!draft.disable} onChange={(ev) => setDraft(e.entryId, { disable: !ev.target.checked })} />
                        Enabled
                      </label>{' '}
                      <label>
                        <input type="checkbox" checked={draft.constant} onChange={(ev) => setDraft(e.entryId, { constant: ev.target.checked })} />
                        Constant (always in)
                      </label>{' '}
                      <label>
                        Probability{' '}
                        <input
                          type="number"
                          min={0}
                          max={100}
                          style={{ width: '4em' }}
                          value={draft.probability}
                          onChange={(ev) => setDraft(e.entryId, { probability: ev.target.value })}
                        />
                      </label>{' '}
                      <label>
                        <input type="checkbox" checked={draft.useProbability} onChange={(ev) => setDraft(e.entryId, { useProbability: ev.target.checked })} />
                        Roll probability
                      </label>{' '}
                      <label>
                        Priority{' '}
                        <input
                          type="number"
                          style={{ width: '4em' }}
                          value={draft.orderValue}
                          onChange={(ev) => setDraft(e.entryId, { orderValue: ev.target.value })}
                        />
                      </label>
                      <br />
                      <label>
                        Group{' '}
                        <input value={draft.groupName} onChange={(ev) => setDraft(e.entryId, { groupName: ev.target.value })} placeholder="(none)" />
                      </label>{' '}
                      <label>
                        Weight{' '}
                        <input
                          type="number"
                          style={{ width: '4em' }}
                          value={draft.groupWeight}
                          onChange={(ev) => setDraft(e.entryId, { groupWeight: ev.target.value })}
                        />
                      </label>{' '}
                      <label>
                        <input type="checkbox" checked={draft.groupOverride} onChange={(ev) => setDraft(e.entryId, { groupOverride: ev.target.checked })} />
                        Override
                      </label>{' '}
                      <label>
                        Sticky <input type="number" style={{ width: '4em' }} value={draft.sticky} onChange={(ev) => setDraft(e.entryId, { sticky: ev.target.value })} />
                      </label>{' '}
                      <label>
                        Cooldown <input type="number" style={{ width: '4em' }} value={draft.cooldown} onChange={(ev) => setDraft(e.entryId, { cooldown: ev.target.value })} />
                      </label>{' '}
                      <label>
                        Delay <input type="number" style={{ width: '4em' }} value={draft.delay} onChange={(ev) => setDraft(e.entryId, { delay: ev.target.value })} />
                      </label>
                      <br />
                      <label>
                        Keys (comma-separated, informational — vector recall replaced keyword matching)
                        <br />
                        <input value={draft.key} onChange={(ev) => setDraft(e.entryId, { key: ev.target.value })} />
                      </label>
                      <br />
                      <label>
                        Comment
                        <br />
                        <input value={draft.comment} onChange={(ev) => setDraft(e.entryId, { comment: ev.target.value })} />
                      </label>
                      <br />
                      <label>
                        Content
                        <br />
                        <textarea rows={3} style={{ width: '100%' }} value={draft.content} onChange={(ev) => setDraft(e.entryId, { content: ev.target.value })} />
                      </label>
                      <br />
                      <button type="button" onClick={() => saveEntry(book, draft)} disabled={savingEntryId === e.entryId}>
                        Save entry
                      </button>{' '}
                      <button type="button" onClick={() => deleteEntry(book, e.entryId)} disabled={deletingId === e.entryId}>
                        Delete entry
                      </button>
                    </div>
                  );
                })}
                <div style={{ marginTop: '8px' }}>
                  <textarea
                    rows={2}
                    style={{ width: '100%' }}
                    value={newEntryText[book.lorebookId] ?? ''}
                    onChange={(ev) => setNewEntryText((prev) => ({ ...prev, [book.lorebookId]: ev.target.value }))}
                    placeholder="New entry content"
                  />
                  <button type="button" onClick={() => createEntry(book)} disabled={savingEntryId === `new:${book.lorebookId}`}>
                    Add entry
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </fieldset>
    </div>
  );
}
