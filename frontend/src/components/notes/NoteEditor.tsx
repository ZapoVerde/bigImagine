import { useEffect, useRef, useState } from 'react';
import { ApiError, callTool } from '../../api/client';
import type { NoteDetailResult, NoteState } from '../../api/types';

function toDateInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

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
  const [state, setStateValue] = useState<NoteState>('active');
  const [reminderAt, setReminderAt] = useState<string | null>(null);
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
        setStateValue(detail.state);
        setReminderAt(detail.reminderAt);
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

  // state/reminder changes apply immediately (not gated behind the Save button above) — they're
  // metadata about the note, not edits to its content, same "explicit action, applied right away"
  // shape complete_list_item/togglePin-style controls use elsewhere in this app.
  async function setState(next: NoteState) {
    setError(null);
    try {
      await callTool<NoteDetailResult>('update_note', { note_id: noteId, state: next }, apiKey);
      setStateValue(next);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to update note');
    }
  }

  async function setReminder(value: string) {
    setError(null);
    try {
      await callTool<NoteDetailResult>('update_note', { note_id: noteId, reminder_at: value || null }, apiKey);
      setReminderAt(value || null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to update reminder');
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
      <div className="note-editor-meta">
        <button
          type="button"
          className={state === 'pinned' ? 'active' : ''}
          onClick={() => setState(state === 'pinned' ? 'active' : 'pinned')}
        >
          {state === 'pinned' ? '★ Pinned' : '☆ Pin'}
        </button>
        <button
          type="button"
          className={state === 'archived' ? 'active' : ''}
          onClick={() => setState(state === 'archived' ? 'active' : 'archived')}
        >
          {state === 'archived' ? 'Unarchive' : 'Archive'}
        </button>
        <label className="note-reminder">
          Remind me
          <input type="date" value={toDateInputValue(reminderAt)} onChange={(e) => setReminder(e.target.value)} />
        </label>
      </div>
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
