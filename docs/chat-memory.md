# Chat Memory: Rolling Summarization, Recall, and Branching

Long conversations in the Chat tab have the same problem any long-context chat has: every turn resends
the entire history, cost and latency grow without bound, and the model's attention dilutes across
messages that stopped being relevant hundreds of turns ago. This is BigImagine's answer — adapted from
the pattern in [SillyTavern-Canonize](https://github.com/ZapoVerde/SillyTavern-Canonize), a rolling
summarization/RAG extension for a different kind of chat app.

This piece of the fork originally carried bigBrain's own household-only framing verbatim: a real
relational store as the canonical record (`docs/bi_principles.md` §1), and "no roleplay world to
model" — a household's actual facts already live in `notes`/`documents`/`list_items`/`recipes`/
`calendar_events`, so Canonize's free-text plot lorebook seemed like a redundant second copy of the
same facts. That reasoning is still correct for a household ('chat'-kind) chat — see "Household
Memory" below, untouched by any of what follows. It stopped being correct once BigImagine repointed
at narrative instead of household data (`docs/bootstrap.md`): an RP-kind chat *is* exactly the kind
of chat Canonize was built for, and `docs/bi_principles.md`'s own "What BigImagine Is" commits to
making Canonize's features "native, relational features of this platform," not declining to build
them. So `chat_sessions.kind` (`0049_chat_kind.sql`) now forks this whole pipeline in two: a 'chat'
chat keeps bigBrain's original digest-only behavior exactly as designed below; an 'rp' chat instead
runs three more lanes on top — the **bridge**, a near-verbatim port of Canonize's own hand-tuned
hookseeker prompt, reading the chat's raw transcript every sync to maintain an evolving SCENE, an
EVENTS table, and arc-tagged PLOT entries; and two periodic **curators**, near-verbatim ports of
Canonize's own `lorebookSyncPrompt`/`peopleSyncPrompt`, maintaining living place/thing/concept and
person entries against the same raw transcript. See "The Bridge (RP Lane)" and "The Curators (RP
Lane)" below.

## The Four Pieces (household / 'chat' lane)

At every turn in a persisted 'chat'-kind chat (one with a `chat_id` — Open WebUI's stateless traffic
is untouched by any of this), the prompt is assembled from:

1. **Live context** — the most recent turn pairs, sent raw, exactly as today.
2. **Household memory** — durable, cross-chat facts about the household (preferences, corrections,
   standing context), always included.
3. **Key-ideas digest** — a short, per-chat running summary of what's rolled off the live window,
   always included.
4. **Chat-lane recall** — full-turn search over this chat's archived history. For a 'chat'-kind
   session it is reached only when the model explicitly calls `recall_chat_history`; for an 'rp'
   session it is *also* auto-injected every turn, CNZ-style (see "The RP Read Path" below).

An 'rp'-kind chat gets pieces 1 and 4 unchanged (piece 4 now auto-injected, see below), but not 2
or 3 — see "The Bridge (RP Lane)" below for what it gets instead.

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
something silently injected on the server's own judgment about what's relevant. That stance still
holds for the 'chat' lane (and for `search_documents` / every other RAG-backed tool here, which are
all explicit, LLM-chosen calls).

**The RP lane is the one deliberate exception, and it's a user decision (session note, 2026-08-08):
"for the prompt stack, we autopopulate the recall tool with the last x turns plus the content of
the user's last entry to pull both the saved facts plus a number of full turn text — the way CNZ
works."** So an 'rp'-kind chat runs the Canonize-shaped retrieval silently at prompt-assembly time
on top of the still-enabled recall tools — see "The RP Read Path" below for exactly what is
injected, how the query is built, and why the tools stay live. This is the one place bigBrain
intentionally reintroduces Canonize's per-turn silent retrieval; everywhere else the "explicit
tool call" rule is unchanged.

## The Sync Pipeline

`orchestrator/src/orchestrator/chatMemorySync.ts` polls every 30 seconds (`POLL_INTERVAL_MS`) for
chats whose unsynced messages exceed the live window by a full sync window's worth. For each due
chat, in one transaction:

1. The eligible message run (past the live window, rounded down to a whole number of chunks) is
   sliced into fixed-size chunks — 4 messages (2 turn pairs) each
   (`io/chatMemory/chunkChatTranscript.ts`, the chat-transcript analogue of
   `plugins/documents/src/chunkDocument.ts`). Same for both chat kinds — this is the RAG-only lane
   (`chat_chunks`/`recall_chat_history`), untouched by the kind branch below.
2. Each chunk gets a one/two-sentence AI summary (`io/chatMemory/classifyChatChunk.ts`) and is
   embedded (single-lane — content only, unlike Canonize's content+summary two-lane retrieval; a
   second lane is a real refinement but not one this scale needs yet). Same for both chat kinds.
3. **This is where the two lanes diverge**, on `chat_sessions.kind`:
   - A 'chat' chat updates its key-ideas digest (`io/chatMemory/distillChatMemory.ts`): given the
     current digest and the trailing `chat_memory_digest_horizon_pairs` worth of `chat_chunks`
     summaries — not just the ones this tick freshly produced — the model returns only entries that
     are new or changed, reusing an existing `topic_key` for a continuing thread and coining a new
     one only for a genuinely new idea. The horizon re-read (oldest-first) is this platform's
     analogue of Canonize's own bridge-summary horizon — see Settings below for why it can default
     smaller than Canonize's.
   - An 'rp' chat instead runs the bridge (`io/chatMemory/bridgeChatMemory.ts`) plus the two
     periodic curators (`io/chatMemory/curateWorldMemory.ts`, `curatePeople.ts`) — see "The Bridge (RP
     Lane)" and "The Curators (RP Lane)" below. None of the three read `chat_chunks` summaries; all
     three read the RAW `toArchive` transcript from step 1 directly, the same messages step 2
     chunked, before they were compressed — one shared `transcriptText`, three separate LLM calls.
4. One new `chat_sync_points` row records the restore point; the chunks from step 2 and whatever
   step 3 wrote (digest entries, or scene/events/plot/lorebook/people) are tied to it.

A failure mid-pipeline rolls the whole transaction back — the previous sync point is untouched, and
the next tick simply retries.

## The Bridge (RP Lane)

An 'rp'-kind chat's sync step 3 is `io/chatMemory/bridgeChatMemory.ts`, not
`distillChatMemory.ts`. Where the household digest is fed only compressed chunk summaries (a
summary-of-summary), the bridge is fed the sync window's RAW transcript directly every tick — the
same shape Canonize's own hookseeker call has always used, and the reason a plain "make the RP digest
richer" fix wasn't enough: the digest's whole shape (summaries-of-summaries, one flat topic_key list)
was the wrong shape for storytelling continuity, not just thin wording.

`DEFAULT_BRIDGE_PROMPT` is a near-verbatim port of Canonize's own hand-tuned `hookseekerPrompt`
(`stacks/sillytavern/st-data/default-user/settings.json`,
`extension_settings.cnz.activeState.hookseekerPrompt`) — preserved wording and structure, not a
re-paraphrase, per the explicit call that years of prompt tuning in Canonize eventually let it "ride
between syncs without adjustment," and that property is the entire point of porting it this way. The
one unavoidable adaptation: Canonize's own raw-markdown "OUTPUT FORMAT" section (parsed by regex on
the SillyTavern side) is replaced with an equivalent forced-tool-call schema (`bridge_chat_memory`) —
BigImagine has no regex-parsing consumer, so the model answers via a structured call instead of free
text. Everything upstream of that section is unchanged. `{{user}}` in the ported prompt resolves
through `util/interpolateMacros.ts` against the household's `persona_name` setting, the same live
macro shape Canonize's own `{{user}}` resolves against.

Each bridge call produces exactly three things, mirroring Canonize's own three-part hookseeker
output:

- **SCENE** — ~150-200 words of present-tense prose, carried forward and evolved each sync, never
  reset. Written to `chat_memory_entries` under the reserved `topic_key` `'scene'` (plain text, same
  upsert-on-`(chat_id, topic_key)` mechanism the household digest already uses — no new table).
- **EVENTS** — a markdown table of upcoming confirmed scheduled events, output in full every sync
  (even unchanged). Written to `chat_memory_entries` under `topic_key` `'events'`. Plain text for
  now, per the user's explicit call — a structured table is a real refinement but "nearly free" to
  add later, not needed to get this working.
- **PLOT entries** — arc-tagged developments (a character's goal/allegiance shifting, a decision, a
  revelation, a threat escalating or resolving, and so on — the exact trigger list lives in the
  ported prompt itself). Each becomes a `'proposed'` `canon_facts` row, `category = 'plot'`. These go
  through the *exact same* settling-window auto-approval as every other canon fact
  (`chatMemorySync.ts`'s `promote_canon_facts` step, which already runs unconditionally at the start
  of every sync tick) — no special-casing needed; a plot fact proposed this tick simply isn't
  `'approved'` until the chat's next tick, the same one-cycle settling window Canonize's own manual
  review gave every entry in its early days.

The bridge also reads two things back in every sync, both scoped to the chat: the **previous
output** (this chat's current `'scene'`/`'events'` `chat_memory_entries` rows, recombined into one
"PREVIOUS OUTPUT" blob — Canonize's own hookseeker reads its own prior output back the same way, and
the prompt's PART 1/PART 2 instructions depend on it for continuity), and **currently open plot
threads** (the latest-approved-per-`arc_tag` `canon_facts` rows where `category = 'plot'` — the same
dedup-to-most-recent-per-arc query `recallCanonFactsTool.ts` already uses for recall, reused here
unranked as a plain listing).

At read time, `buildChatMemorySystemPrompt` (`server/httpServer.ts`) injects an 'rp' chat's SCENE,
EVENTS, and open plot threads unconditionally every turn — the RP lane's equivalent of the household
lane's always-injected key-ideas digest, just three labeled blocks instead of one flat bullet list.
household_memory is never injected for an 'rp' chat, unchanged from before this lane existed.

## The Curators (RP Lane)

The bridge covers Canonize's *plot* lorebook (hookseeker); it never touches Canonize's other
lorebook — the general one, place/thing/concept, plus the dedicated person cards. Those are two more
periodic curator calls, `io/chatMemory/curateWorldMemory.ts` and `io/chatMemory/curatePeople.ts`,
running every sync tick alongside the bridge for 'rp'-kind chats, over the exact same
`transcriptText`. Both are near-verbatim ports of Canonize's own hand-tuned
`lorebookSyncPrompt`/`peopleSyncPrompt` (same source file as the hookseeker prompt), same "preserve
exact wording" direction as the bridge's own port.

Two adaptations from the CNZ source, made identically in both prompts:

- **"Keys:" dropped entirely.** Canonize generates a keyword list per entry for SillyTavern's
  keyword-triggered lorebook activation. `docs/spec.md` states BigImagine's vector recall
  (`recall_canon_facts`) replaces keyword lorebooks outright — there is no keyword-match fallback
  anywhere in this schema — so a generated key would never be read by anything. Dropped along with
  it: Canonize's own carve-out letting the lorebook curator correct a mistagged `#person` entry's
  category alone; BigImagine's lorebook curator is never even shown person entries (the people
  curator owns that category exclusively), so there's nothing for it to mistag.
- **Forced tool call instead of raw markdown.** Canonize's `### OUTPUT FORMAT` section (parsed by
  regex client-side) becomes `curate_lorebook`/`curate_people` — a structured tool call, same swap
  the bridge already made for `bridge_chat_memory`. Canonize's own free-text
  `` **dup** — duplicate of [Primary Name] `` convention becomes a first-class `'duplicate'` action
  with a `duplicate_of` field: the same information, structured instead of parsed back out of prose.

Each curator call returns a list of entries, each an `'update'`, `'new'`, or `'duplicate'` action —
empty when nothing in the window warrants a change, same "silence is a valid answer" shape as the
bridge's own `plot_entries`. Every entry becomes a `'proposed'` `canon_facts` row
(`category = 'place' | 'thing' | 'concept'` for the lorebook curator, always `'person'` for the
people curator), keyed by a new `entity_key` column (`db/migrations/0064_canon_facts_entity_key.sql`)
rather than `arc_tag` — see "Tables" below for why the two columns are kept separate. These settle
through the exact same `promote_canon_facts` auto-approval step as every other canon fact, the chat's
next sync tick, zero special-casing — identical to how the bridge's own plot entries settle.

A `'duplicate'` entry isn't auto-merged — it writes a `'proposed'` row for the *redundant* entry's own
`entity_key`, content `Duplicate of {primary name}.`, which becomes that entity's new live content
once approved (recall's dedup is most-recent-approved-wins, so the duplicate marker naturally
supersedes whatever the redundant entry used to say). Manual cleanup from there — same as Canonize's
own dup-flagging convention, which is also never auto-resolved.

Unlike the bridge's SCENE/EVENTS, curator-produced entries are never unconditionally injected into
the system prompt as standalone blocks — but they are exactly what the RP read path's auto-recall
finds (see "The RP Read Path" below): the same `recall_canon_facts` query, run silently at prompt
assembly against the approved rows, in addition to the still-enabled `recall_canon_facts` tool the
model can call to dig deeper mid-turn. These curators exist to give that read path something real
to search, not to add a fourth always-on injected block.

## The RP Read Path (auto-recall)

For an 'rp'-kind chat, `buildChatMemorySystemPrompt` (`server/httpServer.ts`) runs a fourth,
Canonize-shaped read every turn on top of the scene/events/plot threads — `io/chatMemory/
recallForPrompt.ts`'s `buildAutoRecallParts`, the CNZ-style silent retrieval the user asked for
("the way CNZ works"):

1. **Query = the last `AUTO_RECALL_PAIRS` (3) turn-pairs** of the full message list handed to the
   prompt assembler — which includes the just-sent user message (the client sends complete history;
   `trimToLiveWindow` runs only after assembly), so the user's last entry is always the newest pair.
   This mirrors Canonize's own `ragClassifierHistory` (`formatPairsAsTranscript(allPairs.slice(-3))`
   → `cleanForEmbedding`): the query is the recent transcript itself, not a synthesized question.
2. **One embedding** of that query text.
3. **Two parallel searches**, both scoped to this chat_id inside one `withUserScope`:
   - `chat_chunks` — the chat's archived full-turn texts, top `AUTO_RECALL_CHUNK_TOP_K` (8, the
     Max ceiling — matching Canonize's own `ragChatMax` default) by
     vector distance, content verbatim (the same rows/columns `recall_chat_history` returns).
   - `canon_facts` — approved rows only, deduped to most-recent-approved per
     `arc_tag`/`entity_key` (the same `distinct on (coalesce(...))` query
     `recallCanonFactsTool.ts` runs), top-k from the live `canon_recall_top_k` setting (default 8).
4. **Rendered as three independent prompt-stack markers** (2026-08-13 user direction, the
   component split): `buildChatMemorySystemPrompt` returns the raw parts (scene, events,
   plotThreads, chunks, facts) and the narrator stack renders each marker from its own
   user-editable template — `bridge` (scene + events combined, the CNZ summary prompt verbatim:
   "The following are upcoming events and a summary of what has just occurred:", events table
   first then scene prose, CNZ defaults.js:209-210), `plot_threads` (the approved plot arcs,
   wrapped per arc in canonize's `<{{arc_tag}}>…</{{arc_tag}}>` HTML blocks,
   DEFAULT_CNZ_PLOT_CHUNK_TEMPLATE), `auto_recall` (the CNZ RAG injection template verbatim plus
   `<memory turns="…">` chunk blocks with the summary prefixed as `[header]`, and fact bullets
   appended) — so a preset can order the three
   independently. Templates live in `io/chatMemory/memoryInjection.ts` and are exposed on the Rag
   page ("Retrieval" fieldset) with `{{scene}}`, `{{events}}`, `{{plot}}`, `{{text}}`, `{{facts}}`,
   `{{turn_range}}`, `{{header}}`, `{{char_name}}` variables and CNZ's `{{#if var}}…{{/if}}` blocks
   (empty component ⇒ the slot emits nothing). The deprecated `memory_recall` marker remains as a
   fused alias of all three (the legacy single block) for presets that haven't migrated.

Fail-open by contract: any error (embeddings provider down, DB hiccup) logs a warning and injects
nothing — retrieval must never break or stall a turn. The model itself has no recall tools since
2026-08-10: an RP chat's default `tool_names` is `DEFAULT_RP_TOOLS` = `[]` (and the server enforces
zero tools on every rp turn regardless of stored `tool_names`, `httpServer.ts`) — the RP lane just
executes its prompt stack. The tools were the old mid-turn escalation; auto-recall is the only
recall path now, and it never needed a model tool call.

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
- **Everything that configures how a chat behaves comes along too**: `params` (system prompt,
  temperature, model/profile), `tool_names`, `folder_id`, `kind`, `character_id`,
  `prompt_stack_preset_id`, and `cleanup_preset_id` are all copied verbatim from the parent. Only
  `title` (defaults to `Fork of {parent title}`, or an explicit override) and `canvas_note_id`
  (starts unfocused) are new. The intent is that forking never silently narrows a chat back down to
  defaults — the branch behaves exactly like the chat it came from until someone changes it.
- **`getLineage`** (`chatSessions.ts`) turns `parent_chat_id`/`fork_message_id` provenance into a
  navigable structure: given any chat in a fork family, it walks `parent_chat_id` up to the root and
  back down through every descendant, returning the whole family root-first. `GET
  /v1/chats/:id/lineage` exposes this to the frontend's Branch Map panel (`components/branchMap/`,
  summoned from the chat header's 🌳 button) — a read-only tree of the family, click any node to
  switch to it. This is what makes forking safe to leave unnamed: the relationship between branches
  lives in `parent_chat_id`, not in a naming convention a household member has to maintain by hand.
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
- **Ten prompts**, each **default + bespoke**: the six writer prompts (chunk summary, key-ideas
  digest, long-term memory, RP bridge, lorebook curator, people curator) plus the four RP read-path
  injection templates (bridge, plot threads, auto-recall wrapper, auto-recall chunk — the
  2026-08-13 component split, `io/chatMemory/memoryInjection.ts`). Every prompt ships a sensible
  built-in (`DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT`, `DEFAULT_DISTILL_CHAT_MEMORY_PROMPT`,
  `DEFAULT_HOUSEHOLD_MEMORY_PROMPT`, `DEFAULT_BRIDGE_PROMPT`, `DEFAULT_WORLD_MEMORY_CURATOR_PROMPT`,
  `DEFAULT_PEOPLE_CURATOR_PROMPT`, `DEFAULT_INJECT_BRIDGE_PROMPT`, `DEFAULT_INJECT_PLOT_PROMPT`,
  `DEFAULT_INJECT_AUTO_RECALL_PROMPT`, `DEFAULT_AUTO_RECALL_CHUNK_PROMPT`, each exported from its
  own `io/chatMemory/*.ts` module) and can be overridden freely; an empty override clears back to
  the default rather than needing a separate reset action. `docs/bi_principles.md` §17 makes this
  default-plus-bespoke shape a platform-wide requirement, not a one-off pattern local to this
  feature: any prompt driving an internal LLM call must be surfaced here or somewhere else in
  Settings. The key-ideas digest prompt is mutually
  exclusive with the other three RP-lane prompts per chat (`chat_sessions.kind` picks exactly one
  branch); the bridge/lorebook-curator/people-curator prompts all run together for every 'rp' chat,
  not exclusively.

All fourteen settings (`chat_memory_profile`, `chat_memory_live_window_pairs`,
`chat_memory_sync_every_pairs`, `chat_memory_digest_horizon_pairs`, `chat_memory_chunk_summary_prompt`,
`chat_memory_distill_prompt`, `chat_memory_household_memory_prompt`, `chat_memory_bridge_prompt`,
`chat_memory_world_curator_prompt`, `chat_memory_people_curator_prompt`,
`chat_memory_inject_bridge_prompt`, `chat_memory_inject_plot_prompt`,
`chat_memory_inject_auto_recall_prompt`, `chat_memory_auto_recall_chunk_prompt`) are read live — the
ten sync-side keys on every sync tick and the four injection templates on every RP prompt assembly
(the narrator stack reads them per turn, so a template save takes effect on the very next message,
no restart, same shape as `household_timezone`).

Each of these keys needed `orchestrator_settings.key`'s CHECK constraint widened before it could
actually be saved: the first six were added to application code in `0036`-`0041` but the constraint
itself was never widened to match until `0043` closed that gap alongside adding
`chat_memory_digest_horizon_pairs` fresh (see `db/migrations/README.md`'s `0043` entry);
`chat_memory_bridge_prompt` followed the same pattern in `0063`, and
`chat_memory_world_curator_prompt`/`chat_memory_people_curator_prompt` in `0065` (the world-memory
key itself renamed from `chat_memory_lorebook_curator_prompt` by `0087`).

## Tables

| Table | Scope | Lifecycle |
|---|---|---|
| `chat_sync_points` | per chat | bookkeeping only — records how far rolling sync has reached. Since 0079 also carries `bridge_prompt`: the fully-rendered prompt the 'rp' lane's bridge actually sent the model that pass, so the Sync Status panel's per-sync inspection can play it back |
| `chat_chunks` | per chat | archived turn-pairs + AI summary + embedding; reached via `recall_chat_history` (explicit tool call) and, for 'rp' chats, auto-injected every turn by the RP read path (`recallForPrompt.ts`) |
| `chat_memory_entries` | per chat | 'chat' lane: the always-injected "key ideas" digest, one row per `topic_key`. 'rp' lane: exactly two reserved rows, `topic_key` `'scene'`/`'events'`, written by the bridge. Same upsert-on-`(chat_id, topic_key)` mechanism either way. `sync_id` points at the sync that created or last updated the row (the upsert re-points it), which is exactly what per-sync inspection reads |
| `household_memory` | per household member, cross-chat | populated once at explicit archive; outlives its source chat; 'chat' lane only |
| `canon_facts` (`category = 'plot'`) | per chat | 'rp' lane's plot entries — `'proposed'` rows written by the bridge, promoted to `'approved'` at the chat's next sync tick, latest-per-`arc_tag` is the live state. `sync_id` (0079) attributes each proposal to the sync that wrote it |
| `canon_facts` (`category in ('place','thing','concept','person')`) | per chat | 'rp' lane's lorebook/people entries — `'proposed'` rows written by the two curators, same promotion, latest-per-`entity_key` is the live state. `sync_id` (0079) attributes each proposal to the sync that wrote it |

`entity_key` (`0064_canon_facts_entity_key.sql`) is deliberately a separate column from `arc_tag`,
not a reuse of it, even though both exist purely to give `recallCanonFactsTool.ts`'s dedup query a
group key and the SQL shape (`distinct on (coalesce(arc_tag, entity_key, fact_id::text))`) is
identical either way. `arc_tag` groups successive proposals into one continuing *plot arc*;
`entity_key` groups successive proposals into one continuing *dictionary entry* for a named person/
place/thing/concept — different kinds of identity that happen to want the same recall mechanism. A
`plot` fact never sets `entity_key`; a curator-produced fact never sets `arc_tag`; turn-time
`propose_canon_fact` facts (any category) set neither and dedup to their own `fact_id`.

## What's Different From Canonize, and Why

| Canonize | Chat Memory | Why |
|---|---|---|
| General lorebook (place/thing/concept, free-text world model) | The world-memory curator (`curateWorldMemory.ts`), 'rp' lane only — a near-verbatim port, see "The Curators (RP Lane)" above | Same call as the plot lorebook below: this is a real feature Canonize was built for, not a redundant shadow of the relational store — `canon_facts` (via `entity_key`) is the one canonical home for it, not a second un-reconciled copy |
| Person lorebook (living character cards: appearance/personality/connections/goals) | The people curator (`curatePeople.ts`), 'rp' lane only — a near-verbatim port, see "The Curators (RP Lane)" above | Same reasoning as the general lorebook row; kept as its own curator/prompt because Canonize itself keeps it as a dedicated pass, not folded into the general one |
| Keyword-triggered lorebook activation ("Keys:" per entry) | Dropped — not ported | `docs/spec.md`'s vector recall (`recall_canon_facts`) replaces keyword-lorebook matching outright; there is no keyword-match fallback anywhere in this schema for a generated key to ever reach |
| Targeted on-demand entry refresh/creation (`targetedUpdatePrompt`/`targetedNewPrompt`) | Not ported | Explicit scoping call: periodic batch curation only for now: the two curators above already keep every entry current every sync tick |
| Plot lorebook (hookseeker: EVENTS + SCENE + arc-tagged plot entries) | The bridge (`bridgeChatMemory.ts`), 'rp' lane only — a near-verbatim port, see "The Bridge (RP Lane)" above | This *is* the storytelling-continuity mechanism Canonize was built for; an RP-kind chat gets the real thing, not a simplified reinterpretation |
| Silent RAG injection every turn | **'rp' lane: yes, CNZ-style auto-recall at prompt assembly** (see "The RP Read Path" above); 'chat' lane: no — `recall_chat_history` stays an explicit tool call | User decision (2026-08-08): the RP read path autopopulates the recall from the last turn-pairs, "the way CNZ works", pulling both approved facts and full-turn texts — with the recall tools still enabled alongside so the model can escalate mid-turn. The household 'chat' lane keeps the strict §2 stance |
| Hash-linked anchor chain + branch detection | FK cascade (`on delete cascade`) + fork-as-new-row | BigImagine owns its own mutations; no need to detect what it caused itself |
| Wholesale lorebook/scene snapshot restore | Same idea, narrower: entries dropped rather than reconstructed pre-fork | Accepted simplicity trade, not a correctness gap in the common case |
| Bridge-summary horizon defaults to 40 pairs, a full wholesale re-read every sync ('chat' lane's own analogue only — the RP bridge has no horizon setting, it always reads the live raw transcript) | Digest horizon defaults to 24 pairs, a revision window on top of persisted state | The key-ideas digest already carries state forward as `chat_memory_entries` rows across syncs; Canonize's bridge summary has no equivalent persistent entries of its own, so its horizon has to do all the continuity work alone |
