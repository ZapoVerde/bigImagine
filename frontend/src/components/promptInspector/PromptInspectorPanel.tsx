import { useCallback, useEffect, useState } from 'react';
import { ApiError, getPromptPreview } from '../../api/client';
import { markerLabel } from '../../api/markerLabels';
import type { PromptPreview, PromptPreviewItem } from '../../api/types';
import './PromptInspectorPanel.css';

interface PromptInspectorPanelProps {
  apiKey: string | null;
  chatId: string;
  /** Bumped once per completed chat turn (ChatView) so the panel re-fetches and reflects the
   *  latest exchange — the preview is a live read of current chat state, never cached beyond one
   *  fetch (bi_principles.md §13's live-read guarantee applied to this surface too). */
  refreshToken: number;
  onClose: () => void;
}

// docs/bi_principles.md §11/§18: an 'rp' chat's next turn is assembled fresh, server-side, and
// nothing about it is normally visible except the reply it produced. This panel is the read-only
// window onto that assembly — the exact system-prompt stack (one item per marker/custom slot, in
// the order they're actually sent) plus the trimmed conversation history riding alongside it, each
// with a rough token estimate so a household member can see what's actually eating context.
export default function PromptInspectorPanel({ apiKey, chatId, refreshToken, onClose }: PromptInspectorPanelProps) {
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getPromptPreview(chatId, apiKey)
      .then(setPreview)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load prompt preview'))
      .finally(() => setLoading(false));
  }, [chatId, apiKey]);

  useEffect(() => {
    load();
  }, [load, refreshToken]);

  async function copyFullPrompt() {
    if (!preview) return;
    const full = [...preview.systemStack, ...preview.messages].map((i) => i.content).join('\n\n');
    try {
      await navigator.clipboard.writeText(full);
    } catch {
      return; // clipboard permission denied/unavailable — not worth an error banner
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="prompt-inspector-panel">
      <div className="prompt-inspector-header">
        <span className="prompt-inspector-title">Prompt Inspector</span>
        <div className="prompt-inspector-header-actions">
          <button type="button" className="prompt-inspector-refresh" title="Re-fetch the current prompt" onClick={load} disabled={loading}>
            ↻
          </button>
          <button
            type="button"
            className="prompt-inspector-copy"
            title="Copy the complete prompt as plain text"
            disabled={!preview}
            onClick={copyFullPrompt}
          >
            {copied ? 'Copied' : 'Copy all'}
          </button>
          <button type="button" className="prompt-inspector-close" title="Close prompt inspector" onClick={onClose}>
            &times;
          </button>
        </div>
      </div>

      <div className="prompt-inspector-content">
        {error && <div className="prompt-inspector-error">{error}</div>}
        {loading && !preview && <div className="prompt-inspector-loading">Loading…</div>}

        {preview && (
          <>
            <div className="prompt-inspector-stats">
              <span className="prompt-inspector-stats-total">{preview.totalEstimatedTokens.toLocaleString()} est. tokens</span>
              <span className="prompt-inspector-stats-secondary">{preview.totalChars.toLocaleString()} characters</span>
            </div>

            <PromptStackSection title="System Prompt" items={preview.systemStack} />
            <PromptStackSection title={`Conversation History — ${preview.messages.length} message${preview.messages.length === 1 ? '' : 's'}`} items={preview.messages} />
          </>
        )}
      </div>
    </div>
  );
}

function itemLabel(item: PromptPreviewItem): string {
  if (item.label) return item.label;
  if (item.markerKey) return markerLabel(item.markerKey);
  return item.role === 'user' ? 'User' : item.role === 'assistant' ? 'Assistant' : 'System';
}

// Every item defaults open (<details open>) — the point of this panel is reviewing the complete,
// literal text that goes out, not a summary of it. Collapsing one down is still one click away for
// scanning structure in a long stack.
function PromptStackSection({ title, items }: { title: string; items: PromptPreviewItem[] }) {
  const sectionTokens = items.reduce((sum, i) => sum + i.estimatedTokens, 0);
  return (
    <section className="prompt-inspector-section">
      <h3 className="prompt-inspector-section-title">
        <span>{title}</span>
        {items.length > 0 && <span className="prompt-inspector-section-tokens">{sectionTokens.toLocaleString()} tk</span>}
      </h3>
      {items.length === 0 && <p className="prompt-inspector-empty">Nothing here.</p>}
      {items.map((item, i) => (
        <details key={i} className="prompt-inspector-item" open>
          <summary>
            <span className="prompt-inspector-item-label">{itemLabel(item)}</span>
            <span className={`prompt-inspector-item-role prompt-inspector-item-role-${item.role}`}>{item.role}</span>
            <span className="prompt-inspector-item-tokens">
              {item.estimatedTokens.toLocaleString()} tk · {item.chars.toLocaleString()} ch
            </span>
          </summary>
          <pre className="prompt-inspector-item-content">{item.content}</pre>
        </details>
      ))}
    </section>
  );
}
