import { useState } from 'react';
import { callTool } from '../../api/client';
import NoteEditor from '../notes/NoteEditor';
import './CanvasPanel.css';

interface CanvasPanelProps {
  apiKey: string | null;
  noteId: string;
  /** Bumped once per completed chat turn (ChatView) so the panel re-fetches and shows the LLM's
   *  latest edit, unless the user has an unsaved local edit in progress (NoteEditor's own dirty
   *  guard handles that). */
  refreshToken: number;
  /** The active location's rendered image (endpoint.md §6.4) — the panel's location preview +
   *  re-render section. Null when the chat has no eligible rendered location image. definition
   *  is the location's logical definition (describer.md's "Definition:" half), shown under the
   *  name when present. */
  locationImage: { locationId: string; name: string; definition: string | null; imageUrl: string } | null;
  /** Called after a manual re-render completes (or fails) so ChatView can refresh its background
   *  layer and this panel's preview from the server. */
  onLocationImageChanged: () => void;
  onClose: () => void;
}

// Canvas: the split-screen document panel next to the Chat conversation (ChatGPT Canvas's own
// UX, not a fenced-code-block trick — see the plan this was built from). Which note to show is
// entirely server-decided (chat_sessions.canvas_note_id, set via a tool's focusHint) — this
// component just renders whatever note id it's handed.
//
// The location section above the note (endpoint.md §6.4) is the Vistalyze surface: previews the
// active location's rendered image and offers a manual re-render trigger. The trigger calls the
// regenerate_location_image tool (plugins/locations) — the same deterministic pass the post-turn
// trigger fires automatically, just invoked on demand so an admin can force a fresh render
// without waiting for a location edit.
export default function CanvasPanel({ apiKey, noteId, refreshToken, locationImage, onLocationImageChanged, onClose }: CanvasPanelProps) {
  // Tracked here (not owned) via NoteEditor's onContentChange — this panel never edits the note
  // itself, just needs the current text on hand for the copy button below.
  const [content, setContent] = useState('');
  const [copied, setCopied] = useState(false);
  const [rerendering, setRerendering] = useState(false);
  const [rerenderError, setRerenderError] = useState<string | null>(null);

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      return; // clipboard permission denied/unavailable — not worth an error banner
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function rerenderLocation() {
    if (!locationImage) return;
    setRerendering(true);
    setRerenderError(null);
    try {
      await callTool<{ ok: boolean }>('regenerate_location_image', { locationId: locationImage.locationId }, apiKey);
      onLocationImageChanged();
    } catch (err) {
      setRerenderError(err instanceof Error ? err.message : 're-render failed');
    } finally {
      setRerendering(false);
    }
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
      {locationImage && (
        <div className="canvas-panel-location">
          <div className="canvas-panel-location-name" title={locationImage.name}>
            {locationImage.name}
          </div>
          {locationImage.definition && (
            <div className="canvas-panel-location-definition" title={locationImage.definition}>
              {locationImage.definition}
            </div>
          )}
          <img
            className="canvas-panel-location-image"
            src={locationImage.imageUrl}
            alt={locationImage.name}
            onError={() => {
              // A broken preview is just the preview — drop it; the Chat View background's own
              // onError already notified the server to clear the stale URL (§5.2).
              onLocationImageChanged();
            }}
          />
          <button
            type="button"
            className="canvas-panel-location-rerender"
            onClick={rerenderLocation}
            disabled={rerendering}
          >
            {rerendering ? 'Rendering…' : 'Re-render image'}
          </button>
          {rerenderError && <div className="error-banner">{rerenderError}</div>}
        </div>
      )}
      <div className="canvas-panel-content">
        <NoteEditor apiKey={apiKey} noteId={noteId} refreshToken={refreshToken} onContentChange={setContent} />
      </div>
    </div>
  );
}
