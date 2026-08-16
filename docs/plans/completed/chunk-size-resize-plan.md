# Configurable Chunk Size, with a Guarded Resize

*Follow-up to the recall-token audit that found `chat_memory_auto_recall` injecting full verbatim
turn chunks with no per-chunk cap. The user's chosen fix, this round, is not a token cap — it's
shrinking the chunking grain from 2 turn-pairs to 1, to cut the average injected size roughly in
half while keeping full-exchange fidelity and improving retrieval precision as a side benefit. That
requires promoting `chunkChatTranscript.ts`'s `MESSAGES_PER_CHUNK` from a hardcoded constant to a
live setting — which `docs/plans/completed/eager-chunk-sync-plan.md` explicitly scoped out
("stays a plain constant, matching chunkChatTranscript.ts's own 'nothing yet needs it to vary'
stance"). Something now needs it to vary; this plan is that promotion, done safely.*

## Goal

Make chunk size (`chat_memory_chunk_pairs`, turn-pairs per chunk) a live, DB-backed setting instead
of the hardcoded `MESSAGES_PER_CHUNK` constant, and give the user a safe way to change it: a
warning modal that explains a size change does **not** retroactively touch already-archived
history, plus an opt-in one-click backfill that re-chunks every chat's archived history at the new
size so the whole platform stays consistent rather than drifting into mixed granularities.

## Implementation Protocol — STOP after every step

This plan touches a live memory pipeline end to end. Work it **one step at a time**, and after EVERY
completed step:

1. **STOP** — hand control back to the user with a short report of what the step changed and the
   current cache state. Do not chain two steps in one pass.
2. **Check the cache status** — read the last entry of `/reasonix-home/stats/$(date +%F).jsonl`
   (`cache_hit`/`cache_miss` fields) and report the current prompt total + hit rate.
3. **If the latest prompt total exceeds 120k tokens**, request/trigger compaction before continuing
   to the next step.

## Background — what a naive version of this would get wrong

Five places assume a chunk is exactly 2 turn-pairs, and only the first is obviously connected to
`MESSAGES_PER_CHUNK`:

1. `chunkChatTranscript.ts`'s own grouping loop — the obvious one.
2. `chatMemorySync.ts`'s `pairsPerChunk = MESSAGES_PER_CHUNK / 2` — **twice**: in
   `resolveSyncSettings` (digest-horizon conversion) and in `runOneChatSync`'s eligibility
   arithmetic.
3. `eagerChunkSync.ts`'s own `PAIRS_PER_CHUNK = MESSAGES_PER_CHUNK / 2` local constant (line 62),
   used in the Phase-1 estimate, the locked eligibility check, AND the covered-messages slicing —
   which uses `MESSAGES_PER_CHUNK` directly (not `/2`), so a conversion that only touches the `/2`
   sites would silently mis-slice the eager path's chunk input.
4. `recallChunkLane.ts`'s temporal-decay SQL (both the content-lane and header-lane queries) has
   the literal `2 *` hand-inlined into the age-decay expression
   (`ln(2 * greatest(0, ... - ordinal) + 1)`), converting "chunks behind the newest" into "turn-pairs
   behind the newest" for `recallCutoff.ts`'s `decayFactor` math. `recallCutoff.ts` even has its own
   *separate* `PAIRS_PER_CHUNK = 2` constant, documented as mirroring `MESSAGES_PER_CHUNK` — but
   nothing imports one from the other. It's a manually-kept-in-sync duplicate, not a shared
   reference.

If chunk size becomes configurable and only `chunkChatTranscript.ts` is updated, every other site
keeps assuming every chunk is 2 pairs regardless of what the setting actually says. The decay math
doesn't error or crash — it just silently mis-ages every chunk (at 1 pair/chunk, actual age would be
overstated 2x), quietly skewing which recalled memories rank as "recent" vs "stale." This is exactly
the failure shape `bi_principles.md` §11 calls out: a seam that corrupts the story instead of
crashing. All five call sites must move together — and `eagerChunkSync.ts`'s raw-message slicing
must switch to the live `messagesPerChunk`, not just the `/2` arithmetic.

## Files

- `db/migrations/0099_chat_memory_chunk_pairs.sql` — created — widens `orchestrator_settings.key`'s
  CHECK constraint (rebuilt wholesale with the *complete* key list, per 0092's own precedent) to add
  `chat_memory_chunk_pairs`; also creates a small singleton status table, `chat_chunk_resize_status`
  (`id` fixed at a single row via `check (id = 1)`, `status` `'idle' | 'running' | 'done' | 'error'`,
  `chats_total int`, `chats_done int`, `started_at`, `finished_at`, `error text`), household-wide
  like `orchestrator_settings` itself — no `user_id`, exempt from RLS, same rationale 0010 gives for
  `orchestrator_settings`. New tables in this repo grant explicitly (0068's `grant select, insert,
  update, delete on image_connections to bigimagine_app;` is the precedent): the status table needs
  the same grant for `bigimagine_app` or the app user can't read/write the status row.
- `orchestrator/src/io/chatMemory/chunkChatTranscript.ts` — modified — `chunkChatTranscript` takes
  `messagesPerChunk` as an explicit parameter instead of closing over the module constant (Pure
  Function, no settings access — `bi_principles.md` §8). `MESSAGES_PER_CHUNK` becomes
  `DEFAULT_MESSAGES_PER_CHUNK`, kept only as the fallback value callers use when the setting is
  unset/corrupt. Ride-along while touching this file: its doc comments reference a non-existent
  `runChatSync.ts` (the actual caller is `chatMemorySync.ts`) — fix the stale naming.
- `orchestrator/src/orchestrator/chatMemorySync.ts` — modified — `resolveSyncSettings` reads
  `chat_memory_chunk_pairs` live alongside its existing settings reads (same
  `toPositiveInt(raw, fallback)` pattern already used for `livePairs`/`syncEveryPairs`), derives
  `pairsPerChunk`/`messagesPerChunk` from the live value instead of the constant, and threads
  `messagesPerChunk` into the two `MESSAGES_PER_CHUNK / 2` sites — `resolveSyncSettings`'s
  digest-horizon conversion AND `runOneChatSync`'s eligibility arithmetic — and into
  `chunkChatTranscript`. `MESSAGES_PER_CHUNK` must no longer appear anywhere in this file.
- `orchestrator/src/orchestrator/eagerChunkSync.ts` — modified — same live read and threading,
  mirroring `chatMemorySync.ts`'s resolution so the eager path and the tick never disagree about
  chunk size mid-flight. Convert EVERY `MESSAGES_PER_CHUNK` reference, not just the `/2` ones: the
  local `PAIRS_PER_CHUNK` constant (line 62), the Phase-1/Phase-2 eligibility math, AND the
  covered-messages slicing (`coveredMessages = startOrdinal * MESSAGES_PER_CHUNK`, lines 165-167),
  which silently mis-slices if it keeps using the constant after a size change.
- `orchestrator/src/io/chatMemory/recallCutoff.ts` — modified — `decayFactor(ageChunks,
  pairsPerChunk)` gains `pairsPerChunk` as a required parameter; `PAIRS_PER_CHUNK` is deleted as a
  freestanding constant (it was the drift risk, not a needed default — every real caller already has
  a live value in hand by the time it reaches this function).
- `orchestrator/src/io/chatMemory/recallChunkLane.ts` — modified — `ChunkLaneOptions` gains
  `pairsPerChunk: number`; both decay SQL expressions' hardcoded `2 *` become a bound parameter
  (`$5`) fed from it.
- `orchestrator/src/io/chatMemory/recallForPrompt.ts` — modified — resolves
  `chat_memory_chunk_pairs` live in the same `Promise.all` as its other settings reads (fallback
  `DEFAULT_CHUNK_PAIRS = 2`, same shape as `AUTO_RECALL_PAIRS` etc.), passes it into
  `recallChunkLane`'s opts.
- `orchestrator/src/orchestrator/chatChunkResize.ts` — created — the backfill: for every chat
  belonging to the (single) user, wipes and regenerates its `chat_chunks` at the current
  `chat_memory_chunk_pairs` size, reusing the chat's most-recent sync point AND advancing that
  point's `last_message_id` to the regenerated span's end (see Logic step 6 — skipping the advance
  would make the next tick re-chunk the same span under new ordinals). See Logic. IO
  Wrapper/Orchestrator, same category as `chatMemorySync.ts`'s own chunking step; a new file rather
  than grown onto an existing one (`bi_principles.md` §10).
- `orchestrator/src/server/adminServer.ts` — modified — `SetChatMemorySettingsBody` gains
  `chunkPairs`; `getChatMemorySettings`/`setChatMemorySettings`/`parseSetChatMemorySettingsBody`
  read/write `chat_memory_chunk_pairs` (same optional-field, snake_case-wire-key pattern every other
  field in that body already follows). Two new routes: `POST
  /v1/admin/chat-memory-resize` (fire-and-forget trigger) and `GET
  /v1/admin/chat-memory-resize-status` (reads the status row). See Contracts. Note the route
  wiring: routes are registered in `orchestrator/src/server/httpServer.ts`'s route table (alongside
  the existing chat-memory routes at lines 582-584), with handlers in
  `orchestrator/src/server/handleAdminDisplaySettings.ts`; the new endpoints follow that split, and
  `chatChunkResize.ts` is wired in through `HttpServerDeps`.
- `frontend/src/api/types.ts` — modified — `ChatMemorySettings` gains `chunkPairs: number | null`;
  new `ChunkResizeStatus` type mirroring the DB row.
- `frontend/src/api/client.ts` — modified — `adminSetChatMemorySettings`'s body gains
  `chunk_pairs`; new `adminTriggerChunkResize(adminKey)` and `adminGetChunkResizeStatus(adminKey)`
  calls, same shape as every other admin fetch wrapper in this file.
- `frontend/src/components/ChunkResizeWarningModal.tsx` + `.css` — created — modeled directly on
  `BackupWarningModal.tsx`'s plain-overlay shape (no modal library in use elsewhere in this
  codebase). Three actions, not one: Cancel, "Change setting only," "Change and re-chunk now." See
  Logic for copy content.
- `frontend/src/views/RagView.tsx` — modified — the chunk-size field gets its own dedicated save
  path, not folded into `saveRetrievalSettings`'s combined diff-and-patch (that function saves ~15
  read-time-only knobs in one batch; chunk size is write-time and carries real backfill cost, a
  different enough blast radius to warrant its own button and its own confirm step rather than
  silently riding along in a bulk save). Clicking its Save opens `ChunkResizeWarningModal` whenever
  the new value differs from `chatMemorySettings.chunkPairs`; the modal's choice drives what happens
  next (see Logic). While a resize is `running`, polls the status endpoint and renders progress.

## Logic

**Live-setting resolution, mirroring existing patterns exactly.** `chat_memory_chunk_pairs` is read
live, no restart, the same way `chat_memory_live_window_pairs` already is in three places
(`chatMemorySync.ts`, `eagerChunkSync.ts`, `promptAssembly.ts`'s `trimToLiveWindow`). Default
fallback is `2` — today's behavior — so shipping this change alone, before the user touches the
setting, is a no-op: every existing chat keeps chunking at 2 pairs until the user explicitly saves a
different value.

**The Pure Function boundary.** `chunkChatTranscript.ts` must not call `settings.get` itself
(`bi_principles.md` §8: Pure Functions take no settings access). Both callers already resolve their
own settings live and pass plain values in (`resolveSyncSettings` in `chatMemorySync.ts`,
`eagerChunkSync.ts`'s own settings block) — `messagesPerChunk` joins that same resolved-settings
object, threaded through exactly like `liveWindowMessages`/`syncEveryMessages` already are.

**The decay-math fix.** `recallForPrompt.ts` resolves `chat_memory_chunk_pairs` in its existing
`Promise.all` settings batch (same fallback-parse-with-`Number.isFinite` shape every other knob
there uses) and passes the resolved integer into `recallChunkLane`'s `opts.pairsPerChunk`.
`recallChunkLane.ts`'s two queries bind it as a new parameter (`$5`) in place of the literal `2`,
in both the content-lane and header-lane SQL. `decayFactor`'s TS twin (kept for
`verify-recall-for-prompt.mjs`'s SQL-shape assertion — see Tests) takes the same value as an
explicit argument rather than reading `PAIRS_PER_CHUNK`, so there is exactly one place per call site
where "how many pairs is a chunk" gets decided, not two definitions that can drift.

**The resize job.** `chatChunkResize.ts` exports `runChatChunkResize(deps)` (it enumerates every
chat itself, so no `userId` parameter), called fire-and-forget (not awaited) from the
`POST /v1/admin/chat-memory-resize` handler — same non-blocking shape
`handleChatCompletions.ts`'s `maybeEagerChunk` call already establishes.
Before starting, it writes `chat_chunk_resize_status` to `running` with `chats_total` set to the
user's chat count and `chats_done = 0`; on completion (or the first unhandled error) it writes
`done`/`error` with `finished_at`. Every step logs (`bi_principles.md` §11) — start/end per chat,
chunk counts, any failure — since this is a background pass nothing else observes directly.

For each chat, under the *same* per-chat `pg_advisory_xact_lock(hashtext(chatId))`
`runOneChatSync`/`maybeEagerChunk` already take (so a resize pass and a live turn's own sync/eager
call for that chat serialize instead of racing on `chat_chunks` ordinals):

1. Delete every existing `chat_chunks` row for the chat.
2. Recompute the archived-eligible span using the *exact same* turn-boundary/live-window arithmetic
   `runOneChatSync` already uses (`findTurnBoundaries`, minus the live `chat_memory_live_window_pairs`
   pairs) — i.e., "everything currently eligible for archival," not "whatever was archived before."
   This means a resize can also newly archive a small tail that was previously too small to form a
   whole chunk at the old size but now clears the new, smaller size — a welcome side effect, not a
   special case.
3. Chunk that span via `chunkChatTranscript` at the new size, starting `ordinal` at 0.
4. Summarize (gated LLM, `runWithCallContext({taskId: chatId, kind: 'system', userId})`, mirroring
   `chatMemorySync.ts`'s own `summarize_embed` step exactly, including its unbounded
   `Promise.all` over one chat's own chunk batch — chats themselves are still processed one at a
   time, so this never fans out wider than one chat's chunk count at once) and embed (one batched
   `embeddings.embed` call per chat) every new chunk, writing both `vector_embed` and
   `summary_vector_embed`.
5. Insert the new rows with `sync_id` set to the chat's own most-recent existing `chat_sync_points`
   row (`order by ordinal desc limit 1` — a chat with any prior `chat_chunks` to redo necessarily
   already has at least one). Reusing an existing sync point rather than minting a fresh one avoids
   creating a zero-`chat_memory_entries` "noise" row in the Review Panel's sync history (the exact
   thing `eager-chunk-sync-plan.md`'s own Contracts section was careful to keep out of that list) and
   needs no new `chat_sync_points` insert logic at all.
6. Advance the reused sync point's `last_message_id` to the regenerated span's end — the same
   one-line anchor move `eagerChunkSync.ts` already makes at the end of every pass. REQUIRED when
   the reused point is the open one: the tick's chunk top-up slices its input from the open point's
   anchor (`chatMemorySync.ts`'s `chunkInput` slice), so a reused open point whose anchor still
   points at the old span start makes the next tick re-chunk that whole span under new ordinals —
   duplicate content rows the `(chat_id, ordinal)` unique constraint can't see. A closed point gets
   the same advance (keeps `findDueChats`'s synced-boundary anchor honest; the regenerated span is a
   superset of the old archive, so the anchor only ever moves forward).

A chat with **no `chat_sync_points` row** (never synced) is skipped untouched — nothing to reuse,
and the sync tick will chunk it at the live size when it comes due — but still counts toward
`chats_done`. A chat that has a sync point but zero *existing* `chat_chunks` is NOT skipped on
that basis alone: per step 2 above, its currently-eligible span is still recomputed and may gain
newly-archived chunks (the "welcome side effect").

**The warning modal.** Opens only when the user's entered chunk-pairs value differs from the
currently-saved one. Copy covers, plainly: changing the number alone only affects new archival going
forward — existing history keeps its current grouping until re-chunked; re-chunking now deletes and
regenerates every chat's memory chunks, which re-runs a real summarize + embed call per chunk across
every archived chunk in every chat, costs real LLM/embedding usage, and can take a while. Three
buttons: **Cancel** (closes, saves nothing), **Change setting only** (saves `chat_memory_chunk_pairs`
via the existing settings PATCH, no resize triggered), **Change and re-chunk now** (saves the
setting, then calls `POST /v1/admin/chat-memory-resize`). After the third option, `RagView`
polls `GET /v1/admin/chat-memory-resize-status` (a plain `setInterval` while `status ===
'running'`, matching no particular existing poll convention since none exists yet — pick the
simplest one that works) and renders `chats_done / chats_total` until `done` or `error`.

## Contracts

- `orchestrator_settings` key `chat_memory_chunk_pairs` — integer-as-text, no stored default row;
  unset/non-positive/non-integer reads fall back to `DEFAULT_CHUNK_PAIRS = 2` wherever it's resolved
  (same fail-open shape as every other `chat_memory_*` knob).
- `chat_chunk_resize_status` — singleton row (`id` fixed, e.g. a `check (id = 1)` constraint, same
  "one row, no user_id" shape `orchestrator_settings` itself doesn't need but a true singleton
  table does): `status text check (status in ('idle','running','done','error'))`, `chats_total int
  not null default 0`, `chats_done int not null default 0`, `started_at timestamptz`, `finished_at
  timestamptz`, `error text`. Seed one `idle` row in the same migration.
- `chunkChatTranscript(messages: ChatTranscriptMessage[], startOrdinal: number, messagesPerChunk:
  number): ChunkDraft[]` — new third parameter, required (no default inside the pure function
  itself; callers supply the resolved value).
- `decayFactor(ageChunks: number, pairsPerChunk: number): number` — new second parameter, required.
- `ChunkLaneOptions` (`recallChunkLane.ts`) gains `pairsPerChunk: number`, required.
- `POST /v1/admin/chat-memory-resize` — no request body; `202 { status: 'running' }` on success,
  returned before the backfill itself runs; `409 { error: 'a chat chunk resize is already running' }`
  if `chat_chunk_resize_status.status === 'running'` (no overlapping resize passes).
- `GET /v1/admin/chat-memory-resize-status` — `200 { resize: { status, chatsTotal, chatsDone,
  startedAt, finishedAt, error } }` (camelCase, wrapped in a `resize` key, matching the flat
  hyphenated `/v1/admin/chat-memory-*` route naming already used by the other chat-memory admin
  endpoints in this file, rather than a nested `/chat-memory/...` path).
- `SetChatMemorySettingsBody.chunkPairs?: number` / wire key `chunk_pairs` — same optional,
  independently-settable shape as every other field in that body; validated `> 0` integer, same as
  `liveWindowPairs` etc.

## Edge Cases

- **Setting changed but the fix never run.** Expected steady state for a user who picks "Change
  setting only." New archival uses the new size; old chunks keep their old grouping. `decayFactor`
  is called with whatever `pairsPerChunk` is live *now* for every chunk regardless of which size it
  was actually created under — chunks from before the change are mis-aged until a resize runs. This
  is an accepted, temporary imprecision (same spirit as `eager-chunk-sync-plan.md`'s own accepted-
  imprecision cases), not something this plan tries to solve per-chunk — the modal's "re-chunk now"
  option is the actual fix, and it's one click away.
- **A live turn's own eager-chunk/tick call for a chat currently being resized.** Serialized by the
  shared per-chat advisory lock — whichever acquires it first completes before the other proceeds;
  no special-casing needed beyond taking the same lock.
- **App restart mid-resize.** The status row is left `running` with stale `started_at` and never
  reaches `done`/`error`. No resume logic: a fresh `POST` is safe to fire again (each chat's own
  step is a full wipe-and-regenerate, not additive, so re-running the whole job from scratch is
  idempotent) — but the `409` guard above would block it while status still reads `running`. Simplest
  fix: treat a `running` status whose `started_at` is older than some generous ceiling (say, 2
  hours) as stale and allow a fresh `POST` to override it, logging that it did. Flag to Reasonix if a
  cleaner signal turns up during implementation — this is a judgment call, not a hard requirement.
- **A chat with zero existing `chat_chunks`.** Skipped, not an error; still increments `chats_done`.
- **A chat whose only sync point is currently open** (`closed_at is null`, mid-eager-chunking).
  Still has a valid `sync_id` to reuse (open or closed doesn't matter for the FK) — but its
  `last_message_id` anchor MUST be advanced to the regenerated span's end (Logic step 6), or the
  next tick's chunk top-up re-chunks the same span under new ordinals.
- **Live window changed since archiving.** The resize recomputes "everything currently eligible for
  archival" with the CURRENT `chat_memory_live_window_pairs`. If the user widened the live window
  after the old chunks were archived, now-in-window messages fall out of the regenerated span and
  are dropped — and the incremental tick never re-archives them (it only appends past the last sync
  point). Acceptable and consistent with the "regenerate the currently-eligible span" contract —
  the modal's "existing history keeps its current grouping until re-chunked" framing stays true.
  Deliberate, not a bug.
- **Per-block chunk attribution flattens after a resize.** All regenerated chunks of a chat attach
  to its single most-recent sync point, so the Review Panel's per-block chunk grouping (which rows
  came from which consolidation block) is lost for that chat's history — the old `chat_sync_points`
  rows remain, but no chunks point at them. Accepted: the goal is consistent granularity, and the
  alternative (minting one sync point per old block) is exactly the noise the reuse decision exists
  to avoid.
- **Two browser tabs both open the modal and both click "re-chunk now."** The second `POST` gets the
  `409`; `RagView` should show that as "a resize is already running" and fall into the same status-
  polling view rather than treating it as a hard error.

## Tests

- `chunkChatTranscript` groups strictly by the passed-in `messagesPerChunk`, not any module-level
  value — proves the constant is gone from its body.
- `chatMemorySync`/`eagerChunkSync`: a saved `chat_memory_chunk_pairs` of `1` produces 2-message
  chunks on the very next sync/eager pass, no restart — same live-no-restart proof every other
  `chat_memory_*` setting test already establishes for its own knob.
- `decayFactor`/the chunk-lane SQL: distances computed at `pairsPerChunk = 1` differ from
  `pairsPerChunk = 2` for the same `ageChunks` — a regression test proving the literal `2` is
  actually gone from the SQL, not just from the TS twin. Two verify-script changes are REQUIRED:
  `verify-recall-cutoff.mjs` currently imports `PAIRS_PER_CHUNK` and calls `decayFactor(age)` with
  one argument (lines 21, 111-120) — both break the moment the constant is deleted and the parameter
  becomes required; update its calls to pass `pairsPerChunk` explicitly and drop the constant
  import. `verify-recall-for-prompt.mjs`'s decay assertions are substring-based (`greatest(0.70` +
  `ln(`) and would still pass with the bound parameter — add a NEW assertion (the SQL no longer
  contains `ln(2 *`, and the params array carries the resolved pairs value as `$5`) instead of
  assuming the existing assertion needs updating.
- `chatChunkResize`: wipes and regenerates a chat's `chat_chunks` at the requested size; new rows
  reuse the chat's existing (most recent) `sync_id`, never mint a new `chat_sync_points` row; runs
  under the chat's advisory lock (assert a concurrent `maybeEagerChunk` call for the same chat
  during a resize blocks until the resize's transaction completes, mirroring however
  `eager-chunk-sync-plan.md`'s own concurrency test asserts this today); summarize calls run inside
  `runWithCallContext` (§14 gating, same assertion shape as that plan's own LLM-gate test).
- Resize status: `POST` returns before the backfill completes (fire-and-forget, not blocking);
  `chats_done` increments per chat as the job proceeds; a `POST` while `status === 'running'` gets
  `409` (except the stale-`running` override case above); final state is `done` with `chats_done ===
  chats_total`, or `error` with the failing chat's error message on an unhandled failure.
- A chat with zero `chat_chunks` is a no-op step that still advances `chats_done`.

## Out of Scope

- Per-chat chunk-size overrides — stays one global setting, matching every other `chat_memory_*`
  knob's household-wide scope.
- A cancel-mid-resize affordance — not building a cancellation path this round; a single user's chat
  volume keeps a full pass short enough that this isn't yet warranted.
- Resuming a partially-completed resize after a restart — a fresh full pass is cheap and simple
  enough that resume logic isn't worth building; see Edge Cases.
- A per-chunk token cap on the injected `auto_recall` content — considered and explicitly declined
  this session in favor of the chunk-size lever; not part of this plan.
- Any change to what the digest/bridge/curator consolidation reads or how often it runs — untouched;
  this plan only changes chunk *granularity* and adds the ability to rebuild chunks at a new one.
- Re-deriving `chat_memory_entries`/`canon_facts`/plot threads during a resize — those are
  consolidation output, independent of chunk size; a resize only ever touches `chat_chunks`.

## Principles / Conventions in Play

- `bi_principles.md` §1 (Relational Store is Canonical) — `chat_chunks` is derived working state
  (reconstructible from the still-intact `chat_messages` rows, which the resize never touches or
  deletes), which is exactly what makes "delete and regenerate" a safe, principle-compliant
  operation rather than a data-loss risk.
- §8 (Four Kinds of Code) — `chunkChatTranscript.ts` stays a Pure Function (parameterized, no
  settings access); `chatChunkResize.ts` is an IO Wrapper/Orchestrator, the same category
  `chatMemorySync.ts`'s own chunking step already is.
- §10 (Size Budget) — the resize logic is a new file, not grown onto `chatMemorySync.ts` or
  `eagerChunkSync.ts`.
- §11 (Observability) — this plan exists largely *because* of a silent-corruption seam
  (`recallChunkLane.ts`'s hardcoded decay literal); the resize job itself must log per-chat
  start/done/error so a stuck or failed pass is diagnosable from the log alone.
- §13 (Runtime Config Lives in the Database) — `chat_memory_chunk_pairs` joins the existing DB-backed
  settings; no `.env` change, no rebuild, takes effect on the next sync/eager pass.
- §14 (Every LLM Call Passes Through One Gate) — the resize's re-summarize calls must run through
  `runWithCallContext`/the gated provider, exactly like the tick's own summarize step, so this new
  bulk path doesn't slip past cost accounting.
- §16 (Injected Context is Always Attributable and Bounded) — the motivating principle for treating
  a permanently mixed-granularity chunk history as worth fixing rather than shrugging off.
