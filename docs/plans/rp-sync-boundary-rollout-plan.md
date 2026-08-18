# Roll content above the sync point out of the RP chat window

*For Reasonix to implement per `docs/roles.md`.*

## Goal

An RP chat's cinematic window today renders the **entire** transcript verbatim with no
virtualization (`getChat` returns every `chat_messages` row; `ChatView.tsx` maps them all into
`ChatMessageRow`s). Past ~200 turns that is several hundred message DOM nodes per render, recomputed
every turn — the source of the observed lag — even though the rolling sync pipeline has already
consumed (chunked → `chat_chunks`, reported through the bridge → `scene`/`events`
`chat_memory_entries` and `canon_facts`) everything below the last closed sync point. This change
makes the window show only the live, un-synced tail by default, replace everything above the last
sync boundary with a compact boundary marker, and let the user push back up into the archived raw
transcript **one closed-sync page at a time**. Revealed history is re-collapsed automatically on the
next send, so browsing back never accumulates with the growing tail.

This is a **display change only**: the server continues to return the full message list and the
sync pipeline is untouched. The fix is bounded DOM, not data loss.

## Files

**Modified:**
- `frontend/src/views/ChatView.tsx` — the message render loop collapses the consumed region;
  add the boundary marker and the scroll-reveal (lazy-load) paging state.
- `frontend/src/components/chat/ChatMessageRow.tsx` — no functional change expected; the collapsed
  region and marker are new sibling elements, not new row types. Revisit only if rows need a
  `rolledOut` flag for styling (see Logic).
- `frontend/src/api/types.ts` — extend the `getChat` payload with the sync boundary (see Contracts),
  and the new pagination request shape if it rides the API.
- `frontend/src/api/client.ts` — plumb the new/documented fields through `getChat` (and any new
  fetch for a full page).
- `frontend/src/views/ChatView.css` — styles for the boundary marker / scroll-to-reveal hint and the
  revealed-page blocks (mobile-first per bi_principles.md §18).

**Possibly modified (implementation detail):**
- `orchestrator/src/io/chatSessions.ts` — `getChat`'s return gains the sync boundary; the closed
  sync-point list it needs is one small query the file already knows how to run (see
  `getChatSyncStatus`'s `syncRows` query, narrowed to the fields the client paging needs).
- `orchestrator/src/server/handleChats.ts` — no route change unless a new "fetch page N of a
  chat's archived transcript" endpoint is chosen over reusing the existing full payload (see Logic
  "Which messages the client already has").

No migration, no schema change. No change to `orchestrator/chatMemorySync.ts`, the sync pipeline,
or the LLM prompt stack (the model's view is unchanged — `trimToLiveWindow`/auto-recall stays as
is; this plan touches only what the *person* sees in the chat window).

> **Implemented as scroll-triggered lazy-load, not a button (user decision, post-plan).** The
> "push-up affordance / 'Show previous' control" described below was built instead as **autoload on
> scroll**: the boundary marker is a passive status strip observed by an `IntersectionObserver`
> rooted on the history container, and each time the reader scrolls up so the marker enters the
> visible region, the next-older archived page is revealed. One page per scroll-approach (no
> cascade — the observer fires only on viewport-entry transitions, and the inserted page above the
> marker pushes it back out of view). Everything else in this plan — the boundary definition, page
> spans derived from array indices, newest-first reveal, re-collapse on send, boundary-advance
> page drops, the uncapped `pages` payload — is unchanged. Where "control / affordance" appears
> below, read "lazy-load trigger"; the marker's "at the start" end-cap replaces the disabled state.

## Logic

### The boundary: what's "rolled out"

The **sync boundary** is the last *closed* sync point's `last_message_id`
(`chat_sync_points` row with `closed_at is not null`, highest `ordinal`). Every message at or
before that anchor is consumed by the pipeline; every message after it is the live, un-synced
tail. The same closed-only narrowing `getChatSyncStatus`/`findDueChats` already use (an eager
`closed_at is null` point is chunk-progress only, `docs/plans/eager-chunk-sync-plan.md`, never a
consolidation boundary) applies unchanged.

- **No sync point yet** (never-synced chat): no boundary; the whole transcript renders as today.
- **RP chats only.** A 'chat' lane has no scene/events/bridge and no reason to collapse; the
  rollout (and the boundary payload) is gated on `chat_sessions.kind = 'rp'`. A 'chat' chat renders
  exactly as it does today.

### Default render: live tail + boundary marker

`ChatView` maps messages as it does today, but when a boundary is present it renders:

1. A single **boundary marker** at the top of the visible stack: "Earlier in this story is archived
   (rolled into memory)" plus a passive **scroll-to-reveal** affordance (a "scroll up to keep
   showing previous turns" hint; see the Reveal section below for the lazy-load mechanism).
2. Only the messages **after** the boundary — the live, un-synced tail — *beneath* the marker, in
   order, with all existing row behavior intact (swipe/edit/selection/fork/delete all still work;
   none of those can touch a rolled-out message by construction, matching how the sync pipeline
   already owns consumed messages).

The default DOM therefore holds roughly `liveWindowPairs`–`syncEveryPairs` turns (~tens of
messages), not the whole history. This is the entire point (bounded DOM fixes the lag).

The rolled-out messages are **not removed from `messages` state** — they stay in the state array so
`lastAssistantIndex`/`lastUserIndex`, the tail placeholder during streaming, and the refresh after a
turn keep working. Only the *render* skips them. The boundary index is computed from the sync
boundary `messageId`.

### Reveal: page by sync point, on scroll

The lazy-load trigger reveals the archived region **one closed-sync page at a time**, newest-archived
page first, walking backward toward the chat's start — the same direction a reader scrolling up from
the live tail expects: whatever happened immediately before what's on screen comes first, and each
further scroll-up continues one step further back, in order, never jumping ahead to older content
while a more recent archived page is still hidden:

- **Page = one closed sync point's message span.** Each page's bounds are derived from its anchor's
  **position in the ordered `messages` array** (`messages.findIndex(m => m.messageId === anchor)`),
  never from comparing `messageId` values directly — `message_id` is a random `gen_random_uuid()`
  (`db/migrations/0009_chat_sessions.sql`), not a sortable/time-ordered id, so an id-value range
  comparison is meaningless. `getChat` already returns `messages` in the correct order (`order by
  created_at, message_id`, `chatSessions.ts:596`), so index position is the only ordering signal
  needed. Message at array index `i` belongs to page `n` when `i` falls after sync `n-1`'s anchor
  index (exclusive) and at-or-before sync `n`'s anchor index (inclusive); page 1 is the oldest
  sync's span, from the start of the chat (index 0) up to and including the oldest shipped sync's
  anchor. Each page is a block of original raw `ChatMessageRow`s, verbatim.
- **Each time the reader scrolls up so the marker becomes visible, one page is revealed — the newest
  not-yet-revealed sync, i.e. the one nearest the current
  top of the revealed stack (or nearest the boundary marker, on the first reveal)**; revealing
  again shows the next-older one, and so on, only reaching page 1 (the oldest sync, the true start of
  the chat) once every page has been revealed. This keeps the revealed region one contiguous,
  chronologically unbroken block at all times — never a newer page revealed while an older one
  between it and the boundary is still hidden. The revealed page(s) render above the boundary
  marker, and the boundary marker drops to the bottom of the revealed stack (below every revealed
  page, directly above the live tail) so "where the live tail resumes" stays obvious.
- **Lag stays bounded while browsing**: only the pages the reader has scrolled through are ever in the
  DOM. Browsing far back loads many pages, but that is on-demand and transient (matches the user's
  call: reveal-mode = page by sync point, content = raw archived transcript per page).
- **End-cap at the top** once page 1 is fully revealed and there are no more syncs: the marker's
  lazy-load trigger becomes inert and shows an "at the start of the story" end-cap — there is no
  content older than the chat's first sync (or the very start of the chat).

### Auto re-hide on send

The moment the user sends the next turn, all revealed pages re-collapse **and the boundary advances
if a new sync has landed** since the last render. Two triggers:

- **On send** (`submit` path in `ChatView`): reset `revealedSyncs` to `[]`. This is the explicit
  user-facing guarantee ("next turn hides it again") and is unconditional — it does not depend on a
  sync actually having run.
- **On refresh / boundary change**: when `getChat` returns a newer boundary than the one the client
  is holding (a background sync consolidated the just-sent turns), the boundary index moves up and
  the collapsed region grows; revealed pages whose span moved under the new boundary are dropped
  (they are consumed now). The live tail re-anchors to the new boundary. The displayed region never
  contains a message that a sync has consumed.

### Which messages the client already has, and whether a new fetch is needed

Two viable mechanisms; the plan prefers **reuse**, and Reasonix decides the exact call shape at
implemented time based on how `getChat` is actually consumed:

- **Preferred — reuse `getChat` + a full-messages boundary payload.** `getChat` already returns the
  whole ordered `messages` array. Add the sync boundary (list of `{ sync_id, last_message_id,
  ordinal, createdAt }` for the closed points needed to page, newest-first) to the `getChat`
  response. The client already holds every message in `messages` state, so a page render needs no
  second fetch — paging is pure local filtering by `messageId`. This keeps the DOM the single source
  and the server change minimal.
- **Alternative (only if the above proves awkward) — a dedicated `GET /v1/chats/:id/archived-pages`
  endpoint** returning the message id ranges per closed sync. Rejected as the default: it adds a
  route and lets the client's view of the transcript diverge from `messages` state for no benefit,
  because `getChat` already ships everything.

The boundary list ships **every** closed sync point, uncapped: at sync-every=8 pairs a chat that
has survived 200+ turns barely exceeds tens of sync points, and a few dozen small
`{syncId, lastMessageId, ordinal, createdAt}` objects is negligible next to a `getChat` response
that already ships the full transcript. A cap would directly break the "push up to the chat's
beginning" guarantee (Tests, Edge Cases) for exactly the long-lived chats this plan targets — the
oldest pages are the ones a cap would drop first, and there is no fallback fetch to recover them
(the dedicated-endpoint alternative above was rejected). No cap, no fallback needed.

### Refs and indexing

`lastAssistantIndex`/`lastUserIndex`, the streaming tail placeholder, and selection-mode
`toggleSelect` all index into the full `messages` array today. The rollout must not shift those
indices: the boundary collapse is a **render-time** concern only (the render loop walks the full
array and emits the marker before emitting rows whose index is past the boundary), so downstream
index-based logic sees an unchanged array. `ChatMessageRow` gets its real message index, unchanged.

## Contracts

`getChat` (`GET /v1/chats/:id`) — **response gains a field**; add `syncBoundary` to
`ChatDetail` (`frontend/src/api/types.ts`), present for 'rp' chats and absent (undefined) for
'chat' chats and for an 'rp' chat with no closed sync point yet:

```ts
ChatDetail {
  session: ChatSessionRow;
  messages: StoredChatMessage[];
  // NEW:
  syncBoundary?: {
    // The last closed sync point's anchor message id — everything at or before this is consumed.
    lastMessageId: string;
    // Every closed sync point, newest first, each carrying the anchor needed to derive its message
    // span (a page spans (previous anchor, this anchor]; page 1 = the oldest sync, from the chat
    // start). Uncapped — see "Which messages the client already has" for why.
    pages: { syncId: string; lastMessageId: string; ordinal: number; createdAt: string }[];
  };
}
```

The per-sync `lastMessageId` values are strictly increasing with `ordinal` (each sync's anchor moves
forward). A page's span is derived by **locating each anchor's index in the ordered `messages`
array** (`messages.findIndex`), then slicing between two consecutive anchors' indices — never by
comparing `messageId` values directly (message ids are random UUIDs, not ordered; `getChat` already
returns `messages` in the correct order via `order by created_at, message_id`, so index position is
the only ordering signal needed and no new field is required). If an anchor's `findIndex` returns
-1 (the message was truncated away — see Edge Cases), that page is dropped and the neighboring
page's bound falls back to the next surviving anchor (or index 0, for page 1). The client derives
the boundary message index and each page's message-index range purely from this array plus
`messages` state — **no new endpoint**.

## Edge Cases

- **No sync point / never-synced 'rp' chat** — no `syncBoundary`; render exactly as today (whole
  transcript, no marker). A brand-new chat or one that hasn't exceeded live+sync window yet.
- **'chat'-lane chat** — never gets `syncBoundary`; behavior unchanged.
- **An eager-only (open) sync point exists** — ignored for the rollout (mirror the closed-only
  narrowing); it is chunk progress, not a consolidation boundary.
- **Boundary advances between renders** (a background sync consolidates the just-sent tail) — on the
  next `getChat` refresh the boundary `lastMessageId` moves up; the live tail re-anchors and any
  revealed page whose new span fell under the boundary is dropped. The rendered window never shows a
  pane whose content a sync has already consumed.
- **Revealed pages are open and the user sends** — `revealedSyncs` resets to empty; the marker
  collapses to just the boundary marker above the (possibly grown) live tail. Exactly the stated
  guarantee.
- **Fork boundaries / truncate** — `chat_sync_points` cascades on message delete (0036); a
  truncated-away anchor simply no longer exists, so the boundary query sees the surviving highest
  closed point. For a `pages` entry the client already fetched before a truncate lands (e.g. a stale
  cache), `messages.findIndex` on that anchor returns -1 — the client drops that page from the
  revealable list and falls back its neighboring page's bound to the next surviving anchor (or index
  0 for page 1), so no orphaned page is ever offered.
- **Lag while browsing far back** — accepted and on-demand only, not the default; the default DOM
  is bounded (the whole point). No change to streaming/scroll-to-bottom behavior.
- **Existing scroll position / pendingInitialScroll jump** — unchanged, because the live tail is
  still the tail of the full array and the boundary marker renders above it; initial scroll still
  lands on the newest message.

## Tests

- `getChat` returns `syncBoundary` for an 'rp' chat with ≥1 closed sync point, and omits it for a
  'chat' chat and for an 'rp' chat with no closed point (fake-pool test where `getChatSyncStatus`'s
  closed-only query pattern is modeled).
- Frontend: with a boundary present, the render emits the marker plus only the live-tail rows (the
  rendered row count is `messages.length - boundaryIndex`), and `lastAssistantIndex`/
  `lastUserIndex` still resolve against the full array.
- Scrolling up to the marker reveals the previous sync's span; scrolling up again reveals the
  next-older span; the marker sits directly above the live tail; page id-ranges are correct
  (strictly increasing anchors → open-closed spans).
- Sending a turn resets `revealedSyncs` to empty (revealed pages vanish) and re-anchors to the
  (possibly advanced) boundary; a boundary advance drops a page whose span is now consumed.
- No sync point / 'chat' chat → no marker, full render (regression: existing RP/chat rendering
  unchanged).
- Manual in a long RP chat: default view = marker + bounded tail; scroll up page-by-page to the
  chat's beginning; send a reply → everything re-collapses; confirm no re-render lag regression on
  the default view, and that each scroll-approach of the marker reveals exactly one page (no
  cascade all the way to the chat's start).

## Out of Scope

- Changing the LLM prompt stack, `trimToLiveWindow`, auto-recall, or the sync pipeline — the
  model's context is already bounded and is deliberately untouched.
- Server-side deletion/truncation of archived messages — the raw transcript stays reachable on
  reveal; nothing is removed from the DB.
- Any 'chat'-lane behavior.
- New migrations / schema.
- Virtualization of the live tail itself, or of a fully-expanded history past what the user
  explicitly reveals — that would rewrite the render loop wholesale; the bounded-tail + explicit
  page reveal is the agreed, minimal fix.

## Principles / Conventions in Play

- bi_principles.md §1 (canonical record): rolled-out content is *displayed-derived* state, not
  removed; the DB stays canonical and the raw transcript remains reachable.
- bi_principles.md §5 (specialist views opt-in): the revealed archived history is an explicit,
  on-demand surface layered on the default cinematic view, never required to advance the story.
- bi_principles.md §11 (observability): a boundary that erroneously advances (hiding not-yet-
  consumed messages) would be a silent display failure; log the boundary index and any page-drop on
  boundary change.
- bi_principles.md §18 (mobile-first): the marker and its scroll-to-reveal hint are full-width and
  reflow at phone width — reveal is a natural scroll gesture, so there is no narrow tap target to
  tune (the plan's original "push-up affordance" was as much a tap target as the scroll fix allows).
- `docs/roles.md`: this is a `-plan.md` — it records the architectural/paging decision and is worth
  keeping after implementation (the reveal/paging model), so it stays in `docs/plans/` once done.
- Migration-append-only: no migration, nothing to bump.
