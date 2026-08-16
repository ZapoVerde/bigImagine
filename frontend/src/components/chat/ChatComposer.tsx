/**
 * @file frontend/src/components/chat/ChatComposer.tsx
 * @stamp 2026-08-16
 * @architectural-role Stateful Owner (bi_principles.md §8) — sole owner of the composer draft
 * text and its localStorage persistence; dumb about what sending means
 * @description
 * The chat input textarea, pulled out of ChatView so composer keystrokes stop re-rendering the
 * message list. ChatView's draft state used to live on every keystroke inside the same component
 * as the messages.map pass (composer-render-isolation-plan.md); each keystroke re-rendered
 * ChatView, which re-ran messages.map and diffed every ChatMessageRow even though only the
 * textarea's value had changed. Here the draft is local state, so a keystroke re-renders only
 * this component — ChatView's render is not touched by typing at all.
 *
 * Everything ChatView still needs reactively (the Send/Resend button's label, styling, and
 * disabled state) is reduced to a single boolean, delivered via onEmptyChange only when the
 * trimmed-empty state actually flips (at most twice per typing burst, never per character).
 * Everything ChatView needs imperatively (send() reading the draft, clearing it) goes through
 * the ChatComposerHandle ref: getValue()/clear(). This module owns the draft; it knows nothing
 * about chats, turns, or resend — Enter-to-send just asks via onSend.
 *
 * @api-declaration
 * ChatComposer (default export, forwardRef) — props: ChatComposerProps below; the imperative
 *   handle (ChatComposerHandle, exported) exposes getValue() and clear()
 * ChatComposerHandle (type export) — getValue(): untrimmed draft text; clear(): reset to '' and
 *   remove the localStorage key immediately (does not wait out the debounce)
 *
 * @contract
 *   assertions:
 *     purity:          impure — owns state and writes localStorage
 *     state_ownership: [composer draft for this tab (bb_chat_draft:<tabId>)]
 *     external_io:     [localStorage (bb_chat_draft:<tabId>)]
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface ChatComposerHandle {
  /** Current draft text, untrimmed — send() trims at the call site. */
  getValue(): string;
  /** Reset the draft to '' and remove its localStorage entry immediately. */
  clear(): void;
}

interface ChatComposerProps {
  /** Stable per-tab id; derives the localStorage key exactly as ChatView used to. */
  tabId: string;
  /** Wired to resumingTurn — the composer is disabled while catching up to a turn this tab lost
   *  track of (typing into a conversation whose transcript is about to change under you is worse
   *  than waiting for the refresh). */
  disabled: boolean;
  /** Called on desktop Enter (≥768px, no Shift). Shift+Enter and all mobile Enter behavior stay
   *  the default textarea newline — untouched from ChatView's old inline handler. */
  onSend: () => void;
  /** Called ONLY when the trimmed-empty boolean flips — never per keystroke. Lets ChatView keep
   *  the Send/Resend button's label/styling/disabled state without subscribing to the draft. */
  onEmptyChange: (isEmpty: boolean) => void;
}

const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
  { tabId, disabled, onSend, onEmptyChange },
  ref,
) {
  // Robust-chat-turns plan: the composer's draft survives involuntary remounts (a mobile browser
  // reloading a backgrounded tab, a relogin) keyed by this tab's stable id — useTabs.ts persists
  // TabInstance.id in bb_tabs across reloads, so the key is stable exactly when the tab is. Pure
  // local scratch (bi_principles.md §1), never sent to the server. A deliberate tab close still
  // drops it (App.tsx's documented "closing a tab does unmount it... any local-only draft is
  // gone"); only the involuntary remount is being fixed here, so no cleanup-on-close is needed.
  const draftKey = `bb_chat_draft:${tabId}`;
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey) ?? '');
  // Mirror of the draft for the imperative handle: send() may fire at any time (Enter handler,
  // Send button click, form submit), and a ref read is immune to stale-closure ordering the way
  // a state read from the handler closure would not be. Updated in the same handler as setDraft,
  // so it is never more than one keystroke behind — actually current at every event boundary.
  const draftRef = useRef(draft);
  // Write-through on change with a short debounce (~250ms is plenty for text). clear() also
  // removes the key immediately alongside resetting the state so a sent draft can't resurrect
  // on a later remount.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (draft) localStorage.setItem(draftKey, draft);
      else localStorage.removeItem(draftKey);
    }, 250);
    return () => window.clearTimeout(t);
  }, [draft, draftKey]);

  // The one reactive signal ChatView still needs: trimmed-empty flips the Send/Resend button.
  // Primitive-deps effect — fires only when the boolean value actually changes, which at most
  // happens twice per typing burst (empty→typing, typing→cleared), never per character.
  const isEmpty = draft.trim().length === 0;
  useEffect(() => {
    onEmptyChange(isEmpty);
  }, [isEmpty, onEmptyChange]);

  useImperativeHandle(ref, () => ({
    getValue: () => draftRef.current,
    clear: () => {
      setDraft('');
      draftRef.current = '';
      // Robust-chat-turns plan: the sent draft must not resurrect from localStorage on a later
      // remount — remove the key alongside clearing the state (the debounced write-through effect
      // would clear it 250ms later anyway; doing it here makes the intent explicit and immediate).
      localStorage.removeItem(draftKey);
    },
  }), [draftKey]);

  return (
    <textarea
      value={draft}
      onChange={(e) => {
        draftRef.current = e.target.value;
        setDraft(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && window.innerWidth >= 768) {
          e.preventDefault();
          onSend();
        }
      }}
      placeholder="Message BigImagine…"
      rows={2}
      autoFocus
      disabled={disabled}
    />
  );
});

export default ChatComposer;
