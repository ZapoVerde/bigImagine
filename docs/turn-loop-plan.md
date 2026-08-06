# Turn Loop — Phase 1 Implementation Plan

*Status: designed, not yet built. Phase 1 = one main LLM call handling narrator + all present
characters, plus an optional unconditional cleanup pass. Character-stamped per-character calls are
explicitly shelved (see Non-Goals) — this plan builds the loop shape so that expansion doesn't
require a rewrite, without building the expansion itself.*

## 1. The seven steps

1. Resolve `{{variables}}`
2. Grab the turn's RAG results
3. Assemble the prompt
4. Fire the prompt
5. Receive results → cleanup pass → persist
6. Count and trigger sync (non-blocking)
7. Complete the turn

Steps 2–3 are a subloop by design — today it runs once per turn (narrator only); nothing in its
shape assumes that, so a later per-character expansion calls it N times instead of rewriting it.

## 2. Non-Goals (shelved, not forgotten)

- **Character-stamped per-character calls.** One main call handles everyone for now. The
  extensibility hook being preserved: steps 2–3's field-resolution logic stays small, separable
  functions (see §3.2) rather than inlined into `handleChatCompletions`, so a later rewrite changes
  *how many times* they run, not their shape.
- **Cleanup as a keyword-triggered/conditional pass** (TRG's `sideCall` model). Confirmed:
  unconditional every turn, through the standard gate retry, falling back to raw text on exhausted
  retries. No detection step, no per-match granularity — TRG needs that because it patches
  messages already rendered/saved in the ST UI; this runs pre-persistence, so whole-text-in,
  whole-text-out is sufficient.
- **Preset role assignment beyond narrator + cleanup** (a scene-level manager/character override
  chain). Still deferred from `0042`'s own note — not needed until per-character calls exist.
- **Large-gap sync catch-up.** Decided: every sync pass is capped to exactly one normal sync
  window; a chat that's still behind stays "due" and gets picked up again next tick. No special
  case.

## 3. Steps 1–4: resolve, assemble, fire

### 3.1 What's already live (unchanged by this plan)

- **Step 1** — `interpolateMacros` (`orchestrator/src/util/interpolateMacros.ts`), resolved fresh
  every turn against a `MacroSnapshot`. Already wired in `handleChatCompletions`
  (`httpServer.ts:557-559` for the RP-chat macro-resolution path).
- **Step 4** — `runTurn` (`orchestrator/loop.ts`) → the gated `LlmProvider` (`llmGate.ts`). No
  changes; the cleanup call in step 5 reuses this same gated path, not a separate one.

### 3.2 What changes: step 2–3 becomes real per-turn assembly, not a frozen read

Today, `assemblePromptStack` (`plugins/context-stack-presets/src/assemblePromptStack.ts`) is
called exactly once, at Apply-click, by `applyPromptStackToChatTool.ts`, and the result is frozen
into `chat_sessions.params.system` forever after. `handleChatCompletions` just replays that frozen
string through `interpolateMacros` every turn (`httpServer.ts:561`). Per the "bake at turn start,
not Apply-click" decision, this becomes a real per-turn call:

1. **Resolve the active preset** — `chat_sessions.prompt_stack_preset_id` (already set by Apply,
   `migration 0049`). No new schema.
2. **Gather present characters' fields** — `scene_presence` if the chat is scene-linked, else the
   existing single `character_id` (`applyCharacterToChatTool.ts`'s existing link). For more than
   one character, concatenate each marker's value across present characters with plain labels —
   deliberately simple, not the stamped-per-character shape; acceptable specifically because this
   is one call, not N.
3. **Auto-fetch `canon_facts`** — a pre-turn call reusing `recallCanonFactsTool.ts`'s underlying
   semantic-recall query, gated by that preset's `canon_facts` slot `enabled` flag (schema already
   exists, `context_stack_slots.enabled`; default the builtin preset's slot to `true`).
   `recall_canon_facts` stays live as a tool call too, for the model to dig further mid-turn — no
   conflict, this just gives it a starting baseline.
4. **Move `memory_recall` into the stack.** Today `buildChatMemorySystemPrompt`
   (`httpServer.ts:328`) concatenates the chat-memory digest directly into the system string,
   bypassing slot position. Change: feed its result into `fields.memory_recall` instead, so a
   preset's slot ordering actually governs where it lands. Same underlying read, no new query.
5. **`recent_history` stays out of the stack** — real `chat_messages` appended after, as already
   decided; the marker exists in the vocabulary but nothing feeds it for chat-shaped turns.
6. Call `assemblePromptStack(fields, slots)`, then `interpolateMacros` over the joined result —
   same two-phase pattern `applyPromptStackToChatTool` already uses, just re-run every turn instead
   of once.

No new migration for narrator assembly — everything it needs already has a column.

## 4. Step 5: receive, clean up, persist

### 4.1 Cleanup preset — its own prompt stack, not a separate schema

Per your last message: cleanup is exposed as its own `context_stack_presets` row, not a second
"instruction content" system. Concretely: a preset whose slots are mostly `custom`-type (the
banned-word/construction/name list, the header-reconstruction instructions, the
internal-thoughts-suffix instructions — each as system-role text), with `{{message}}` embedded
directly in that text wherever the raw generated turn should appear (e.g. `"...TEXT TO
FIX:\n{{message}}"`).

- `assemblePromptStack` needs no change — it already passes `custom` slot content through verbatim.
- `interpolateMacros`/`MacroSnapshot` (`interpolateMacros.ts:32-45`) gains one new field:
  `message?: string`, and `resolveToken` gains `case 'message': return snapshot.message ?? '';` —
  a one-line addition to an existing switch, matching exactly how the file's own doc comment
  already anticipates later fields being added without touching its signature or caller.
- **New migration** (`0056`, next after the unapplied `0055`): `chat_sessions` gains
  `cleanup_preset_id uuid references context_stack_presets(preset_id) on delete set null`, nullable
  — same shape as `prompt_stack_preset_id`'s own addition in `migration 0049`. Null = cleanup off
  for that chat (the common case until a user opts in).

### 4.2 Loop wiring

In `handleChatCompletions`, between `runTurn` resolving (`httpServer.ts:611`) and the assistant
message being persisted (`httpServer.ts:625`):

1. If `sessionParams`/chat has no `cleanup_preset_id`, skip straight to persistence — unchanged
   behavior, zero cost, for every chat that hasn't opted in.
2. Otherwise: assemble the cleanup preset's slots (no character/canon/memory fields needed — just
   `{ message: reply }` through `interpolateMacros`), producing the cleanup prompt text.
3. Fire it through the same gated `llm.complete()`, wrapped in
   `runWithCallContext({ taskId: body.chat_id, kind: 'chat', userId }, ...)` — `kind: 'chat'`
   because this is part of the turn the user is waiting on, not a background job; it should never
   be throttled by `agent_routine` caps, and it's not a one-off standalone call like
   `generateChatTitle`'s `kind: 'system'`. Retry/backoff behavior comes from `docs/llm-gate-plan.md`
   once built — not re-described here.
4. On success: replace `reply` with the cleaned text before persistence.
5. On exhausted-retry failure: log it, keep the raw `reply`, proceed unchanged. Per your call —
   cleanup failing never blocks or degrades the turn itself.

## 5. Step 6: count and trigger sync (non-blocking)

This is the `chatMemorySync.ts` rework already agreed in this conversation, restated here only as
a build item (not re-derived):

- Chunk summarization moves from batch-at-sync-tick to eager-at-live-buffer-exit: as soon as a
  message pair exits the live window (`MESSAGES_PER_CHUNK = 4`, `chunkChatTranscript.ts:31`),
  summarize+embed it immediately and insert into `chat_chunks` right away, rather than waiting for
  `runOneChatSync`'s batch pass.
- `chat_sync_points`'s `sync_id` (currently only created inside `runOneChatSync`,
  `chatMemorySync.ts:295-302`) gets created eagerly instead — at the *first* chunk-exit event for a
  new block, not at the periodic tick. `chat_chunks.sync_id not null` (`0037`) is satisfied from
  the start this way; `unique (chat_id, ordinal)` is the natural idempotency key if a chunk is ever
  produced twice (once on exit, once redundantly on the next tick — "fire again on sync, skip if it
  exists," no logic change needed beyond the constraint already there).
- Sync itself (`runOneChatSync`'s distill + upsert) still runs on the existing 30s tick, but now
  consumes chunks that mostly already exist — its job shrinks to consolidation. RAG/digest
  visibility stays gated on this same sync-time boundary, unchanged — the eager part is a cost
  optimization sitting before that boundary, not a visibility change. `chat_memory_sync_status`
  semantics (Review Panel) don't change.
- **Open, still needs an answer before building this part**: what marks a `sync_id` "closed" so the
  next chunk-exit event opens a fresh one, rather than one `sync_id` accumulating indefinitely.
  Flagged twice earlier in this conversation, not yet resolved — needs answering before step 6 is
  buildable, independent of everything else in this doc.
- Sync trigger itself is non-blocking from the turn's perspective — step 6 in the loop is "increment
  a counter / check due-ness," not "wait for a sync to finish." The existing 30s tick
  (`startChatMemorySyncLoop`) already runs independently of any request; step 6 doesn't need its
  own scheduling, just needs to not block step 7 on anything sync-related.

## 6. Step 7: complete the turn

Already what happens today — `sendJson`/stream response at the end of `handleChatCompletions`
(`httpServer.ts:650-666`). No change; listed for loop-shape completeness only.

## 7. Build order

Dependency-ordered, not calendar-estimated:

1. **LLM Gate retry/queueing** (`docs/llm-gate-plan.md`) — step 5's cleanup fallback and step 6's
   eager-chunk calls both want real retry behavior; build this first so nothing downstream needs a
   placeholder.
2. **`interpolateMacros` + `message` field** — trivial, unblocks cleanup-preset testing early.
3. **Migration `0056`: `chat_sessions.cleanup_preset_id`.**
4. **Per-turn narrator assembly (§3.2)** — the `applyPromptStackToChatTool`-shaped bake, moved to
   run every turn instead of once; `memory_recall`/`canon_facts` field wiring.
5. **Cleanup loop wiring (§4.2)** in `handleChatCompletions`.
6. **Sync rework (§5)** — blocked on resolving the `sync_id`-closing open question first; otherwise
   independent of 1–5 and can happen in parallel.

## 8. Open questions carried into this plan

- `sync_id`-closing mechanism (§5) — blocks step 6 specifically, nothing else.
- The three open questions already in `docs/llm-gate-plan.md` §6 (concurrency lanes, retry-vs-cap
  accounting, real backoff numbers) — blocks step 1 of the build order above.
