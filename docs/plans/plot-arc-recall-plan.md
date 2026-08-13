# Plot Arc Recall — Ranked, Bounded, Append-Only-Aware

## Goal

Replace `plot_threads`' current behavior — an unranked, unbounded dump of every open plot arc's
latest row — with a ranked, bounded retrieval that treats plot beats the way Canonize's own Plot
RAG lane does: every beat is a permanent, individually-embedded record; each turn surfaces only the
arcs relevant to *this* turn, each rendered as a first-entry + last-three-entries card. This fixes
an unbounded per-turn cost/attention-dilution growth problem (documented in this plan's originating
conversation: ~40 tokens/entry × 3 new arcs/sync means the current design crosses over to being
*more* expensive than a bounded design within roughly 10 sync cycles, and keeps getting worse) and
brings plot recall to actual parity with the CNZ source it was ported from. Folded into the same
change: a status-filter bug in `recallFactLane.ts` that excludes every category of newly-proposed
fact (not just plot) from auto-recall for a full sync cycle.

## Principle flag — resolved 2026-08-13

This plan originally flagged a conflict with `bi_principles.md` §15, which at the time read "Canon
Requires Approval Before It Becomes Truth" and stated that only `approved` facts were ever
injected. That text was invented — nothing in this codebase ever built the manual review gate it
described; `promote_canon_facts` runs unconditionally at the start of every sync tick, so
`proposed` vs. `approved` always meant only "created this sync cycle" vs. "survived to the next
one," never "unreviewed" vs. "reviewed." §15 has since been rewritten ("A Proposed Fact Is Already
Live") to say exactly what this plan does: a `proposed` row is already live, and the
silent-injection paths (`recallFactLane.ts`, `recallPlotLane.ts`) select anything that isn't
`rejected`. There is no remaining conflict to resolve.

`recallCanonFactsTool.ts` (the explicit `recall_canon_facts` tool-call path) still keeps its own
`status = 'approved'` filter, which is now an open question rather than a settled exception — its
comment used to cite the old §15/§16 as its rationale, and that rationale no longer exists in the
form it was written against. See that file's own comment (and `bi_principles.md` §15) for the
current state of that question; this plan still does not touch it.

## Files

- `orchestrator/src/io/chatMemory/recallFactLane.ts` — modified. Line 72: `f.status = 'approved'`
  → `f.status <> 'rejected'`. Line 77's `order by ..., approved_at desc` tie-break needs to fall
  back to `proposed_at` when `approved_at` is null (a freshly-proposed row has no `approved_at` yet
  and must not lose the per-arc/entity dedup to a stale approved row for the same key purely
  because the stale row has a non-null timestamp).
- `orchestrator/src/io/chatMemory/recallPlotLane.ts` — new file. The plot-specific ranked retrieval
  lane, sibling to `recallChunkLane.ts`/`recallFactLane.ts` (same directory, same `bi_principles.md`
  §10 one-purpose-per-file convention that split those two apart originally).
- `orchestrator/src/server/promptAssembly.ts` — modified. `buildChatMemorySystemPrompt`'s rp branch
  (currently lines 96-114): replace the `plotRows` query (lines 101-107, the unranked
  `distinct on (arc_tag) ... status = 'approved'` read) with a call into the new
  `recallPlotLane.ts`, using the same query vector `buildAutoRecallParts` already computes this
  turn (see Contracts — avoid embedding the same query text twice per turn).
- `orchestrator/src/io/chatMemory/memoryInjection.ts` — modified. `PlotArcRow` (currently
  `{ arc_tag, summary, detail? }`, one row = one arc's latest state) becomes a per-arc card shape
  carrying multiple entries. `renderPlotThreads` updates to render each arc's entries inside its
  `<arc_tag>` wrapper. `RpMemoryContext.plotThreads`'s type follows.
- `orchestrator/src/io/orchestratorSettings.ts` — modified. Two new settings keys added to the
  documented list (mirrors `canon_recall_top_k`/`canon_recall_min`'s doc comment shape).
- `db/migrations/0097_plot_recall_bounds.sql` — new file. Widens `orchestrator_settings_key_check`
  to include the two new keys, same wholesale-rebuild pattern as `0081_recent_history_slot.sql`
  (full current key list, not just the diff — confirm against the live constraint via
  `pg_get_constraintdef` before writing, same as `0081`'s own note).
- Frontend settings surface (wherever `canon_recall_top_k`/`canon_recall_min` are exposed today —
  likely the Rag page's Retrieval fieldset per `docs/chat-memory.md`'s settings section) — modified,
  to add the two new plot-recall knobs alongside the existing fact-lane ones.
- `orchestrator/scripts/verify-*.mjs` (whichever fake-pool scripts exercise `buildChatMemorySystemPrompt`
  or `recallFactLane`/prompt assembly for an 'rp' chat — likely `verify-chat-memory-sync.mjs` and/or
  the prompt-assembly verify script) — modified. New query shapes need matching fake-pool branches;
  this has bitten past sessions (the fake pool matches by exact SQL substring) and is called out
  explicitly so it isn't missed.

## Logic

**Status filter (recallFactLane.ts).** Change the `WHERE` clause from `status = 'approved'` to
`status <> 'rejected'`. Nothing currently sets `status = 'rejected'` anywhere in the codebase (it
exists only in the CHECK constraint, reserved for a future manual-review action) — this change is
currently equivalent to "no status filter" in practice, but should be written as `<> 'rejected'`,
not removed entirely, so a future rejection feature is respected automatically once it exists rather
than needing this filter re-added.

**Plot arc selection (recallPlotLane.ts).** Given the same query vector `buildAutoRecallParts`
already embeds this turn (see Contracts), and the same `min`/`max`/`poolMultiple`/`cutoffMode`
shape the other two lanes use:

1. Fetch a candidate pool of *individual* `category = 'plot'`, `status <> 'rejected'` rows for this
   chat, ranked by vector distance to the query — deliberately **not** deduped to one row per arc
   first, unlike `recallFactLane`'s existing dedup. An older beat of a still-open arc must be able
   to win on relevance even when that arc's latest beat doesn't match the current query well —
   this is what makes an arc "come back into focus" when the story circles back to it. Reduce the
   ranked pool to one entry per `arc_tag` by keeping each arc's best-scoring row (first occurrence
   in rank order), preserving that best score as the arc's representative score.
2. Apply the existing `recallCutoff.ts` `applyCutoff` function to the arc-level representative
   scores (same min/max/cutoffMode knobs, new setting values — see Contracts) to decide how many
   arcs clear the bar.
3. Recency floor: separately identify arcs with at least one row belonging to the chat's most
   recent `N` sync ticks (by `sync_id`/`chat_sync_points.ordinal` recency, not wall-clock time —
   sync ticks are the natural "how long ago" unit here, matching every other timing knob in this
   feature). Union these arcs into the selected set regardless of whether they cleared the semantic
   cutoff, so a thread that's clearly active right now can't drop out purely because its wording
   didn't embed close to the query. This mirrors Canonize's "supplemented by recency-based filler."
4. Cap the final selected-arc count at the Max setting (selection-cutoff arcs and recency-floor
   arcs combined, deduplicated) — the floor is a guarantee of inclusion, not an addition on top of
   an already-full Max.
5. For each selected `arc_tag`, run a second query: this chat's full row history for that arc
   (`status <> 'rejected'`, ordered by `proposed_at`). Reduce to first entry + last three entries,
   deduplicated when the arc has four or fewer total entries — direct port of Canonize's
   `buildExistingThreads` (`stacks/sillytavern/st-extensions/SillyTavern-Canonize/core/sync.js`,
   lines 63-101: first entry + `slice(-3)`, deduplicated when `entries.length <= 4`).
6. Return the selected arcs as an ordered list of `{ arc_tag, entries: [...] }` cards (order:
   by representative score, recency-floor-only arcs appended after the scored ones — exact
   ordering is not a contract, just needs to be deterministic for a given input so the assembled
   stack's byte-prefix stays cache-stable).

**Wiring (promptAssembly.ts).** `buildChatMemorySystemPrompt`'s rp branch currently computes
`plotRows` as its own parallel query alongside `bridgeRows` and `autoRecall`. Replace it with a
call into the new lane. The query vector must be computed once and shared — `buildAutoRecallParts`
already embeds the same trailing-turn-pairs query text for the chunk/fact lanes; either lift the
embed-once step up a level so all three lanes (chunk, fact, plot) share one embedding call, or have
`recallPlotLane` accept a pre-computed vector the same way `recallFactLane`/`recallChunkLane`
already do (`vector: number[]` parameter) — this is the natural fit given the existing lane
signatures, see Contracts.

**Rendering (memoryInjection.ts).** `renderPlotThreads` currently maps one row per arc to one
`<arc_tag>\nsummary — detail\n</arc_tag>` block. Update it to join each arc's `entries` array inside
the wrapper (blank-line separated, same "2-4 sentences, past tense" prose shape each entry already
has from the bridge's own writing prompt — no new formatting logic needed there, just render more
than one entry per arc). The `{{plot}}` template variable's *contract* is unchanged — it's still one
pre-formatted string handed to `DEFAULT_INJECT_PLOT_PROMPT` — only what's inside that string grows
from one line per arc to a small card per arc.

## Contracts

- `recallPlotLane(session: DbSession, userId: string, chatId: string, vector: number[], opts: { min: number; max: number; poolMultiple: number; cutoffMode: CutoffMode; recencyFloorSyncs: number }) => Promise<{ arcs: PlotArcCard[] }>`
  — mirrors `recallFactLane`'s signature shape exactly, plus the one new `recencyFloorSyncs` option.
- `PlotArcCard { arc_tag: string; entries: { summary: string; detail: string }[] }` — replaces the
  current `PlotArcRow { arc_tag: string; summary: string; detail?: string }` in
  `memoryInjection.ts`. `RpMemoryContext.plotThreads: PlotArcCard[]` follows. `detail` becomes
  non-optional-empty-string on each entry (matches the `canon_facts.detail` column's own
  `not null default ''` shape — no new optionality introduced).
- Two new settings keys, following the existing `canon_recall_top_k`/`canon_recall_min` naming and
  default/fallback-constant pattern exactly:
  - `chat_memory_plot_recall_top_k` (Max, integer-as-text, suggest default `6` — fewer than the
    general fact lane's `8` default since each result here is a multi-entry card, not one line)
  - `chat_memory_plot_recall_min` (Min, integer-as-text, suggest default `1`)
  - `chat_memory_plot_recall_floor_syncs` (recency floor, integer-as-text, suggest default `2` —
    guarantees an arc touched in the last two sync ticks stays visible regardless of score)
  - Pool multiple and cutoff mode are **not** duplicated as new settings — reuse the existing
    shared `chat_memory_auto_recall_pool_multiple` / `chat_memory_auto_recall_cutoff_mode` values,
    same as `recallFactLane` and `recallChunkLane` already share them.
- Per-arc card size (first + last-3) is **not** a new setting — hardcode it as a named constant
  (e.g. `PLOT_ARC_CARD_SIZE = 3`), matching Canonize's own source, which never made this number
  configurable either. Flagged here as a deliberate choice, not an oversight, in case review
  expects every knob to be settings-surfaced per §17 — §17 covers *prompts*, this is a structural
  constant closer in kind to `AUTO_RECALL_PAIRS`'s own hardcoded-default treatment.

## Edge Cases

- **Chat with zero plot facts** (fresh RP chat, or a household 'chat'-kind session that never
  routes here at all): `recallPlotLane` returns `{ arcs: [] }`, `plotThreads` marker's existing
  non-empty filter drops the slot — no behavior change from today's empty case.
- **An arc with exactly one entry total**: first-entry and last-three-entries selection collapses
  to that one entry, no duplication (the existing `entries.length <= 4` branch in the ported
  reducer already handles this — confirm the port keeps it, don't re-derive it as `>= 4`, which
  would double-count a 4-entry arc's first item).
- **Recency floor and semantic cutoff select overlapping arcs**: dedupe before applying Max (see
  Logic step 4) — an arc must not count twice against the cap.
- **A `sync_id` is null** (a canon fact whose originating sync was later deleted — see
  `canon_facts_sync_id_fkey ... ON DELETE SET NULL`, an existing, unrelated behavior this plan
  doesn't change): such a row can still be ranked and selected by the semantic-relevance path, but
  cannot count toward the recency floor (no sync to measure recency from). Don't let a null
  `sync_id` throw or silently exclude the row from the semantic path — only exclude it from the
  floor calculation specifically.
- **Embedding provider down / DB error**: fail-open, same contract as every sibling lane —
  `recallPlotLane` catches and returns `{ arcs: [] }`, doesn't throw, doesn't stall the turn. The
  caller (`buildChatMemorySystemPrompt`) already wraps the whole rp branch's `Promise.all` in the
  same fail-open expectation the other two lanes rely on — confirm a plot-lane failure can't reject
  that `Promise.all` and take `bridgeRows`/`autoRecall` down with it (i.e. `recallPlotLane` must
  catch internally, not rely on an outer catch, matching `recallFactLane`'s/`recallChunkLane`'s own
  internal try/catch shape).
- **A rejected row is the only row for an arc**: the arc has zero eligible rows in both the
  selection query and the card-history query — it simply never appears, same as an arc with no
  rows at all. No special-casing needed beyond the `status <> 'rejected'` filter applied
  consistently in both queries.

## Tests

- `recallFactLane`'s status filter: a `status = 'proposed'` fact with no `approved_at` is returned
  and correctly wins its arc/entity's dedup tie-break over an older `status = 'approved'` row for
  the same key. A `status = 'rejected'` fact is never returned.
- `recallPlotLane`: an arc whose *only* semantically-matching row is not its most recent one still
  gets selected, and its card still contains the *current* first+last-3 (not just the matching
  row) — proving arc selection and card content are genuinely separate steps, not the same query
  reused.
- `recallPlotLane` recency floor: an arc with a low similarity score but a row from the most recent
  sync tick is selected; an arc with an equally low score and no recent row is not.
- `recallPlotLane` bounding: with more qualifying arcs than Max, exactly Max arcs are returned, and
  the ones returned are the union-then-capped set from Logic step 4 (not just top-Max-by-score,
  ignoring the floor — write a case where a floor-only arc would be cut if Max were applied to the
  scored set alone, and confirm it survives).
- Card reduction: an arc with 3 entries returns all 3, undeduplicated, in original order; an arc
  with 5 entries returns entry 1 + entries 3-5 (first + last three), not 5 entries.
- `buildChatMemorySystemPrompt`'s rp branch: confirm the query vector is computed once per turn
  and shared across all three lanes (chunk/fact/plot), not embedded three times — this is a real
  cost concern (an extra embedding-provider round trip per turn) worth a test asserting the
  embeddings provider mock is called exactly once.
- `renderPlotThreads`: an arc with 2 entries renders both inside one `<arc_tag>` wrapper block,
  blank-line separated.
- Fail-open: embeddings provider throws → `recallPlotLane` returns `{ arcs: [] }`, the surrounding
  `buildChatMemorySystemPrompt` call still resolves with `bridgeRows`/`autoRecall` intact (not
  rejected as a whole).
- Verify-script fake-pool coverage for whatever new SQL shape `recallPlotLane` introduces —
  matching branches added to the relevant `verify-*.mjs` files per the Files section note.

## Out of Scope

- `recallCanonFactsTool.ts` (the explicit `recall_canon_facts` tool call) — keeps its existing
  `status = 'approved'` filter. See the Principle flag section above.
- `chatMemorySync.ts:584-590` (the sync-time "currently open plot threads" read that feeds the
  bridge LLM call's continuity context) — not changed. This read is provably unaffected by the
  status-filter bug: `promote_canon_facts` always runs before this read within the same sync tick,
  so no `status = 'proposed'` plot row can exist at the time this query runs (barring an already-
  out-of-scope partial-failure edge case). It's also a different kind of consumer — an internal
  LLM-continuity input that legitimately wants to see every arc unranked, matching Canonize's own
  `buildExistingThreads`, which feeds the *hookseeker* call the same unbounded way. No change
  needed or wanted here.
- Making plot entries visible to the `recall_canon_facts` tool's own arc-history — that tool
  already dedupes to latest-per-arc by design (a one-off model-chosen lookup, not a per-turn
  budget concern the way silent injection is) and this plan doesn't touch it.
- Comfy 3's slot reorder (moving `plot_threads` into the volatile tail alongside `recent_history`/
  `auto_recall`, per the correction made earlier in this planning conversation) — tracked
  separately, not part of this plan's file list, though it should land in the same implementation
  pass since both touch the same preset row and it'd be wasteful to reorder twice.
- Any change to how the bridge (`SCENE`/`EVENTS`) is written or retrieved — untouched.
- Any change to `chat_memory_entries`, `chat_chunks`, or the general/people curator lanes — untouched.

## Principles / Conventions in Play

- **§15 (A Proposed Fact Is Already Live)** — see the Principle flag section above. This plan reads
  as `status <> 'rejected'` on the silent-injection paths, not `status = 'approved'`, which is now
  what §15 itself says to do. Flag this during review rather than silently patching it back to
  `'approved'` — that would just reintroduce the one-sync-cycle lag this plan exists to remove.
- **§16 (Injected Context is Always Attributable and Bounded)** — this plan's whole point. Every
  card traces back to specific `canon_facts` rows (`fact_id`s), and the Max setting is the explicit
  bound that was missing before.
- **The assembler's purity (§8)** — `recallPlotLane`'s output must be deterministic for identical
  inputs (same messages, same DB state, same settings). The vector search itself is deterministic
  given a fixed embedding provider and query text; ensure the arc-ordering tie-break (equal scores)
  is also deterministic (e.g. `arc_tag` as a secondary sort key), not insertion-order-dependent on
  whatever Postgres happens to return.
- **§17 (Every Prompt is Surfaced for Manual Tuning)** — the two numeric bounds and the recency
  floor are settings, not constants, per this principle's spirit even though they're not literally
  prompt strings — matches how `canon_recall_top_k`/`_min` were already treated as settings rather
  than hardcoded.
- **§10 (Every File Has One Purpose and a Size Budget)** — `recallPlotLane.ts` as its own file
  follows the same split that produced `recallChunkLane.ts`/`recallFactLane.ts` in the first place;
  don't fold this into `recallForPrompt.ts` or `recallFactLane.ts`.
- **`conventions.md`** — not read as part of this planning pass; Reasonix should cross-check
  naming/style conventions there before implementing, same as any other plan.
