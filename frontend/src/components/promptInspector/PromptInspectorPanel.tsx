import { useCallback, useEffect, useState } from 'react';
import { parsePromptTagTree } from '@bigbrain/orchestrator/prompt-tag-tree';
import type { PromptTagSection } from '@bigbrain/orchestrator/prompt-tag-tree';
import { ApiError, getPromptPreview } from '../../api/client';
import { markerLabel } from '../../api/markerLabels';
import type { PromptPreview, PromptPreviewGroup, PromptPreviewItem } from '../../api/types';
import './PromptInspectorPanel.css';

interface PromptInspectorPanelProps {
  apiKey: string | null;
  chatId: string;
  /** Bumped once per completed chat turn (ChatView) so the panel re-fetches and reflects the
   *  latest exchange — the preview is a live read of current chat state, never cached beyond one
   *  fetch (bi_principles.md §13's live-read guarantee applied to this surface too). */
  refreshToken: number;
  /** Optional: when absent (the left-drawer mount), the × close button is hidden — the drawer
   *  collapses via its own arrow/FAB instead. */
  onClose?: () => void;
}

// docs/bi_principles.md §11/§18: an 'rp' chat's turn prompts are assembled fresh, server-side, and
// nothing about them is normally visible except the reply they produced. This panel is the
// read-only window onto them — one collapsible section per prompt the chat fired, in order: Main
// Prompt (the exact text the last turn sent — captured at send time server-side, io/promptTrace.ts
// kind 'main' — shown as a tag tree: grouped into collapsible sections by the author's own
// HTML-style tags via util/promptTagTree.ts, see docs/prompt-inspector-tag-tree.md), then each
// captured background prompt (cleanup pass, chat title generation, …) with its full actual text —
// and, when the trace captured one, the model's reply to that prompt (cleanup repair outputs are
// discarded the moment the cleaned text replaces them; the inspector is where they survive). Every
// block carries a rough token estimate so a household member can see what's actually eating
// context. ChatView bumps refreshToken once per completed turn, so the panel always shows the last
// turn that was sent.
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
    const full = preview.groups.flatMap((g) => g.items).map((i) => i.content).join('\n\n');
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
          {onClose && (
            <button type="button" className="prompt-inspector-close" title="Close prompt inspector" onClick={onClose}>
              &times;
            </button>
          )}
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

            {preview.groups.map((group, i) => (
              <PromptGroupSection key={`${group.kind}-${i}`} group={group} />
            ))}
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

// One collapsible section per prompt: the group title (Main Prompt / Cleanup Prompt / …), a
// "fired" badge when this is a captured prompt's actual sent text, and the prompt's text as
// collapsible blocks — plus, when the trace captured one, the model's reply as a block in the
// same style (labeled "Reply", role assistant). The Main Prompt — the full system stack plus the
// entire trimmed conversation history — is rendered as a TAG TREE: its sub-sections grouped by
// the author's own HTML-style tags, each a collapsible row with a token/char budget (the user's
// approved spec, docs/prompt-inspector-tag-tree.md). Matching is loss-tolerant: broken or
// unmatched tags are inert, and their text rolls up to the enclosing level — so the tree view is
// exactly the text the model saw, never a rearrangement. When no tags match at all, it degrades
// to a single collapsed "Complete prompt text" block, exactly as before the tree existed.
// Every other group keeps one item per header/slot/message, each defaulting open — those are
// short enough that reviewing the complete literal text inline is the point.
function PromptGroupSection({ group }: { group: PromptPreviewGroup }) {
  // Same ceil-of-total rule as the panel header's totalEstimatedTokens — sum the chars, then one
  // ceil — so section tokens always add up to exactly the header total (summing per-item ceils
  // would over-report by up to one token per item).
  const totalChars = group.items.reduce((sum, i) => sum + i.chars, 0);
  const sectionTokens = Math.ceil(totalChars / 4);
  return (
    <section className="prompt-inspector-section">
      <h3 className="prompt-inspector-section-title">
        <span>{group.title}</span>
        {group.captured && (
          <span className="prompt-inspector-captured" title="Actual text sent to the model during a turn">
            fired
          </span>
        )}
        {group.items.length > 0 && <span className="prompt-inspector-section-tokens">{sectionTokens.toLocaleString()} tk</span>}
      </h3>
      {group.items.length === 0 && <p className="prompt-inspector-empty">Nothing here.</p>}
      {group.kind === 'main' && group.items.length > 0 ? (
        // The whole main prompt as a tag tree — see MainPromptTree below.
        <MainPromptTree items={group.items} />
      ) : (
        group.items.map((item, i) => (
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
        ))
      )}
      {group.reply && (
        // The model's reply to this captured prompt — same collapsible block style as the prompt
        // items above, defaulting open like they do. Labeled "Reply" so it can't be mistaken for
        // a prompt item; its role badge is 'assistant'.
        <details className="prompt-inspector-item" open>
          <summary>
            <span className="prompt-inspector-item-label">Reply</span>
            <span className="prompt-inspector-item-role prompt-inspector-item-role-assistant">assistant</span>
            <span className="prompt-inspector-item-tokens">
              {group.reply.estimatedTokens.toLocaleString()} tk · {group.reply.chars.toLocaleString()} ch
            </span>
          </summary>
          <pre className="prompt-inspector-item-content">{group.reply.content}</pre>
        </details>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main Prompt tag tree (docs/prompt-inspector-tag-tree.md)
// ---------------------------------------------------------------------------

// The main prompt's items joined in send order — exactly the text the model saw — parsed into a
// display-only tag tree by orchestrator's util/promptTagTree.ts (pure, exported as
// @bigbrain/orchestrator/prompt-tag-tree). No tags matched → the same single collapsed block the
// panel showed before the tree existed. Tags matched → the tree: each section a collapsible row,
// collapsed by default, with its canonical tag name and its own token/char budget; text that
// belongs to no matched section (untagged preamble, history between tags, broken-tag leftovers)
// rolls up and renders as "untagged text" at the enclosing level — nothing is ever dropped.
function MainPromptTree({ items }: { items: PromptPreviewItem[] }) {
  const text = items.map((i) => i.content).join('\n\n');
  const tree = parsePromptTagTree(text);
  if (tree.children.length === 0) {
    const totalChars = items.reduce((sum, i) => sum + i.chars, 0);
    const sectionTokens = Math.ceil(totalChars / 4);
    return (
      <details className="prompt-inspector-item">
        <summary>
          <span className="prompt-inspector-item-label">Complete prompt text</span>
          <span className="prompt-inspector-item-tokens">
            {sectionTokens.toLocaleString()} tk · {totalChars.toLocaleString()} ch
          </span>
        </summary>
        <pre className="prompt-inspector-item-content">{text}</pre>
      </details>
    );
  }
  return <PromptTagTreeView tree={tree} text={text} />;
}

// A section's own text = everything inside its span that no child section owns (tags excluded).
// For the root that is the untagged preamble/trailing text; for a section it is the text between
// its open tag and its first child, between children, and after its last child. Slicing, never
// rewriting — walking every section in document order reproduces the source byte-for-byte.
function ownText(section: PromptTagSection, text: string): string {
  let out = '';
  let cursor = section.start;
  for (const child of section.children) {
    out += text.slice(cursor, child.start);
    cursor = child.end;
  }
  return out + text.slice(cursor, section.end);
}

// Total content chars for a section: own text + everything its children own. Sections are
// disjoint and cover the source exactly, so a section's chars always equal
// ownText.length + Σ child chars — the same sum the rendering shows.
function sectionChars(section: PromptTagSection, text: string): number {
  return ownText(section, text).length + section.children.reduce((sum, c) => sum + sectionChars(c, text), 0);
}

function PromptTagTreeView({ tree, text }: { tree: PromptTagSection; text: string }) {
  const own = ownText(tree, text);
  const hasOwn = own.trim().length > 0;
  return (
    <div className="prompt-inspector-tree">
      {hasOwn && (
        // Untagged text at the top level (the preset's --- preamble, history between tags, …):
        // rendered as a first-class collapsed block so no part of the sent text is hidden.
        <details className="prompt-inspector-tag">
          <summary>
            <span className="prompt-inspector-tag-name">untagged text</span>
            <span className="prompt-inspector-item-tokens">
              {Math.ceil(own.length / 4).toLocaleString()} tk · {own.length.toLocaleString()} ch
            </span>
          </summary>
          <pre className="prompt-inspector-tag-own">{own}</pre>
        </details>
      )}
      <div className="prompt-inspector-tag-children">
        {tree.children.map((child, i) => (
          <PromptTagSectionView key={i} section={child} text={text} />
        ))}
      </div>
    </div>
  );
}

function PromptTagSectionView({ section, text }: { section: PromptTagSection; text: string }) {
  const own = ownText(section, text);
  const chars = sectionChars(section, text);
  const tokens = Math.ceil(chars / 4);
  const hasOwn = own.trim().length > 0;
  const hasChildren = section.children.length > 0;
  if (!hasOwn && !hasChildren) {
    // Empty section (<a></a>) — nothing to expand; render as a plain row with its budget.
    return (
      <div className="prompt-inspector-tag prompt-inspector-tag-leaf">
        <span className="prompt-inspector-tag-name">{section.name}</span>
        <span className="prompt-inspector-item-tokens">{tokens.toLocaleString()} tk · {chars.toLocaleString()} ch</span>
      </div>
    );
  }
  return (
    <details className="prompt-inspector-tag">
      <summary>
        <span className="prompt-inspector-tag-name">{section.name}</span>
        {hasChildren && (
          <span className="prompt-inspector-tag-count">
            {section.children.length} section{section.children.length === 1 ? '' : 's'}
          </span>
        )}
        <span className="prompt-inspector-item-tokens">{tokens.toLocaleString()} tk · {chars.toLocaleString()} ch</span>
      </summary>
      {hasOwn && <pre className="prompt-inspector-tag-own">{own}</pre>}
      {hasChildren && (
        <div className="prompt-inspector-tag-children">
          {section.children.map((child, i) => (
            <PromptTagSectionView key={i} section={child} text={text} />
          ))}
        </div>
      )}
    </details>
  );
}
