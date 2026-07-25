import { useEffect, useRef, useState } from 'react';
import { ApiError, callTool } from '../../api/client';
import type { NoteDetailResult } from '../../api/types';

interface NoteEditorProps {
  apiKey: string | null;
  noteId: string;
  /** Bumped by a caller (Canvas's panel, after each chat turn) to trigger a re-fetch — skipped
   *  while the user has unsaved local edits (dirty) so an in-progress edit is never clobbered by
   *  the LLM having moved on to touch the note again. NotesView doesn't pass this at all; a plain
   *  note-id change there is enough of a trigger on its own. */
  refreshToken?: number;
  /** Tells the caller to re-fetch anything that shows this note's title (a sidebar list). */
  onChanged?: () => void;
}

// The actual title/content editor, extracted out of NotesView so Canvas's panel (ChatView, via
// CanvasPanel.tsx) can reuse the exact same fetch/edit/save behavior instead of a second copy of
// it. get_note is the canonical source (bb_principles.md §1) — always fetched fresh on mount/id
// change, never trusted from anything the caller might already have in hand.
export default function NoteEditor({ apiKey, noteId, refreshToken, onChanged }: NoteEditorProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  function load() {
    setError(null);
    callTool<NoteDetailResult>('get_note', { note_id: noteId }, apiKey)
      .then((detail) => {
        if (!detail.found) {
          setNotFound(true);
          return;
        }
        setNotFound(false);
        setTitle(detail.title);
        setContent(detail.content);
        setDirty(false);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load note'));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  useEffect(() => {
    if (refreshToken === undefined) return;
    if (dirtyRef.current) return; // don't clobber an unsaved local edit
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  async function save() {
    setError(null);
    try {
      await callTool<NoteDetailResult>('update_note', { note_id: noteId, title, content }, apiKey);
      setDirty(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to save note');
    }
  }

  if (notFound) {
    return (
      <div className="note-editor">
        <div className="empty-state">This note no longer exists.</div>
      </div>
    );
  }

  return (
    <div className="note-editor">
      {error && <div className="error-banner">{error}</div>}
      <input
        className="note-title-input"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          setDirty(true);
        }}
        placeholder="Title"
      />
      <textarea
        className="note-content-input"
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setDirty(true);
        }}
        rows={16}
        placeholder="Write a note…"
      />
      <div className="note-editor-actions">
        <button onClick={save}>Save</button>
        {saved && <span className="saved-note">Saved.</span>}
      </div>
    </div>
  );
}
