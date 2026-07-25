import NoteEditor from '../components/notes/NoteEditor';
import './NotesView.css';

interface NotesViewProps {
  apiKey: string | null;
  /** Which note to edit — picked (and created/deleted) in the sidebar's NotesBrowser. */
  selectedNoteId: string | null;
  /** Tells the sidebar to re-fetch titles after a save. */
  onChanged: () => void;
}

// Detail/editor half of the notes master-detail split — browsing, search, create, and delete all
// live in the sidebar's NotesBrowser now. The actual title/content editor is NoteEditor
// (components/notes/), shared with Canvas's panel (ChatView's CanvasPanel) so both surfaces
// fetch/edit/save a note identically. Backed entirely by the notes plugin's tools via the generic
// callTool API, so anything done here is equally reachable by asking the LLM in chat.
export default function NotesView({ apiKey, selectedNoteId, onChanged }: NotesViewProps) {
  if (!selectedNoteId) {
    return (
      <div className="notes-view">
        <div className="empty-state">Pick a note from the sidebar, or create a new one.</div>
      </div>
    );
  }

  return (
    <div className="notes-view">
      <NoteEditor apiKey={apiKey} noteId={selectedNoteId} onChanged={onChanged} />
    </div>
  );
}
