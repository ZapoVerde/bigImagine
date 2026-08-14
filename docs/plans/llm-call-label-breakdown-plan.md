# LLM Call-Type Breakdown

## Goal

The Usage & Cost section's `kind` group-by (docs/plans/llm-stats-page-plan.md) only goes as fine
as `chat` / `agent_routine` / `system` — and `system` alone already covers cleanup repairs, chat-
memory sync (six different LLM-calling steps), location descriptions, and title generation, all
indistinguishable from each other today (every one of them calls `runWithCallContext` with
`taskId: chatId, kind: 'system'` — nothing else varies). Add a finer, one-level-deeper label so the
Stats page can break usage/cost down into:

- **Main** — the actual RP/chat turn (`kind: 'chat'`, unchanged, no new label needed).
- **Cleanup** — header / body / footer, separately.
- **Background** — location description, title generation.
- **Sync** — broken down by which of chat-memory sync's own six LLM-issuing steps fired
  (chunk-summary, bridge, world-memory curation, people curation, distill, household-memory
  archival).

## Files

- `db/migrations/0103_llm_calls_call_label.sql` — created — widens `llm_calls` with
  `call_label text`, nullable, no backfill (pre-migration and non-`system` rows have none — see
  Edge Cases).
- `orchestrator/src/io/llm/callContext.ts` — modified — `LlmCallContext` gains an optional
  `callLabel?: string`, and a new `withCallLabel(label, fn)` export: reads the currently active
  context via `getCallContext()` (throwing the same "must already be inside a context" error
  `llmGate.ts` throws, if somehow called outside one — this should be unreachable in practice,
  every call site below is already nested inside an outer `runWithCallContext`), and re-runs `fn`
  under a nested context that's identical except for `callLabel`. AsyncLocalStorage nests cleanly —
  `getCallContext()` inside `fn` sees the inner (labeled) context; anything outside `fn` keeps
  seeing the outer one. This is additive to the existing `runWithCallContext` API, not a
  replacement — every call site that doesn't care about a finer label keeps working unchanged.
- `orchestrator/src/io/llm/llmGate.ts` — modified — `logCall` gains `callLabel: string | null`,
  read off `ctx.callLabel ?? null`; the insert widens with the new column.
- `orchestrator/src/orchestrator/cleanupLoop.ts` — modified — `dispatchStep`'s existing `stepKind`
  local (already computed as `'header' | 'footer' | step.setName`) wraps its `deps.llm.complete`
  call in `withCallLabel(...)`, normalized to `cleanup:header` / `cleanup:footer` / `cleanup:body`
  — body's per-paragraph-set name (`step.setName`) stays in the existing log/trace calls for
  debugging, but collapses to the one `cleanup:body` label here, since h/b/f is the granularity
  asked for, not per-set.
- `orchestrator/src/orchestrator/ensureFirstTurnHeader.ts` — modified — its one `complete()` call
  (turn 1's pre-stream header check, the case the original Timing plan already flagged as invisible
  to the client-side timeline) wraps in `withCallLabel('cleanup:header', ...)` — same label as the
  poll-tick path, since it's the same repair, just on a different code path for turn 1.
- `orchestrator/src/orchestrator/describeLocation.ts` — modified — wraps its call in
  `withCallLabel('bg:location-description', ...)`.
- `orchestrator/src/server/handleChatCompletions.ts` — modified — the title-generation call (the
  one other already-`runWithCallContext`-wrapped call site in this file) wraps in
  `withCallLabel('bg:title-generation', ...)`.
- `orchestrator/src/orchestrator/chatMemorySync.ts` — modified — six call sites wrap:
  the `summarize_embed` step's `summarizeChatChunk` call → `sync:chunk-summary`; `bridge` →
  `sync:bridge`; `curate_world_memory` → `sync:world-memory`; `curate_people` → `sync:people`;
  `distill` → `sync:distill`; `archiveChatMemory`'s `classifyHouseholdMemory` call →
  `sync:household-memory`. (`chunk`, `sync_point`, `insert_chunks`, `upsert_*`, `promote_canon_facts`,
  `settle_transient_records` are pure-DB steps — nothing to label, they never call the LLM.)
- `orchestrator/src/orchestrator/chatChunkResize.ts` — modified — its `summarizeChatChunk` call
  wraps in `withCallLabel('sync:chunk-summary', ...)` — same underlying function and label as the
  main sync tick's chunk-summary step, just triggered on a resize rather than the regular tick.
- `orchestrator/src/orchestrator/eagerChunkSync.ts` — modified — same, its `summarizeChatChunk`
  call also wraps in `withCallLabel('sync:chunk-summary', ...)` — same reasoning.
- `orchestrator/src/server/adminServer.ts` — modified — `listLlmStats`'s query selects the new
  `call_label` column; the row mapper adds `callLabel: r.call_label` (nullable, no substitution —
  see Edge Cases, this is different from the `'(pre-tracking)'` treatment `providerKind`/`model`
  get).
- `frontend/src/api/types.ts` — modified — `LlmCallStatRow` gains `callLabel: string | null`.
- `frontend/src/views/StatsView.tsx` — modified — the Usage & Cost group-by gains a `'call-type'`
  option: groups by `r.callLabel ?? (r.kind === 'chat' ? 'main' : r.kind)` — a `system` row that
  predates this migration (null `callLabel`) falls back to the group label `'system'`, distinct
  from every labeled bucket rather than silently merging into one of them (see Edge Cases).
- `orchestrator/scripts/verify-llm-gate.mjs` — modified — new fixtures proving `withCallLabel`
  actually nests (a call inside it logs the label; a call outside/after it doesn't carry it over).
- `orchestrator/scripts/verify-server.mjs` — modified — `listLlmStats` fixture gains a `call_label`
  case, proving it round-trips to the wire shape untouched (no `'(pre-tracking)'`-style rewrite).

## Logic

**Why a nested-context helper instead of threading a parameter.** Every call site in the Files
list is already inside an outer `runWithCallContext({ taskId: chatId, kind: 'system', userId })`
that exists for a different reason (bb_principles.md §14's gate, and — for `chatMemorySync.ts`
especially — a single outer transaction spanning many steps, only some of which call the LLM).
Threading a `callLabel` parameter through every intermediate function between that outer call and
the actual `deps.llm.complete()` call would touch far more files than the label itself needs to
know about, the same reasoning `callContext.ts`'s own header comment already gives for why it uses
AsyncLocalStorage in the first place instead of a plain parameter. `withCallLabel` reuses the same
mechanism one level in: it doesn't replace the outer context, it narrows it for exactly the
duration of the labeled call.

**Cleanup's `stepKind` already exists — this reuses it, doesn't duplicate it.** `dispatchStep`
already computes the exact region a given repair step targets (for its own logging and prompt
trace title). The new `call_label` piggybacks on that existing computation rather than
re-deriving it — normalized to the coarser h/b/f-only granularity this plan asks for (body's
per-set name stays available in the log line for anyone debugging a specific paragraph repair, it
just doesn't fork the `call_label` value).

**The Stats page's new dimension is flat, not two-level.** Rather than a literal nested "kind, then
call-type" UI, `call_label` is designed so grouping by it alone already reads as the finer
breakdown — `cleanup:header`, `sync:bridge`, etc. carry their category in the string itself, so one
new `'call-type'` group-by option in the existing dropdown (docs/plans/llm-stats-page-plan.md's
"no library, dropdown + filter" shape) is enough; no second-level UI is needed.

## Contracts

`llm_calls` new column (migration 0103):
```
call_label  text   -- null for kind='chat'/'agent_routine' rows and for pre-migration rows
```

`callContext.ts`:
```
withCallLabel<T>(label: string, fn: () => T): T
// Reads the active context (throws if none), re-runs fn under { ...active, callLabel: label }.
```

`LlmCallStatRow` (frontend, mirrors the widened `listLlmStats` row):
```
callLabel: string | null
```

Call-label vocabulary (the complete, closed set this plan produces — anything else stays `null`):
```
cleanup:header | cleanup:body | cleanup:footer
bg:location-description | bg:title-generation
sync:chunk-summary | sync:bridge | sync:world-memory | sync:people | sync:distill | sync:household-memory
```

## Edge Cases

- **Pre-migration rows and any `system` call this plan doesn't reach**: `call_label` stays `null`.
  The Stats page's `'call-type'` grouping falls back to the row's own `kind` for those (`'system'`
  as a catch-all bucket, `'main'` for `chat`, `kind` verbatim for `agent_routine`) — never
  `'(pre-tracking)'`, since (unlike `providerKind`/`model`) a null `call_label` isn't necessarily a
  pre-migration artifact, it may just be a `system` call this plan didn't label (there is no
  currently-known such case, but the fallback needs to be correct if one is ever added later
  without a matching label).
- **`chatChunkResize.ts` and `eagerChunkSync.ts` share `sync:chunk-summary` with the main sync
  tick's own chunk-summary step** — deliberate: all three call the identical `summarizeChatChunk`
  function for the identical purpose, just triggered on three different schedules. Splitting them
  into three labels would fragment one real cost category into three for no analytical benefit.
- **A `refused`/`error` row**: `call_label` is set the same way `providerKind`/`model` already are
  for those outcomes — the label describes *what was attempted*, not whether it succeeded, so it's
  populated even when the call never reached the provider.
- **`agent_routine` calls get no `call_label`** — out of scope (the user's ask was specifically
  about breaking down `system`; `agent_routine` is already its own distinct `kind`).

## Tests

- `withCallLabel`: a call made inside it logs the label; a call made in the same outer context but
  outside/after the `withCallLabel` scope does not retain it (proves the nesting is scoped, not a
  mutation of the outer context).
- `verify-llm-gate.mjs`: `logCall`'s insert carries `call_label` through unchanged, including the
  `null` case (a call made with no `withCallLabel` wrapper).
- `verify-server.mjs`: `GET /v1/admin/llm-stats` returns `callLabel` verbatim (including `null`) —
  no `'(pre-tracking)'`-style substitution, unlike `providerKind`/`model`.
- Manual QA (frontend has no test runner — see the Turn Timeline Graph plan's own Tests section for
  the same note): after a real cleanup pass and a real chat-memory sync tick fire, the Stats page's
  new `'call-type'` grouping shows the expected labeled buckets with plausible costs.

## Out of Scope

- Any UI change beyond the one new group-by option — no new chart type, no nested/two-level
  dropdown.
- Backfilling `call_label` on existing rows — not recoverable, same reasoning as every other
  addition to `llm_calls` in this feature area.
- A `call_label` for `agent_routine` or `chat` calls.
- Resolving the still-open total-vs-average question for the Timing bar-list (separate,
  unresolved thread — not part of this plan).

## Principles / Conventions in Play

- §14 (Every LLM Call Passes Through One Gate) — `call_label` is carried by the same gate every
  other attribute already rides through; no second logging path.
- §8 (The Four Kinds of Code) — `withCallLabel` lives in `callContext.ts`, the existing Stateful
  Owner for ambient call context, not bolted onto `llmGate.ts` (an IO Wrapper) as a new kind of
  reasoning.
- §11 (Observability is Not an Afterthought) — same principle the whole Stats page already serves;
  this closes the specific gap where the busiest `kind` bucket (`system`) was the least legible one.
