import { useEffect, useState } from 'react';
import { ApiError, callTool } from '../api/client';
import type { NoteDetailResult } from '../api/types';
import './NotesView.css';

interface NotesViewProps {
  apiKey: string | null;
  /** Which note to edit — picked (and created/deleted) in the sidebar's NotesBrowser. */
  selectedNoteId: string | null;
  /** Tells the sidebar to re-fetch titles after a save. */
  onChanged: () => void;
}

// Detail/editor half of the notes master-detail split — browsing, search, create, and delete all
// live in the sidebar's NotesBrowser now. Backed entirely by the notes plugin's tools via the
// generic callTool API, so anything done here is equally reachable by asking the LLM in chat.
export default function NotesView({ apiKey, selectedNoteId, onChanged }: NotesViewProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!selectedNoteId) {
      setTitle('');
      setContent('');
      return;
    }
    setError(null);
    callTool<NoteDetailResult>('get_note', { note_id: selectedNoteId }, apiKey)
      .then((detail) => {
        if (!detail.found) {
          setError('note not found');
          return;
        }
        setTitle(detail.title);
        setContent(detail.content);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load note'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteId]);

  async function saveNote() {
    if (!selectedNoteId) return;
    setError(null);
    try {
      await callTool<NoteDetailResult>('update_note', { note_id: selectedNoteId, title, content }, apiKey);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to save note');
    }
  }

  if (!selectedNoteId) {
    return (
      <div className="notes-view">
        <div className="empty-state">Pick a note from the sidebar, or create a new one.</div>
      </div>
    );
  }

  return (
    <div className="notes-view">
      {error && <div className="error-banner">{error}</div>}
      <div className="note-editor">
        <input
          className="note-title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
        />
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
        </div>
      </div>
    </div>
  );
}
