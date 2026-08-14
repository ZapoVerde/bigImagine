# Turn-Order Lead-In Context for Recalled Chunks

*Follow-up to the full-content RAG lane once [chunk-size-resize-plan.md](chunk-size-resize-plan.md)
made chunk size live: a chunk pulled out by vector similarity reads out of context ("she said yes"
— yes to what?) because it's shown with nothing from just before it in the actual conversation, and
because `recallChunkLane.ts` returns chunks ordered by relevance, not by where they sit in the
chat. The user's fix: prepend the 1-3 chunks immediately before each retrieved chunk (each already
carries its own real summary once chunking runs at 1 turn-pair per chunk), deduped against
anything already retrieved or already used as another chunk's lead-in, with the whole result
ordered by position in the chat rather than by score.

Getting there safely surfaced a second, independent problem: `chat_chunks.ordinal` is an integer
assigned by `count(*)` at insert time, with no persisted relationship between a chunk and whatever
actually precedes it — correct today only because nothing has ever deleted a single `chat_chunks`
row (only a whole-chat cascade or the resize plan's full wipe-and-regenerate touch that table at
all). The user's explicit direction: don't build the lead-in feature on that inference — add a real
`parent_chunk_id` edge, and build the deletion path that will eventually need to exist (an admin
repair tool, a future per-chunk regenerate) so it relinks the chain and closes the ordinal gap
*before* the row disappears, never after.*

## Goal

1. Give `chat_chunks` an explicit, self-referencing `parent_chunk_id` — robust to gaps, not
   inferred from `ordinal` arithmetic.
2. Build `deleteChatChunk`, a safe single-row deletion primitive that rebuilds the parent chain and
   renumbers ordinals *before* the row is removed, never leaving a moment where the chain or
   sequence is broken.
3. Walk that chain at recall time to prepend up to `chat_memory_auto_recall_lead_in_chunks`
   preceding chunks' existing summaries to each retrieved chunk, deduped against the retrieved set
   and against each other, with the final chunk list — lead-ins and full chunks together — always
   ordered by `ordinal`, not by relevance score.

## Implementation Protocol — STOP after every step

This plan touches the live chat-memory schema and the live recall path end to end, same shape as
`chunk-size-resize-plan.md`. Work it **one step at a time**, and after EVERY completed step:

1. **STOP** — hand control back to the user with a short report of what the step changed.
2. **Check the cache status** — read the last entry of `/reasonix-home/stats/$(date +%F).jsonl`
   and report the current prompt total + hit rate.
3. **If the latest prompt total exceeds 120k tokens**, request/trigger compaction before continuing.

## Background — why `ordinal` alone isn't enough

`chatMemorySync.ts`'s chunking step computes the next chunk's starting number as
`count(*) from chat_chunks where chat_id = $1` (not `max(ordinal)+1`) — see
[chatMemorySync.ts:562-567](../../orchestrator/src/orchestrator/chatMemorySync.ts). This is safe
today only by accident of what the codebase happens not to do yet: the only two *deletion* paths
that exist today are a whole-chat cascade delete (the chat itself is gone, moot) and the resize
plan's full wipe-then-regenerate-from-ordinal-0 (self-consistent, since it always deletes and
recreates 100% of a chat's rows in one pass). The moment anything deletes a *subset* of a chat's
chunks — this plan's own `deleteChatChunk`, or any future repair/edit tool — `count(*)` undercounts
against `max(ordinal)`, and the next sync's insert either collides with the unique
`(chat_id, ordinal)` constraint or silently misnumbers. That's exactly the kind of seam
`bi_principles.md` §11 exists to catch before it corrupts anything, not after.

The migration lands `parent_chunk_id` and backfills existing rows once; keeping the chain true from
then on is a property of every INSERT, and there are exactly four today — the sync tick
(`chatMemorySync.ts`'s `insert_chunks` step), the eager path (`eagerChunkSync.ts`), the resize
backfill (`chatChunkResize.ts`), and `forkChat`'s chunk copy (`chatSessions.ts`). All four must
populate the new column, and this plan changes each one (see Files) — a migration alone would leave
every future chunk's parent NULL and silently flatten the chain, which is the exact failure mode
this plan exists to eliminate.

Forks are a real writer to keep honest, not a non-issue: `chatSessions.ts`'s `forkChat` copies the
parent's `chat_chunks` rows whose sync point falls at-or-before the fork point
([chatSessions.ts:1174-1185](../../orchestrator/src/io/chatSessions.ts)) under fresh `chunk_id`s
(`gen_random_uuid()` default) with their original ordinals. Because the eligible sync points form a
prefix, the copied ordinals stay contiguous, so the migration's one-shot backfill links them
correctly — but the fork's own INSERT must remap `parent_chunk_id` within the copied subset
(Files), or every forked chat's chain is flat from birth.

**The Postgres subtlety that makes "rebuild before delete" actually work.** A plain UPDATE that
shifts a contiguous run of unique values down by one (closing the ordinal gap) or that re-points a
`parent_chunk_id` to a value another row still momentarily holds can trip a *non-deferred* unique
constraint mid-statement, even though the transaction's final, committed state is perfectly valid —
the classic "swap two unique column values in one statement" problem. The fix is to mark both
`chat_chunks_chat_id_ordinal_key` (`unique (chat_id, ordinal)`, from `0037_chat_chunks.sql`) and the
new `parent_chunk_id` uniqueness `DEFERRABLE INITIALLY DEFERRED`, so Postgres checks them once at
commit instead of per row. Without this, `deleteChatChunk`'s relink-then-renumber-then-delete
sequence — the exact ordering the user asked for — throws a spurious duplicate-key error under
real data, not just in theory.

One consequence worth stating: `DEFERRABLE INITIALLY DEFERRED` applies to *every* transaction, not
just `deleteChatChunk`'s — the `(chat_id, ordinal)` uniqueness check moves from per-statement to
commit-time globally. That is benign here: nothing uses `ON CONFLICT` against it, and every writer
of `chat_chunks` already serializes on the per-chat advisory lock, so a genuine duplicate now fails
at commit instead of at the INSERT — still an error, still a full rollback, just later.

## Files

- `db/migrations/0100_chat_chunk_parent_and_lead_in.sql` — created —
  - `alter table chat_chunks add column parent_chunk_id uuid references chat_chunks(chunk_id) on
    delete set null;` — nullable; null means "first chunk in this chat."
  - `alter table chat_chunks add constraint chat_chunks_parent_unique unique (parent_chunk_id)
    deferrable initially deferred;` — enforces the linear-chain invariant (at most one child per
    parent) and makes the relink-before-delete sequence legal within one transaction.
  - `alter table chat_chunks alter constraint chat_chunks_chat_id_ordinal_key deferrable initially
    deferred;` (confirm the auto-generated constraint name via `\d chat_chunks` against the live DB
    before applying — drop/re-add by explicit name if it differs, same defensive shape 0099 already
    uses for the settings CHECK constraint) — same reason: `deleteChatChunk`'s ordinal renumber has
    to be legal mid-transaction, not just at the end.
  - Backfill: `update chat_chunks c set parent_chunk_id = p.chunk_id from chat_chunks p where
    p.chat_id = c.chat_id and p.ordinal = c.ordinal - 1;` — one statement, using today's still-
    trustworthy `ordinal` adjacency to seed the chain once. After this, the chain stands on its own;
    `ordinal` is never trusted for adjacency again.
  - Widens `orchestrator_settings_key_check` (rebuilt wholesale, complete list, same 0092/0099
    precedent) to add `chat_memory_auto_recall_lead_in_chunks` and
    `chat_memory_auto_recall_lead_in_prompt`.
  - Applied by hand, same as every migration in this repo:
    `docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0100_chat_chunk_parent_and_lead_in.sql`.
- `orchestrator/src/io/chatMemory/deleteChatChunk.ts` — created — IO Wrapper, no caller yet (built
  ahead of one deliberately, per the user's direction — the safe primitive exists before anything
  needs it, so nothing is ever tempted to `delete from chat_chunks where chunk_id = $1` directly).
  Exports `deleteChatChunk(session, userId, chatId, chunkId): Promise<void>`. See Logic for the
  exact sequencing.
- `orchestrator/src/io/chatMemory/chunkLeadIn.ts` — created — IO Wrapper. Exports
  `resolveLeadInRows(session, userId, chatId, chunkIds, leadInCount): Promise<LeadInRow[]>`
  (`LeadInRow = { chunkId: string; ordinal: number; summary: string }`) — one recursive-CTE query
  that walks every retrieved chunk's `parent_chunk_id` up to `leadInCount` hops, in one round trip,
  structurally excluding anything already in `chunkIds` and de-duplicating chunks reachable from
  more than one retrieved chunk's chain. See Logic.
- `orchestrator/src/orchestrator/chatMemorySync.ts` — modified — the `insert_chunks` step sets
  `parent_chunk_id` on every inserted chunk: the batch's first chunk links to the chat's current
  max-ordinal row (`select chunk_id ... order by ordinal desc limit 1` — null when the chat has no
  chunks yet), each subsequent chunk links to the previously inserted row of the batch. The step
  already runs inside the per-chat advisory lock, so the read-then-insert is race-free.
- `orchestrator/src/orchestrator/eagerChunkSync.ts` — modified — the same parent rule in its
  `insert into chat_chunks` loop, which likewise runs under the per-chat advisory lock.
- `orchestrator/src/orchestrator/chatChunkResize.ts` — modified — **this file is already built and
  deployed** (an earlier draft of this plan called it "not-yet-built"; it isn't — stamp
  2026-08-13, and migration 0099's `chat_chunk_resize_status` singleton is live). Its
  wipe-then-regenerate loop (`resizeOneChat`) re-inserts each row via plain inserts; it must set
  `parent_chunk_id` sequentially — chunk `i`'s parent is chunk `i-1` of the same pass, null for
  the first — by capturing each insert's `returning chunk_id`.
- `orchestrator/src/io/chatSessions.ts` — modified — `forkChat`'s chunk copy
  ([chatSessions.ts:1180](../../orchestrator/src/io/chatSessions.ts)) iterates the copied rows in
  `ordinal` order and sets each new chunk's `parent_chunk_id` to the previously copied row's fresh
  `chunk_id` (null for the first). The copied set is a contiguous prefix, so every non-first
  chunk's parent is itself copied — no orphan links.
- `orchestrator/src/io/chatMemory/recallChunkLane.ts` — modified — `ChunkRow` gains `chunkId:
  string` and `parentChunkId: string | null`; both SQL selects (content lane, header lane) add
  `chunk_id, parent_chunk_id` to their column lists. Nothing else in this file's fetch/fuse/blend/
  cutoff pipeline changes — the new columns just ride along.
- `orchestrator/src/io/chatMemory/recallForPrompt.ts` — modified — `buildAutoRecallParts` reads the
  new `chat_memory_auto_recall_lead_in_chunks` setting alongside its existing `Promise.all` batch
  (same parse-with-fallback-and-clamp shape as `chunkMin`/`chunkTopK`, fallback
  `DEFAULT_LEAD_IN_CHUNKS = 2`, clamped to `[0, MAX_LEAD_IN_CHUNKS = 3]`). After `recallChunkLane`
  returns, calls `resolveLeadInRows` (skipped entirely when the resolved count is `0`) and merges
  the lead-in rows into `chunks` — each lead-in row becomes a `ChunkRow`-shaped entry with
  `content: ''`, `isLeadIn: true`, then the combined array is sorted by `ordinal` ascending before
  being returned. This is the one place the merge happens, so every consumer of
  `AutoRecallParts.chunks` (the legacy `formatAutoRecallBlock` path and the real
  `RpMemoryContext.chunks` path — see below) gets the same ordered, lead-in-enriched list for free.
  `formatAutoRecallBlock` (the deprecated `memory_recall` alias) also updates: a lead-in entry
  renders as its summary alone (no `<memory>` wrapper), a full chunk renders exactly as it does
  today.
- `orchestrator/src/io/chatMemory/memoryInjection.ts` — modified — `ChunkRow` gains `isLeadIn?:
  boolean` (falsy for every existing call site, so nothing else changes shape). New
  `DEFAULT_AUTO_RECALL_LEAD_IN_PROMPT` constant (§17: a real, user-overridable template, not a
  hardcoded string) — a lighter wrapper than the full chunk template, since a lead-in entry only
  ever carries a summary: `[Just before: {{text}}]`. `renderAutoRecall` gains a `leadInTemplate`
  parameter and picks it over `chunkTemplate` per-entry based on `c.isLeadIn`, rendering `{{text}}`
  as `c.summary` (never `c.content`, which is empty for a lead-in row) for those entries.
- `orchestrator/src/server/promptAssembly.ts` — modified — `buildNarratorStackItems`'s existing
  settings `Promise.all` (around
  [promptAssembly.ts:274](../../orchestrator/src/server/promptAssembly.ts)) adds
  `settings.get('chat_memory_auto_recall_lead_in_prompt')`; the `auto_recall` field's
  `renderAutoRecall(...)` call at
  [promptAssembly.ts:337](../../orchestrator/src/server/promptAssembly.ts) passes it through as the
  new `leadInTemplate` argument.
- `orchestrator/src/io/orchestratorSettings.ts` — modified — `SETTING_NAMES` gains
  `chat_memory_auto_recall_lead_in_chunks` and `chat_memory_auto_recall_lead_in_prompt`. Without
  this the new keys are a TypeScript error: `SettingName` is the union over `SETTING_NAMES`, and
  `store.get`/`store.set` are typed against it.
- `orchestrator/src/server/adminServer.ts` — modified — `ChatMemorySettings` gains
  `autoRecallLeadInChunks: number | null` and `autoRecallLeadInPrompt` /
  `autoRecallLeadInPromptIsDefault`; `getChatMemorySettings` reads both;
  `SetChatMemorySettingsBody` / `parseSetChatMemorySettingsBody` / `setChatMemorySettings` accept
  and persist them (`auto_recall_lead_in_chunks` integer ≥ 0, `0` = feature off;
  `auto_recall_lead_in_prompt` string, empty clears to the built-in default — the §17 contract).
- `orchestrator/src/server/handleAdminDisplaySettings.ts` — modified — the 400 error message's key
  enumeration and `parseSetChatMemorySettingsBody`'s all-undefined guard include the two new keys.
- `frontend/src/api/types.ts` / `frontend/src/api/client.ts` / `frontend/src/views/RagView.tsx` —
  modified — `chat_memory_auto_recall_lead_in_chunks` (a plain number field, "Lead-in chunks",
  0-3) and `chat_memory_auto_recall_lead_in_prompt` (a textarea alongside `autoRecallChunkPrompt`)
  join `RagView`'s existing bulk `saveRetrievalSettings` diff-and-patch — read-time-only knobs like
  the ~15 others already batched there, unlike `chunk_pairs`'s dedicated save path (no backfill
  cost here, nothing to warn about).

## Logic

**`deleteChatChunk`'s sequencing — parent and ordinal rebuilt before the row is gone, in one
transaction:**

1. `select pg_advisory_xact_lock(hashtext($1))` on `chatId` — the same per-chat lock
   `runOneChatSync`/`maybeEagerChunk`/the resize job's own pass already take, so a delete can never
   race a concurrent sync/eager/resize pass on the same chat's chunk sequence.
2. Read the target row (`chunk_id`, `ordinal`, `parent_chunk_id`). Not found → no-op, return (the
   primitive is idempotent, safe to call twice).
3. Find its child — `select chunk_id from chat_chunks where parent_chunk_id = $1` (0 or 1 row,
   guaranteed by the `chat_chunks_parent_unique` constraint).
4. **Relink** — if a child exists, `update chat_chunks set parent_chunk_id = $2 where chunk_id =
   $1` (`[child.chunkId, target.parentChunkId]`), splicing the target out of the chain: the child
   now points at the target's own parent (which may be null, if the target was the chain's head).
5. **Renumber** — `update chat_chunks set ordinal = ordinal - 1 where chat_id = $1 and ordinal >
   $2` (`[chatId, target.ordinal]`), closing the gap the deletion is about to leave. Legal only
   because both unique constraints are deferred to commit-time (see Background) — without that,
   this statement (and the relink above, which also transiently overlaps the target's own still-
   present values) would throw.
6. **Delete** — `delete from chat_chunks where chunk_id = $1`.
7. Log one line (`bi_principles.md` §11) — `chatId`, deleted `chunkId`, whether a relink happened,
   how many rows were renumbered — this is a destructive, rare operation; nothing else observes it
   directly.

Steps 4-6 all happen before the transaction commits, so no external reader ever sees an
intermediate state — but the *statement order within the transaction* still matters exactly the way
the user asked: the relink and renumber are issued, and would succeed or fail, before the delete
statement runs, not as a side effect the delete triggers.

**`resolveLeadInRows`'s single query** — given the retrieved chunks' `chunkId`s and a resolved
`leadInCount`:

```sql
with recursive lead_in as (
  select chunk_id, parent_chunk_id, ordinal, summary, 0 as depth
  from chat_chunks
  where user_id = $1 and chat_id = $2 and chunk_id = any($3)
  union all
  select c.chunk_id, c.parent_chunk_id, c.ordinal, c.summary, li.depth + 1
  from chat_chunks c
  join lead_in li on c.chunk_id = li.parent_chunk_id
  where c.user_id = $1 and c.chat_id = $2 and li.depth < $4
)
select distinct chunk_id, ordinal, summary
from lead_in
where depth > 0 and chunk_id != all($3)
```

`$3` is the retrieved `chunkId`s (the recursion's seed rows, `depth = 0`, excluded from the final
result by `depth > 0`); `$4` is `leadInCount`. The seed at 0 with the `li.depth < $4` bound yields
exactly `leadInCount` hops — `1` → the immediate parent, `3` → three chunks back. (An earlier draft
of this plan seeded `depth` at 1, which made `leadInCount = 1` return nothing and every value
return `leadInCount - 1` rows; the SQL above is the corrected form, and the Tests section pins it
down.) `distinct` plus the `chunk_id != all($3)` filter is
what makes dedup structural rather than a JS-side pass: a chunk reachable from two different
retrieved chunks' chains surfaces once; a chunk that's independently *also* one of the retrieved
matches never surfaces as a lead-in at all — the full version (already in `chunks`) always wins.
`leadInCount = 0` skips this query entirely (`resolveLeadInRows` isn't called).

**The merge**, in `recallForPrompt.ts` after both calls resolve:

```ts
const leadInEntries: ChunkRow[] = leadInRows.map((r) => ({
  ordinal: r.ordinal,
  summary: r.summary,
  content: '',
  isLeadIn: true,
  // recallChunkLane.ChunkRow requires distance/kw_score; these placeholders are never consumed
  // for a lead-in entry (rendered from summary, never re-scored, never re-ranked).
  distance: 0,
  kw_score: 0,
}));
const merged = [...chunks, ...leadInEntries].sort((a, b) => a.ordinal - b.ordinal);
```

Nothing more elaborate is needed — the recursive CTE already guarantees no overlap between `chunks`
and `leadInEntries`, so the merge is a concatenate-and-sort, not a second dedup pass.

## Contracts

- `chat_chunks.parent_chunk_id uuid references chat_chunks(chunk_id) on delete set null` — null
  for a chat's first chunk; unique (deferred) across non-null values.
- `deleteChatChunk(session, userId, chatId, chunkId): Promise<void>` — idempotent; relinks the
  chain and closes the ordinal gap before removing the row, all in one transaction, under the
  chat's advisory lock.
- `resolveLeadInRows(session, userId, chatId, chunkIds: string[], leadInCount: number):
  Promise<LeadInRow[]>` — `LeadInRow = { chunkId: string; ordinal: number; summary: string }`;
  never returns a row whose `chunkId` is in the input `chunkIds`; never returns duplicates;
  returns exactly `leadInCount` rows when the chain has that many ancestors, fewer (never zero for
  `leadInCount >= 1` with a non-head chunk) when it runs out. `leadInCount <= 0` short-circuits to
  `[]` with no query.
- `chat_chunks.parent_chunk_id` (writing side) — every INSERT into `chat_chunks` sets it: the first
  chunk of a batch links to the chat's current max-ordinal row (null when the chat has no chunks),
  each later chunk links to the previously inserted row. The four writers (sync tick, eager path,
  resize backfill, fork copy) all run under the per-chat advisory lock — or, for the fork, against
  a brand-new `chat_id` no other writer can touch — so the read-then-insert is race-free.
- `ChunkRow` (both `recallChunkLane.ts` and `memoryInjection.ts`) gains `isLeadIn?: boolean`
  (default falsy) — `recallChunkLane.ts`'s copy also gains `chunkId`/`parentChunkId`, needed only
  internally to build the lead-in query's input.
- `AutoRecallParts.chunks` — now always sorted by `ordinal` ascending, mixing full chunks and
  lead-in entries; this is a behavior change from today's relevance-sorted order, and both
  consumers (`formatAutoRecallBlock`, `RpMemoryContext.chunks`) inherit it automatically.
- `chat_memory_auto_recall_lead_in_chunks` — integer-as-text, no stored default row; unset/corrupt
  falls back to `DEFAULT_LEAD_IN_CHUNKS = 2`; clamped to `[0, 3]` on read (`0` disables the
  feature entirely).
- `chat_memory_auto_recall_lead_in_prompt` — text override for `DEFAULT_AUTO_RECALL_LEAD_IN_PROMPT`,
  same empty-string-means-default contract (§17) as every other chat-memory prompt setting.

## Edge Cases

- **A retrieved chunk is the first chunk in its chat** (`parent_chunk_id` null). Its lead-in walk
  terminates immediately with nothing beyond — zero lead-in rows for it, not an error.
- **A lead-in candidate is also independently retrieved** on its own merits. Excluded from the
  lead-in result by `chunk_id != all($3)`; it still appears in the output, fully rendered, as a
  normal retrieved chunk — never downgraded to summary-only.
- **`chat_memory_chunk_pairs` is greater than 1.** Each lead-in hop still pulls exactly one
  *chunk*, which now spans more than one turn-pair — "1-3 chunks before," not literally "1-3 turns
  before," at that setting. Not special-cased further; documented in Out of Scope.
- **`chatChunkResize.ts`** (the backfill from `chunk-size-resize-plan.md` — already built and
  deployed, so this plan changes it directly; it is not a future touch-point). Its
  wipe-then-regenerate is a bulk delete of 100% of a chat's chunks followed by a full rebuild from
  ordinal 0 — it does not call `deleteChatChunk` (that primitive is for a single-row removal, not a
  full-chat reset) and needs no relink logic of its own for the *deletion* half; its insert loop
  sets `parent_chunk_id` sequentially (Files) so a resize pass leaves the chain intact.
- **Two chunks reachable from each other's chains at `leadInCount >= 2`** (e.g., chunks 10 and 11
  both retrieved; chunk 9 is "2 before" 11 and "1 before" 10). Recursion + `distinct` returns chunk
  9 once regardless of how many retrieved chunks' chains reach it.
- **A `deleteChatChunk` call races a concurrent sync/eager/resize pass on the same chat.**
  Serialized by the shared per-chat advisory lock, same as every other concurrency case this
  codebase already handles this way.
- **The auto-generated constraint name for `unique (chat_id, ordinal)` doesn't match
  `chat_chunks_chat_id_ordinal_key`.** Confirm via `\d chat_chunks` against the live DB before
  writing the migration; if it differs, drop and re-add by the real name rather than guessing.

## Tests

- `deleteChatChunk`: deleting a middle chunk relinks its child's `parent_chunk_id` to the deleted
  chunk's own parent, and every chunk with a higher ordinal shifts down by exactly one, remaining
  contiguous. Deleting the chat's last chunk (no child) removes it and shifts nothing. Deleting the
  first chunk (`parent_chunk_id` null) makes its former child the new head (`parent_chunk_id` →
  null) and still shifts every later ordinal down by one. Calling it twice on the same `chunkId` is
  a no-op the second time. Runs under the chat's advisory lock — assert a concurrent sync/eager call
  for the same chat blocks until the delete's transaction completes, mirroring the resize plan's own
  concurrency test shape.
- `resolveLeadInRows`: returns exactly the `leadInCount` chunks preceding a retrieved chunk, walking
  `parent_chunk_id`; returns fewer than `leadInCount` without error when the chain runs out (chat's
  first chunk reached); never returns a `chunkId` present in the input set; a chunk reachable from
  two different retrieved chunks' chains is returned exactly once; `leadInCount = 0` never issues
  the query.
- Merge: given retrieved chunks with non-contiguous ordinals plus resolved lead-in rows, the
  combined, returned `chunks` array is strictly ascending by `ordinal`.
- `renderAutoRecall`: a lead-in entry (`isLeadIn: true`) renders via the lead-in template using
  `summary`, never `content`; a full chunk entry renders exactly as it does today, unaffected by the
  new parameter's presence.
- Migration backfill: against a chat with an existing multi-chunk history, every row's
  `parent_chunk_id` after the migration equals the `chunk_id` of the row one `ordinal` lower in the
  same chat; a chat with exactly one chunk gets `parent_chunk_id = null`.
- `orchestrator_settings`: `chat_memory_auto_recall_lead_in_chunks` set to `1`/`3`/an out-of-range
  value round-trips through `getChatMemorySettings`/`setChatMemorySettings` with the same
  parse-clamp-fallback shape every other chat-memory knob already has a test for.
- Off-by-one regression: `resolveLeadInRows` with `leadInCount = 1` returns exactly the immediate
  predecessor chunk (never zero), and with `leadInCount = 3` exactly three — the draft's original
  CTE seeded `depth` at 1 and returned `leadInCount - 1` rows; the corrected SQL (Logic) is pinned
  down by this test.
- Writer linkage: after a sync tick / eager pass appends a batch, every new chunk's
  `parent_chunk_id` equals the previous chunk's `chunk_id` — the batch's first chunk links to the
  chat's prior max-ordinal row, or null for a chat's very first chunk. After a resize pass,
  ordinals 0..N-1 link in order. After a fork, the copied prefix's chunks link in ordinal order
  with no orphan links.
- Verify-suite touch-points: the `npm run verify` scripts stub exactly what this plan changes and
  must land in the same pass — `verify-recall-for-prompt.mjs` (chunk-lane stub rows gain
  `chunk_id`/`parent_chunk_id`/`isLeadIn`, the two new settings keys join its settings stub, and
  the SQL-shape assertion the `recallChunkLane.ts` preamble references),
  `verify-chat-memory-sync.mjs` / `verify-eager-chunk-sync.mjs` (insert-path assertions gain
  parent linkage), and `verify-chat-sessions.mjs` (the fork copy asserts remapped parents).

## Out of Scope

- Reconciling `chat_chunks.content` with a since-deleted or since-edited `chat_messages` row — no
  FK exists between them today, and this plan doesn't add one; a chunk's frozen content can already
  go stale relative to a deleted source message, unchanged by this work.
- Any admin UI or API route that actually calls `deleteChatChunk` — built as a safe, tested
  primitive with no caller yet, exactly per the user's direction that the robust path should exist
  before anything needs it. Wiring a repair/admin surface on top is a separate future step if it
  ever comes up.
- `chatChunkResize.ts` itself — tracked entirely by `chunk-size-resize-plan.md`; this plan only
  touches its insert loop (the `parent_chunk_id` linkage, Files/Edge Cases) and leaves the
  resize-job lifecycle — claim, enumeration, status row, anchor handling — to that plan's scope.
- LLM-generated summaries specifically for lead-in context — deliberately reuses each preceding
  chunk's existing `summary` (already computed by `classifyChatChunk.ts` at archival time); no new
  summarization pipeline, no new LLM call added anywhere on the recall path.
- Turn-level granularity independent of chunk size — lead-in walks chunks, not raw messages or
  turn-pairs; running at `chat_memory_chunk_pairs = 1` is what makes "N lead-in chunks" equal "N
  turns," and that's an existing setting the user already controls, not something this plan adds a
  second knob for.
- Reconciling `chat_chunks.summary_vector_embed`/`vector_embed` for lead-in rows — lead-in entries
  are rendered, never re-searched; nothing about this plan touches either embedding lane.

## Principles / Conventions in Play

- `bi_principles.md` §1 (Relational Store is Canonical) — `chat_chunks` stays fully reconstructible
  derived state; `deleteChatChunk` removing a row is safe precisely because nothing else treats a
  chunk as a source of truth `chat_messages` doesn't already hold.
- §8 (Four Kinds of Code) — `deleteChatChunk.ts` and `chunkLeadIn.ts` are IO Wrappers (Postgres
  calls, zero derivation logic of their own beyond the SQL); the merge/sort step stays inline in
  `recallForPrompt.ts`, which has already established itself as the orchestration layer for the
  three recall lanes.
- §10 (Size Budget) — both new modules are new, single-purpose files rather than further growth on
  `recallChunkLane.ts` or `chatMemorySync.ts`.
- §11 (Observability) — `deleteChatChunk` logs every relink/renumber/delete; this plan exists in
  the first place because an inferred-not-persisted relationship (`ordinal` adjacency) is exactly
  the kind of seam that fails silently rather than loudly.
- §13 (Runtime Config Lives in the Database) — `chat_memory_auto_recall_lead_in_chunks` joins the
  existing DB-backed settings, live, no restart.
- §16 (Injected Context is Always Attributable and Bounded) — the entire motivation: a lead-in
  entry traces to one specific `chat_chunks` row via its `chunkId`, and the count injected per
  retrieved chunk is hard-capped at `leadInCount` (max 3), never unbounded.
- §17 (Every Prompt is Surfaced for Manual Tuning) — `DEFAULT_AUTO_RECALL_LEAD_IN_PROMPT` follows
  the same overridable, empty-string-means-default contract as every other chat-memory template.
