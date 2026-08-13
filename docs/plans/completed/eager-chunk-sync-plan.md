# Eager Chat-Memory Chunking

*Spun out of `docs/plans/turn-loop-plan.md` §5 ("Step 6: count and trigger sync"), which restated
this rework without fully specifying it and left one blocking question open ("what marks a
`sync_id` closed"). That question sat unanswered long enough that step 6 was never picked up —
not superseded by anything else, just never made buildable. This doc answers it and is the
complete, standalone spec; `turn-loop-plan.md` now points here instead of carrying its own copy.*

## Goal

Today, `chatMemorySync.ts`'s 30-second poll tick does all of a due chat's chunking (splitting the
newly-eligible message run into fixed-size chunks, summarizing, and embedding each one) inside the
same transaction as the digest/bridge/curator LLM calls — a chat that's gone quiet for a while can
arrive at a tick with a large backlog of chunk work bunched into one pass. Move chunk creation
(`chunkChatTranscript.ts` + `classifyChatChunk.ts` + embedding) to run the moment enough new
messages exist to form a whole chunk — right after a turn persists — so that by the time the sync
tick actually runs, the chunk rows mostly already exist and the tick's own job shrinks to
consolidation (digest/bridge/curators). This is a cost/latency-smoothing change only: nothing
about *when* a turn becomes visible to recall or to the digest/bridge changes (see Logic).

## Background — the two questions this plan answers

`turn-loop-plan.md` flagged two things as needed before this was buildable, and got neither:

1. **Where does "a pair just exited the live window" get observed?** The live window is only
   computable today at sync time — `findDueChats`/`runOneChatSync` measure it from the last sync
   point's anchor message. Nothing observes it at write time. This plan's answer: hook the turn
   path itself (see Logic), not a new poll loop — the moment `appendMessages` commits a turn is
   already the one place message count grows, for both chat kinds.
2. **What marks a `sync_id` "closed" so the next chunk-exit event opens a fresh one?** This plan's
   answer: a new `closed_at` column on `chat_sync_points`. An eagerly-created sync point starts
   open (`closed_at is null`); the sync tick that eventually consolidates it closes it. See Logic
   and Contracts.

## Files

- `db/migrations/0098_chat_sync_points_closed_at.sql` — created — adds nullable
  `closed_at timestamptz` to `chat_sync_points`, then backfills: `update chat_sync_points set
  closed_at = created_at where closed_at is null`. The backfill is load-bearing, not cosmetic:
  every pre-existing sync point was created by the sync tick inside the same transaction as its
  consolidation (digest/bridge/curators, `chatMemorySync.ts`'s `runOneChatSync`), so all historical
  rows are semantically closed — left null, the first deploy after 0098 would read every chat as
  never-synced (closed-only `findDueChats`/`lastSynced` lose all anchors → full-history
  re-consolidation with duplicate canon-fact inserts), empty the Review Panel's `syncs` list, and
  make the plan's "at most one open sync point" invariant dead on arrival. No change to
  `last_message_id`'s existing `not null` constraint or its on-delete-cascade truncate-repair
  behavior (0036's own comment) — both apply unchanged to an open sync point, see Edge Cases.
- `orchestrator/src/orchestrator/eagerChunkSync.ts` — created — the eager chunk step: computes how
  many whole chunks are newly eligible for a chat, and if at least one is, chunks + summarizes +
  embeds them and writes them tied to that chat's open sync point (opening one if none exists).
  Sibling to `chatMemorySync.ts`, not folded into it — same one-purpose-per-file split
  `recallPlotLane.ts`/`recallFactLane.ts` already follow (`bi_principles.md` §10). Summarization is
  a real LLM call (`classifyChatChunk.ts`'s own contract: "impure, calls the LLM" —
  `chat_chunks.summary` is `not null`, so this is mandatory, not optional), so this file needs the
  same gated-provider construction `resolveSyncSettings` already does, and must run under
  `runWithCallContext` — see Logic and Contracts.
- `orchestrator/src/orchestrator/chatMemorySync.ts` — modified — `runOneChatSync`'s sync-point
  creation becomes reuse-or-create (an open sync point, if one exists, is reused and then closed);
  `findDueChats`'s and `runOneChatSync`'s own "last sync point" reads narrow to closed sync points
  only. See Contracts for the exact query-shape change.
- `orchestrator/src/io/chatSessions.ts` — modified in two places, both because `closed_at` is a
  real, load-bearing column now, not cosmetic:
  - `forkChat`'s branch-copy step (the block that copies `chat_sync_points` rows whose
    `last_message_id` was actually copied) currently inserts `chat_id, user_id, ordinal,
    last_message_id` explicitly, column by column — it must also carry `closed_at` over verbatim.
    Left unlisted, every copied sync point lands `closed_at null` regardless of its source state,
    silently reopening already-closed points on the branch.
  - `getChatMemorySyncStatus` (the Review Panel's per-chat read) has its own copy of the
    "unsynced" anchor query and its own per-sync summary list — both need the same closed-only
    narrowing `findDueChats` gets. See Contracts.
- `orchestrator/src/server/handleChatCompletions.ts` — modified — after a turn's messages are
  persisted via `appendMessages` (both chat kinds), fire `maybeEagerChunk` without awaiting it
  before the response is sent; errors are caught and logged inside the call itself, never surfaced
  to the client.
- `orchestrator/scripts/verify-chat-memory-sync.mjs` — modified — the fake pool's sync-point
  fixtures and queries gain `closed_at`; new branches for the reuse-or-create query and the
  closed-only "last sync point" reads (this codebase's known fake-pool-drift trap — matching
  branches are required, not optional, per this file's own past incidents).
- `orchestrator/scripts/verify-eager-chunk-sync.mjs` — created — the new module's own tests.

## Logic

**Trigger.** `handleChatCompletions.ts` is the main place a turn's messages get persisted via
`appendMessages` for both chat kinds (swipes/regenerates go through `recordSwipe`/
`recordSwipeIfContent` instead, which never change the chat's message count, so they're not a
trigger). `agentRoutineDispatch.ts` also calls `appendMessages` directly, for a linked chat's
wake-message turn, outside this hook — those turns simply miss the eager trigger and fall back to
the tick's own top-up, the same graceful degradation an app restart already causes (see Edge
Cases); not worth threading the hook through a second call site for. Immediately after
`appendMessages` commits in `handleChatCompletions.ts`, call `maybeEagerChunk(deps, userId, chatId)`
without awaiting it before the HTTP response is sent — this is the "increment a counter / check
due-ness" non-blocking shape `turn-loop-plan.md`'s own build-order note already called for. The
call catches and logs its own errors (`bi_principles.md` §11); nothing it does can fail or delay
the turn.

**Eligibility — two phases, cheap check before the lock, counted in turn-pairs with the greeting
folded into pair 1.** `maybeEagerChunk` derives its counts in the same units the sync tick's own
archive math uses — turn-pairs, not raw messages. It first does an unlocked, cheap pre-check:
current message count, the current `chat_memory_live_window_pairs` setting (live, no restart — same
read every sync tick already does), and how many *chunks* already exist for this chat (`select
count(*) from chat_chunks where chat_id = $1`, the exact same query `runOneChatSync`'s own chunk
step already uses to derive `startOrdinal` — reuse that convention rather than an "equivalent"
`max(ordinal)+1` derivation). That count is a chunk count, not a message count, and it plays two
distinct roles off the same query: `startOrdinal` (the ordinal base, used as-is) and
`alreadyChunkedPairs = count(*) * pairsPerChunk` (with `pairsPerChunk = MESSAGES_PER_CHUNK / 2`) —
the value that actually belongs in the eligibility formula below; the two roles share one query but
are not interchangeable numbers. The eligible-but-unchunked span is `max(0, turnCount −
liveWindowPairs − alreadyChunkedPairs)` — the floor at zero matters: a truncate/rerun can shrink
`turnCount` below `liveWindowPairs + alreadyChunkedPairs` when messages are removed from the
live-window tail without touching anything already chunked (see Edge Cases), and the arithmetic must
not go negative. If `floor(eligiblePairs / pairsPerChunk)` is zero (the common case — most turns
add one user + one assistant message, half of one chunk), return immediately: no lock taken, no
chunk, no sync point touched. Only when the pre-check finds at least one whole chunk eligible does
the call proceed to the locked phase below, which re-derives the same counts under the lock as the
authoritative check (guarding the race where a concurrent eager call or sync tick for the same chat
changed the counts between the pre-check and the lock). Whichever count wins, chunk exactly
`floor(eligiblePairs / pairsPerChunk)` whole 2-pair chunks, continuing `chunkChatTranscript`'s
ordinal numbering from `startOrdinal`, same "never chunk a trailing partial group" contract that
function already has.

**The seeded greeting is folded into turn pair 1 — never its own turn, pair, chunk, or live-window
slot.** `applyCharacterToChatTool.ts` seeds a new chat with a lone leading `assistant` message (the
greeting) that has no user turn of its own, detected purely by role/position (first message,
assistant, no prior user message — the same detection `handleChats.ts`'s rerun logic and
`findTurnBoundaries` already use). `findTurnBoundaries` — the very function the tick's archive math
runs — never marks a boundary on it, so it rides along inside turn 1 (`chatMemorySync.ts:320-321`).
The eager path derives `turnCount` the same way, through `findTurnBoundaries`: turn 1's span is
`[greeting?, user, assistant]`, the greeting contributes zero turns and zero live-window pairs. In
every case that exists today (each turn is exactly one user + one assistant message,
`chunkChatTranscript.ts`'s own stated assumption), this turn-pair formula is numerically identical
to the naive `totalMessages − liveWindowMessages − alreadyChunkedMessages` form — the greeting's +1
message sits at the front, ahead of everything the formula measures, so it cancels — but it is
defined in the tick's own units, so a greeting can never push the eager boundary ahead of or behind
the tick's turn-aligned boundary, and the formula survives unchanged if a future "continue"
affordance ever lets a turn span more than two messages. Two consequences are deliberate and match
today: the first chunk in a greeting chat is `[greeting, u1, a1, u2]` — the greeting shares a chunk
with turn pair 1, which is what `chunkChatTranscript`'s raw 4-message grouping from message 0
already produces, so this plan does not change chunk content boundaries — and a greeting chat's
archived span is `1 + 4m` messages, so the trailing assistant message of each archived block is not
chunked, exactly as today, in both paths alike.

**Summarization runs the gated LLM, under the same call context the tick uses.** Once there's at
least one chunk to write, `maybeEagerChunk` resolves the chunk-summary connection exactly the way
`resolveSyncSettings` does today (`chat_memory_profile` → `createLlmProviderForProfile` +
`createGatedLlmProvider`, falling back to the household's active connection when unset) and calls
`summarizeChatChunk(llm, chunk.content, chunkSummaryPrompt)` per chunk, then embeds content and
summary exactly as the tick's own `summarize_embed` step does. The whole call runs inside
`runWithCallContext({ taskId: chatId, kind: 'system', userId }, ...)` — the same wrapper
`runOneChatSync` uses — so `bi_principles.md` §14's gate sees this as a real, accounted-for LLM
call, not an ungated one slipping in through a new path.

**Sync-point lifecycle.** Take the same per-chat `pg_advisory_xact_lock(hashtext(chatId))`
`runOneChatSync` already takes, as the first statement of the locked phase, so an eager call and a
concurrently-running sync tick for the same chat can never race on what follows. Look up this
chat's open sync point (`chat_sync_points` row with `closed_at is null` — at most one can exist by
construction, since only this reuse-or-create path and the tick's own fallback ever create one,
and both take the same lock first). If none exists, insert one (next `ordinal`, `closed_at` null).
Insert the new `chat_chunks` rows tied to that `sync_id`, and update the sync point's
`last_message_id` to the last message the newly-chunked span covers — this update only ever runs
when at least one chunk was actually produced this call (the eligibility check above already
guarantees that), which matters because `chat_sync_points` also carries `unique (chat_id,
last_message_id)` (0036): writing it on a genuine no-op call would risk writing the same value
twice. The update satisfies `last_message_id`'s existing `not null` constraint and keeps the
existing truncate-cascade self-healing working unchanged for an open sync point exactly as it
already does for a closed one (see Edge Cases).

**What the sync tick does differently.** `runOneChatSync`, under the same advisory lock it already
takes first, looks for this chat's open sync point instead of unconditionally minting a new one.
If found, two things change from today, both required together:
1. The tick's own chunking step must slice its `toArchive` transcript starting *after* the open
   sync point's own `last_message_id`, not from the last *closed* sync point's anchor the way
   `lastSyncedIdx` is computed today. Feeding the unnarrowed full span into `chunkChatTranscript`
   would re-chunk messages eager chunking already covered — `unique (chat_id, ordinal)` only stops
   two rows from sharing an ordinal, it does nothing to stop two *different* ordinals from
   duplicating the same message content. The tick's chunking step is therefore a real top-up
   (covering only whatever ordinals the open point's chunks don't yet reach), not a no-op rerun of
   the whole span.
2. Before setting `closed_at = now()`, the tick must update the (possibly just-reused) sync
   point's `last_message_id` to *this tick's own* `archiveEnd` — the consolidation boundary the
   digest/bridge/curators actually processed — not leave it at whatever eager chunking last wrote,
   which can be earlier than `archiveEnd` in the top-up case. This is the only place a *closed*
   sync point's `last_message_id` gets its "consolidation boundary" meaning; skipping this step
   would leave the closed point's anchor short, and the next `findDueChats`/`lastSynced`
   (closed-only) read would re-include already-consolidated messages in the following tick's
   `toArchive`, double-processing them through the digest/bridge/curators.

Reusing the sync point and closing it this way is the "next chunk-exit event opens a fresh one"
behavior the original plan asked for — the next eager call, finding no open sync point, opens a
new one. If no open sync point exists (eager chunking never fired, or hasn't fired since the last
tick closed one), behavior is byte-identical to today: create the sync point fresh, inline, and
chunk the full span exactly as now.

**What does not change.** `last_message_id` on a *closed* sync point still means exactly what it
means today — the digest/bridge/curator consolidation boundary — and only the sync tick ever
writes it in that capacity (an open sync point's `last_message_id` only ever reflects chunking
progress, not consolidation progress, and never gets read by `findDueChats`, see Contracts). RAG/
digest visibility stays gated on the sync tick exactly as before — this plan only changes when the
chunk rows underneath that boundary get created, never what's visible or when.

## Contracts

- `chat_sync_points.closed_at timestamptz null` (migration 0098) — null means open (chunk-only,
  not yet consolidated); non-null is the existing "this sync tick fully processed this block"
  state, now made explicit instead of implicit-by-existence.
- `findDueChats`'s "last sync point" subquery (`chatMemorySync.ts`, currently `sp.ordinal =
  (select max(ordinal) from chat_sync_points where chat_id = cs.chat_id)`) narrows to `... where
  chat_id = cs.chat_id and closed_at is not null`. An open sync point must never be treated as the
  due-check's anchor — otherwise a chat whose only sync point is eager-only would look "synced"
  for consolidation purposes when it isn't.
- `runOneChatSync`'s own `lastSynced` read (currently `select last_message_id, ordinal from
  chat_sync_points where chat_id = $1 order by ordinal desc limit 1`) gets the same `and closed_at
  is not null` filter, for the same reason — this is the query that computes `lastSyncedIdx`, the
  digest/bridge/curator eligibility boundary.
- `getChatMemorySyncStatus`'s (`chatSessions.ts`) own copy of the same anchor logic — the
  `unsynced` count's `sp.ordinal = (select max(ordinal) from chat_sync_points where chat_id =
  m.chat_id)` subquery — gets the identical `and closed_at is not null` addition. This is a second,
  independent copy of `findDueChats`' query (not a shared function), so the two must be updated
  together or the Review Panel's "unsynced messages" figure disagrees with the tick's own due-check.
- `getChatMemorySyncStatus`'s per-sync summary list (the `syncs` array the panel renders) adds
  `and sp.closed_at is not null` to its own `where sp.chat_id = $1`, so an open, chunk-only sync
  point — which has no `chat_memory_entries`/`canon_facts` rows and would only show up as a
  zero-count noise row — never appears in the list. This keeps the panel showing exactly the same
  rows it shows today; see Out of Scope.
- `recallPlotLane.ts`'s arc-recency floor — the `select sync_id from chat_sync_points ... order by
  ordinal desc limit $3` subquery that picks the chat's most recent N syncs for its floor-arcs read
  — gets `and closed_at is not null` on the same `where user_id = $1 and chat_id = $2` clause. Left
  unfiltered, an eager-only open sync point (which has no `canon_facts` rows yet) consumes one of
  the floor's N slots, quietly shrinking arc recall visibility from N to N−1 real consolidated
  syncs — a real visibility change this plan's "visibility unchanged" claim must not silently make.
- `forkChat`'s branch-copy insert (`chatSessions.ts`) adds `closed_at` to both the source `select`
  and the destination `insert into chat_sync_points (...)` column lists, copied through unchanged —
  a closed source point stays closed on the branch; an open one (a normal state to fork from, given
  eager chunking can leave a point open for as long as the chat isn't yet due for its own tick)
  stays open on the branch too, and its already-copied chunks remain coherent under it.
- `maybeEagerChunk(deps: EagerChunkDeps, userId: string, chatId: string): Promise<void>` — never
  throws; internally catches and logs. `EagerChunkDeps` mirrors `ChatMemorySyncDeps` in full —
  `db`, `llm`, `embeddings`, `settings`, `llmConnections` — because chunk summarization is a
  mandatory, gated LLM call (`chat_chunks.summary` is `not null`; see Logic), not something this
  path can skip or stub out. Eligibility is derived in turn-pairs through `findTurnBoundaries`
  (seeded greeting folded into turn 1), never raw message counts — the tick's own archive math, in
  the eager path's units; see Logic.
- `chat_chunks` insertion stays exactly as today (`sync_id not null`, `unique (chat_id, ordinal)`)
  — no schema change to that table.
- `chat_sync_points` also carries `unique (chat_id, last_message_id)` (0036, pre-existing) — both
  the eager path's insert-or-update and the tick's own reuse-then-close update must only ever write
  `last_message_id` when the value is actually changing to a new message, which "only write it when
  ≥1 chunk was produced this call" (eager) and "always write it to the tick's own `archiveEnd`
  before closing" (tick) both already guarantee by construction.

## Edge Cases

- **App restart between a turn persisting and the eager call resolving.** No chunks get created
  early; the sync tick's existing fallback chunking path picks up the full backlog next time this
  chat is due, exactly as it does today. No data loss, no special-casing — this is the graceful
  degradation the "top-up" design in Logic already covers.
- **Two turns for the same chat complete in rapid succession**, each triggering an eager call
  before the first one finishes. The advisory lock serializes them; the second call re-reads the
  current chunked/message counts fresh under the lock, so it naturally computes whatever's newly
  eligible rather than double-chunking or racing on ordinal numbering.
- **A message that is an open sync point's `last_message_id` gets deleted** (edit/rerun truncating
  back past it, `io/chatSessions.ts`'s `truncateMessagesFrom`). The existing on-delete-cascade
  (0036's own documented mechanism) fires exactly as it does for a closed sync point today: the
  sync point row cascades away, and every `chat_chunks` row tied to it (the eagerly-created ones)
  cascades away too — no new code needed, this is inherited behavior, not a gap this plan opens.
- **The live window setting shrinks after some messages were already eagerly chunked under a
  larger window.** No special handling — eligibility is recomputed fresh from current settings and
  current counts on every call, so a shrink just makes more messages immediately eligible on the
  very next turn, the same self-correcting behavior the sync tick's own due-check already has.
- **A chat seeded with an opening greeting** (`applyCharacterToChatTool.ts`'s lone leading
  assistant message). Folded into turn pair 1 by the shared `findTurnBoundaries` rule (see Logic) —
  never a boundary of its own, so it can't be orphaned as its own chunk, miscounted as a
  live-window pair, or drift the eager boundary off the tick's turn-aligned boundary. The one
  lasting effect is pre-existing and unchanged: a greeting chat's archived span is `1 + 4m`
  messages, so the last assistant message of each archived block is never chunked — true today in
  the tick, and this plan keeps it true in the eager path too (chunk content boundaries are
  deliberately not rewritten; see Out of Scope).
- **An open sync point and the arc-recency floor** (`recallPlotLane.ts`). The floor counts the
  chat's most recent N *closed* syncs (see Contracts); an open, chunk-only point never occupies a
  floor slot, so arc recall visibility is exactly what it is today at every point in the
  open-then-close cycle.
- **The sync tick fires for a chat whose open sync point's chunks don't cover the entire
  eligible-for-sync window** (a burst of turns outran eager chunking, or a trailing partial chunk
  sits just inside the boundary). The tick's own chunking step runs as a top-up under the same
  `sync_id`, sliced from the open point's own `last_message_id` forward (see Logic's "What the sync
  tick does differently") — additive by construction, never re-chunking content eager already
  covered.
- **A truncate/rerun removes messages from the live-window tail without touching anything already
  chunked** (the open sync point's `last_message_id` message survives). `alreadyChunkedPairs`
  stays the same but `turnCount` drops, which can push `turnCount − liveWindowPairs −
  alreadyChunkedPairs` negative — the `max(0, …)` floor in the Eligibility step exists exactly
  for this case, not just as defensive padding.
- **Household 'chat'-kind chats.** Eager chunking applies to both kinds unchanged — `chat_chunks`/
  `recall_chat_history` is explicitly the one lane `chatMemorySync.ts`'s own doc comment already
  calls out as kind-agnostic; no branch needed here either.
- **A chat with zero prior sync activity at all** (brand new chat, first time it crosses a whole
  chunk boundary). "Open sync point lookup finds none" and "insert a fresh one" is the same code
  path as every subsequent open-then-close cycle — no first-time special case.

## Tests

- A turn that brings a chat's turn count to exactly `liveWindowPairs + pairsPerChunk` (the live
  window plus one whole 2-pair chunk) triggers exactly one new chunk tied to a freshly-opened sync
  point (`closed_at` null); a turn that doesn't cross a whole-chunk boundary is a no-op (no chunk
  row, no sync point touched, no advisory-lock query even issued).
- A second eager call later in the same open window reuses the existing open sync point's
  `sync_id` rather than opening a second one; the sync point's `ordinal` stays the same across both
  calls.
- `runOneChatSync`: when an open sync point already exists for a due chat, the tick reuses its
  `sync_id` for the digest/bridge/curator writes and sets `closed_at`; when none exists, behavior
  (including which `sync_id` ends up on the resulting `chat_memory_entries`/`canon_facts` rows) is
  byte-identical to today's fresh-create path — a regression guard.
- `findDueChats`: a chat whose only sync point is open (never closed) is treated as due exactly as
  if it had no sync point at all — an open-only sync point must never suppress due-ness.
- Failure isolation: stub the embeddings provider (or `classifyChatChunk`) to throw inside
  `maybeEagerChunk` and assert `handleChatCompletions`'s HTTP response still completes normally and
  on time — the eager call's failure must never be observable to the client.
- Truncate cascade: extend the existing truncate-cascade test to cover deleting a message that is
  an *open* sync point's `last_message_id`, asserting the same cascade-cleanup as the existing
  closed-sync-point case; also cover a truncate that stops short of the open point's anchor (anchor
  survives) and assert eligibility never goes negative on the next eager call.
- Concurrency: two eager calls fired back-to-back for the same chat (simulating rapid turns) never
  produce two open sync points at once and never double-insert the same `(chat_id, ordinal)` pair.
- Top-up: a sync tick for a chat whose open sync point covers only part of the tick's eligible
  window inserts only the remaining chunks under the same `sync_id` — assert no two `chat_chunks`
  rows for the chat ever cover overlapping message content (not just that their ordinals differ).
- Reuse-then-close: a sync tick that reuses an open sync point writes `last_message_id` as its own
  `archiveEnd` (not the value eager last left it at) before setting `closed_at`; the following
  tick's `findDueChats`/`lastSynced` read anchors on that updated value, not the eager-progress one.
- LLM gate: `maybeEagerChunk`'s summarize call is asserted to run inside a `runWithCallContext`
  scope (e.g. via a spy/fake on `callContext`, mirroring however `chatMemorySync.ts`'s own tests
  already assert `kind: 'system'` gating) — proving §14 isn't silently bypassed by this new path.
- `chunksAdded` semantics: once eager chunking has kept a chat fully caught up, a due sync tick's
  `chunksAdded` is legitimately `0` (nothing left to top up) — assert this doesn't get treated as
  an error/skip; it's a valid `status: 'ok'` outcome with `chunksAdded: 0`.
- Eligibility units: a chat with 20 existing `chat_chunks` rows (40 turn-pairs' worth = 80 messages)
  and a live window of 8 pairs (16 messages) has exactly 2 eligible pairs (4 messages), not 64 — a
  regression case directly proving `count(*) * pairsPerChunk` (not the raw chunk count) feeds the
  formula.
- Greeting: a chat seeded with a lone leading assistant greeting has it folded into turn 1 — the
  greeting alone never triggers a chunk (no boundary, no live-window pair), the first chunk is
  `[greeting, u1, a1, u2]`, and at every turn count the eager path's chunk output (ordinals and
  content) is identical to what the tick's turn-boundary archive math produces for the same chat.
- `getChatMemorySyncStatus`: a chat with only an open sync point reports the same `unsyncedMessages`
  it would with no sync point at all, matching `findDueChats`'s own due-check; the panel's `syncs`
  list never includes an open (unclosed) sync point.
- `recallPlotLane`: a chat whose only sync point is open consumes none of the arc-recency floor's N
  slots — the floor's `sync_id` subquery excludes it, so floor coverage is identical to a chat
  with no open point at all.
- `forkChat`: branching a chat whose most recent sync point is still open copies that point with
  `closed_at` still null (not defaulted to closed or dropped), and the branch's own next eager/tick
  activity behaves exactly as it would have on the parent at that same point.

## Out of Scope

- Any change to what the digest/bridge/curators read, how often they run, or the due-check
  thresholds (`chat_memory_sync_every_pairs`/`chat_memory_live_window_pairs`) — unaffected; this
  plan only changes when the underlying chunk rows get created.
- Promoting `MESSAGES_PER_CHUNK` or any new eager-specific threshold to a setting — stays a plain
  constant, matching `chunkChatTranscript.ts`'s own "nothing yet needs it to vary" stance.
- Any kind-branch between 'chat' and 'rp' — none introduced, matching today's chunking step.
- Rewriting chunk content boundaries for greeting chats (e.g. a pair-aligned 5-message first chunk
  `[greeting + 2 full pairs]` so every chunk boundary lands on a turn boundary). `chunkChatTranscript`
  keeps its raw 4-message grouping: the greeting already shares the first chunk with turn pair 1,
  and re-boundarying would rewrite every existing chunk in every deployed greeting chat (re-embed +
  re-summarize history), a content change this cost-smoothing plan deliberately does not make.
- A UI affordance showing "N chunks pre-computed, waiting on next sync" — the Review Panel's
  existing sync-status surface is unaffected; this is a backend cost/latency change with no new
  visible state.
- Revisiting the "one turn = one user + one assistant message" assumption for a future "continue"
  affordance — inherited from `chunkChatTranscript.ts`, not this plan's problem to solve.

## Principles / Conventions in Play

- `bi_principles.md` §1 (Relational Store is Canonical) — `chat_chunks`/`chat_sync_points` remain
  the durable record either way; this plan changes only *when* rows get written, never what's
  written or what's visible.
- §8 (Four Kinds of Code) — `eagerChunkSync.ts` is an IO Wrapper (impure: Postgres, embeddings,
  and — via `classifyChatChunk.ts` — the gated LLM), the same category `chatMemorySync.ts`'s own
  chunking step already is; no new pure module needed since `chunkChatTranscript.ts`/
  `classifyChatChunk.ts` are reused unchanged.
- §10 (Size Budget) — a new file rather than growing `chatMemorySync.ts` further, the same split
  rationale `recallPlotLane.ts` documents for itself.
- §11 (Observability) — the fire-and-forget error path must log, not silently swallow, so a stuck
  or broken eager pass is visible without ever breaking a turn — the same fail-open contract every
  other chat-memory seam already has.
- §13 (Runtime Config Lives in the Database) — no new setting; the live-window/pairs values this
  reads are already DB-backed and read live, no restart, same as the sync tick's own reads.
- §14 (Every LLM Call Passes Through One Gate, Carrying a Task Id) — chunk summarization is a real,
  mandatory LLM call (see Logic), so `maybeEagerChunk` must build its provider through
  `createGatedLlmProvider` and run under `runWithCallContext` exactly like the sync tick does.
