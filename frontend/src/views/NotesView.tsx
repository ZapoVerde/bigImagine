import { useEffect, useRef, useState } from 'react';
import { ApiError, callTool } from '../api/client';
import type { CreateNoteResult, DeleteNoteResult, NoteDetailResult, NoteSummary } from '../api/types';
import './NotesView.css';

interface NotesViewProps {
  apiKey: string | null;
}

// Singleton browser for freeform notes — same list/detail shape as RecipesView, but the detail
// pane is editable in place (a note has no separate "add" flow beyond blank + edit, unlike a
// recipe import). Backed entirely by the notes plugin's tools via the generic callTool API, so
// anything done here is equally reachable by asking the LLM in chat.
export default function NotesView({ apiKey }: NotesViewProps) {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState(false);

  const searchTimer = useRef<number | null>(null);

  async function reload(searchText?: string) {
    setLoading(true);
    setError(null);
    try {
      setNotes(await callTool<NoteSummary[]>('get_notes', { search: searchText || undefined }, apiKey));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load notes');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSearchChange(text: string) {
    setSearch(text);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => reload(text), 300);
  }

  async function openNote(noteId: string) {
    setError(null);
    try {
      const detail = await callTool<NoteDetailResult>('get_note', { note_id: noteId }, apiKey);
      if (!detail.found) {
        setError('note not found');
        return;
      }
      setSelectedId(detail.noteId);
      setTitle(detail.title);
      setContent(detail.content);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load note');
    }
  }

  async function newNote() {
    setError(null);
    try {
      const created = await callTool<CreateNoteResult>('create_note', { content: '' }, apiKey);
      setSelectedId(created.noteId);
      setTitle(created.title);
      setContent(created.content);
      await reload(search);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to create note');
    }
  }

  async function saveNote() {
    if (!selectedId) return;
    setError(null);
    try {
      await callTool<NoteDetailResult>('update_note', { note_id: selectedId, title, content }, apiKey);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
      await reload(search);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to save note');
    }
  }

  async function deleteNote(noteId: string) {
    setError(null);
    try {
      await callTool<DeleteNoteResult>('delete_note', { note_id: noteId }, apiKey);
      if (selectedId === noteId) setSelectedId(null);
      await reload(search);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete note');
    }
  }

  if (selectedId) {
    return (
      <div className="notes-view">
        <button className="back-link" onClick={() => setSelectedId(null)}>
          &larr; all notes
        </button>
        {error && <div className="error-banner">{error}</div>}
        <div className="note-editor">
          <input className="note-title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
          <textarea
            className="note-content-input"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={16}
            placeholder="Write a note…"
          />
          <div className="note-editor-actions">
            <button onClick={saveNote}>Save</button>
            {saved && <span className="saved-note">Saved.</span>}
            <button className="danger" onClick={() => deleteNote(selectedId)}>
              Delete
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="notes-view">
      {error && <div className="error-banner">{error}</div>}

      <div className="notes-toolbar">
        <input
          className="notes-search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search notes…"
        />
        <button onClick={newNote}>+ New note</button>
      </div>

      {loading && notes.length === 0 && <div className="empty-state">Loading…</div>}
      {!loading && notes.length === 0 && <div className="empty-state">No notes yet.</div>}

      <ul className="notes-list">
        {notes.map((note) => (
          <li key={note.noteId} className="note-row" onClick={() => openNote(note.noteId)}>
            <span className="note-row-title">{note.title}</span>
            <button
              className="note-row-delete"
              title="Delete note"
              onClick={(e) => {
                e.stopPropagation();
                deleteNote(note.noteId);
              }}
            >
              &times;
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
