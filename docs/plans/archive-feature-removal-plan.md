# Archive Feature Removal Plan

## Goal

Remove **chat archive as a lifecycle concept** from BigImagine.

After this change:

* chats are either present or deleted;
* no chat has an `archived_at` state;
* rolling sync never excludes a chat because it was archived;
* there is no archive-time household-memory extraction;
* there is no `/archive` API;
* there is no Archive UI;
* existing previously archived chats simply become ordinary chats again.

This is a feature deletion, not a redesign.

Do **not** add replacement finalization semantics, soft-delete behavior, inactive status, or an alternative "completed chat" state.

---

# 0. Two known landmines — read before touching code

These were found by checking the plan against the live codebase, not inferred from the diff. Both
are places where a mechanical "search and remove archive" pass will do the wrong thing if you don't
know they exist going in.

### 0a. `ChatView.tsx` has a second, unrelated feature that also says "archive"

The sync-boundary rollout / lazy-reveal pagination feature (`docs/plans/rp-sync-boundary-rollout-plan.md`)
lives in the same file and reuses the word "archive" throughout its own comments and UI text — it has
nothing to do with `archived_at`:

* the `rollout` memo, `revealedBlocks`, `boundaryMarkerRef`, `revealedSyncCount`
* comments calling revealed history blocks "archive pages" (around the `rollout` useMemo and the
  lazy-load reveal `useEffect`)
* the boundary marker's rendered text: `"Earlier in this story is archived (rolled into memory)"`

None of that reads or writes `archived_at`. It's scroll-position-driven message pagination that
happens to use the English word "archive." **Do not touch it.**

The only things in `ChatView.tsx` that are actually in scope for this plan:

* the `archiveChat` import and `archiveCurrentChat()` function
* the archive button (`chat-archive-button`) and badge (`chat-archived-badge`)
* the `archived={!!activeChat.archivedAt}` / `archived={!!session.archivedAt}` props passed to
  `ChatSyncStatusPanel` and any sibling component
* any `activeChat.archivedAt` read used to gate UI state

If a search for "archive" turns up the rollout code, leave it alone — it is a different feature that
happens to share vocabulary, not a second copy of the thing being removed.

### 0b. `scenes.archived_at` is a different column on a different table

`db/migrations/0046_scenes.sql` independently adds its own `archived_at timestamptz` column to the
`scenes` table. It is unrelated to `chat_sessions.archived_at` and is not part of this removal — it
doesn't currently appear to be read or written anywhere in the TypeScript source. A repo-wide
`grep archived_at` (§3, §17 below) **will** surface it. That's expected. Do not drop it, migrate it,
or otherwise touch the `scenes` table as drive-by cleanup — out of scope for this plan, same as
everything else listed in §18.

---

# 1. Remove the archive API surface

### Modify

`orchestrator/src/server/handleChats.ts`

Delete:

```text
POST /v1/chats/:id/archive
```

including:

* `deps.chats.archiveChat(...)`
* `archiveChatMemory(...)`
* the RP/household branching around archive extraction
* the fire-and-forget error handler
* archive-specific comments/imports

The route should cease to exist.

A request to the old endpoint should naturally fall through to the existing `404 not found` behavior.

Do not leave a compatibility stub.

The current route stamps the chat archived and then asynchronously runs household extraction for non-RP chats. Both pieces go.

---

# 2. Remove archive from the session store

### Modify

`orchestrator/src/io/chatSessions.ts`

Remove:

```ts
archivedAt: string | null;
```

from:

```ts
ChatSessionRow
```

Remove:

```ts
archiveChat(...)
```

from the `ChatSessionStore` API and its implementation.

Remove every `archived_at` projection/mapping from:

* create/read/list/session mapping
* fork/session construction
* lineage records if applicable
* any internal row types

Update the file header/API documentation so it no longer describes archive as an explicit chat lifecycle transition.

Archive currently exists as a first-class persistence concept in this store, not just a route wrapper.

---

# 3. Remove `archived_at` from chat selection semantics

This is important: don't merely stop exposing Archive while leaving archived rows silently excluded from background work.

Search the entire production tree for:

```text
archived_at
```

and remove archive filtering wherever the intended meaning is:

```sql
where archived_at is null
```

Known current consumers include:

### Rolling memory sync

`orchestrator/src/orchestrator/chatMemorySync.ts`

Current due-chat selection excludes archived chats.

Remove:

```sql
cs.archived_at is null
```

Now every existing chat can become due based solely on its actual sync state.

### Chunk resize

`orchestrator/src/orchestrator/chatChunkResize.ts`

The resize job currently enumerates only non-archived chats.

Remove that filter so every surviving chat participates.

### Cleanup loop

`orchestrator/src/orchestrator/cleanupLoop.ts`

It also contains `archived_at` filtering.

Remove the archive condition while preserving its genuine cleanup eligibility criteria.

Do a repo-wide production search rather than assuming those are the only three.

**Remember §0b**: this search will also surface `scenes.archived_at` in `db/migrations/0046_scenes.sql`
and any code referencing the `scenes` table. That hit is not part of this removal — leave it.

---

# 4. Delete archive-time household memory extraction

The archive feature is currently the only runtime reason for the household classifier.

Delete:

```text
orchestrator/src/io/chatMemory/classifyHouseholdMemory.ts
orchestrator/src/io/chatMemory/parseHouseholdMemoryOutput.ts
```

Remove their imports from:

```text
orchestrator/src/orchestrator/chatMemorySync.ts
```

Delete:

```ts
archiveChatMemory(...)
```

entirely.

That also removes:

* archive digest construction
* latest-20-message collection
* `sync:household-memory` LLM call
* archive-triggered inserts into `household_memory`

Also remove the plumbing that only exists to feed `archiveChatMemory()`, which will otherwise survive
as dead weight that a TypeScript build won't flag (it's still valid code, just orphaned):

* the `householdMemoryPrompt: string | undefined` field on the `SyncSettings` type
* its destructuring/fetch inside `resolveSyncSettings()` (`deps.settings.get('chat_memory_household_memory_prompt')`)
* its inclusion in the object `resolveSyncSettings()` returns

None of these three cause a compile error if left behind, so don't rely on "the build passes" to catch
them — remove them explicitly as part of this same edit.

The ordinary household `chat` lane's rolling **Distill** behavior remains untouched.

This removal is specifically the archive-time cross-chat promotion path.

---

# 5. Remove the household archive classifier prompt setting

The classifier is configurable through chat-memory prompt settings.

### Modify

`orchestrator/src/server/admin/chatMemoryPromptSettings.ts`

Remove the household archive-classifier setting from:

* default/value schema
* GET settings response
* PATCH/PUT parser
* persistence mapping
* help text/description

Current setting key:

```text
chat_memory_household_memory_prompt
```

or whichever exact exported key the current implementation maps it to.

Do not leave a dead setting that nothing consumes. The classifier currently appears in the prompt-settings module.

### Frontend

`frontend/src/views/RagView.tsx` genuinely exposes this setting — it is not a hypothetical. It holds
`selectedHouseholdMemoryPrompt` state, sends `household_memory_prompt` in its PATCH payload, and
renders a labeled textarea plus a reset button keyed on `householdMemoryPromptIsDefault`. Remove all
of that: the state, the PATCH field, the textarea block, and the reset-button branch for
`'householdMemoryPrompt'`. Also remove `householdMemoryPrompt` / `householdMemoryPromptIsDefault`
from the corresponding settings type in `frontend/src/api/types.ts` and `frontend/src/api/client.ts`.

---

# 6. Keep `household_memory` itself — but state the real consequence of doing so

Do **not** automatically delete:

```text
household_memory
```

or migration `0039_household_memory.sql`.

Archive extraction is only one producer/consumer relationship around that table.

This has been checked against the live code, not left as an open question: `household_memory` is
actively **read** — `orchestrator/src/server/promptAssembly.ts` (~line 113) injects every row for the
current user into the system prompt of every ordinary ("chat" kind, non-RP) household chat. But
`archiveChatMemory()` → `classifyHouseholdMemory()` is the **only writer** anywhere in the codebase.
There is no admin CRUD endpoint, no frontend memory-management UI, and no other insertion path.

**Consequence of this plan, stated explicitly rather than left as a surprise**: after this change,
`household_memory` becomes a permanently write-never table. Existing rows keep being injected into
every household chat's prompt indefinitely; no new row can ever be added through any path in the
product. This is not a bug in the plan's scope boundary — the archive-time classifier genuinely is
the only writer, and deleting the only writer without deleting the table is the correct, conservative
choice for a removal chunk. But it is a real product-behavior regression (household memory silently
stops growing, forever) and should be a conscious decision, not a side effect nobody notices until
someone asks "why hasn't my household memory updated in months."

If this consequence is acceptable, proceed as written. If it isn't, that's a reason to either scope a
replacement writer (out of scope for this plan — see §18) or to hold this chunk until one exists. Do
not silently reintroduce a replacement here.

Existing household-memory rows remain valid historical data. Do not delete them merely because their
original source chat was archived.

---

# 7. Remove archive from the frontend API

### Modify

`frontend/src/api/client.ts`

Delete:

```ts
archiveChat(...)
```

and any archive response handling.

No compatibility wrapper.

Search frontend imports/callers afterward and ensure none remain. Current archive client use exists in the frontend API and ChatView.

---

# 8. Remove Archive UI from ChatView

### Modify

`frontend/src/views/ChatView.tsx`

Remove:

* Archive action/menu item/button (`chat-archive-button`)
* archive confirmation dialog, if any
* `archiveChat(...)` invocation (`archiveCurrentChat()`)
* archive pending/error state
* archived-chat restrictions
* `chat-archived-badge` and any UI state that treats an archived chat as read-only or completed
* `archived={!!activeChat.archivedAt}` / `archived={!!session.archivedAt}` props on
  `ChatSyncStatusPanel` and any other child component

**Do not touch** the sync-boundary rollout / lazy-reveal pagination code described in §0a — the
`rollout` memo, `revealedBlocks`, `boundaryMarkerRef`, `revealedSyncCount`, the IntersectionObserver
reveal effect, or the `"Earlier in this story is archived"` marker text. That feature is unrelated to
`archived_at` and must survive this change unmodified.

A chat should behave identically regardless of whether its database row was historically archived before this migration.

---

# 9. Remove archive from frontend types

### Modify

`frontend/src/api/types.ts`

Remove:

```ts
archivedAt
```

from the corresponding chat/session types.

Then fix downstream compile errors rather than searching manually for every consumer first—the type removal is useful here because TypeScript will expose the remaining frontend assumptions.

Known consumer:

```text
frontend/src/components/branchMap/BranchMapPanel.tsx
```

uses `archivedAt`.

Remove any archived/completed visual treatment from Branch Map.

The branch itself still exists. Only the archive state disappears.

---

# 10. Drop the database column

Create a new migration; do not edit migration `0040`.

### Create

Next migration (confirmed next-available at time of writing: `0128`):

```text
db/migrations/0128_remove_chat_archive.sql
```

with:

```sql
alter table chat_sessions
  drop column archived_at;
```

Confirm the actual next migration number at implementation time in case other migrations have landed
since.

Do **not** touch `scenes.archived_at` (§0b) — it is a different column on a different table and is
out of scope.

### Existing archived chats

This has an intentional semantic consequence:

**all previously archived chats become ordinary chats.**

Nothing needs to be `UPDATE`d first. Dropping the column erases the distinction.

Their:

* messages
* chunks
* canon facts
* sync points
* branch relationships

remain exactly where they are.

On future polling, an old chat with genuinely outstanding sync work may become eligible again.

That is desirable: we're removing the state that previously prevented it.

---

# 11. Do not remove historical migrations

Keep:

```text
db/migrations/0040_chat_branching.sql
```

and other historical migrations intact.

Fresh databases still need to migrate through historical schema states before the new migration removes the column.

Only add the forward removal migration.

Update:

```text
db/migrations/README.md
```

with the new migration.

---

# 12. Remove household parser verification

### Modify

`orchestrator/scripts/verify-chat-memory-text-parsers.mjs`

Remove:

```ts
parseHouseholdMemoryOutput
```

import and its associated tests.

After this chunk, the structured chat-memory parsers under test are:

* Bridge
* World
* People
* Distill

Chunk summary remains its simple raw-text normalizer.

---

# 13. Remove archive/classifier integration fixtures

### Modify

`orchestrator/scripts/verify-chat-memory-sync.mjs`

Delete:

* `HOUSEHOLD MEMORY CLASSIFIER` fake-backend routing
* `householdMemoryOverride`
* `isHouseholdMemoryCall`
* archive-household classifier assertions
* old classifier call-count exclusions
* archive-specific fixtures

Then simplify:

```ts
summarizeCalls()
```

by removing:

```ts
!isHouseholdMemoryCall(c)
```

Do **not** perform the broader fake-backend classifier refactor in this chunk.

Just remove the now-dead sixth call class.

The current fake backend explicitly routes six tool-free callers, including the archive-only household classifier. After removal it should route five.

---

# 14. Remove archive store/server verification

### Modify

```text
orchestrator/scripts/verify-chat-sessions.mjs
orchestrator/scripts/verify-server.mjs
```

(both confirmed to exist in `orchestrator/scripts/`)

Delete tests whose purpose is:

* archive stamps `archived_at`
* archived chat appears archived
* archive endpoint succeeds
* RP archive skips household extraction
* household archive triggers extraction
* archived chats are excluded from selection

Replace only where necessary with assertions for the new behavior.

Examples:

* chat session shape contains no archive field;
* `/v1/chats/:id/archive` returns 404;
* previously ordinary chat CRUD remains unchanged.

Do not create tests for a replacement feature.

---

# 15. Update resize/cleanup verification

Because archive filtering is being removed, existing tests may seed:

```text
archived_at
```

to prove a chat is skipped.

Update those tests.

Known affected areas from the current repository search:

```text
orchestrator/scripts/verify-chat-chunk-resize.mjs
orchestrator/scripts/verify-cleanup-loop.mjs
```

If those fixtures need an entity to be ineligible, use the actual eligibility rule belonging to that subsystem—not an invented replacement "inactive" state.

---

# 16. Documentation cleanup is part of this removal

Because archive is architectural behavior, update current docs in the same chunk.

### Modify

`docs/chat-memory.md`

Remove:

* archive lifecycle description
* end-of-chat household memory extraction
* references saying archived chats leave rolling sync
* archive endpoint
* classifier explanation

Also fix any nearby description that says archive is how a chat becomes final.

Current docs explicitly describe `archiveChat` and archive-triggered extraction.

### Remove completed implementation plan?

The newly added:

```text
docs/plans/chat-memory-household-classifier-plan.md
```

is now a plan for a feature being deleted almost immediately.

Given your existing policy of not retaining completed plans as active context, delete it rather than leaving an authoritative-looking dead design around.

Also inspect the umbrella structured-output plan (`docs/plans/chat-memory-structured-output-plan.md`)
for the household-classifier chunk and either update/remove that section or move the whole completed
plan out according to the repo's existing plan-cleanup convention.

---

# 17. Mechanical repo-wide removal check

At the end, search production + frontend + tests + docs for:

```text
archiveChat
archive_chat
archived_at
archivedAt
classifyHouseholdMemory
parseHouseholdMemoryOutput
HOUSEHOLD MEMORY CLASSIFIER
chat_memory_household_memory_prompt
```

Expected:

### `archived_at`

Only historical migrations may still contain it — **plus `db/migrations/0046_scenes.sql`'s unrelated
`scenes.archived_at` column (§0b), which is not part of this removal and must be left as-is.**

### Archive identifiers

No production/frontend references, other than the sync-boundary rollout's unrelated "archive page" /
"archived" UI text and comments in `ChatView.tsx` (§0a), which is a different feature and stays.

### Household classifier identifiers

No references except possibly git-history-only documentation that is deliberately retained—which I would avoid retaining here.

---

# 18. Things explicitly not touched

Do not alter:

* normal rolling sync thresholds
* RP Bridge
* World curator
* People curator
* Distill
* chunk summarizer
* sync health warning/blocking
* `household_memory` table itself
* recall behavior
* historical-mutation invalidation
* canon settling semantics
* failure suppression
* eager chunk arithmetic
* the sync-boundary rollout / lazy-reveal pagination feature in `ChatView.tsx` (§0a)
* `scenes.archived_at` or anything on the `scenes` table (§0b)

Those are separate work.

---

# Acceptance criteria

* There is no Archive action in the UI.
* There is no archive client method.
* There is no `/v1/chats/:id/archive` API.
* `ChatSessionRow` has no `archivedAt`.
* `ChatSessionStore` has no `archiveChat()`.
* `chat_sessions` has no `archived_at` after the new migration.
* `scenes.archived_at` is untouched.
* Previously archived chats become ordinary surviving chats.
* Rolling sync does not filter chats on archive state.
* Cleanup and chunk-resize do not filter chats on archive state.
* `archiveChatMemory()` is gone, including its `SyncSettings.householdMemoryPrompt` plumbing in
  `chatMemorySync.ts`.
* `classifyHouseholdMemory.ts` is gone.
* `parseHouseholdMemoryOutput.ts` is gone.
* The archive household-memory prompt setting is gone, including its `RagView.tsx` textarea/state.
* `household_memory` itself remains intact, and this plan's document explicitly records that the
  table becomes write-never as a result (§6) — this was a conscious call, not an oversight.
* Household archive classifier tests/fixtures are gone.
* No replacement lifecycle state is introduced.
* The sync-boundary rollout pagination feature in `ChatView.tsx` is unmodified.
* Existing chat/RP behavior remains otherwise unchanged.
* Full TypeScript build and verify suite pass.

The important scope line is: **we are removing "archive" completely, not fixing archive.**
