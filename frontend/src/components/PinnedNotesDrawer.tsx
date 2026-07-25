import { useEffect, useState } from 'react';
import { callTool } from '../api/client';
import type { NoteSummary } from '../api/types';
import NoteEditor from './notes/NoteEditor';
import './PinnedNotesDrawer.css';

interface PinnedNotesDrawerProps {
  apiKey: string | null;
}

// Tier 2 of the Landing Deck (docs/spec.md §5's addition): pinned notes (notes.state = 'pinned',
// db/migrations/0024_action_dates_priority.sql), collapsed to a summary header by default,
// expanding on click. Opening a note reuses NoteEditor directly rather than the Canvas mechanism
// the spec entry originally described — the landing state has no chat session yet (Canvas is a
// chat_sessions.canvas_note_id column), and NoteEditor is already the shared component built
// specifically so any surface can read/edit a note identically (components/notes/NoteEditor.tsx's
// own docstring), so reusing it here needed no new machinery at all. Renders nothing if there are
// no pinned notes — same "never block the picker, just disappear" spirit as TodayAgenda.
export default function PinnedNotesDrawer({ apiKey }: PinnedNotesDrawerProps) {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);

  function reload() {
    callTool<NoteSummary[]>('get_notes', { state: 'pinned' }, apiKey)
      .then(setNotes)
      .catch(() => setNotes([])); // best-effort widget — a failed fetch just hides the drawer
  }

  useEffect(reload, [apiKey]);

  if (!notes || notes.length === 0) return null;

  return (
    <div className="pinned-notes-drawer">
      <button type="button" className="pinned-notes-toggle" onClick={() => setExpanded((e) => !e)}>
        {expanded ? '▾' : '▸'} {notes.length} pinned note{notes.length === 1 ? '' : 's'}
      </button>
      {expanded && (
        <div className="pinned-notes-body">
          <ul className="pinned-notes-list">
            {notes.map((note) => (
              <li key={note.noteId}>
                <button
                  type="button"
                  className={openNoteId === note.noteId ? 'active' : ''}
                  onClick={() => setOpenNoteId(openNoteId === note.noteId ? null : note.noteId)}
                >
                  {note.title}
                </button>
              </li>
            ))}
          </ul>
          {openNoteId && (
            <div className="pinned-notes-editor">
              <NoteEditor
                apiKey={apiKey}
                noteId={openNoteId}
                onChanged={() => {
                  reload(); // a title edit or an unpin should update the list/summary right away
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
