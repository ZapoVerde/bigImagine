import NoteEditor from '../notes/NoteEditor';
import './CanvasPanel.css';

interface CanvasPanelProps {
  apiKey: string | null;
  noteId: string;
  /** Bumped once per completed chat turn (ChatView) so the panel re-fetches and shows the LLM's
   *  latest edit, unless the user has an unsaved local edit in progress (NoteEditor's own dirty
   *  guard handles that). */
  refreshToken: number;
  onClose: () => void;
}

// Canvas: the split-screen document panel next to the Chat conversation (ChatGPT Canvas's own
// UX, not a fenced-code-block trick — see the plan this was built from). Which note to show is
// entirely server-decided (chat_sessions.canvas_note_id, set via a tool's focusHint) — this
// component just renders whatever note id it's handed.
export default function CanvasPanel({ apiKey, noteId, refreshToken, onClose }: CanvasPanelProps) {
  return (
    <div className="canvas-panel">
      <div className="canvas-panel-header">
        <span className="canvas-panel-title">Canvas</span>
        <button className="canvas-panel-close" title="Close canvas" onClick={onClose}>
          &times;
        </button>
      </div>
      <div className="canvas-panel-content">
        <NoteEditor apiKey={apiKey} noteId={noteId} refreshToken={refreshToken} />
      </div>
    </div>
  );
}
