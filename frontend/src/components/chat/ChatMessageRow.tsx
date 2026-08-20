/**
 * @file frontend/src/components/chat/ChatMessageRow.tsx
 * @stamp 2026-08-15
 * @architectural-role dumb module (bi_principles.md §8) — pure presentational renderer, no data
 * loading, no state
 * @description
 * One bubble of ChatView's message history, pulled out of its messages.map so it can be
 * React.memo'd. ChatView re-renders on every composer keystroke (the draft textarea's state
 * lives there); without this split that cascaded into every message in the history re-running
 * its ReactMarkdown parse on every keystroke — worst on long RP chats, which is most of what's
 * on screen there. Renders the bubble itself (content + optional reasoning block, both through
 * the same sanitizing markdown pipeline) and its action row (swipe/rerun for the last assistant
 * reply, edit/fork/delete otherwise) — everything it needs arrives as props, all derivation
 * (isLastAssistant, shownReasoning, etc.) stays in ChatView.
 *
 * Memoization only pays off if those props stay referentially stable across a keystroke-driven
 * re-render: ChatView.tsx routes the callback props (onSwipe, onStartEdit, etc.) through
 * ref-backed stableXxx wrappers so their identity never changes, and precomputes the derived
 * booleans off a single O(n) pass instead of a fresh lookahead scan per message.
 *
 * @api-declaration
 * ChatMessageRow (default export, React.memo-wrapped) — props: ChatMessageRowProps below
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkQuotes from '../../lib/remarkQuotes';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { DisplayMessage } from '../../views/ChatView';
import { GitBranchIcon } from '../../views/ChatView';

interface ChatMessageRowProps {
  message: DisplayMessage;
  index: number;
  /** This is the newest assistant reply in the chat — gets the full swipe/rerun action bar
   *  instead of the plain edit/fork/delete row. */
  isLastAssistant: boolean;
  /** The user's own last message can be saved in place; earlier ones only offer branch-and-resend
   *  (see submitEdit's own doc in ChatView.tsx). */
  isLastUserMsg: boolean;
  /** A card's seeded greeting rather than an earlier LLM turn — Rerun must not offer to
   *  "regenerate" it the way a real reply would be. */
  isOpeningGreeting: boolean;
  selectionMode: boolean;
  selected: boolean;
  editing: boolean;
  editDraft: string;
  onEditDraftChange: (value: string) => void;
  onSubmitEdit: (inPlace: boolean) => void;
  onCancelEdit: () => void;
  sending: boolean;
  swipingId: string | null;
  actionsVisible: boolean;
  onToggleActions: (messageId: string | undefined) => void;
  onToggleSelect: (index: number) => void;
  onSwipe: (messageId: string, direction: 'prev' | 'next') => void;
  onStartEdit: (messageId: string, content: string) => void;
  onForkFrom: (messageId: string) => void;
  onRemoveMessage: (messageId: string) => void;
  onTruncateFrom: (messageId: string) => void;
  settled: boolean;
  /** Precomputed by ChatView: the live streaming buffer when this row is the in-flight turn's
   *  target, else this message's own persisted reasoning (or undefined — no block at all). */
  shownReasoning: string | undefined;
  reasoningLiveOpen: boolean;
}

// Pulled out of ChatView's messages.map so it can be React.memo'd: ChatView re-renders on every
// composer keystroke (the draft textarea's state lives there), and without this split that
// cascaded into every message in the history re-running its ReactMarkdown parse on every
// keystroke — worst on long RP chats, which is most of what's on screen there. Memoization only
// pays off if the props below stay referentially stable across a keystroke-driven re-render; see
// the stableSwipe/stableStartEdit/etc. ref-wrappers in ChatView.tsx that make that true for the
// callbacks, and the lastAssistantIndex/lastUserIndex useMemo that makes it true for the booleans.
function ChatMessageRow({
  message: m,
  index,
  isLastAssistant,
  isLastUserMsg,
  isOpeningGreeting,
  selectionMode,
  selected,
  editing,
  editDraft,
  onEditDraftChange,
  onSubmitEdit,
  onCancelEdit,
  sending,
  swipingId,
  actionsVisible,
  onToggleActions,
  onToggleSelect,
  onSwipe,
  onStartEdit,
  onForkFrom,
  onRemoveMessage,
  onTruncateFrom,
  settled,
  shownReasoning,
  reasoningLiveOpen,
}: ChatMessageRowProps) {
  const busy = sending || swipingId === m.messageId;
  const hasMoreSwipesAhead = m.swipes ? m.swipes.index < m.swipes.count - 1 : false;
  const hasPrevSwipe = !!m.swipes && m.swipes.index > 0;
  const hasNextSwipe = !!m.swipes && hasMoreSwipesAhead;
  const showCounter = !!m.swipes && m.swipes.count > 1;
  const showRerun = !isOpeningGreeting && !hasMoreSwipesAhead;

  return (
    <div
      className={`chat-message ${m.role}${editing ? ' editing' : ''}`}
      data-last-user-msg={isLastUserMsg || undefined}
    >
      {selectionMode && (
        <label className="chat-select-box" title={m.role === 'user' ? 'Select this message and everything below it' : 'Select this reply and everything below it'}>
          <input
            type="checkbox"
            checked={selected}
            disabled={!m.messageId}
            onChange={() => onToggleSelect(index)}
          />
        </label>
      )}
      <div
        className={`chat-bubble ${m.role}${editing ? ' editing' : ''}${actionsVisible ? ' actions-visible' : ''}`}
        onClick={() => onToggleActions(m.messageId)}
      >
      {editing ? (
        <div className="message-edit">
          <textarea value={editDraft} onChange={(e) => onEditDraftChange(e.target.value)} rows={3} autoFocus />
          <div className="message-edit-actions">
            {m.role === 'assistant' || isLastUserMsg ? (
              <button onClick={() => onSubmitEdit(true)} disabled={!editDraft.trim() || sending}>
                Save
              </button>
            ) : null}
            {m.role === 'user' ? (
              <button onClick={() => onSubmitEdit(false)} disabled={!editDraft.trim() || sending}>
                Save &amp; resend
              </button>
            ) : null}
            <button onClick={onCancelEdit}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          {/* Reasoning block (docs/plans/reasoning-blocks-plan.md): a first-class
              <details> sibling above the content — same SillyTavern-style "hidden text"
              idiom the raw markdown below already supports, applied to the model's
              thinking span instead of LLM-authored markdown. Rendered from the
              persisted field (collapsed, opened on demand) or the live in-flight
              buffer (open while streaming, collapsed once done). The text runs through
              the same sanitizing markdown pipeline as the content below — never raw
              HTML injection. */}
          {shownReasoning !== undefined && (
            <details className="mes_reasoning_details" open={reasoningLiveOpen}>
              <summary>Reasoning</summary>
              <div className="mes_reasoning">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks, remarkQuotes]}
                  remarkRehypeOptions={{ allowDangerousHtml: true }}
                  rehypePlugins={[rehypeRaw, [rehypeSanitize, defaultSchema]]}
                >
                  {shownReasoning}
                </ReactMarkdown>
              </div>
            </details>
          )}
          <div className="markdown-content">
            {/* allowDangerousHtml + rehypeRaw let literal HTML the LLM writes inline (chiefly
                <details>/<summary> spoiler blocks, SillyTavern-style "hidden text") parse into
                real elements instead of rendering as escaped text. rehypeSanitize runs right
                after with hast-util-sanitize's default (GitHub) schema, which strips anything
                not on its allowlist — script tags, event-handler attributes, iframes, etc. —
                so this never becomes a path for injected HTML/JS from message content (including
                tool/RAG output that ends up quoted back into a message) to execute. */}
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkBreaks, remarkQuotes]}
              remarkRehypeOptions={{ allowDangerousHtml: true }}
              rehypePlugins={[rehypeRaw, [rehypeSanitize, defaultSchema]]}
            >
              {/* resolvedContent is the display copy of a macro-bearing message (the
                  seeded greeting's {{user}} etc., resolved against the live persona on
                  the server); content stays verbatim and is what re-sends, so the
                  per-turn resolution stays fresh. */}
              {m.resolvedContent ?? m.content}
            </ReactMarkdown>
          </div>
          {m.messageId && !selectionMode &&
            (isLastAssistant && m.role === 'assistant' ? (
              <div className="last-chat-actions" onClick={(e) => e.stopPropagation()}>
                {!settled && hasPrevSwipe && (
                  <button
                    type="button"
                    className="last-chat-arrow"
                    title="Previous reply"
                    disabled={busy}
                    onClick={() => onSwipe(m.messageId!, 'prev')}
                  >
                    ‹
                  </button>
                )}
                {!settled && <button
                  type="button"
                  className="last-chat-icon"
                  title="Edit this reply — rewrite the text in place, the original stays one ‹ away"
                  disabled={busy}
                  onClick={() => onStartEdit(m.messageId!, m.content)}
                >
                  ✏️
                </button>}
                {!settled && showRerun && (
                  <button
                    type="button"
                    className="last-chat-icon"
                    title="Regenerate this reply"
                    disabled={busy}
                    onClick={() => onSwipe(m.messageId!, 'next')}
                  >
                    {swipingId === m.messageId ? '…' : '↻'}
                  </button>
                )}
                <button
                  type="button"
                  className="last-chat-icon"
                  title="Branch a new chat from this point, leaving this one untouched"
                  onClick={() => onForkFrom(m.messageId!)}
                >
                  <GitBranchIcon />
                </button>
                {!settled && (
                  <button type="button" className="last-chat-icon" title="Delete" onClick={() => onRemoveMessage(m.messageId!)}>
                    🗑
                  </button>
                )}
                {showCounter && (
                  <span className="last-chat-counter">
                    [{m.swipes!.index + 1}/{m.swipes!.count}]
                  </span>
                )}
                {!settled && hasNextSwipe && (
                  <button
                    type="button"
                    className="last-chat-arrow"
                    title="Next reply"
                    disabled={busy}
                    onClick={() => onSwipe(m.messageId!, 'next')}
                  >
                    ›
                  </button>
                )}
                {settled && <button type="button" className="last-chat-icon" title="Delete this and everything after" onClick={() => onTruncateFrom(m.messageId!)}>Delete from here</button>}
              </div>
            ) : (
              <div className="message-actions" onClick={(e) => e.stopPropagation()}>
                {!settled && <button onClick={() => onStartEdit(m.messageId!, m.content)}>Edit</button>}
                <button onClick={() => onForkFrom(m.messageId!)} title="Branch a new chat from this point, leaving this one untouched">
                  Fork from here
                </button>
                {settled ? (
                  <button onClick={() => onTruncateFrom(m.messageId!)}>Delete from here</button>
                ) : (
                  <button onClick={() => onRemoveMessage(m.messageId!)}>Delete</button>
                )}
              </div>
            ))}
        </>
      )}
      </div>
    </div>
  );
}

export default memo(ChatMessageRow);
