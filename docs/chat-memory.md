# Chat Memory: Rolling Summarization, Recall, and Branching

Long conversations in the Chat tab have the same problem any long-context chat has: every turn resends
the entire history, cost and latency grow without bound, and the model's attention dilutes across
messages that stopped being relevant hundreds of turns ago. This is bigBrain's answer — adapted from
the pattern in [SillyTavern-Canonize](https://github.com/ZapoVerde/SillyTavern-Canonize), a rolling
summarization/RAG extension for a different kind of chat app, reshaped around the two things bigBrain
has that Canonize doesn't: a real relational store as the canonical record (`docs/bi_principles.md`
§1), and no roleplay "world" to model — a household's actual facts already live in `notes`,
`documents`, `list_items`, `recipes`, and `calendar_events`.

That difference is why this isn't a port of Canonize's lorebook system. Canonize needs a free-text
"world model" (people/places/things entries) because SillyTavern has no database at all — the
lorebook *is* the only place world state can live. bigBrain already has that world state, in
structured, queryable tables. What bigBrain was actually missing was narrower: a way to keep a long
chat's own history out of the model's face without losing it, and a place to keep facts that are
genuinely about the ongoing relationship with the household rather than about any single note or
event. That's what this feature builds.

## The Four Pieces

At every turn in a persisted chat (one with a `chat_id` — Open WebUI's stateless traffic is
untouched by any of this), the prompt is assembled from:

1. **Live context** — the most recent turn pairs, sent raw, exactly as today.
2. **Household memory** — durable, cross-chat facts about the household (preferences, corrections,
   standing context), always included.
3. **Key-ideas digest** — a short, per-chat running summary of what's rolled off the live window,
   always included.
4. **Chat-lane recall** — full-turn search over this chat's archived history, reached only when the
   model explicitly calls `recall_chat_history`.

```
│←──────────── archival (chat_chunks, RAG-only) ────────────→│←── live context ──→│
oldest                                                                                 newest
                                                              ^
                                                     sync boundary (rolls forward
                                                     every chat_memory_sync_every_pairs)
```

Household memory and the key-ideas digest are small and unconditional — they're closer to "the
model's own working notes" than a retrieval decision, so they're just always there, the same way
the live window itself always is. Full-turn recall is different: pulling a specific archived
exchange back into view is a real reach into the past, and per `docs/bi_principles.md` §2 (the LLM
reasons, nothing else does), that's a decision the model makes explicitly by calling a tool — not
something silently injected on the server's own judgment about what's relevant. This is a deliberate
departure from Canonize, which re-runs its full retrieval pipeline unprompted on every turn; bigBrain
has no other precedent for silent context injection (`search_documents` and every other RAG-backed
tool here are explicit, LLM-chosen calls), and this feature doesn't introduce one either.

## The Sync Pipeline

`orchestrator/src/orchestrator/chatMemorySync.ts` polls every 30 seconds (`POLL_INTERVAL_MS`) for
chats whose unsynced messages exceed the live window by a full sync window's worth. For each due
chat, in one transaction:

1. The eligible message run (past the live window, rounded down to a whole number of chunks) is
   sliced into fixed-size chunks — 4 messages (2 turn pairs) each
   (`io/chatMemory/chunkChatTranscript.ts`, the chat-transcript analogue of
   `plugins/documents/src/chunkDocument.ts`).
2. Each chunk gets a one/two-sentence AI summary (`io/chatMemory/classifyChatChunk.ts`) and is
   embedded (single-lane — content only, unlike Canonize's content+summary two-lane retrieval; a
   second lane is a real refinement but not one this scale needs yet).
3. The chat's key-ideas digest is updated (`io/chatMemory/distillChatMemory.ts`): given the current
   digest and the trailing `chat_memory_digest_horizon_pairs` worth of `chat_chunks` summaries — not
   just the ones this tick freshly produced — the model returns only entries that are new or
   changed, reusing an existing `topic_key` for a continuing thread and coining a new one only for a
   genuinely new idea — the same "arc tag" discipline Canonize's plot lorebook uses to stay append-
   bounded instead of growing one row per sync forever. The horizon re-read (oldest-first) is this
   platform's analogue of Canonize's own bridge-summary horizon — see Settings below for why it can
   default smaller than Canonize's.
4. One new `chat_sync_points` row records the restore point; the chunks and updated digest entries
   are tied to it.

A failure mid-pipeline rolls the whole transaction back — the previous sync point is untouched, and
the next tick simply retries.

## Branching, and Why the Healing Problem Mostly Disappears

Canonize needs a real branch/rollback detector (`core/healer.js`) because SillyTavern owns message
deletion, not the extension — a swipe or rewind happens entirely outside Canonize's control, and it
only finds out afterward by walking a hash-linked anchor chain looking for the deepest node that
still matches the current chat file. bigBrain doesn't have that constraint: it owns every mutation to
`chat_messages` itself. So branching here is designed as a relational operation instead of a
detect-and-repair one:

- **A fork is a new `chat_sessions` row** (`chatSessions.ts`'s `forkChat`), not a tree of messages
  inside one row. Forking copies the parent's messages up to the fork point under fresh
  `message_id`s (a global primary key — the parent's own rows can't be reused), plus only the
  `chat_sync_points`/`chat_chunks`/`chat_memory_entries` rows whose restore point falls at or before
  that message. The branch is constructed correct from birth — there is nothing to detect, because
  nothing is mutating out from under it.
- **An edit** (`truncateMessagesFrom`) still deletes forward messages from the *same* `chat_id`,
  and that's where a real cascade matters. It's handled by the schema, not application code:
  `chat_sync_points.last_message_id` is `on delete cascade` from `chat_messages`, and
  `chat_chunks`/`chat_memory_entries` are `on delete cascade` from `chat_sync_points`. Deleting a
  message that was some sync point's restore point cascades through the whole chain automatically,
  in the same statement, inside the same transaction as the edit. `truncateMessagesFrom` itself
  didn't need to change at all.
- **Rerun is no longer edit's cousin.** It used to also go through `truncateMessagesFrom` (delete
  the reply, resend). Since `db/migrations/0059_chat_message_swipes.sql` it's swipe capability's
  "no earlier stored variant, so regenerate" case (`chatSessions.ts`'s `recordSwipe`) — the
  message's own `chat_messages` row is mutated in place, never deleted, so this cascade chain never
  fires for it. That's also *why* it's safe to mutate in place at all: swiping only ever touches
  whichever message is still the chat's last one, which by construction is always inside the live
  window below and has never yet been chunked/summarized/extracted into canon — there's no derived
  state anywhere pointing at that message's old content for the in-place swap to invalidate.

One accepted imprecision: `chat_memory_entries` stores current content per `topic_key`, not a full
version history, so a fork skips an entry entirely if it was last touched by a sync *after* the fork
point, rather than reconstructing its pre-fork-point wording. Same simplicity trade Canonize itself
makes with its own wholesale-snapshot restore (overwrite, don't diff) — worth revisiting only if it
turns out to matter in practice.

## Household Memory

`household_memory` is the one piece of derived state here that deliberately outlives its source chat
(`on delete set null`, not cascade — everything else is chat-scoped and disappears with the chat).
It's populated exactly once per chat, when a household member explicitly archives it
(`POST /v1/chats/:chatId/archive` → `chatSessions.ts`'s `archiveChat` stamps `archived_at`, which
triggers `chatMemorySync.ts`'s `archiveChatMemory`) — never inferred from an idle timeout. That's a
direct application of `docs/bi_principles.md` §3 (explicit user signal outranks inferred): deciding
a conversation is "done" is the household's call, not a heuristic's.

Every `household_memory` row also carries a `source` (`'inferred'` by default, flipped to `'user'`
the moment a household member edits or directly creates one via `create_household_memory`/
`update_household_memory`) — again §3: an entry a person has touched outranks whatever the model
originally guessed.

## Settings — Default + Bespoke

Mirroring Canonize's own "Connections & Prompts" settings panel, the Settings tab's **Chat Memory**
section exposes:

- **Connection** — which configured LLM profile runs this pipeline's calls, independent of the
  household's main conversational connection (unset = the active one, same fallback a chat's own
  `params.profile` uses).
- **Live window / sync-every / digest horizon** (turn pairs) — three timing knobs. Live window and
  sync-every are what Canonize calls "live context buffer" and "pairs between updates." Digest
  horizon is Canonize's "summary horizon" — how many trailing turn pairs the digest re-reads on
  each sync, not just what's brand new. It defaults to 24, smaller than Canonize's own default of
  40, because the key-ideas digest already persists its own state forward as `chat_memory_entries`
  rows across syncs; the horizon here is a revision window layered on top of that persistence, not
  the sole source of continuity the way Canonize's wholesale bridge re-read is.
- **Three prompts** (chunk summary, key-ideas digest, long-term memory), each **default + bespoke**:
  every prompt ships a sensible built-in (`DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT`,
  `DEFAULT_DISTILL_CHAT_MEMORY_PROMPT`, `DEFAULT_HOUSEHOLD_MEMORY_PROMPT`, each exported from its
  own `io/chatMemory/*.ts` module) and can be overridden freely; an empty override clears back to
  the default rather than needing a separate reset action. `docs/bi_principles.md` §18 makes this
  default-plus-bespoke shape a platform-wide requirement, not a one-off pattern local to this
  feature: any prompt driving an internal LLM call must be surfaced here or somewhere else in
  Settings.

All seven settings (`chat_memory_profile`, `chat_memory_live_window_pairs`,
`chat_memory_sync_every_pairs`, `chat_memory_digest_horizon_pairs`, `chat_memory_chunk_summary_prompt`,
`chat_memory_distill_prompt`, `chat_memory_household_memory_prompt`) are read live on every sync
tick — a save takes effect on the next tick, no restart, same shape as `household_timezone`.

These seven keys all needed `orchestrator_settings.key`'s CHECK constraint widened before any of
them could actually be saved; the first six were added to application code in `0036`-`0041` but the
constraint itself was never widened to match until `0043` closed that gap alongside adding the
seventh (`chat_memory_digest_horizon_pairs`) fresh — see `db/migrations/README.md`'s `0043` entry.

## Tables

| Table | Scope | Lifecycle |
|---|---|---|
| `chat_sync_points` | per chat | bookkeeping only — records how far rolling sync has reached |
| `chat_chunks` | per chat | archived turn-pairs + AI summary + embedding; reached via `recall_chat_history` |
| `chat_memory_entries` | per chat | the always-injected "key ideas" digest, bounded by topic_key upsert |
| `household_memory` | per household member, cross-chat | populated once at explicit archive; outlives its source chat |

## What's Different From Canonize, and Why

| Canonize | Chat Memory | Why |
|---|---|---|
| General/Plot lorebook (free-text world model) | Nothing — existing `notes`/`documents`/`list_items` tables | The relational store is already the canonical world model (§1); a shadow prose copy would be a second, un-reconciled source of the same facts |
| Silent RAG injection every turn | `recall_chat_history` is an explicit tool call | The LLM reasons, nothing else does (§2) |
| Hash-linked anchor chain + branch detection | FK cascade (`on delete cascade`) + fork-as-new-row | bigBrain owns its own mutations; no need to detect what it caused itself |
| Wholesale lorebook/scene snapshot restore | Same idea, narrower: entries dropped rather than reconstructed pre-fork | Accepted simplicity trade, not a correctness gap in the common case |
| Bridge-summary horizon defaults to 40 pairs, a full wholesale re-read every sync | Digest horizon defaults to 24 pairs, a revision window on top of persisted state | The key-ideas digest already carries state forward as `chat_memory_entries` rows across syncs; Canonize's bridge summary has no equivalent persistent entries of its own, so its horizon has to do all the continuity work alone |
