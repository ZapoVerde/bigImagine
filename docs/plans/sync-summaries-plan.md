# Sync Summaries: close the eager-chunk / bridge-tick gap

## Goal

Close a real gap between eager chunking (per-turn) and the bridge (per-sync-tick): chunks
archived since the chat's last bridge update are currently invisible unless RAG's similarity
score happens to pick them. Add a new `sync_summaries` prompt-stack marker — unconditional,
chronologically between `bridge` and `recent_history` — that lists every chunk under the chat's
currently-open sync point as a bare summary, and "inflates" one to full text in place if RAG's
own scoring also selects it (never duplicated across both sections).

## Background

`eagerChunkSync.ts` chunks a turn-pair the moment it rolls off the live window, purely to smooth
LLM cost/latency versus batching at the sync tick. But the bridge (scene/events digest) only
updates when `chatMemorySync.ts`'s tick *closes* the chat's sync point — default every
`chat_memory_sync_every_pairs` = 8 turn-pairs. Between ticks, a chunk sits under the chat's open
(`closed_at is null`) sync point: archived, but folded into neither the bridge nor guaranteed
inclusion in RAG's scored top-8. Confirmed live on the user's BeachBum chat: 1 chunk (ordinal 64)
currently sits in that gap; worst case (default settings) it's 8 — comparable in size to the
entire live window.

Diagnosed while auditing why the RAG section of the prompt ran ~1.5x the size of `bridge` +
`recent_history` combined (unrelated finding, already understood: most of that gap was
`canon_facts`/`plot_threads` riding along inside `auto_recall`, not this issue — but it's what
surfaced the sync/bridge timing gap in the first place).

No cap is placed on how many chunks `sync_summaries` can show — a deliberate choice: if the sync
tick can't run (no LLM connectivity), the whole turn can't run either, so there's no realistic
scenario where this section balloons unboundedly while play continues.

## Logic

### Step 1 — New lane: `orchestrator/src/io/chatMemory/recallSyncSummaryLane.ts`

Unconditional, no vector query, no cutoff — modeled on `recallFactLane.ts`'s shape but simpler:

```ts
export interface SyncSummaryRow {
  chunk_id: string;
  ordinal: number;
  summary: string;
  content: string; // '' unless inflated by recallForPrompt.ts's merge step
}

export async function recallSyncSummaryLane(session, userId, chatId): Promise<{ rows: SyncSummaryRow[] }> {
  const [openPoint] = await session.query<{ sync_id: string }>(
    `select sync_id from chat_sync_points where chat_id = $1 and closed_at is null order by ordinal desc limit 1`,
    [chatId],
  );
  if (!openPoint) return { rows: [] };
  const rows = await session.query<SyncSummaryRow>(
    `select chunk_id, ordinal, summary, '' as content from chat_chunks
     where chat_id = $1 and user_id = $2 and sync_id = $3 order by ordinal`,
    [chatId, userId, openPoint.sync_id],
  );
  return { rows };
}
```

Reuses the exact boundary `eagerChunkSync.ts`/`chatMemorySync.ts` already model — "at most one
open sync point per chat" is already a construction invariant there (confirmed in
`chatMemorySync.ts`'s `runOneChatSync`, same query, both under the chat's advisory lock), so no
new bookkeeping is required.

### Step 2 — Inflate/exclude merge in `orchestrator/src/io/chatMemory/recallForPrompt.ts`

In `buildAutoRecallParts`, add `recallSyncSummaryLane` to the parallel lane fetch (it needs no
embedding, so it can start immediately, not gated on the query embed). After `recallChunkLane`
returns its scored `chunks`:

1. Build a `Set` of the sync-summary rows' `chunk_id`s.
2. Partition `chunks`: any whose `chunk_id` is in that set is removed from `chunks` and instead
   marks its corresponding sync-summary row as inflated — attach its `content`, using the same
   `[{{header}}]\n{{text}}` composition `renderAutoRecall` already applies to a normal full chunk.
3. Lead-in resolution (`resolveLeadInRows`) runs on the **post-removal** `chunks` list only, so a
   chunk moved into `sync_summaries` never triggers or receives a lead-in walk. No ordinal-overlap
   risk between the two lanes: sync-window chunks are always the newest (open sync point), so a
   deep-archive pick's lead-in predecessors are structurally always older still.
4. Return the new `syncSummaries: SyncSummaryRow[]` alongside the existing
   `chunks`/`facts`/`plots` in `AutoRecallParts`.

`recallChunkLane.ts` and `recallCutoff.ts` are untouched — the split happens entirely in this
existing post-processing step, the same place the lead-in merge already lives.

### Step 3 — Rendering in `orchestrator/src/io/chatMemory/memoryInjection.ts`

- New `RpMemoryContext.syncSummaries: SyncSummaryRow[]` field.
- New `renderSyncSummaries(rows, template, entryTemplate, chunkTemplate, charName)`, parallel to
  `renderAutoRecall`: a non-inflated row renders through a new lightweight entry template
  (`DEFAULT_SYNC_SUMMARY_ENTRY_PROMPT`, e.g. `[{{text}}]`); an inflated row renders through the
  **same** `chunkTemplate`/`chat_memory_auto_recall_chunk_prompt` setting `auto_recall` already
  uses — identical "what does a full recalled chunk look like" concept, so reuse avoids a
  redundant setting (`bi_principles.md` §17's "default + bespoke" pattern, not duplicated
  vocabulary). New outer wrapper `DEFAULT_INJECT_SYNC_SUMMARIES_PROMPT`
  (`{{#if text}}...{{/if}}`, same empty-collapses-to-nothing shape as
  `DEFAULT_INJECT_AUTO_RECALL_PROMPT`).
- `renderFusedMemoryBlock` (the deprecated `memory_recall` alias) is **not** changed — same
  treatment `plots` already gets: legacy presets stay byte-identical; only presets that add the
  new `sync_summaries` marker get the new behavior.

### Step 4 — New settings + migration

Two new orchestrator settings, following the existing pair's naming/shape exactly:

- `chat_memory_inject_sync_summaries_prompt` — outer wrapper template (mirrors
  `chat_memory_inject_auto_recall_prompt`).
- `chat_memory_sync_summary_entry_prompt` — per-entry bare-summary template. Its own setting,
  not a reuse of `chat_memory_auto_recall_lead_in_prompt`, since lead-ins and sync summaries are
  now conceptually separate (lead-ins reserved for `auto_recall`'s deep-archive picks only).

New migration `db/migrations/0104_sync_summaries.sql`: rebuild `orchestrator_settings_key_check`
(same wholesale-rebuild pattern migration 0100 used) adding these two keys. No schema change —
`chat_sync_points`/`chat_chunks` already carry everything this reads.

Wire the two new keys everywhere `chat_memory_auto_recall_chunk_prompt` already is (1-2 line
addition per file, same pattern twice):
- `orchestrator/src/server/adminServer.ts` — get/set handlers (~line 1246/1486, the function that
  already round-trips `autoRecallChunkPrompt`/`autoRecallLeadInPrompt`).
- `frontend/src/api/types.ts` — `ChatMemorySettings` interface.
- `frontend/src/views/RagView.tsx` — two new `useState` fields + save-patch lines, same block as
  `selectedAutoRecallChunkPrompt`/`selectedAutoRecallLeadInPrompt`.

### Step 5 — Marker plumbing

- `orchestrator/src/util/assemblePromptStack.ts` — add `'sync_summaries'` to the `MarkerKey`
  union and `MARKER_LABELS` (`'Sync Summaries'`).
- `frontend/src/api/markerLabels.ts` — mirror the same label (the file's own comment requires
  these two stay in sync).
- `orchestrator/src/server/promptAssembly.ts` — `buildChatMemorySystemPrompt`'s `rp` branch
  threads `syncSummaries` from `buildAutoRecallParts` into the returned `RpMemoryContext`;
  `buildNarratorStackItems` reads the two new settings (added to its existing big `Promise.all`)
  and adds `sync_summaries: renderSyncSummaries(...) || undefined` to `fields`.
- `applyPromptStackToChatTool.ts` needs **no change** — it already leaves every `MarkerKey` it has
  no source for as `undefined`, which the assembler treats as "skip this slot" (per its own doc
  comment).

No auto-insertion into existing presets: same precedent as `plot_threads`/`auto_recall` at their
own launch — the user adds `sync_summaries` to their preset(s) via the existing slot editor and
positions it between `bridge` and `recent_history` (or inside their own `<Live content>` group).

## Files

**New:**
- `orchestrator/src/io/chatMemory/recallSyncSummaryLane.ts`
- `db/migrations/0104_sync_summaries.sql`

**Modified:**
- `orchestrator/src/io/chatMemory/recallForPrompt.ts`
- `orchestrator/src/io/chatMemory/memoryInjection.ts`
- `orchestrator/src/server/promptAssembly.ts`
- `orchestrator/src/util/assemblePromptStack.ts`
- `frontend/src/api/markerLabels.ts`
- `orchestrator/src/server/adminServer.ts`
- `frontend/src/api/types.ts`
- `frontend/src/views/RagView.tsx`

## Testing

- Extend `orchestrator/scripts/verify-recall-for-prompt.mjs` (the existing fake-pool harness for
  this pipeline) with cases for: an open sync point with 2-3 chunks, none RAG-selected (all render
  as bare summaries, `auto_recall` unaffected); one of those chunks also RAG-selected (asserts it
  appears **once**, full-text, inside `sync_summaries`, absent from `auto_recall`, and receives no
  lead-in); no open sync point at all (empty `syncSummaries`, slot omitted entirely).
- Apply the migration by hand against the live DB (`docker exec bigimagine-postgres psql -U
  bigimagine_admin -d bigimagine < db/migrations/0104_sync_summaries.sql`, this repo's standing
  process for every migration), then confirm `orchestrator_settings_key_check` accepts the two new
  keys.
- Add the `sync_summaries` slot to a real preset via the editor, send a turn on a chat with a
  known open sync point (BeachBum currently has one — ordinal 64), and pull
  `/v1/chats/:id/prompt-preview` to confirm: the section sits between `bridge` and
  `recent_history`, shows the open point's chunk(s) as bare summaries, and — if a later turn's
  auto-recall happens to also select that same ordinal — it flips to full text in place with no
  duplicate block in `auto_recall`.
