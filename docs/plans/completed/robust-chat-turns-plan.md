# Robust Chat Turns — Draft Persistence + Server-Truth Reconciliation

*Prompted by a real mobile incident: the screen timed out mid-compose, the bounced-back error
("missing or unrecognized API key") turned out to be BigImagine's own household auth guard
(`handleChatCompletions.ts`'s `authenticate()` 401, unrelated to any LLM/image provider key), and
the typed message was unrecoverable because the composer's draft is plain React state with no
persistence. Chasing that surfaced a second, more serious gap while reading the actual turn
machinery.*

## Goal

Two independent robustness gaps, fixed together because the second was found while investigating
the first:

1. **Draft loss.** Typed-but-unsent composer text lives only in `ChatView.tsx`'s in-memory `draft`
   state. Any forced remount (a mobile browser reloading a backgrounded tab, a relogin) wipes it
   with no way to recover.
2. **No reliable "is a turn actually running" signal, and no guard against two running at once.**
   `GET /v1/chat/status` (`orchestrator/turnStatus.ts`) only reports which *tool* `loop.ts`'s
   `runTurn` is currently calling — it reads `null` between tool rounds and for the entirety of the
   RP streaming lane. It was never meant as a general in-flight signal, but it's the only one the
   client polls today. Worse: nothing server-side stops two overlapping turns from running on the
   same `chat_id` at once. If the client's local `sending` state is lost (backgrounding, reload) and
   the user sends again believing the first attempt didn't go through, both turns run concurrently
   and can genuinely corrupt the transcript — not just a display glitch.

Both fixes keep faith with `bi_principles.md` §1 (the canonical record lives on the server; anything
client-side is derived/disposable) and §4 (turn state is explicit, never inferred): the browser gets
to keep unsent text as pure local scratch, but "is a turn running" is always answered by asking the
server, never guessed from stale local state.

## Scope

- Client: `frontend/src/views/ChatView.tsx`, `frontend/src/App.tsx`, `frontend/src/api/client.ts`.
- Server: `orchestrator/src/server/handleChatCompletions.ts`, `orchestrator/src/server/handleChats.ts`
  (swipe/regenerate route), `orchestrator/src/server/handleTurnControl.ts`, and one new file,
  `orchestrator/src/orchestrator/interactiveTurnLock.ts`.
- Out of scope: Open WebUI's stateless traffic (no `chat_id`, untouched by the lock), and the
  cleanup subloop (`cleanupLoop.ts`) — it already has its own independent in-flight guard
  (`claimCleanupInFlight`/`releaseCleanupInFlight`) and must stay unaffected by this one.

## Background

- `draft` (`ChatView.tsx` ~L389) is a bare `useState('')`; nothing persists it. `send()` (~L1163)
  clears it on send but there's no path that restores it after a remount.
- Every tab already has a stable id that survives reload — `useTabs.ts`'s `TabInstance.id`,
  persisted via its own `bb_tabs` localStorage entry (`useTabs.ts`, `STORAGE_KEY`). `ChatView` isn't
  currently given this id as a prop, only `chatId` (which is `undefined` for a chat not yet created
  server-side — exactly the case most likely to lose a draft).
- `turnStatus.ts`'s own doc comment is explicit about its role: "a lost status on restart is fine,
  it's a still-thinking hint, not the canonical record" — it was designed as a UX nicety, not a
  concurrency signal, and shouldn't be stretched into one.
- `turnAbort.ts` is a `Map<taskId, Set<AbortController>>` that *does* span a chat's whole interactive
  turn reliably: `loop.ts`'s `runTurn` (~L177/204) and `streamingTurn.ts`'s `runStreamingRpTurn`
  (~L169/195) both `registerTurnAbort`/`unregisterTurnAbort` their own controller inside a top-level
  `try/finally`, for the full duration of generation — this pairing already has to be correct for the
  Stop button to work. But it isn't safe to reuse directly for a concurrency guard: the async cleanup
  subloop registers a *second*, independent controller under the same `chat_id` key
  (`handleChatCompletions.ts` ~L419-425) while repairing a prior turn, so "is this key present" would
  false-positive on routine background cleanup and block a legitimate new send.
- `handleChatCompletions.ts` is one large (~775-line) handler with two lanes (buffered `runTurn`,
  streaming `runStreamingRpTurn`) and several existing explicit-release patterns (e.g.
  `releaseLiveCleanupGuard()`) rather than one enclosing `try/finally` — there currently isn't a
  single choke point that spans "this endpoint is doing real generation work for this chat_id."
- `handleChats.ts`'s swipe route (`POST /v1/chats/:id/messages/:msgId/swipe`) is documented in its
  own preamble as deliberately mirroring `handleChatCompletions` ("send/swipe parity"). Only its
  `needs_regenerate` branch (direction `'next'` past the last stored variant) actually starts
  generation; plain prev/next cycling is a DB-only swap with no LLM call and must not be gated.

## Logic

### Step 1 — Draft persistence (client-only, additive, ships independently)

- Add `tabId: string` to `ChatViewProps`; pass `tabId={tab.id}` from both `<ChatView>` sites in
  `App.tsx` (~L247, ~L262).
- Key drafts as `bb_chat_draft:${tabId}`. Lazily initialize `draft` from
  `localStorage.getItem(draftKey) ?? ''`; write on change (short debounce, ~250ms is plenty for
  text); `localStorage.removeItem(draftKey)` alongside the existing `setDraft('')` in `send()`
  (~L1189).
- A deliberate tab close still drops its draft — that matches the existing documented intent in
  `App.tsx`'s tab comment ("closing a tab does unmount it... any local-only draft is gone"). Only an
  *involuntary* remount is being fixed here; no cleanup-on-close needed for the localStorage entry
  (negligible size).

### Step 2 — A real per-chat "turn active" signal (server)

New `orchestrator/src/orchestrator/interactiveTurnLock.ts`, matching `turnStatus.ts`/`turnAbort.ts`
in size and philosophy (in-memory, single-process, a lost entry on restart is fine):

```
beginInteractiveTurn(chatId): boolean   // false = already active (and not stale) — caller must not proceed
endInteractiveTurn(chatId): void
isInteractiveTurnActive(chatId): boolean
```

Backed by `Map<chatId, startedAt>`. `beginInteractiveTurn` reclaims an entry older than a generous
staleness ceiling (e.g. 10 minutes) rather than trusting every caller's `finally` to fire — the same
self-healing-hint stance `turnStatus.ts` already documents, extended so a missed release can never
permanently wedge a chat.

### Step 3 — Wire the lock into both turn-producing endpoints

- **`handleChatCompletions.ts`**: right after `taskId` is established (~L326), when `body.chat_id`
  is set, call `beginInteractiveTurn(body.chat_id)`. `false` → `sendJson(res, 409, { error: 'a turn
  is already in progress for this chat' })` and return, before any DB/LLM work. Wrap the rest of the
  function (both lanes) in `try { ...existing body, unchanged... } finally { endInteractiveTurn(body.chat_id) }`
  — a structural/indentation change only, no edits to the existing logic. `try/finally` covers every
  `return`/`throw` inside it, so no individual exit path needs to be hunted down. This is the most
  mechanically involved edit here; review it as indentation-only plus the two new lock calls at the
  boundaries.
- **`handleChats.ts`**: same `beginInteractiveTurn`/409-on-false/`finally { endInteractiveTurn }`
  wrapping, applied only to the `needs_regenerate` branch inside the swipe route (~L458+).

### Step 4 — Expose the signal

- `handleTurnControl.ts`'s `handleChatTurnStatus`: extend the response from `{ status }` to
  `{ status, active }`, `active = chatId ? isInteractiveTurnActive(chatId) : false`.
- `client.ts`'s `getChatTurnStatus`: return type becomes `{ status: string | null; active: boolean }`.
  Update its existing call site (~L1040, the per-second poll during a locally-initiated send).

### Step 5 — Client reconciliation on resume

In `ChatView.tsx`'s chat-load effect (~L602-639, already runs `getChat(chatId, apiKey)` whenever
`chatId` changes):

- After `getChat` resolves, call the status endpoint once. If `active` is true, enter a dedicated
  `resumingTurn` state (kept separate from `sending` so it doesn't disturb `send()`'s own guards):
  show the existing pending-bubble UI, disable the composer, poll on the same 1s interval
  `runChatTurn` already uses (~L1039) until `active` clears, then call the existing
  `refreshActiveMessages(chatId)` (the same one `send()` calls on completion) and clear
  `resumingTurn`.
- A resumed streaming (RP) turn has no live token stream to reattach to — the SSE connection
  belonged to the original request. Resumed view just shows "still generating…" and waits for
  `active` to clear, then shows the final persisted result via the refresh — the same degradation
  turn 1 already accepts today (never streamed live).
- Add a `document.addEventListener('visibilitychange', ...)`, guarded by the same
  `chatIdRef`/`activeChat?.chatId === chatId` pattern already used elsewhere in this file (e.g.
  `send()`'s post-turn refresh), so it only ever acts on the chat currently open in the currently
  visible tab. On regaining visibility, re-run the same active-check-and-reconcile logic — this is
  what directly answers "I check another tab and come back": the tab need not have been
  killed/reloaded for local polling to have gone stale, since mobile browsers throttle/pause timers
  in backgrounded tabs. This re-syncs against server truth on every return, not only on mount.
- In `send()`'s existing catch block (~L1222-1236, which already special-cases `ApiError` status
  `499`), add a `409` branch: instead of `setError(...)`, enter the same `resumingTurn`
  reconciliation flow — a 409 means another turn (most likely one this same client lost track of) is
  already running for this chat.

## Testing

- `orchestrator/scripts/verify-server.mjs` already exercises `/v1/chat/completions` and the swipe
  route end-to-end against a fake pool/LLM. Add a case that fires two overlapping completions for
  the same `chat_id` and asserts the second gets `409` while the first still succeeds, plus a case
  asserting `GET /v1/chat/status` reports `active: true` mid-turn and `false` after.
- Manual: start a long RP turn, background the tab (or switch app tabs) before it resolves, return,
  confirm the composer shows "still generating" rather than an idle input, and the reply lands once
  done. Force-reload the tab mid-turn and confirm the same recovery on reopen, plus that a draft
  typed into a fresh unsent chat reappears in the composer.
- `npm run build` (or the project's typecheck script) across both the `orchestrator` and `frontend`
  workspaces — check each workspace separately, not just one `tsc --noEmit` at the root.

## Implementation Notes

Land as two commits/checkpoints, not one:

1. Step 1 (draft persistence) is purely additive and client-only — zero risk to turn execution,
   ship and verify it alone first.
2. Steps 2-5 (the lock + reconciliation) touch the live turn path in both `handleChatCompletions.ts`
   and `handleChats.ts` — commit and push before starting this stage so there's a clean recovery
   point, then verify against `verify-server.mjs` before moving on to the client-side reconciliation
   work in `ChatView.tsx`.
