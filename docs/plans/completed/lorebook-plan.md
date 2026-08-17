# Lorebook — Implementation Plan

## 0. Naming, and a companion rename it depends on

"Lorebook" should mean what it universally means to anyone importing a `.json` file from another
platform: a book of `key`/`keysecondary`-triggered entries, string-matched into the prompt with no
LLM in the loop. That's what this document specifies, and it's exactly what `0051_lorebooks.sql`
already named `lorebooks`/`lorebook_entries` — this plan builds on those tables as-is, no rename
needed on that side.

The collision is on the other side. `docs/chat-memory.md`'s Tables section calls `canon_facts` rows
with `category in ('place','thing','concept','person')` *"the RP lane's lorebook/people entries,"*
and the code backing them is more deeply "lorebook"-named than that one doc line suggests —
`curateLorebook.ts`, `DEFAULT_LOREBOOK_CURATOR_PROMPT`, `LorebookCuratorEntryDraft`, a settings key
persisted in `orchestrator_settings` as the literal string `chat_memory_lorebook_curator_prompt`, an
admin API field (`lorebookCuratorPrompt` / wire `lorebook_curator_prompt`), and UI copy in
`RagView.tsx` ("Lorebook curator prompt (place / thing / concept)"). None of that is what a lorebook
is anywhere else — it's an LLM curator pass that writes rows into the same approval-gated,
vector-recalled table plot/person facts use. It's memory. `docs/chat-memory.md`'s own title already
calls the umbrella system "Chat Memory"; this rename just makes the place/thing/concept slice of it
stop fighting that name.

**Companion rename (do this first, as its own change, before any Lorebook schema work):**

| Old | New |
|---|---|
| `orchestrator/src/io/chatMemory/curateLorebook.ts` | `curateWorldMemory.ts` |
| `curateLorebook()`, `DEFAULT_LOREBOOK_CURATOR_PROMPT`, `LorebookCuratorEntryDraft` | `curateWorldMemory()`, `DEFAULT_WORLD_MEMORY_CURATOR_PROMPT`, `WorldMemoryCuratorEntryDraft` |
| settings key `chat_memory_lorebook_curator_prompt` | `chat_memory_world_curator_prompt` |
| `lorebookCuratorPrompt` / `lorebook_curator_prompt` (adminServer.ts, api/types.ts, api/client.ts) | `worldCuratorPrompt` / `world_curator_prompt` |
| `RagView.tsx` label "Lorebook curator prompt" | "World memory curator prompt" |
| `chatMemorySync.ts` locals (`lorebookResult`, `lorebookCuratorPrompt`, step names `curate_lorebook`/`upsert_lorebook`) | `worldMemoryResult`, `worldCuratorPrompt`, `curate_world_memory`/`upsert_world_memory` |

The settings key rename needs an actual migration, not just a code change — `orchestrator_settings`
rows are live data (Principle 13), so a settings row written under the old key must not silently
stop being read. Migration does `update orchestrator_settings set key =
'chat_memory_world_curator_prompt' where key = 'chat_memory_lorebook_curator_prompt'` and widens the
CHECK constraint accordingly, same pattern `0048`/`0043` already used for CHECK-list changes.
`canon_facts.category` values (`'place'`/`'thing'`/`'concept'`) are untouched — only the *curator
that writes them* was ever "lorebook"-named, not the data itself.

## 1. Why this needs reconciling with existing architecture at all — and why less than it first looked

`docs/spec.md` states three times, in explicit terms, that this platform's semantic recall
replaces keyword lorebooks and that there is no keyword-match fallback in the schema. `0051`'s own
header says the same: storage only, not wired into the prompt stack, "in case it's ever used."
`bi_principles.md` §2 puts all reasoning in the LLM; §4 requires every turn's scope to come from
explicit scene state, "never inferred by parsing the message text."

ST's World Info conflates two separate jobs under one "activation" concept: **discovery** (is this
entry relevant right now — ST does this by substring-matching `key`/`keysecondary` against recent
message text) and **gating** (given a relevant entry, should it actually fire this turn —
probability, sticky/cooldown/delay, inclusion groups, budget). Only discovery is the thing `spec.md`
and §2/§4 were written to rule out. Gating isn't a relevance mechanism at all — it's a set of pacing/
variance controls layered on top of relevance, and nothing in this codebase already does that for
any content type.

So this plan doesn't build ST's discovery mechanism. §5 replaces it with the same
`vector_embed <->` similarity search `recall_canon_facts`/`recallForPrompt.ts` already use — the
exact mechanism `spec.md` calls "the platform's entire lorebook-replacement mechanism." A lorebook
entry becomes relevant the same way a canon fact does; ST's `key`/`keysecondary` substring scan is
not ported at all, not even as a fallback. What this plan actually adds on top of the existing
recall pattern is the gating layer §5 describes, which is new. That's a much narrower, much more
defensible addition than a parallel keyword-discovery engine would have been, and §6 is
correspondingly short.

## 2. Product decision (confirmed)

- Canon Facts / `recall_canon_facts` semantic recall (née "Chat Memory," per §0) remains the
  platform default and is never disabled by this feature. Every chat has it whether or not Lorebook
  is touched.
- Lorebook is off by default, per user, and opt-in per character/chat. A global setting
  (`lorebook_settings.mode`, §3d) governs the default; a per-chat override can turn it on or off for
  one conversation without touching the global default.
- When Lorebook is off (the default), the sidebar and management page both say so plainly —
  "Lorebook is off. Chat Memory (semantic recall) is doing this job." No dead UI pretending to be
  live.

## 3. Data model

### 3a. What already exists — reuse it

`0051_lorebooks.sql` already created `lorebooks` and `lorebook_entries`, RLS-scoped the same way
every other table in this schema is, with `source_json` holding the complete original ST entry
verbatim. This plan adds columns and sibling tables to those two; it renames neither.

### 3b. Scoping — reuse the `canon_facts` pattern, don't reinvent it

`canon_facts` already solved "which chat/scene/character does this apply to" via `chat_id` +
`scene_id` + `linked_character_ids`, orthogonal per `0054_canon_facts_chat_anchor.sql`'s own
comment. Lorebook scoping should be the same shape, not a bespoke pair of junction tables:

- `lorebook_character_links (lorebook_id, character_id, user_id)` — many-to-many, same shape as
  `scene_presence`. Loading a character brings its books into scope.
- `lorebook_chat_overrides (chat_id, lorebook_id, user_id, enabled)` — per-chat on/off for a book
  that's in scope via a character or the global-scope flag, without touching the book itself. A row
  here beats the book's default; no row means "use the default."
- `lorebook_entry_overrides (chat_id, entry_id, user_id, enabled)` — same idea, one level down, for
  the sidebar's per-entry Quick Toggles.
- A `lorebooks.global_scope boolean` column (new) marks a book as in-scope for every chat regardless
  of character links — the draft's "Global Scope flag."

### 3c. Gating columns, plus one discovery column

`0051` already has `key`, `keysecondary`, `constant`, `selective`, `disable`, `order_value`,
`position`, `probability`, `depth`, `group_name` — everything else lives only in `source_json`, per
that migration's own comment. Since discovery is now vector recall (§5), not a keyword scan, most of
what needs promoting to real columns is the *gating* logic, matching `world-info.js`'s
`newWorldInfoEntryDefinition` fields that control firing rather than relevance:

`use_probability boolean`, `group_weight integer`, `group_override boolean`, `sticky integer`,
`cooldown integer`, `delay integer`.

Plus one new discovery column: `vector_embed vector(2048)` — same width as `canon_facts.vector_embed`
(`0047`'s comment: matches the repo's Voyage AI embedding width; no index, pgvector's hnsw/ivfflat
cap out below 2048 dims, so this is a brute-force scan over the scoped candidate set, same as every
other vector search in this schema). Populated at create/import/update time by embedding `content`
(`comment` prefixed in, same `"${name}\n${content}"` shape `chatMemorySync.ts` already uses for
canon facts), via the existing `EmbeddingProvider.embed()` IO wrapper — no new embedding
infrastructure needed.

`key`/`keysecondary` are kept as columns (browsing/filtering in the management UI, round-trip
fidelity) but are **not evaluated at runtime** — see §9. `selective`/`selective_logic` (ST's
AND_ANY/AND_ALL/NOT_ANY/NOT_ALL keyword-combination logic), `scan_depth`, `case_sensitive`,
`match_whole_words` are dropped entirely, not promoted to columns at all — they exist only to serve
keyword discovery, which this plan doesn't build. `exclude_recursion`/`prevent_recursion` are also
dropped with recursion itself (§9).

Left in `source_json` only, never modeled as columns: `characterFilter` (persona/character
allow-list for activation), `matchPersonaDescription` and its four siblings, `automationId`/
`triggers` (ST's slash-command automation hooks), `addMemo`. None of these have an obvious
BigImagine equivalent and none block import/export fidelity since `source_json` already carries
them.

### 3d. `lorebook_settings` — DB-backed, per §13

Follows the `orchestrator_settings` key/value + CHECK-list convention `canon_settings`
(`0048_canon_settings.sql`) already established, not a new bespoke settings table:

- `lorebook_mode` — `'off'` (default) | `'on'`. The global default; per-chat overrides live via the
  same override-row pattern as §3b, not a new `chat_sessions` column (`0009`'s own comment already
  restricts `params` to a fixed key set).
- `lorebook_token_budget` — max tokens the resolved entries may consume; entries beyond budget are
  dropped least-similar-first (§5), `order_value` as tiebreak — not the draft's "lowest order_value
  first," since relevance rank now exists and is a better signal than a static priority number.
- `lorebook_recall_top_k` — how many candidates the vector search returns before gating runs, same
  role `canon_recall_top_k` (`canon_settings`, `0048`) already plays for Chat Memory. Replaces ST's
  `scan_depth` concept: instead of "scan the last N messages for keyword hits," it's "take the top K
  most-similar entries," matching how `recall_canon_facts` already frames the same problem.
- `lorebook_recursion_enabled` — global kill switch for recursive scanning (§9: ships disabled, this
  setting exists so it's a config flip later, not a redeploy).

### 3e. `lorebook_activation_log` — the audit trail *and* the timed-effect state

The draft's "IDs sent back with the response payload" is ephemeral — fine for painting a badge,
useless for satisfying §16 ("individually removable, traceable to a row") or for computing `sticky`/
`cooldown`, both of which need "was this entry active as of message N." One table does both jobs:

`(activation_id, chat_id, message_id, entry_id, user_id, activated_at)` — one row per entry per
assistant turn it was injected into. The sidebar's Live Activation Indicator reads the rows for the
latest `message_id`. The Pure evaluator (§4) reads the rows for the last N turns to resolve sticky
(still-active-until) and cooldown (blocked-until) without a separate mutable state table drifting
out of sync with the log.

## 4. Engine processing — by role, per §8

- **IO Wrapper** `recallLorebookEntries(userId, characterId, chatId, queryText, topK)` — embeds
  `queryText` (the recent-turn text, same input `recallForPrompt.ts` already builds) via
  `EmbeddingProvider.embed()`, then a `vector_embed <->` scan over the §3b-scoped candidate set,
  `constant` entries included unconditionally, everything else ranked by distance and cut at
  `topK` (`lorebook_recall_top_k`). Structurally a sibling of `recallCanonFactsTool.ts`, not the
  same function — different table, no proposal/approval status to filter on, different (gating)
  columns to return alongside each hit.
- **IO Wrapper** `fetchLorebookTimedEffectState(chatId, entryIds)` — recent `lorebook_activation_log`
  rows for the candidate set, feeding sticky/cooldown/delay resolution.
- **Pure Function** `gateLorebookCandidates(candidates, timedEffectState, turnSeed)` → activated
  entry ids + which were skipped and why (probability roll, cooldown, group loss, budget cut).
  Deterministic given its inputs — critically, `turnSeed` (derived from the assistant `message_id`
  being generated, not `Math.random()`) makes the probability roll (§5) reproducible and keeps this
  function pure per §8, not a hidden source of prompt-cache-breaking nondeterminism. Discovery
  already happened in the IO step above; this function only ever narrows a candidate set, never
  looks at message text.
- **IO Wrapper** `writeLorebookActivationLog(chatId, messageId, activatedEntryIds)` — called after
  the turn completes, same "write after, not during" shape `chatMemorySync.ts` already uses.
- **Orchestrator** — a new `resolveLorebook()` step in the turn loop (`plans/turn-loop-plan.md`'s step 2,
  alongside the existing canon-facts/memory-recall resolution), sequencing recall → fetch timed-effect
  state → gate → format into a flat string → hand to `assemblePromptStack`. Owns no state, does no IO
  itself, decides nothing about what the data means — only the order these calls happen in.

## 5. Discovery (vector recall) + gating (ported from `world-info.js`, ST source, gating fields only)

**Discovery** — `recallLorebookEntries` (§4). `constant` entries are always candidates (ST's own
"always active" flag, kept because it's not a relevance mechanism — it's an explicit "never
discover this, just always include it" author choice, same tier as pinning). Everything else is
ranked by `vector_embed <-> query` distance against the recent-turn text and cut at
`lorebook_recall_top_k`. No `key`/`keysecondary` substring matching anywhere in this path.

**Gating** — `gateLorebookCandidates` (§4). Reference for the mechanics below:
`stacks/sillytavern/st-source/public/scripts/world-info.js`, `newWorldInfoEntryDefinition`
(~line 4002) and the probability/group logic around lines 4881–5480 — only the fields listed in
§3c are ported; the keyword-matching fields around them are not.

- **Probability** — the actual "randomness" the user originally asked about, and the one piece of
  ST's mechanism that survives unchanged: even a vector-relevant entry only fires if
  `use_probability` and a per-turn roll (seeded per §4) falls within `probability`%. A sticky-active
  entry (below) skips the re-roll — ST's own rule, `entry.sticky ? skip : roll`.
- **Inclusion groups** — entries sharing a non-empty `group_name` compete: normally only one member
  of the group activates per turn, chosen by weighted random over `group_weight` (ST's
  `filterByInclusionGroups`); `group_override` makes a member always win its group outright instead
  of rolling. Groups are evaluated over whatever discovery already returned — a group can't pull in
  an irrelevant sibling entry just to compete.
- **Timed effects** — `sticky` (N): once activated, stays active for N further turns without needing
  to be rediscovered. `cooldown` (N): once deactivated, can't reactivate for N turns even if
  rediscovered. `delay` (N): can't activate until the chat has ≥N messages. All three are resolved
  from `lorebook_activation_log` (§3e), not a separate counter column, so there's one source of
  truth for "was this active."
- **Budget** — after gating, entries are added to the prompt in similarity-rank order (closest
  first, `order_value` as tiebreak) until `lorebook_token_budget` is spent; the rest are dropped for
  that turn (still logged as "discovered but budget-cut," not silently missing — §11
  observability).
- **Recursion** — ships disabled for v1 regardless of the settings flag existing; see §9.

## 6. The §2/§4 carve-out, written down explicitly

Discovery isn't actually an exception to §2/§4 at all — it's `vector_embed <->` similarity search,
the identical mechanism `recall_canon_facts` already runs, over a table populated by explicit
authorship or import (§3 of `bi_principles.md`: "explicit user signal outranks inferred signal") —
a lorebook entry existing at all is already a direct user action, not an inference. It never sets
`scene_id`, never touches `scene_presence`, never decides which character is present or which
location is active; those stay exactly as owned by `scenes`/`scene_presence` as §4 requires.

The one genuinely new piece is gating (§5): probability, sticky/cooldown/delay, and inclusion
groups are outcome-randomizing controls with no LLM call and no judgment about what anything means —
closer to a dice roll than reasoning. They only ever narrow a set vector recall already decided was
relevant; they can't promote an irrelevant entry into the prompt. Combined with §2's default-off
posture, the platform's default behavior (semantic recall only, no keyword fallback) is unchanged
for anyone who never opts in.

## 7. Prompt injection integration point

New `MarkerKey`: `'lorebook'`, registered in `assemblePromptStack.ts`'s `MARKER_LABELS` (`Lorebook`)
exactly like `canon_facts` is today, so it's a slot users can position in a `context_stack_preset`
like any other marker. `resolveLorebook()` (§4) fills `PromptStackFields.lorebook` with the
formatted, budget-trimmed entry texts before `assemblePromptStack` runs; the assembler itself stays
untouched and still pure.

A dedicated slot, not folded into the existing `canon_facts` marker — `chat-memory.md`'s own system
already spans five separate markers (`canon_facts`, `memory_recall`, `bridge`, `plot_threads`,
`auto_recall`) for what it calls one umbrella system, so a sixth for a genuinely distinct source
follows precedent rather than breaking it. More concretely: `canon_facts` rows carry a provenance
lorebook entries lack (`0051`... `canon_facts` are LLM-*proposed*, live immediately, then firmed
up to `approved` at the next sync per §15) — lorebook entries are directly authored or imported,
no extraction step at all — and merging the two into one text
block would hide that distinction from anyone reading the assembled prompt. It would also cost the
Prompt Inspector's per-slot tag boundary (`0085`/`0086`'s `<Name>...</Name>` wrapping): a dedicated
slot gets its own `<Lorebook>` tag in the inspector, so "is Lorebook on for this chat" (§2) stays a
visible, inspectable fact rather than silently changing the size of the `canon_facts` block. Costs
nothing structurally — one more field key doesn't change `assemblePromptStack`'s pure-function shape
or hurt its caching.

**Non-goal for v1:** ST's per-entry `position`/`depth` (inject *this* entry N messages back into
history, independent of every other entry) has no equivalent in BigImagine's fixed-ordered-slot
assembler — there's one `lorebook` slot, not one slot per entry. `position`/`depth` stay on
`lorebook_entries` (already present since 0051) purely for import/export round-trip fidelity; they
are not read by the evaluator or the assembler in v1. If deep depth-placement fidelity turns out to
matter, `0086`'s slot-group mechanism is the extension point to revisit, not a special case bolted
onto the assembler.

## 8. UI

### 8a. Management page

`frontend/src/views/LorebooksView.tsx`, wired into `App.tsx`'s tab-type switch and `AppNavDrawer`
exactly like `CanonQueueView`/`RagView` (same `apiKey`-prop, same tab-summon pattern). Library list
(entry count, character attachments, enabled state), entry editor (keys, logic mode, priority,
activation-mechanics fields from §3c), the settings panel from §3d, and an import/export hub —
import parses an ST world-info JSON export (`{ name, entries: { [uid]: entryObject } }`, per
`0051`'s own header comment) into `lorebooks`/`lorebook_entries` rows, `source_json` capturing the
verbatim original; export reverses it losslessly per §7 of `bi_principles.md`.

### 8b. Chat sidebar

`frontend/src/components/lorebook/LorebookPanel.tsx`, wired into `ChatView.tsx` the same way
`CanvasPanel` already is: same mobile-full-pane-swap class pattern (`mobile-show-lorebook`, not a
desktop-only fixed-right-edge panel — the draft's "collapsible panel on the right edge" breaks §18 on
a phone unless it follows this existing swap pattern), a toggle button next to the existing Canvas
toggle, offered on any chat per §5 of `bi_principles.md`, not just `'rp'` chats.

Content: active-books accordion (from §3b's links/overrides), live activation badges (reads
`lorebook_activation_log` for the latest `message_id`), quick toggles (write
`lorebook_entry_overrides`/`lorebook_chat_overrides`), and quick-add — inserts a `lorebook_entries`
row into a lazily-created, chat-scoped book (auto-created on first quick-add, linked only via a
`lorebook_chat_overrides` row for that one chat) rather than a separate "chat note" concept.

When `lorebook_mode` resolves to off for this chat (§2), the panel replaces all of the above with a
one-line status and a link to Chat Memory / the RAG view — never a blank or half-populated panel.

## 9. Non-goals (v1)

- **Keyword-substring discovery** (`key`/`keysecondary` matching, `selective`/`selective_logic`,
  `scan_depth`, `case_sensitive`, `match_whole_words`) — dropped outright per §1/§5, not deferred.
  Vector recall replaces it; these fields are kept as columns (`key`/`keysecondary`) or left in
  `source_json` only (the rest) purely for import/export round-trip, never read by the evaluator.
  Reviving keyword discovery later would be a real design decision, not a "turn a flag on."
- **Recursion** (lore triggering lore) — real perf/cardinality risk (each activated entry's content
  becoming a second scan pass, potentially unbounded without careful depth-limiting) and the draft
  only asked for a toggle, not a design. Ships as a settings row that does nothing yet (§3d), not as
  working code, so turning it on later is a logic change, not a schema change.
- **Per-entry dynamic depth-in-history placement** — see §7.
- **Character/persona-description filter fields** (`matchPersonaDescription` and siblings) — kept in
  `source_json` for round-trip only; not evaluated.
- **Automation triggers** (`automationId`/`triggers`, ST's slash-command hooks) — no BigImagine
  equivalent exists to trigger; `source_json` only.

## 10. Build order

0. Companion rename (§0): `curateLorebook.ts` → `curateWorldMemory.ts` and everything downstream of
   it, including the `orchestrator_settings` key migration. Land and deploy this first, separately —
   it touches live settings data and shouldn't be bundled with net-new schema work.
1. Migration: `lorebook_*` scoping tables (§3b), activation-mechanics columns on `lorebook_entries`
   (§3c), `lorebook_activation_log` (§3e); widen `orchestrator_settings`'s key CHECK for the §3d
   keys, same pattern `0048`/`0043` used.
2. IO wrappers (§4): fetch, write-log.
3. Pure evaluator (§4/§5) + unit tests over the ST semantics in §5 — this is the highest-value place
   for tests given how much branching logic (probability, groups, timed effects) it carries.
4. Orchestrator wiring: `resolveLorebook()` into the turn loop, new `lorebook` `MarkerKey`.
5. Settings route (mirrors `orchestratorSettings.ts`'s existing read/write pattern) +
   `LorebooksView.tsx` minus import/export.
6. `LorebookPanel.tsx` in `ChatView.tsx`.
7. Import/export hub, last — it's the one piece with no dependents, and getting the ST JSON parse
   right benefits from the columns it's populating already existing and already tested.

## 11. Open questions

- Does `lorebook_token_budget` share a pool with Chat Memory's own recall budget, or is it
  independent? The draft implies independent; nothing in the current schema pools context budgets
  across markers today, so independent is the default unless told otherwise.
- Quick-add's lazily-created chat-scoped book: does it need its own `is_scratch boolean` flag so the
  management page can visually distinguish "a real book" from "accumulated chat notes," or is that
  over-modeling a case the accordion's grouping already handles for free?
- Should `recallLorebookEntries` (§4) share literal code with `recallCanonFactsTool.ts`'s query
  shape (both are "embed a query, scan a scoped table by `vector_embed <->`, cut at top-K"), via a
  small shared helper, or stay a fully separate function since the two tables have different
  scoping joins and neither has a `status` filter the other needs? Leaning separate given how thin
  the actual shared logic is once the joins differ, but worth a look once both exist side by side.
- `lorebook_recall_top_k` needs a sane default before anyone tunes it — `canon_recall_top_k`'s
  existing default (check `canon_settings`) is the obvious starting point rather than guessing fresh.
