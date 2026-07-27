import { useEffect, useRef, useState } from 'react';
import { ApiError, callTool } from '../../api/client';
import type {
  CreateCalendarEventResult,
  DeleteNoteResult,
  NoteDetailResult,
  NoteState,
  SaveDocumentResult,
} from '../../api/types';

function toDateInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

// Mirrors plugins/documents/src/chunkDocument.ts's CHUNK_CHAR_CAP (~750 tokens at the same
// ~4-chars/token heuristic, no tokenizer dependency anywhere in this repo) — past this size a
// note's single whole-note embedding stops meaningfully representing its content, while a
// document gets chunked per-section. That's the actual point a table (one row, one embedding)
// becomes the wrong shape, not an arbitrary word count.
const NOTE_TO_DOC_CHAR_THRESHOLD = 3000;

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
  const [converted, setConverted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [calendarStatus, setCalendarStatus] = useState<'added' | 'already' | null>(null);
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
    if (content.length > NOTE_TO_DOC_CHAR_THRESHOLD) {
      const saveAsDoc = window.confirm(
        "This note is getting long. For better search quality, save it as a document instead?\n\nOK — save as a document (this note will be removed)\nCancel — save it as a note anyway",
      );
      if (saveAsDoc) {
        await saveAsDocument();
        return;
      }
    }
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

  // Promotion, not a duplicate: once the document save succeeds, the note is deleted so the
  // content lives in exactly one place — same one-copy-of-the-truth reasoning as every other
  // canonical-record decision in this app, just crossing from Postgres-canonical (notes) to
  // git-canonical (documents) instead of staying within one table.
  async function saveAsDocument() {
    try {
      await callTool<SaveDocumentResult>(
        'save_document',
        { title: title.trim() || 'Untitled note', content_markdown: content },
        apiKey,
      );
      await callTool<DeleteNoteResult>('delete_note', { note_id: noteId }, apiKey);
      setConverted(true);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to save as a document');
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

  // Promotes the reminder to a real calendar event, linked back to this note (defaults to
  // visibility='private' via create_calendar_event's own linked-event default — see
  // db/migrations/0025_calendar_links_visibility.sql). One-directional: this note's reminderAt
  // stays the source of truth and is never kept in sync with the event created here afterward.
  // create_calendar_event is idempotent for a linked create (createCalendarEventTool.ts) — a
  // second click reuses the existing event (created: false) rather than duplicating it.
  async function addToCalendar() {
    if (!reminderAt) return;
    setError(null);
    try {
      const result = await callTool<CreateCalendarEventResult>(
        'create_calendar_event',
        { title, start_time: reminderAt, end_time: reminderAt, linked_note_id: noteId },
        apiKey,
      );
      setCalendarStatus(result.created ? 'added' : 'already');
      window.setTimeout(() => setCalendarStatus(null), 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to add to calendar');
    }
  }

  if (notFound) {
    return (
      <div className="note-editor">
        <div className="empty-state">This note no longer exists.</div>
      </div>
    );
  }

  if (converted) {
    return (
      <div className="note-editor">
        <div className="empty-state">Saved as a document — find it in Documents. This note has been removed.</div>
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
        {reminderAt && (
          <button type="button" onClick={addToCalendar}>
            {calendarStatus === 'added' ? 'Added ✓' : calendarStatus === 'already' ? 'Already on calendar' : '📅 Add to calendar'}
          </button>
        )}
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
