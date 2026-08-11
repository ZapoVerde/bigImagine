// docs/lorebook-plan.md §8b — the chat-sidebar Lorebook panel. Wired into ChatView.tsx's
// settings rail as a collapsible set (LorebookSet): embedded, static flow — the set's summary is
// the title and a collapsed set never mounts the panel. The standalone chrome (title + ✕ header,
// side-by-side pane) still exists via the `embedded` prop for any future standalone mount. Reads
// the user-scoped /v1/chats/:chatId/lorebook-panel data: the resolved mode, the §3b in-scope
// books with all their entries, the §8b live activation badge (lorebook_activation_log's latest
// message), and the quick toggles/quick-add that write lorebook_chat_overrides /
// lorebook_entry_overrides / a lazily-created chat-scoped book. When mode resolves to off, the
// whole panel collapses to a one-line status + a link to the RAG view — never a blank or
// half-populated panel.
import { useEffect, useState } from 'react';
import {
  getLorebookPanel,
  quickAddLorebookEntry,
  setLorebookChatOverride,
  setLorebookEntryOverride,
} from '../../api/client';
import type { LorebookPanelData, LorebookPanelEntry } from '../../api/types';
import { ApiError } from '../../api/client';
import './LorebookPanel.css';

interface LorebookPanelProps {
  apiKey: string | null;
  chatId: string;
  /** Bumped once per completed chat turn (ChatView) so the activation badges refresh. */
  refreshToken: number;
  /** The mode-off one-liner's link target (App wires this to summon the Lorebooks tab). */
  onOpenLorebooks?: () => void;
  onClose: () => void;
  /** Render as a static embedded flow (no standalone header chrome — title, mode tag, ✕) for
   *  hosting inside the chat settings rail's collapsible Lorebook set, whose summary is the
   *  title. Defaults to the standalone side-pane treatment. */
  embedded?: boolean;
}

export default function LorebookPanel({ apiKey, chatId, refreshToken, onOpenLorebooks, onClose, embedded = false }: LorebookPanelProps) {
  const [data, setData] = useState<LorebookPanelData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [quickAddText, setQuickAddText] = useState('');
  const [status, setStatus] = useState('');

  async function load() {
    try {
      setData(await getLorebookPanel(chatId, apiKey));
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.message : 'failed to load lorebook panel');
    }
  }

  useEffect(() => {
    if (chatId) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, refreshToken]);

  async function toggleBook(lorebookId: string, effectiveEnabled: boolean) {
    setBusy(`book:${lorebookId}`);
    setStatus('');
    try {
      await setLorebookChatOverride(chatId, { lorebook_id: lorebookId, enabled: !effectiveEnabled }, apiKey);
      await load();
    } catch (error) {
      setStatus(error instanceof ApiError ? error.message : 'failed to update book');
    } finally {
      setBusy(null);
    }
  }

  async function toggleEntry(entry: LorebookPanelEntry) {
    const effective = entry.entryOverrideEnabled ?? true;
    setBusy(`entry:${entry.entryId}`);
    setStatus('');
    try {
      await setLorebookEntryOverride(chatId, { entry_id: entry.entryId, enabled: !effective }, apiKey);
      await load();
    } catch (error) {
      setStatus(error instanceof ApiError ? error.message : 'failed to update entry');
    } finally {
      setBusy(null);
    }
  }

  async function quickAdd() {
    if (!quickAddText.trim()) return;
    setBusy('quick-add');
    setStatus('');
    try {
      await quickAddLorebookEntry(chatId, quickAddText, apiKey);
      setQuickAddText('');
      await load();
    } catch (error) {
      setStatus(error instanceof ApiError ? error.message : 'failed to add entry');
    } finally {
      setBusy(null);
    }
  }

  const modeOff = data !== null && data.mode === 'off';

  return (
    <div className={`lorebook-panel${embedded ? ' embedded' : ''}`}>
      {!embedded && (
        <div className="lorebook-panel-header">
          <span className="lorebook-panel-title">📖 Lorebook</span>
          <span className="lorebook-panel-header-actions">
            {modeOff && data?.modeIsDefault && <span className="lorebook-panel-mode-tag">(default)</span>}
            <button type="button" className="lorebook-panel-close" onClick={onClose} title="Close">
              ✕
            </button>
          </span>
        </div>
      )}

      {loadError && <div className="lorebook-panel-content status">{loadError}</div>}

      {data === null && !loadError && <div className="lorebook-panel-content status">Loading…</div>}

      {modeOff && data !== null && (
        <div className="lorebook-panel-content">
          <p className="status">
            Lorebooks are off — nothing recalls or injects while the mode is off. Turn it on in{' '}
            {onOpenLorebooks ? (
              <button type="button" className="lorebook-panel-link" onClick={onOpenLorebooks}>
                the Lorebooks page
              </button>
            ) : (
              'the Lorebooks page'
            )}
            .
          </p>
        </div>
      )}

      {data !== null && !modeOff && (
        <div className="lorebook-panel-content">
          {status && <p className="status">{status}</p>}
          {data.books.length === 0 && (
            <p className="status">
              No books are in scope for this chat — global-scope books, character-linked books,
              and per-chat-enabled books show up here. Add one with the quick-add box below.
            </p>
          )}
          {data.books.map((book) => {
            const effectiveEnabled = book.chatOverrideEnabled ?? true;
            const open = expanded.has(book.lorebookId);
            return (
              <div key={book.lorebookId} className="lorebook-book">
                <div className="lorebook-book-header">
                  <button
                    type="button"
                    className="lorebook-book-toggle"
                    onClick={() => setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(book.lorebookId)) next.delete(book.lorebookId);
                      else next.add(book.lorebookId);
                      return next;
                    })}
                  >
                    {open ? '▾' : '▸'} {book.name}
                  </button>
                  {book.globalScope && <span className="lorebook-badge" title="In scope for every chat">global</span>}
                  {book.characterLinked && <span className="lorebook-badge" title="Linked to this chat's character">char</span>}
                  <label className="lorebook-enable" title={effectiveEnabled ? 'Disable this book for this chat' : 'Enable this book for this chat'}>
                    <input
                      type="checkbox"
                      checked={effectiveEnabled}
                      disabled={busy === `book:${book.lorebookId}`}
                      onChange={() => toggleBook(book.lorebookId, effectiveEnabled)}
                    />
                    {effectiveEnabled ? 'on' : 'off'}
                  </label>
                </div>
                {open && (
                  <div className="lorebook-book-entries">
                    {book.entries.length === 0 && <p className="status">No entries.</p>}
                    {book.entries.map((entry) => {
                      const entryOn = entry.entryOverrideEnabled ?? true;
                      return (
                        <div key={entry.entryId} className={`lorebook-entry${entry.disable ? ' disabled' : ''}`}>
                          <div className="lorebook-entry-line">
                            <span className="lorebook-entry-content">
                              {entry.activatedInLatestTurn && <span className="lorebook-badge live" title="Active in the latest turn">⚡</span>}
                              {entry.constant && <span className="lorebook-badge" title="Constant — always in">📌</span>}
                              {entry.content}
                            </span>
                            <label className="lorebook-enable" title={entryOn ? 'Exclude this entry for this chat' : 'Include this entry for this chat'}>
                              <input
                                type="checkbox"
                                checked={entryOn}
                                disabled={busy === `entry:${entry.entryId}`}
                                onChange={() => toggleEntry(entry)}
                              />
                              {entryOn ? 'on' : 'off'}
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          <div className="lorebook-quickadd">
            <textarea
              rows={2}
              value={quickAddText}
              onChange={(e) => setQuickAddText(e.target.value)}
              placeholder="Quick-add: a fact or scene note for this chat's lorebook"
            />
            <button type="button" onClick={quickAdd} disabled={!quickAddText.trim() || busy === 'quick-add'}>
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
