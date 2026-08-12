# RAG Dynamic Cutoff — Stage 1 of the CNZ Retrieval Port

*Status: planned, not yet implemented.*

## Goal

Replace the RP read path's fixed `LIMIT N` chunk recall (`io/chatMemory/recallForPrompt.ts`) with a
dynamic, distribution-aware cutoff — the retrieval-quality mechanism SillyTavern-Canonize's
`rag/cutoff.js` has always used and this platform's auto-recall never ported. This is **Stage 1 of
a five-stage plan** to bring Canonize's full three-lane hybrid retrieval (content + header vector
lanes, keyword/FTS, temporal decay, dynamic threshold, telemetry) to BigImagine, staged so each
piece ships and proves itself before the next is built on top of it. See Non-Goals for the other
four stages and why they wait.

Today, `buildAutoRecallParts` always injects exactly `chat_memory_auto_recall_chunk_top_k` (default
8 — Canonize's own `ragChatMax`, see the Stage-5.1 addendum) chunks into every 'rp' turn's prompt,
whether the chat's archive actually has eight relevant matches or none at all. On a quiet, generic
turn with no real match in the archive, eight mediocre chunks get injected anyway — there is no
concept of "nothing here is worth recalling." Canonize's
own pool-mean/σ threshold exists specifically to catch this case (see
`stacks/sillytavern/st-extensions/SillyTavern-Canonize/docs/RAG_strategy_v4.md` §3–4, Scenario 2).
This plan ports that mechanism onto BigImagine's existing single content-vector lane, unchanged
otherwise — no schema change to `chat_chunks`, no new vector lane, no keyword search yet.

## Background

- `buildAutoRecallParts` (`recallForPrompt.ts`) currently runs two independent flat-`LIMIT` queries
  per RP turn: `chat_chunks` (top `chunkTopK`, default `AUTO_RECALL_CHUNK_TOP_K` = 8) and
  `canon_facts` (top `factTopK`, default `DEFAULT_FACT_TOP_K` = 8). This plan touches only the
  `chat_chunks` query and its settings — the `canon_facts` query is Stage 2's job (see Non-Goals),
  once this stage has proven the cutoff module against one real call site.
- BigImagine's `vector_embed <-> $query` ordering (`recallForPrompt.ts`, `recallLorebookEntries.ts`,
  `searchDocumentsTool.ts`) is pgvector's `<->` operator, which is **Euclidean (L2) distance** —
  lower is better — not a bounded `[0,1]` cosine similarity the way Canonize's `s_vec` scores are.
  Confirmed: no vector index of any kind exists yet on any `vector_embed` column (`0047_canon_facts.
  sql`'s own comment), so there is no `vector_cosine_ops` index silently changing what `<->` means
  here. The Voyage AI embedding adapter (`io/embeddings/voyage.ts`) does not normalize its output to
  unit length — only the stub provider does, for test determinism — so there is no reliable
  `similarity = 1 − distance²/2` conversion to fall back on for real embeddings. **This plan
  therefore runs the pool statistics on raw distance, not on a converted similarity score** — see
  Logic for the inverted threshold direction this implies. This is a deliberate adaptation from
  Canonize's literal formula, not an oversight; Stages 3–5 (which add more lanes to blend) will need
  to either keep this distance-native convention consistently or revisit it once there's a second
  lane to blend against — flagged there, not resolved here.
- Canonize's σ floor (`0.01`, `RAG_strategy_v4.md` §4) is calibrated to its own `[0,1]`-ish
  similarity range. Raw L2 distance has no such fixed scale — it depends on the embedding model and
  isn't bounded — so this plan uses a floor relative to the pool's own mean instead of a borrowed
  absolute constant. See Logic.
- `recallForPrompt.ts`'s existing settings (`chat_memory_auto_recall_chunk_top_k`, migration 0077)
  already function as a ceiling on how many chunks get injected — this plan keeps that key and its
  default (8, Canonize's own `ragChatMax` — see the Stage-5.1 addendum) as the new **Max**, adds a
  **Min** floor (default 2, matching Canonize's own `ragChatMin` default in `state.js`), and two new
  shared knobs — **Pool Multiple** and **Cutoff Mode** — named without a `chunk_`/`fact_` prefix
  because Stage 2 reuses them unchanged for the `canon_facts` query, mirroring Canonize's own
  settings shape (`RAG_strategy_v4.md` §5: Min/Max are per-channel, Pool Multiple/Cutoff Mode are
  shared).

## Non-Goals (deferred, staged separately)

- **Stage 2 — widen to the other three recall surfaces** (`canon_facts` in `recallForPrompt.ts`,
  `recallCanonFactsTool.ts`, `recallLorebookEntries.ts`, `searchDocumentsTool.ts`). Deliberately
  waits for this stage to be validated against one real call site first — mechanical once the
  cutoff module exists and its behavior is trusted, not before.
- **Stage 3 — temporal decay** on `chat_chunks` scoring (Canonize's `factor = max(0.70, 1 −
  0.025·ln(age+1))`). An additive adjustment to the score feeding into this stage's pool statistics;
  needs this stage's pipeline shape to exist first.
- **Stage 4 — keyword/FTS lane.** `tsvector` column + GIN index on `chat_chunks.content` (and later
  `canon_facts` text), a keyword-search module, and the anchored vector/keyword blend
  (`RAG_strategy_v4.md` §3 Step 3) feeding into this stage's pool-stats step. The largest lift of the
  five stages — deliberately last-but-one so there's a working single-lane threshold to blend into,
  not built alongside it.
- **Stage 5 — header/second vector lane**, embedding `chat_chunks.summary` (already stored) as a
  second lane with best-of scoring and Canonize's 1.08× dual-confirmation bonus. Smallest marginal
  value of the five stages per Canonize's own doc — last by design, not by difficulty.
- **Any change to `canon_facts`, `recallCanonFactsTool.ts`, `recallLorebookEntries.ts`, or
  `searchDocumentsTool.ts`.** Untouched until Stage 2.
- **Any change to what gets fetched for `canon_facts` in this same `buildAutoRecallParts` call.**
  Stays exactly as it is today — flat `LIMIT factTopK` — even though it's fetched in the same
  function as the chunk query this stage changes.

## Files

- `orchestrator/src/io/chatMemory/recallCutoff.ts` — created — the ported pool-statistics/threshold
  module (Canonize's `rag/cutoff.js` equivalent), operating on raw distance. Pure Function per
  `bi_principles.md` §8 — no IO, no settings access; `recallForPrompt.ts` reads settings and passes
  plain numbers in. See Contracts for its exact exports.
- `orchestrator/src/io/chatMemory/recallForPrompt.ts` — modified — `buildAutoRecallParts`'s
  `chat_chunks` query changes from `ORDER BY ... LIMIT chunkTopK` to `ORDER BY ... LIMIT poolSize`
  (pool sized by the new Pool Multiple setting against the Max setting), reads the three new/
  repurposed settings, calls `recallCutoff`'s functions to decide how many of the returned rows to
  keep, slices to that count before formatting, and logs one structured telemetry line per call
  (`bi_principles.md` §11) with the pool/threshold/returned-count fields. The `canon_facts` query
  and its formatting are untouched.
- `db/migrations/0091_chat_memory_auto_recall_cutoff.sql` — created — widens
  `orchestrator_settings_key_check` (wholesale rebuild, same pattern as 0077/0087/0088) to add
  `chat_memory_auto_recall_chunk_min`, `chat_memory_auto_recall_pool_multiple`,
  `chat_memory_auto_recall_cutoff_mode`. Hand-applied against the live DB per this repo's standing
  convention (see 0077's own header for the exact `docker exec ... psql` invocation shape).
- `db/migrations/README.md` — modified — one new entry for 0091, same style as the existing 0077/
  0087/0088 entries.
- `orchestrator/src/io/orchestratorSettings.ts` — modified — the three new keys added to
  `SETTING_NAMES`, plus a doc-comment paragraph (matching the existing `chat_memory_auto_recall_*`
  paragraph's style) explaining what each controls and its default.
- `orchestrator/src/server/adminServer.ts` — modified — `ChatMemorySettings` gains `autoRecallMin`,
  `autoRecallPoolMultiple`, `autoRecallCutoffMode`; `getChatMemorySettings` reads the three new keys
  alongside the existing `autoRecallChunkTopK` (renamed in the read path only to be understood as
  "Max" — the setting key itself is unchanged); `SetChatMemorySettingsBody` and
  `parseSetChatMemorySettingsBody` gain the three matching optional fields with the same validation
  shape as the existing `auto_recall_pairs`/`auto_recall_chunk_top_k` fields; `setChatMemorySettings`
  writes them. See Contracts for exact field names and validation.
- `frontend/src/api/types.ts` — modified — `ChatMemorySettings` interface gains the three matching
  fields.
- `frontend/src/api/client.ts` — modified — `adminSetChatMemorySettings`'s body type gains the three
  matching optional fields, passed straight through to the POST body (same pattern as
  `auto_recall_chunk_top_k` today).
- `frontend/src/views/RagView.tsx` — modified — the Retrieval fieldset's existing "Chunk Top K"
  field is relabeled "Chunk Max" and three new fields are added beside it: "Chunk Min" (number
  input), "Pool Multiple" (number input), "Cutoff Mode" (select: Mean / Mean + 1 SD / Mean + 2 SD) —
  same controlled-input/`useState`/save-on-blur-or-button pattern the existing auto-recall fields in
  this view already use.
- `orchestrator/scripts/verify-recall-cutoff.mjs` — created — unit tests for the new pure module, no
  DB or embeddings provider involved. See Tests.
- `orchestrator/scripts/verify-recall-for-prompt.mjs` — modified — the fake session's `chunkRows`
  fixture gains a `distance` column (the query now selects it); a new fixture exercises a
  multi-row pool so the cutoff's effect on the returned count is actually observable, not just a
  fixed-length passthrough. See Tests, and the caution below.

## Logic

**`recallCutoff.ts`'s two exports:**

- `poolSize(max, poolMultiple)` — pure arithmetic: `max(round(poolMultiple × max), 6)`, Canonize's
  own `N_C` formula (`RAG_strategy_v4.md` §3 Step 4) unchanged. This is called *before* the SQL
  query runs, to size its `LIMIT`.
- `applyCutoff(distances, { min, max, cutoffMode })` — `distances` is the pool's distance values in
  the order the SQL query already returned them (ascending — closest/best first, from `ORDER BY
  vector_embed <-> $query`). Cold-pool bypass: if `distances.length <= min`, keep everything, skip
  statistics entirely (Canonize keeps this as an explicit separate branch for the same reason;
  here it's folded into one check since the alternative — computing a mean/σ on a handful of
  points and then flooring back up to `min` anyway — produces an identical result through more
  code). Otherwise: compute `mean` and `stdDev` over the full pool (not just a leading slice — the
  query already only returned `poolSize` rows, so the "pool" and "everything fetched" are the same
  set here), floor `stdDev` at `max(stdDev, 0.01 × mean)` — the relative floor explained in
  Background — then resolve a threshold **in distance space, where lower is better, so the
  direction is inverted from Canonize's own similarity-space formulas**:
  - `mean` → `threshold = mean`, keep `distance < threshold`
  - `mean+1sd` → `threshold = mean − stdDev`, keep `distance < threshold`
  - `mean+2sd` → `threshold = mean − 2×stdDev`, keep `distance < threshold`

  Count how many leading rows (the pool is already sorted best-first) fall under the threshold; if
  that count is below `min`, return `min` instead (floor); otherwise clamp to `max` (ceiling —
  always satisfiable since `poolSize ≥ max` by construction whenever `poolMultiple ≥ 1`). Returns
  `{ keepCount, stats: { poolSize, mean, stdDev, threshold, cutoffMode } }` — `recallForPrompt.ts`
  slices its already-fetched rows to `keepCount` and logs `stats` alongside `min`/`max`/`keepCount`.

**`recallForPrompt.ts` changes.** Reads `chat_memory_auto_recall_chunk_min`,
`chat_memory_auto_recall_pool_multiple`, and `chat_memory_auto_recall_cutoff_mode` alongside the
settings it already reads, with the same parse-with-fallback shape every other setting in this file
uses (`Number.isFinite(...) && > 0 ? parsed : DEFAULT`; an unrecognized `cutoffMode` string falls
back to `'mean'`). Clamps `min = Math.min(parsedMin, chunkTopK)` so a misconfigured `min > max`
can never make the floor step exceed the ceiling. Computes `poolSize(chunkTopK, poolMultiple)`,
changes the `chat_chunks` query to `SELECT ordinal, summary, content, vector_embed <-> $3 AS
distance ... ORDER BY vector_embed <-> $3 LIMIT <poolSize>` (bounded by a new sanity cap, see Edge
Cases), then calls `applyCutoff` and slices the result to `keepCount` before it reaches
`formatAutoRecallBlock`/the narrator-stack chunk renderer — both of which are otherwise unchanged,
since they already just render whatever `ChunkRow[]` they're handed. Logs one `log.info` call after
the slice with `userId`, `chatId`, and the `stats`/`min`/`max`/`keepCount` fields — the seam
`bi_principles.md` §11 calls out ("log where reasoning happens"), and the only place in this stage
where a "nothing worth recalling" turn becomes visible in the logs instead of silently injecting
mediocre matches.

## Contracts

- `recallCutoff.ts`:
  ```ts
  export type CutoffMode = 'mean' | 'mean+1sd' | 'mean+2sd';

  export function poolSize(max: number, poolMultiple: number): number;

  export function applyCutoff(
    distances: number[],   // ascending, best-first; length === the pool actually returned
    opts: { min: number; max: number; cutoffMode: CutoffMode },
  ): {
    keepCount: number;
    stats: { poolSize: number; mean: number; stdDev: number; threshold: number; cutoffMode: CutoffMode; bypassed: boolean };
  };
  ```
  `bypassed: true` marks the cold-pool case (`distances.length <= min`) — `mean`/`stdDev`/
  `threshold` are `0` in that case and must not be read as meaningful by the caller's telemetry
  line beyond logging `bypassed`.
- `orchestrator_settings` keys added (migration 0091, all integer-as-text or enum-as-text, same
  convention as every existing key in this store):
  - `chat_memory_auto_recall_chunk_min` — default `'2'` when unset.
  - `chat_memory_auto_recall_pool_multiple` — default `'2'` when unset; parsed as a float, not an
    integer (Canonize's own `P` is not restricted to whole numbers either).
  - `chat_memory_auto_recall_cutoff_mode` — one of `'mean' | 'mean+1sd' | 'mean+2sd'`; default
    `'mean'` when unset or unrecognized.
- `ChatMemorySettings` (`adminServer.ts` / `frontend/src/api/types.ts`) gains:
  ```ts
  autoRecallMin: number | null;
  autoRecallPoolMultiple: number | null;
  autoRecallCutoffMode: 'mean' | 'mean+1sd' | 'mean+2sd' | null;
  ```
- `SetChatMemorySettingsBody` / the POST `/v1/admin/chat-memory-settings` body gains the matching
  snake_case optional fields: `auto_recall_min?: number`, `auto_recall_pool_multiple?: number`,
  `auto_recall_cutoff_mode?: string`. Same "all fields optional, independently settable" contract
  every other `SetChatMemorySettingsBody` field already has.

## Edge Cases

- **Empty archive** (`distances.length === 0`). `applyCutoff` must not divide by zero computing
  `mean`; the cold-pool bypass (`0 <= min`) already covers this — `keepCount = 0`.
- **Perfectly flat pool** (every distance identical). Raw `stdDev = 0`; the relative floor
  (`0.01 × mean`) prevents `mean+1sd`/`mean+2sd` from collapsing to a threshold equal to `mean`
  itself, so those modes still trim at least the intended margin rather than degenerating to
  `mean` mode's behavior. If `mean` is itself `0` (a distance of exactly zero across the whole
  pool — only possible with duplicate/degenerate embeddings), the floor is also `0`; accepted as a
  genuinely degenerate input case, not worth a second special-case.
- **Misconfigured settings** — `pool_multiple <= 0`, a `cutoff_mode` string outside the three valid
  values, `chunk_min <= 0` — all fall back to their defaults, matching this file's existing
  parse-with-fallback convention for `autoRecallPairs`/`autoRecallChunkTopK`. Never throws, never
  blocks the turn (this function is still inside `buildAutoRecallParts`'s existing fail-open `try`/
  `catch`).
- **`chunk_min` configured larger than `chunk_top_k` (Max).** Clamped at read time
  (`min = Math.min(min, max)`) so the floor step can never be asked to return more than the
  ceiling allows.
- **Pool size sanity cap.** A corrupt `pool_multiple` (e.g. a stray `9999`) must not turn into an
  unbounded `SELECT ... LIMIT` against `chat_chunks`. Cap the computed `poolSize` at a constant
  (`MAX_POOL_SIZE`, suggest `40` — generous relative to `MAX_CHUNK_TOP_K`'s existing `12`) the same
  way `MAX_CHUNK_TOP_K`/`MAX_FACT_TOP_K` already cap their settings.
- **`chat_memory_auto_recall_enabled === 'false'`.** Unaffected — the existing early return in
  `buildAutoRecallParts` happens before any of this stage's new code runs, same as today.

## Tests

- **`verify-recall-cutoff.mjs`** (new, pure, no DB/embeddings):
  - `poolSize` matches Canonize's own worked examples from `RAG_strategy_v4.md` Appendix A (e.g.
    `max=8, poolMultiple=2 → 16`; `max=8, poolMultiple=5 → 40`), and floors at `6` for a tiny
    `max`/`poolMultiple` combination.
  - On a pool shaped like the doc's own "Standard Thematic Query" scenario (a handful of strong
    matches, gradual decay to a long tail), `mean` mode returns more items than `mean+1sd`, which
    returns more than `mean+2sd` — the strictness ordering Canonize's own Appendix A demonstrates,
    reproduced here in distance space.
  - On a flat/uniform pool (every distance within a tiny range), `mean` mode returns close to
    `max` while `mean+1sd`/`mean+2sd` collapse toward `min` — the doc's "Flat Noise Query" behavior,
    proving the σ floor doesn't silently defeat the stricter modes.
  - Cold-pool bypass: a pool with `length <= min` returns `keepCount === distances.length` and
    `stats.bypassed === true`, regardless of `cutoffMode`.
  - Zero-length pool doesn't throw.
  - `min` never exceeds the returned `keepCount` beyond what the pool actually contains (can't floor
    up past what exists).
- **`verify-recall-for-prompt.mjs`** (extended): update the fake session's SQL-matching fixture
  (currently matches on `sql.includes('from chat_chunks')`) to also supply a `distance` column on
  each fake row — per this codebase's own known trap (fake pools mirror real SQL by string match
  and drift silently if the query shape changes without the fixture changing too), so this update
  is required, not optional, once the `SELECT` gains the `distance` column. Add a fixture with
  enough distance spread that `mean`/`mean+1sd` visibly return different counts, proving the cutoff
  is actually wired into `buildAutoRecallParts`'s chunk path end to end, not just unit-tested in
  isolation. The existing fail-open (embedding provider throws, DB throws) assertions are
  unaffected and must still pass unchanged.
- **Manual verification** (no browser tooling in this environment — per this session's own standing
  note, UI changes are checked via HTTP calls, not a live browser): `curl` the
  `/v1/admin/chat-memory-settings` GET/POST routes directly to confirm the three new fields
  round-trip, and confirm an RP chat turn's orchestrator log shows the new telemetry line with
  sane `mean`/`threshold`/`keepCount` values against real archived chunks.

## Out of Scope

- Everything listed under Non-Goals (Stages 2–5).
- Any change to `chat_chunks`' schema — no new columns, no index.
- Any change to how `canon_facts` are queried, scored, or limited in this same function.
- Any change to `formatAutoRecallBlock` or the narrator-stack injection templates
  (`memoryInjection.ts`) — they keep rendering whatever `ChunkRow[]` they're handed, unaware the
  count is now dynamic instead of fixed.
- A UI affordance for viewing the cutoff telemetry outside the orchestrator log (Canonize's console
  bar-chart display and health CSV export are not ported here — see the Stage roadmap discussion in
  this doc's parent conversation; not scheduled as one of the five stages, revisit only if the log
  line proves insufficient in practice).

## Principles / Conventions in Play

- `bi_principles.md` §8 (Four Kinds of Code) — `recallCutoff.ts` is a Pure Function: no settings
  access, no IO, just numbers in and a decision out. `recallForPrompt.ts` stays the IO Wrapper that
  reads settings and issues the query, same role it already declares.
- §11 (Observability) — the new telemetry line is exactly the kind of seam this principle calls
  out: a "recall silently injected four mediocre chunks" failure mode doesn't crash, it quietly
  degrades story continuity, so it needs to be visible in the log even though nothing errors.
  Consistent with `buildAutoRecallParts`'s own existing fail-open `log.warn` on real errors.
  Note: not asserted by an automated test in the plan above, matching this file's own existing
  practice of not unit-testing its fail-open `log.warn` calls either — logging is verified by
  reading it, not by a test spying on the logger.
- §13 (Runtime Config Lives in the Database) — the three new knobs are ordinary DB-backed settings,
  read live every call, no restart required, same shape as every other `chat_memory_*` key.
- §18 (Every Prompt is Surfaced for Manual Tuning) — not directly triggered (no new prompt string),
  but the same spirit applies to these three retrieval knobs: they're tuning surfaces a household
  member should be able to adjust from Settings without a redeploy, which is why this plan wires
  full Settings-page fields rather than leaving them DB-only.
- `conventions.md` — `recallCutoff.ts` opens with the standard preamble declaring itself a Pure
  Function from the start; `recallForPrompt.ts`'s existing preamble gets its `@stamp` bumped since
  this is an intentional architectural change to its retrieval shape, and its `@description` gets a
  short addendum pointing at `recallCutoff.ts` as the new collaborator.

---

## Stage 3 addendum — temporal decay on chat_chunks (implemented 2026-08-12, commit pending)

Status: implemented on top of Stages 1-2. What shipped, and the two decisions this stage
resolves that the Stage-1 doc deliberately left open ("flagged there, not resolved here"):

**Distance-space form.** Canonize's Step 2 is `s_vec = s_vec × factor` in similarity space
(higher better). This plan's convention is raw L2 distance (lower better), so Stage 3 mirrors
the multiplication as a **division: `d' = d / factor`** — older chunks measure farther and rank
worse, exactly the inversion of Canonize's semantics, and scale-free (no absolute constants, so
no new calibration against whatever embedding model is live). Implemented in SQL: each row's
`distance` column is `(vector_embed <-> $3) / greatest(0.70, 1.0 - 0.025 * ln(2 * greatest(0,
maxOrd - ordinal) + 1))` and the pool is ordered AND measured on that decayed distance — decay
before pool statistics, Canonize's pipeline order. `recallCutoff.ts` exports the pure
`decayFactor(ageChunks)` mirror; the SQL duplicates it by design (SQL must apply it per row)
and verify-recall-for-prompt.mjs asserts the SQL shape to catch drift.

**Age unit.** Canonize ages in turn-pairs (`age = max(0, totalPairs - pairEnd)`). BigImagine's
`chat_chunks.ordinal` is a *chunk* index (each chunk = MESSAGES_PER_CHUNK = 4 messages = 2
pairs), so `agePairs = 2 × ageChunks` — a faithful unit mapping, not an extra knob. "Now" is
the chat's newest chunk ordinal (`max(ordinal)` scalar subquery, index-assisted), so the
freshest chunk has age 0 → factor 1 → no decay; the 0.70 floor keeps ancient-but-relevant
chunks alive.

**No new setting.** The constants (floor 0.70, coefficient 0.025, pairs-per-chunk 2) are
Canonize's own values, hardcoded exactly as this stage's plan text specifies the formula —
no migration, no admin/frontend surface. Promoting any of them to a DB setting later is a
mechanical follow-up. The chunk telemetry line gains `temporalDecay: true` so operators can
tell the measured distribution is decayed.

**Scope.** Chat lane only (Canonize: "chat channel only"); the canon_facts lane keeps its
plain distance. No schema change, no index change, no settings change.

---

## Stage 4 addendum — keyword/FTS lane on chat_chunks (implemented 2026-08-17, commit pending)

Status: implemented on top of Stages 1-3. What shipped, and the decisions this stage resolves
that the Stage-1 doc deliberately left open ("flagged there, not resolved here"):

**Distance-space blend form (the flagged item).** Canonize's Step 3 blend is
`s_i = s_vec_i + (t_i/t_max) × (1−α) × max(s_vec)` in similarity space. Raw L2 distance has no
fixed scale, and the literal distance mirror — subtract `(t_i/t_max) × (1−α) × min(d)` —
collapses whenever the best match is a near-duplicate (min(d) ≈ 0 silences the keyword lane).
Stage 4 therefore blends in the bounded similarity space `s = 1/(1+d)`: strictly monotone
(ordering-preserving), bounded (0,1], and the anchor `max(s) = 1/(1+min(d))` is always
meaningful — the keyword lane can contribute at most (1−α) × the strongest vector match,
Canonize's exact interpretability. Blended back with `d' = max(0, 1/s' − 1)` (a row clamped at
0 is a top-vector AND top-keyword match — perfect); the pool statistics still run on distance,
keeping the pipeline's distance-native convention consistently (the option the Stage-1
Background named first).

**Window, not pool, is the chunk fetch unit.** Canonize blends over the full collection
(topK=100k) and slices the pool from blended ranks. Stage 4 fetches a bounded **keyword
window** (`KEYWORD_WINDOW_SIZE` 100, ≥ MAX_POOL_SIZE 40) ordered by decayed vector distance,
scores each row with `ts_rank` in SQL, blends in JS, re-sorts by blended distance, and only
then slices the blended top-N_C pool for applyCutoff — the same pipeline order (decay → keyword
blend → pool statistics), with the window as the documented bound so the per-turn fetch stays
bounded. The Stage-1 pool sizing (P × Max) now only floors the window and still sizes the fact
lane's LIMIT; the chunk lane's pool statistics measure the blended window.

**Keyword lane is additive-only.** The window is selected purely by decayed vector distance;
`ts_rank` is a SELECT column, never a `@@` WHERE filter — a row can only rank *better* via
keyword, never be excluded, so the keyword lane can't reduce recall below what the vector lane
found. The GIN index (migration 0093) is added per the plan's own scope text ("tsvector column
+ GIN index on chat_chunks.content") and serves future keyword-filtered paths (the plan's
"later canon_facts text" widening, the recall tools); the Stage-4 query itself doesn't need it.

**Scoring + query adaptation.** Canonize's custom in-memory TF-IDF becomes Postgres native
`ts_rank` over a STORED generated `content_tsv` column (`to_tsvector('english', content)` —
computed on insert and backfilled for existing rows, no trigger, no backfill script). The
tsquery is the OR of the query text's lexemes (`string_agg` over `to_tsvector('english', $4)`);
a query with no lexemes yields a NULL tsquery → `ts_rank` is NULL → coalesced to 0 → blend
inert → the vector lane is unaffected (never an error). Absolute `ts_rank` scale is irrelevant
because the blend normalizes by maxKw. The transcript query text retains its
`User:`/`Assistant:` prefixes
(the module's documented deviation from CNZ's speaker-stripping) — their lexemes contribute a
minor, maxKw-normalized constant at worst.

**No new setting.** `KEYWORD_BLEND_ALPHA` (0.7, Canonize's own default) and
`KEYWORD_WINDOW_SIZE` (100) are plain constants, exactly like Stage 3's decay constants — the
plan's Stage-4 scope lists no settings surface ("tsvector column + GIN index + keyword-search
module + anchored blend"). Promoting α to a DB-backed RagView knob is the same mechanical
follow-up Stage 3 documented.

**Scope.** Chat lane only (`chat_chunks.content`); the plan's "later canon_facts text" stays
out, matching Stage 3's chat-channel-only discipline and the user's direction (RP-chat main
memory focus; tools and lorebook untouched).

**Deploy note.** Migration 0093 must be hand-applied before the chunk query works — it
references `content_tsv`, and an unapplied migration fails the chunk lane open (empty chunks,
never a broken turn — the fail-open contract still holds). Same standing hand-apply convention
as 0091/0092 (both still unapplied as of this addendum).

---

## Stage 5 addendum — header/second vector lane on chat_chunks (implemented 2026-08-17, commit pending)

Status: implemented on top of Stages 1-4. What shipped, and the decisions this stage resolves
that the Stage-1 doc deliberately left open:

**Best-of scoring (the "best cosine across lanes" mirror).** Canonize's RRF fusion gives each
item the best cosine seen across its content and header lanes; in distance space that is the
MIN of the two lanes' decayed distances (`mergeLanes`). The stage runs the Stage-4 chunk query
twice — once against `vector_embed` (content, migration 0037) and once against
`summary_vector_embed` (header, migration 0094) — and fuses the two windows in JS BEFORE the
keyword blend, preserving Canonize's pipeline order (fusion → decay-equivalent → keyword blend →
pool statistics). Chunks the content lane missed but the header lane found join the merged
window, so the header lane is additive — it can only add recall, never suppress it (the same
discipline as the Stage 4 keyword lane).

**The 1.08× dual-confirmation bonus (the second flagged item).** Canonize multiplies an item's
fused score by 1.08, capped at 1 (`DUAL_BONUS`, `min(1, s × 1.08)` in their rag/rrf.js), when the
item appeared in BOTH lanes' result lists — two independent representations agreeing
strengthens the signal. The distance-space inverse uses the bounded-similarity convention the
Stage 4 blend established: `s' = min(1, 1.08·s)` with `s = 1/(1+d)`, converted back
`d' = max(0, 1/s' − 1)`. The similarity cap at 1 becomes a distance floor at 0 — any dual match
at distance ≲ 0.08 clamps to 0 (perfect) — and the transform is strictly monotone, so the bonus
can re-rank but never invert lane order.

**Per-lane decay ≡ fused-then-decay, and one documented order adaptation.** The decay factor
depends only on the chunk's ordinal, so `min(d_c, d_h)` after per-lane decay (the SQL's Stage-3
expression) equals the fused score after decay — best-of commutes exactly. The bonus does NOT
commute: Canonize boosts the fused score BEFORE decay, while this pipeline applies the bonus to
the already-decayed best-of distance. That is a slightly weaker bonus for older chunks (the
factor ≤ 1 shrinks the bonus's absolute effect), monotone and bounded, chosen to keep every
number the cutoff measures in decayed distance space — the same "all distances are decayed"
convention Stages 3-4 already established. Documented here rather than silently diverged.

**Scoring + schema.** The header query reuses the exact Stage-4 shape: same decayed-distance
expression against `summary_vector_embed`, same `KEYWORD_WINDOW_SIZE` window, same
lane-independent `kw_score` (`ts_rank` over `content_tsv` — the keyword score does not depend on
which vector lane selected the row, so a header-only chunk still carries its keyword score).
`summary_vector_embed` is NULL for rows written before 0094 (nothing has embedded summaries
until now — 0037's comment explicitly deferred this lane); the query skips NULLs, so old chunks
stay content-lane-only until a future sync pass rewrites them. chatMemorySync.ts embeds
summaries alongside content from the next sync onward (one extra embed call per sync pass).
No vector index — `vector(2048)` is too wide to index usefully at household scale, the same
no-index design as `vector_embed` (0047's comment). No new settings: `DUAL_CONFIRM_BONUS` is a
plain constant like Stages 3-4's.

**Scope.** Chat lane only; the fact lane's flat `LIMIT factTopK` stays untouched, matching the
user's direction (RP-chat main memory focus; tools and lorebook out of scope).

**Deploy note.** Migration 0094 must be hand-applied before the header lane query works (it
references `summary_vector_embed`); unapplied → the chunk query fails open (empty chunks, never
a broken turn), same contract as 0093. Applied after 0091/0092/0093 in the end-of-work batch.

---

## Stage 5.1 addendum — CNZ settings-default audit (implemented 2026-08-17, commit pending)

User direction: "investigate what the settings that CNZ uses in the sillytavern installation and
make them the defaults." The authoritative source is the Canonize extension's own
`state.js` `PROFILE_DEFAULTS` (the live installation defaults; `docs/settings.md` describes each
control but the exact numbers live in code), cross-checked against `rag-fetch.js`/`cutoff.js`/
`rrf.js` for how each is consumed. Result: every BigImagine RAG default already matched the CNZ
installation except one — the chunk Max ceiling:

| BigImagine | Default | CNZ analog | CNZ default | Verdict |
|---|---|---|---|---|
| `AUTO_RECALL_PAIRS` (query window) | 3 | `ragClassifierHistory` (the `allPairs.slice(-horizonPairs)` query horizon in rag-fetch.js) | 3 | matched |
| `AUTO_RECALL_CHUNK_TOP_K` (chunk Max) | **4 → 8** | `ragChatMax` | **8** | **changed** |
| `DEFAULT_CHUNK_MIN` (chunk Min) | 2 | `ragChatMin` | 2 | matched |
| `DEFAULT_POOL_MULTIPLE` | 2 | `ragPoolMultiple` | 2 | matched |
| `DEFAULT_CUTOFF_MODE` | `'mean'` | `ragCutoffMode` | `'mean'` | matched |
| `KEYWORD_BLEND_ALPHA` (Stage 4) | 0.7 | `ragKwBlend` | 0.7 | matched |
| `DECAY_FACTOR_FLOOR`/`COEFFICIENT` (Stage 3) | 0.70 / 0.025 | hardcoded in CNZ code (not a setting) | 0.70 / 0.025 | matched |
| `DUAL_CONFIRM_BONUS` (Stage 5) | 1.08 | `DUAL_BONUS` (rag/rrf.js, not a setting) | 1.08 | matched |
| `PAIRS_PER_CHUNK` | 2 | `ragChunkSize` | 2 | matched |

Notes from the audit:

- **The 4 → 8 change** is the whole delta. It applies where the setting is unset (the live DB has
  no value — the migrations 0091/0092 that would persist RAG-page edits are still unapplied), so
  the code fallback `AUTO_RECALL_CHUNK_TOP_K` IS the default. The RagView field shows empty when
  unset (its existing behavior) and the code default now matches the CNZ installation.
- **`ragRetrievalTopK: 5`** in CNZ's `PROFILE_DEFAULTS` is a dead default — grep shows no consumer
  (the plot lane's Max falls back to `ragPlotRetrievalTopK`, which is 3). Not ported.
- **The keyword window (`KEYWORD_WINDOW_SIZE` 100) is NOT a CNZ setting** — CNZ scans the full
  collection for both vector lanes and caps only the FTS query at 100k. The 100-row window is the
  plan's bounded analog (Stage 4 addendum); left unchanged, since the user's ask was settings
  defaults.
- **The fact lane (`canon_facts`) has no CNZ analog** — CNZ's channels are chat/LB/plot; approved
  canon facts are BigImagine's own concept, so `DEFAULT_FACT_TOP_K` 8 / `DEFAULT_FACT_MIN` 2 stand.
- `MAX_CHUNK_TOP_K` (12) stays a sanity cap above the new 8 default, same as before.
