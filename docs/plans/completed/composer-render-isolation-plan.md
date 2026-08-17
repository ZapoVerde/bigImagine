# Composer render isolation — eliminate per-keystroke ChatView re-render

*For Reasonix to implement per `docs/roles.md`.*

## Context

`e2d4eda` ("chat: fix composer typing lag by memoizing message rows", 2026-08-15) fixed the
dominant cost of composer typing lag: before it, every keystroke re-rendered `ChatView` and
cascaded into every message in the history re-running its `ReactMarkdown` parse. Pulling message
rendering into `ChatMessageRow` (`React.memo`, stable ref-backed callback props) stopped that
cascade — a keystroke no longer re-parses markdown it doesn't need to.

It did not stop `ChatView` itself from re-rendering on every keystroke, because the composer's
`draft` text still lives in `ChatView`'s own state (`ChatView.tsx:413`). Per the fix's own comment
at `ChatView.tsx:1884`, that's by design — the fix's contract was "each row's memo check stays
cheap," not "typing doesn't touch the message list at all." Every keystroke still re-runs
`messages.map(...)` (`ChatView.tsx:2047`), allocating a fresh React element per message and having
React diff/memo-compare all of them against the previous render. That's O(n) in message count, once
per keystroke. On an ordinary chat it's imperceptible; on a really long RP chat (hundreds of turns —
the exact case this feature exists for) it's enough to be felt again, just at a higher message-count
threshold than before.

The complete fix is the same move `ChatMessageRow` already made, one level up: stop the
high-frequency state (composer keystrokes) from living in the same component as the large,
infrequently-changing tree (the message list). This plan pulls the composer's text input into its
own component that owns its own state, so a keystroke re-renders only that component — `ChatView`'s
render, and the `messages.map` pass, are no longer touched by typing at all.

## Goal

Move the composer draft's state and its `<textarea>` out of `ChatView` into a new
`ChatComposer` component, so typing in the composer no longer re-renders `ChatView` (and therefore
never re-runs `messages.map` or touches any `ChatMessageRow`). `ChatView` keeps everything it
actually needs reactively (the Send/Resend button's label, styling, and disabled state) via a
boolean that only changes on the empty/non-empty transition, not per keystroke.

## Files

- `frontend/src/components/chat/ChatComposer.tsx` — new. Owns the draft text state, its
  localStorage persistence, and the `<textarea>` itself. Mirrors `ChatMessageRow.tsx`'s shape and
  preamble style (dumb-ish module, but a genuine Stateful Owner of `draft` per `bi_principles.md`
  §8 — document it as such, not as a Pure Function).
- `frontend/src/views/ChatView.tsx` — modified. Removes `draft` state and its persistence effect
  (`ChatView.tsx:413-422`); removes the inline `<textarea>` (`ChatView.tsx:2205-2218`) in favor of
  `<ChatComposer>`; `send()` (`ChatView.tsx:1324`) and `resendMode()` (`ChatView.tsx:1113`) read the
  composer via the new ref/prop contract below instead of the old `draft` variable.

No other files change. `StagingBar`/`ImageStagingBar` and the `stagedFiles`/`stagedImages` state
stay exactly where they are — they change on attach/remove clicks, not per keystroke, and aren't
part of this cost.

## Logic

`ChatComposer` receives `tabId` (to derive the same `` `bb_chat_draft:${tabId}` `` localStorage key
used today) and `disabled` (wired to `resumingTurn`, same as today). It owns `draft` as local state,
lazily initialized from localStorage exactly as `ChatView` does today, and keeps the same
250ms-debounced write-through effect (write on non-empty, remove the key on empty) — that whole
block moves verbatim, just re-homed.

It renders exactly the `<textarea>` that exists today (same `value`/`onChange`/`placeholder`/
`rows={2}`/`autoFocus`/`disabled`), as its sole root element — no wrapping `div` — so it drops into
`ChatView`'s existing `<form className="chat-input">` in the exact position the bare `<textarea>`
occupies today, and the surrounding CSS (which targets the textarea structurally, not by its own
class) is unaffected.

The desktop Enter-to-send keydown handler moves into `ChatComposer` too, unchanged in behavior
(`e.key === 'Enter' && !e.shiftKey && window.innerWidth >= 768` → `e.preventDefault()`), but instead
of calling `send()` directly it calls an `onSend` prop — `ChatComposer` doesn't know what sending
means, only that Enter (desktop) requests it. Shift+Enter and all mobile Enter behavior are
untouched (default textarea newline).

`ChatComposer` tracks whether the trimmed draft is empty, and calls an `onEmptyChange(isEmpty:
boolean)` prop **only when that boolean actually flips** — not on every keystroke, not on every
render. This is the one piece of information `ChatView` still needs reactively (`resendMode()` and
the Send button's label/class/disabled state all currently branch on `!draft.trim()`), and it
changes at most twice per typing burst (empty→typing, typing→cleared) rather than once per
character.

`ChatView` exposes an imperative handle from `ChatComposer` (`useImperativeHandle` +
`forwardRef`) with two methods: `getValue()` (current draft, untrimmed) and `clear()` (resets draft
to `''`, which also removes the localStorage key via the existing effect's empty-string branch —
this replaces today's `setDraft(''); localStorage.removeItem(draftKey);` pair in `send()`).
`ChatView` holds a `composerRef` and:

- `send()` reads `composerRef.current.getValue().trim()` where it used to read `draft.trim()`, and
  calls `composerRef.current.clear()` where it used to call `setDraft(''); localStorage.removeItem(draftKey)`.
- `resendMode()` and the Send button's className/disabled/title/label all read a new
  `composerHasText` boolean state instead of `draft.trim()`. `composerHasText` is updated only by
  `ChatComposer`'s `onEmptyChange` callback (inverted — `onEmptyChange(isEmpty)` →
  `setComposerHasText(!isEmpty)`).
- `composerHasText`'s initial value is seeded with the same lazy localStorage read/trim check
  `ChatComposer` performs for its own initial `draft` (see Edge Cases) — a second, one-time,
  cheap read, not a shared source of truth.

## Contracts

`ChatComposer` props:
- `tabId: string` — required, used only to derive the localStorage key.
- `disabled: boolean` — required, wired to `resumingTurn`.
- `onSend: () => void` — called on desktop Enter (no other trigger; the Send button click and form
  submit stay wired to `ChatView`'s own `send`/`stopTurn`, unchanged).
- `onEmptyChange: (isEmpty: boolean) => void` — called only on a change of the trimmed-empty
  boolean, never on every keystroke.

`ChatComposer` imperative handle (ref type, export it as `ChatComposerHandle`):
- `getValue(): string` — current draft text, untrimmed.
- `clear(): void` — resets draft to `''` and removes the localStorage entry.

## Edge Cases

- **First-paint correctness.** `ChatComposer`'s `onEmptyChange` only fires from an effect/handler,
  which runs after the first render — if `ChatView`'s `composerHasText` defaulted to `false`, a
  chat reloaded with a persisted, non-empty draft in localStorage would flash "Send"/disabled for
  one frame before correcting to "Resend"/enabled. Avoid this by seeding `composerHasText`'s
  initial state in `ChatView` with the same lazy `localStorage.getItem(draftKey)` + trim check
  `ChatComposer` uses for its own initial `draft` value, so both start correct on the very first
  render. This is a one-time read, not a perf concern.
- **Whitespace-only draft.** Today, `!draft.trim()` treats a whitespace-only draft as empty for
  resend purposes. `ChatComposer`'s empty check must use `.trim().length === 0`, not
  `.length === 0`, so typing only spaces doesn't flip `onEmptyChange` and doesn't exit resend mode —
  matches current behavior exactly.
- **Unmount mid-debounce.** The moved persistence effect's existing `clearTimeout` cleanup already
  covers this; no new handling needed, just don't drop it in the move.
- **`editDraft` has the same latent issue, deliberately not fixed here.** `editDraft`
  (`ChatView.tsx`, used for in-place editing of an existing message) is a single shared string
  passed identically to every `ChatMessageRow` — while a user is actively editing an older message,
  every keystroke there changes a prop value on every row, breaking each row's memo bail-out the
  same way composer typing used to. It's a narrower trigger (only during an active edit, not normal
  typing) and a separate component boundary problem. Flagged here so it isn't mistaken for fixed by
  this plan; worth its own follow-up using the same isolation pattern if it turns out to matter in
  practice.

## Tests

- Typing a burst of characters into the composer does not re-render `ChatView`'s message list —
  assert `ChatMessageRow` instances render exactly once across N keystrokes (e.g. a render-count
  spy), on a chat seeded with enough messages that the old O(n) cost would be measurable.
- The Send/Resend button's label, styling, and disabled state flip at the correct
  empty/whitespace-only/non-empty transitions, matching today's `!draft.trim()` semantics exactly.
- `send()` picks up exactly the text present in the composer at the moment Send (or desktop Enter)
  is pressed, and both the visible textarea and localStorage are cleared afterward — a later
  remount does not resurrect a sent draft.
- A draft persisted in localStorage from an involuntary remount restores into the textarea on
  reload, and the Send/Resend button reflects it correctly on the very first render (no
  wrong-state flash).
- Desktop Enter still sends (≥768px width) and Shift+Enter still inserts a newline on both
  breakpoints; mobile Enter still inserts a newline rather than sending.

## Out of Scope

- The `editDraft` shared-state issue described above — a separate, narrower problem, not fixed by
  this plan.
- Virtualizing/windowing the message list itself. That's a further lever if a really long chat is
  still slow to scroll or paint even with zero composer-driven re-renders — a different bottleneck
  (raw DOM size) than the one this plan addresses (unnecessary reconciliation triggered by typing).
- `stagedFiles`/`stagedImages` (attachment staging) and the attach button — unrelated to per-
  keystroke cost, untouched.

## Principles / Conventions in Play

- `bi_principles.md` §8 (Four Kinds of Code) — `ChatComposer` is a Stateful Owner of `draft`, the
  sole place that state lives after this change; its preamble should say so explicitly, same as
  `ChatMessageRow.tsx`'s does for its own role.
- `bi_principles.md` §9 (Every Module is Self-Describing) / `conventions.md`'s Module Preamble —
  new file needs the standard preamble block, contract section included.
- `bi_principles.md` §10 (File Size) — `ChatComposer` is small (textarea + a handful of hooks);
  no split expected, but keep it under budget rather than growing send-adjacent logic into it later.
