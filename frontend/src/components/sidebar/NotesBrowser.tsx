import { useEffect, useRef, useState } from 'react';
import { ApiError, callTool } from '../../api/client';
import type { CreateNoteResult, DeleteNoteResult, NoteSummary } from '../../api/types';

interface NotesBrowserProps {
  apiKey: string | null;
  selectedNoteId: string | null;
  onSelect: (id: string) => void;
  onDeselect: () => void;
  /** Bumped by NotesView after a save that changed a title. */
  refreshKey: number;
}

export default function NotesBrowser({ apiKey, selectedNoteId, onSelect, onDeselect, refreshKey }: NotesBrowserProps) {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<number | null>(null);

  async function reload(searchText?: string) {
    try {
      setNotes(await callTool<NoteSummary[]>('get_notes', { search: searchText || undefined }, apiKey));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load notes');
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  function onSearchChange(text: string) {
    setSearch(text);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => reload(text), 300);
  }

  async function newNote() {
    setError(null);
    try {
      const created = await callTool<CreateNoteResult>('create_note', { content: '' }, apiKey);
      onSelect(created.noteId);
      await reload(search);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to create note');
    }
  }

  async function removeNote(noteId: string) {
    setError(null);
    try {
      await callTool<DeleteNoteResult>('delete_note', { note_id: noteId }, apiKey);
      if (selectedNoteId === noteId) onDeselect();
      await reload(search);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete note');
    }
  }

  return (
    <div className="sidebar-browser">
      {error && <div className="error-banner">{error}</div>}
      <div className="sidebar-actions">
        <input
          className="sidebar-search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search notes…"
        />
        <button className="sidebar-add-btn" title="New note" onClick={newNote}>
          + New
        </button>
      </div>
      <div className="sidebar-list">
        {notes.map((note) => (
          <div
            key={note.noteId}
            className={`sidebar-row${note.noteId === selectedNoteId ? ' active' : ''}`}
            onClick={() => onSelect(note.noteId)}
          >
            <span className="sidebar-row-title">{note.title}</span>
            <button
              className="sidebar-row-delete"
              title="Delete note"
              onClick={(e) => {
                e.stopPropagation();
                removeNote(note.noteId);
              }}
            >
              &times;
            </button>
          </div>
        ))}
        {notes.length === 0 && <div className="empty-state small">No notes yet.</div>}
      </div>
    </div>
  );
}
