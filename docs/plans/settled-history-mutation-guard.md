# Settled-History Mutation Guard Plan

*Created 2026-08-20. Governed by `bi_principles.md`. Plan only, not yet implemented. Reviewed
against the current codebase before writing: schema, routes, and lock precedent below were
verified against `orchestrator/src/io/chatSessions.ts`, `orchestrator/src/server/handleChats.ts`,
`db/migrations/0036`, `0054`, `0079`, and `0098`. Two corrections came out of that review and are
folded into the plan directly (see §11 and §2/§16): canon facts are never deleted by rollback, and
the settled boundary reuses the existing `syncBoundary` field rather than inventing a new one.*

## Goal

Make synchronized chat history effectively immutable without introducing expensive cascade-and-rebuild behavior.

The governing rule becomes:

> **Messages at or before the latest closed sync boundary are settled history. They cannot be edited, individually deleted, or regenerated in place.**

Users can still:

* freely edit/swipe/delete within the unsynced live tail;
* **fork** from older settled history to explore another branch;
* **truncate/delete back** into settled history when they intentionally want to destroy everything after that point.

A destructive rollback deletes derived state. It does **not** regenerate it.

No LLM replay.
No re-embedding.
No Bridge replay.
No curator replay.
No digest reconstruction.

Normal rolling sync rebuilds new future state only if the user continues the surviving timeline.

---

# 1. Define the authoritative mutation boundary

Do not independently calculate:

```text
last N live-window pairs
```

inside edit/delete/swipe routes.

Use the newest **closed** `chat_sync_points` row:

```sql
select last_message_id
from chat_sync_points
where chat_id = $1
  and closed_at is not null
order by ordinal desc
limit 1
```

That message is the hard settled boundary.

The rule is:

```text
message <= latest closed anchor
    → settled / immutable

message > latest closed anchor
    → live / mutable
```

If there is no closed sync point:

```text
everything is mutable
```

This is preferable to using configured live-window size because it describes what BI has **actually consumed**, not what it normally expects to retain.

It also naturally handles temporary sync lag: unsynced messages remain editable even if they have grown beyond the nominal live-window size.

Note: `chat_sync_points` rows only exist for `rp`-lane chats. A `chat`-lane chat never has a
closed sync point, so this rule already reduces it to "everything is mutable" without any
special-casing. No lane check is needed anywhere in this plan; it falls out of rule 1 for free.

---

# 2. Reuse the existing settled-boundary computation, don't reinvent it

`ChatDetail.syncBoundary.lastMessageId` (`frontend/src/api/types.ts`, computed in
`chatSessions.ts` inside `getChat`) already resolves to exactly this value: the newest closed sync
point's anchor message, for `rp` chats, `select ... where closed_at is not null order by ordinal
desc`. It was built for the sync-boundary pagination rollout and is already returned to the
frontend today.

Do not add a second, parallel concept (`settledThroughMessageId`) that computes the same thing a
second way. Instead:

* factor the boundary query that already backs `syncBoundary` into a small shared function both
  `getChat` and the new mutation guard call;
* keep `syncBoundary.lastMessageId` as the one field the frontend reads for "where does settled
  history end" (§16 below reuses it rather than adding a new one).

What *is* new and does need a small helper module is the truncate-time question, which nothing in
the codebase currently answers: given a truncation target message, which sync points does it
affect. That's a distinct query from "what's the current boundary" and belongs in its own function.

### Suggested module

```text
orchestrator/src/orchestrator/chatHistoryBoundary.ts
```

or a similarly narrow name.

Expose:

```ts
export async function getSettledBoundary(
  session,
  chatId,
): Promise<{ lastMessageId: string | null }>
```

(the same query `getChat` already runs; both call sites use this one function), and:

```ts
export async function isMessageSettled(
  session,
  chatId,
  messageId,
): Promise<boolean>
```

for the mutation guards, plus the affected-sync-suffix lookup used by truncate (§9).

The implementation must compare **chronological position**, not UUID values.

Use the same ordering the rest of chat memory uses:

```text
created_at, message_id
```

Do not use raw timestamps alone.

---

# 3. Guard in-place edit

Current endpoint:

```text
POST /v1/chats/:id/messages/:messageId/edit
```

currently permits rewriting an earlier assistant reply while keeping the same canonical `message_id`. That is the current integrity hole.

### New behavior

Before:

```ts
deps.chats.editMessageContent(...)
```

check whether the message is settled.

If settled:

```http
409 Conflict
```

with a specific machine-readable error, for example:

```json
{
  "error": "CHAT_HISTORY_SETTLED",
  "message": "This message has already been synchronized. Fork from this point or truncate the conversation to change earlier history."
}
```

Do not mutate anything.

Do not invalidate memory.

Do not offer an automatic rebuild.

Messages after the closed boundary retain current edit behavior exactly.

---

# 4. Guard individual delete

Current endpoint:

```text
DELETE /v1/chats/:id/messages/:messageId
```

should follow the same rule.

### Live message

Allow existing delete behavior.

### Settled message

Reject with:

```text
CHAT_HISTORY_SETTLED
```

because deleting one arbitrary synchronized message would punch a hole through source history while leaving later derived memory semantically dependent on it.

If the user really wants to remove that point in history, they use **truncate/delete-back**, not single-message delete.

---

# 5. Guard swipe/regeneration

Current swipe route operates only on the chat's current last assistant message, which normally means it is already live.

Still add the settled-history check at the route boundary.

Reason:

* it makes the invariant explicit;
* it protects future UI changes;
* it prevents raw API callers from bypassing the intended lifecycle;
* the cost is trivial.

### If current last assistant message is settled

Reject:

```text
CHAT_HISTORY_SETTLED
```

### Otherwise

Existing:

* previous swipe
* next swipe
* regenerate

behavior remains unchanged.

Do not alter the swipe storage model.

---

# 6. Keep fork allowed across settled history

Forking is exactly the right operation for changing direction from old history.

Current fork behavior creates a new chat with copied source history and appropriately bounded derived state.

Do **not** restrict:

```text
POST /v1/chats/:id/fork
```

based on the settled boundary.

A settled message is an entirely valid fork point.

This is one of the two sanctioned ways to act on historical synchronized content:

```text
settled history
→ fork
→ new timeline
```

No mutation of the parent.

---

# 7. Keep truncate/delete-back allowed across settled history

This is the other sanctioned historical operation.

Current route:

```text
POST /v1/chats/:id/messages/:messageId/truncate
```

deletes that message and everything chronologically after it.

That is an intentional timeline rollback, not an in-place mutation.

Therefore it may cross the settled boundary.

But it must also remove derived state that belongs to the destroyed suffix, **with the canon-facts
exception in §11**.

---

# 8. Define cheap rollback semantics for truncate

When truncating at message `M`:

```text
delete canonical messages from M onward
```

and also delete every sync point whose covered history reaches `M` or later.

Conceptually:

```text
find earliest affected sync point
delete that sync point and all later sync points
delete canonical message suffix
commit
```

No rebuild.

No LLM calls.

No embeddings.

No replay.

The remaining prefix is valid and settled.

If the user continues chatting afterward, normal sync resumes from the newest surviving closed sync point.

---

# 9. Find the earliest affected sync point correctly

Given:

```text
Sync 0 anchor A
Sync 1 anchor B
Sync 2 anchor C
```

and truncation target `M` lies:

```text
B < M <= C
```

then delete:

```text
Sync 2
and every later sync point
```

If:

```text
M == B
```

then Sync 1 is affected too, because the source message anchoring that sync is itself being deleted.

So the criterion is effectively:

> first sync whose covered range contains the truncation point.

Use chronology based on:

```text
created_at, message_id
```

not UUID comparison and not timestamp alone.

---

# 10. Let FK ownership delete derived rows where possible, with one exception

The existing schema deliberately ties:

```text
chat_chunks
chat_memory_entries
```

to `sync_id` with `on delete cascade` (`db/migrations/0037`, `0038`), so deleting a sync point
already cascades those two tables away. They are pure derived state, reconstructible from the
source transcript, so this cascade is correct and requires no application code. Use it.

`canon_facts.sync_id` is **not** part of this cascade. See §11: it is `on delete set null` by
deliberate design, and rollback must not touch it.

Do not manually enumerate and delete `chat_chunks` or `chat_memory_entries` rows. The FK graph
already does it.

---

# 11. Canon facts survive rollback, de-attributed, never deleted

This is the one derived-data class that needs deliberate handling, and it goes the opposite
direction from chunks and digest entries.

`canon_facts.sync_id`, `canon_facts.chat_id`, and `canon_facts.anchor_message_id` are all `on
delete set null`, not cascade (`db/migrations/0054`, `0079`). This is not an oversight to route
around, it's a documented invariant: the migration comments state explicitly that "truncating/editing
a chat must never delete a canon fact," citing `bi_principles.md` §15 ("a proposal is reviewable,
not erased"). `bi_principles.md` §1 goes further and names canon facts as part of the platform's
**canonical record** alongside characters, scenes, and locations, not derived working state like
chunks or embeddings. Deleting them on a destructive rollback would violate both.

So truncate must:

* never delete rows from `canon_facts`, under any circumstances, for any truncation target;
* let the existing FK `set null` behavior run as-is when a sync point or anchor message it
  references is deleted.

When a sync point dies, the facts it proposed lose their `sync_id` attribution and fall back to
unattributed / global visibility, exactly like a fact written outside the sync loop. When an
anchor message dies, the fact loses its chat-scoping the same way. Both are self-healing via the
existing FK graph, not application code.

This already gives the plan's original goal for free: once the later sync points and their
attribution are gone, latest-approved-per-key recall naturally falls back to the surviving
earlier records, because those records are still there, just de-attributed. No explicit deletion,
no regeneration, is needed or wanted.

---

# 12. Handle open eager sync points too

The current memory system can have an open:

```text
closed_at IS NULL
```

sync point created by eager chunking (`orchestrator/src/orchestrator/eagerChunkSync.ts`).

A truncate may hit content already summarized/embedded into that open point.

Therefore rollback must inspect **all** sync points, not only closed ones.

If truncation reaches an open point's covered span:

```text
delete the open sync point
```

and let its `chat_chunks`/`chat_memory_entries` cascade away (§10). Any `canon_facts` it proposed
follow §11: de-attributed, not deleted.

The next eager/tick pass starts again from the surviving closed boundary.

---

# 13. Put truncate + derived rollback in one transaction

This is essential.

Current canonical truncation and memory rollback must not happen as two separate committed operations.

The operation should be:

```text
BEGIN

lock chat
find truncation position
find affected sync suffix
delete affected sync points (canon_facts survive via set null, §11)
delete message suffix

COMMIT
```

Use the same per-chat advisory lock already shared by:

* normal sync (`chatMemorySync.ts`)
* eager chunk (`eagerChunkSync.ts`)
* resize (`chatChunkResize.ts`)
* chunk delete (`chatMemory/deleteChatChunk.ts`)

```sql
select pg_advisory_xact_lock(hashtext($1))
```

That prevents a sync pass from simultaneously deriving memory from history being destroyed. It's
specifically `eagerChunkSync.ts` truncate is most likely to race against in practice, since it can
run frequently and opens the sync points §12 has to account for.

---

# 14. Move rollback ownership into the store/domain layer

Do not implement this entirely inside `handleChats.ts`.

The current:

```ts
truncateMessagesFrom(...)
```

(`orchestrator/src/io/chatSessions.ts`) is the logical mutation primitive.

Upgrade it so the store/domain operation owns the complete atomic behavior.

Conceptually:

```ts
truncateMessagesFrom(
  userId,
  chatId,
  messageId,
): Promise<boolean>
```

still has the same public shape, but internally it now:

1. locks the chat;
2. resolves affected sync points;
3. deletes the affected sync-point suffix (chunks/entries cascade, canon facts de-attribute);
4. deletes canonical suffix.

That makes it impossible for another caller to truncate history without performing the rollback.

---

# 15. Do not use automatic invalidation for live edits

For messages after the closed boundary:

```text
edit
delete
swipe
```

should remain cheap ordinary operations.

No sync-point lookup beyond the guard.

No derived state needs deletion because by definition those messages have not crossed the authoritative closed boundary.

This is the main payoff of the design.

---

# 16. Expose mutability to the frontend

The frontend should not have to discover immutability only after pressing Edit.

`ChatDetail.syncBoundary.lastMessageId` already gives the UI exactly this information for `rp`
chats: everything at or before it is settled. Use that field directly. Do not add a second
`settledThroughMessageId` field carrying the same value.

Then ChatView can determine:

```text
message at/before syncBoundary.lastMessageId
→ hide/disable edit/delete/swipe
```

and instead surface:

* Fork
* Delete back / truncate

Mutability itself is still derived, computed client-side from the one boundary id already in the
payload. No per-message `editable: boolean` is persisted or added to the wire format.

---

# 17. Frontend behavior

### Settled messages

Do not show normal mutation actions:

* Edit
* Delete message
* Regenerate/swipe

Allow:

* Fork from here
* Delete back to here

A tooltip or disabled-state explanation can say:

> This turn has already been folded into memory. Fork from here or delete later history to change it.

Keep it short.

### Live messages

Existing controls unchanged.

---

# 18. Delete-back wording

The current backend operation is called `truncate`.

The user-facing action should make its destructive meaning obvious.

Something like:

```text
Delete from here
```

or:

```text
Delete this and everything after
```

Avoid exposing the technical word `truncate` in the UI unless it already exists there.

Require the existing destructive confirmation if one is already used.

Do not invent a new rollback/version-management interface.

---

# 19. Sync status after destructive rollback

If truncation removes the most recent sync points, `chat_memory_sync_status` may still say:

```text
last success
last chunks added
last entries updated
```

from a now-deleted sync.

This is metadata, not canonical memory, but it can become misleading.

After deleting a settled suffix:

* clear current error state;
* clear failure suppression;
* reset consecutive errors;
* do not claim that the removed sync is still the current success.

At minimum clear:

```text
last_status
last_step
last_error
last_error_kind
failure_signature
consecutive_errors
```

Whether to preserve `last_success_at` as historical telemetry or clear it should follow what the Sync Status UI means today.

Do not overbuild a sync-status history reconstruction system.

---

# 20. Existing sync-point anchor cascade remains useful

Do not remove the existing:

```text
last_message_id → chat_messages(message_id) ON DELETE CASCADE
```

behavior.

It remains a useful backstop.

But application-level truncate should no longer **depend** on accidentally deleting an anchor message to clean things up.

The explicit suffix rollback is authoritative.

---

# 21. Production files likely touched

### Core

```text
orchestrator/src/io/chatSessions.ts
orchestrator/src/server/handleChats.ts
orchestrator/src/orchestrator/chatMemorySync.ts
```

### Related, not modified but relevant to the advisory-lock serialization

```text
orchestrator/src/orchestrator/eagerChunkSync.ts
```

Truncate's advisory lock exists specifically to serialize against this file (§13); it's the most
likely thing mid-flight when a truncate lands, and it's the source of the open sync points §12
has to account for.

### New helper

Likely:

```text
orchestrator/src/orchestrator/chatHistoryBoundary.ts
```

Keep it small:

* resolve settled boundary (shared with `getChat`'s `syncBoundary` computation, §2);
* test message chronological position;
* find affected sync ordinal for truncate.

Do not turn it into a generic history-management service.

### Frontend

```text
frontend/src/api/types.ts
frontend/src/views/ChatView.tsx
```

`types.ts` should not need a new field (§16 reuses `syncBoundary`); check whether it needs
anything beyond that once the guard errors are wired up client-side.

Possibly:

```text
frontend/src/api/client.ts
```

only if request/response types need adjustment.

---

# 22. Verification

## Settled mutation guard

Add tests proving:

1. no sync point → any message editable
2. message after latest closed anchor → editable
3. message equal to latest closed anchor → edit rejected
4. message before latest closed anchor → edit rejected
5. settled individual delete rejected
6. live individual delete allowed
7. settled swipe/regeneration rejected
8. live swipe remains allowed
9. fork from settled message remains allowed

## Destructive truncate

Prove:

10. truncate entirely inside live tail deletes no sync points
11. truncate at newest closed anchor deletes that sync point
12. truncate inside newest settled sync deletes that sync and later ones
13. truncate inside an older sync removes the complete sync suffix
14. earlier sync prefix survives
15. dependent chunks disappear (cascade)
16. dependent digest entries disappear (cascade)
17. dependent canon facts **survive**, de-attributed: `sync_id`/`anchor_message_id` become null, row and content unchanged
18. open eager sync point is removed when affected
19. unaffected open/closed state survives when truncation is purely live
20. no LLM calls occur during rollback
21. no embedding calls occur during rollback
22. continuing afterward lets normal sync rebuild only future derived state

---

# 23. Concurrency verification

One test should explicitly prove:

```text
sync pass
vs
truncate
```

serialize through the same advisory lock.

We do not need elaborate multithread simulation.

The important contract is that both operations acquire:

```text
pg_advisory_xact_lock(hashtext(chatId))
```

before reading/writing synchronization state.

This prevents:

```text
sync reads old history
truncate deletes it
sync commits derived state from deleted history
```

---

# 24. Non-goals

Do not include:

* archive removal
* automatic memory rebaking
* parser changes
* failure suppression changes
* scheduler fixes
* eager arithmetic cleanup
* entity-key cleanup
* canon settling redesign
* branch-history redesign

Fork already exists.

Delete-back already exists.

This change simply establishes where each operation is legal.

---

# Acceptance criteria

* Latest closed sync point is the single authoritative mutability boundary.
* Messages before or equal to that boundary cannot be edited.
* Settled messages cannot be individually deleted.
* Settled messages cannot be swiped/regenerated.
* Unsynced live-tail messages retain existing mutation behavior.
* Fork remains available from settled history.
* Truncate/delete-back remains available across settled history.
* A settled truncate removes the affected sync-point suffix and its cascaded chunks/digest entries.
* Canon facts are never deleted by rollback; they survive de-attributed via the existing `set null` FK behavior.
* Rollback performs **zero LLM or embedding work**.
* Chunks/digest after the rollback point do not survive. Canon facts do, unattributed.
* Earlier valid derived history survives.
* Open eager chunk state is handled.
* Sync and truncate serialize on the same per-chat advisory lock.
* Frontend does not offer illegal mutation actions on settled messages, using the existing `syncBoundary` field rather than a new one.
* No general "invalidate and rebuild history" mechanism is introduced.

The resulting mental model is simple:

```text
SETTLED HISTORY                 LIVE HISTORY
─────────────────────│────────────────────────
immutable             │ editable
fork allowed          │ edit/delete/swipe
delete-back allowed   │
                      ↑
             latest closed sync point
```

That is the rule to build around.
