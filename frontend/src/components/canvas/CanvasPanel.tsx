import { useState } from 'react';
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
  // Tracked here (not owned) via NoteEditor's onContentChange — this panel never edits the note
  // itself, just needs the current text on hand for the copy button below.
  const [content, setContent] = useState('');
  const [copied, setCopied] = useState(false);

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      return; // clipboard permission denied/unavailable — not worth an error banner
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="canvas-panel">
      <div className="canvas-panel-header">
        <span className="canvas-panel-title">Canvas</span>
        <div className="canvas-panel-header-actions">
          <button
            className="canvas-panel-copy"
            title="Copy note content"
            disabled={!content}
            onClick={copyContent}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="canvas-panel-close" title="Close canvas" onClick={onClose}>
            &times;
          </button>
        </div>
      </div>
      <div className="canvas-panel-content">
        <NoteEditor apiKey={apiKey} noteId={noteId} refreshToken={refreshToken} onContentChange={setContent} />
      </div>
    </div>
  );
}
