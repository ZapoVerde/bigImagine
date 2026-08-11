# Feature Specification: Turn Loop Cleanup Pass

> **⚠️ SUPERSEDED — 2026-08-08.** The inline, preset-driven Cleanup Pass this document specifies
> (a post-`runTurn` LLM call inside `httpServer.ts`, configured via `chat_sessions.cleanup_preset_id`)
> is **retired and removed**. It is replaced by the **async heuristic cleanup subloop**:
> `orchestrator/src/orchestrator/cleanupLoop.ts` (the poll loop) + `cleanupHeuristics.ts` (the pure
> engine), migration `0072_cleanup_heuristic_settings.sql`. A reply now lands raw and instantly; the
> background loop rewrites it after the fact — `cleanup_slop_rules` (RLS-exempt household config,
> editable on the Cleanup page) for antislop, and the `cleanup_header_regex`/`cleanup_header_prompt`/
> `cleanup_footer_regex`/`cleanup_footer_prompt` orchestrator_settings keys for the header/footer
> formats ("the format expressed as a prompt"). The old `cleanup_preset_id` column is left in place,
> unread. This document is kept only as the historical design record of what the inline pass was —
> including §2.4's canonical header wire format, which the new header regex/prompt default still
> encodes (`DEFAULT_CLEANUP_CONFIG` in `cleanupHeuristics.ts`).

**Status**: Designed  
**Scope**: Addition and handling of the secondary LLM Cleanup Pass prompt in the turn loop.  
**Governing Principles**: `bi_principles.md` §2 (LLM Reasons), §8 (Four Kinds of Code), §11 (Observability), §18 (Surfaced Prompts/Presets).

---

## 1. Overview & Goal

The **Cleanup Pass** is an optional, post-processing LLM call executed immediately after the main LLM completes a turn (`runTurn`) and before the final assistant message is persisted to database storage.

Its purpose is to accept the raw generated reply (`{{message}}`), alongside optional trailing turn history, and run it through a dedicated **Cleanup Preset** (`context_stack_presets`) to:
1. Strip banned constructions, AI clichés, and formatting slop.
2. Reconstruct or enforce required location/date/time headers.
3. Reconstruct or format internal thought/reasoning suffixes (`<details>` blocks).

**Key Design Contract**: The Cleanup Pass is **fail-open**. If the cleanup pass throws an error, times out, or returns empty output, the engine logs the error and gracefully falls back to the raw generated reply. Cleanup failure must **never** block or degrade the user's turn.

The prompt itself — including the banned-construction/slop list — is not hardcoded: it ships as a built-in, named preset on the **Prompt Stacks** page, viewable and duplicate-to-edit exactly like any other prompt stack (see §2.3).

---

## 2. Data Model & Schema

### 2.1 Database Schema (`chat_sessions`)
Added via `db/migrations/0057_cleanup_preset.sql`:

```sql
ALTER TABLE chat_sessions 
  ADD COLUMN cleanup_preset_id uuid REFERENCES context_stack_presets(preset_id) ON DELETE SET NULL;
```

* `cleanup_preset_id = NULL` (default): Cleanup pass is **disabled** for this chat.
* `cleanup_preset_id = <uuid>`: Cleanup pass is **enabled** using the specified preset.

### 2.2 Application Types

#### `orchestrator/src/io/chatSessions.ts` & `frontend/src/api/types.ts`
```typescript
export interface ChatSessionRow {
  // ... existing fields ...
  cleanupPresetId: string | null;
}

export interface ChatParams {
  // ... existing fields ...
  cleanupPresetId?: string | null;
}
```

#### `orchestrator/src/util/interpolateMacros.ts`
```typescript
export interface MacroSnapshot {
  charName?: string;
  userName?: string;
  persona?: string;
  description?: string;
  scenario?: string;
  /** The raw generated text from the main turn, available during the Cleanup Pass. */
  message?: string; 
}
```

### 2.3 Built-in Cleanup Preset — Where the Prompt is Viewed, Edited & the Slop List Lives

Per `bi_principles.md` §18 (Every Prompt is Surfaced for Manual Tuning), the Cleanup Pass prompt — including the banned-construction/AI-clichés slop list — must ship with a sensible default but must never live only in source.

It is surfaced the same way every other prompt in this system already is: as a **named, built-in preset on the Prompt Stacks page** (`frontend/src/views/PromptStacksView.tsx`), seeded by a new migration `db/migrations/0066_cleanup_preset_seed.sql` that follows the exact `is_builtin = true` pattern migration `0042` used for the "Standard" and "Minimal" presets.

* A new builtin preset named **"Cleanup Pass"** (owned by the system user, `is_builtin = true`).
* A single `custom` slot (`custom_role = 'system'`) whose `custom_content` holds the actual instruction text: the banned-word/phrase slop list, the header-reconstruction rule, and the thought-suffix formatting rule. This *is* the literal prompt sent to the cleanup LLM call (§3.1) — the slop list is not a separate table, config value, or JSON array; it's just text inside this one slot.

**Viewing / editing the prompt**: Same mechanism as any other preset. Open Prompt Stacks, select "Cleanup Pass". Being builtin it's read-only there; a user who wants to tune it clicks **Duplicate to customize**, which creates a normal (non-builtin) preset copy they can freely edit — same "edit locally, commit one `update_context_stack_preset` call on Save" flow every other preset already uses.

**Maintaining the slop list**: There is no separate slop-list UI or table. It's the `customContent` textarea of that one slot — add, remove, or reword banned constructions directly as plain text, the same way any other custom prompt block is edited.

**Assigning to a chat**: The Chat Settings "Cleanup Preset" selector (§5 item 5) points a chat's `cleanup_preset_id` at either the builtin default or a user's customized duplicate — the same selection shape the pre-existing `prompt_stack_preset_id` selector already uses.

### 2.4 Header Wire Format (Canonical)

This is the exact, load-bearing format the builtin preset's rule 2 enforces — anything downstream that parses a cleaned reply (the post-cleanup heuristic extraction pass, `docs/vistalyze_integration/segway.md`) must match this precisely, not a paraphrase of it:

```
[ TimeOfDay | 🗓️ DayOfWeek, Month DD, YYYY Era | 📍 Location - Specific Area ]
Present: Character A, Character B, Character C
```

* Always exactly two lines, the first two lines of the message, nothing before them.
* `TimeOfDay` — a plain phrase ("Early Morning", "Late Evening"), not a clock time.
* `Era` — "AD"/"BC" by default, or the story's own established custom calendar era if one exists (e.g. "41st Millennium", "3 ABY").
* `Location` — `General Area - Specific Room` when a specific room/spot is known, else just the general area.
* `Present` — the explicit, comma-separated roster of every character physically in the room at the end of the turn. Reconstructed from context (never invented) when missing, same as the rest of the header.

No weather/atmosphere field — dropped from an earlier draft of this prompt; it isn't part of the format this doc's design is actually built around.

---

## 3. Prompt Construction & Input Assembly

The Cleanup Pass is driven by a standard `context_stack_presets` row. Its slots are typically `custom` system/user blocks that contain instruction rules and embed the `{{message}}` macro variable.

### 3.1 Macro Interpolation
When assembling the cleanup prompt:
1. `MacroSnapshot` is populated with `message: rawReply` (the uncleaned output from `runTurn`).
2. `interpolateMacros(text, snapshot, resolveArg)` replaces `{{message}}` with the literal raw reply text, and `{{prev_turns, N}}` — via the cleanup call site's `resolveArg` hook — with the last `N` turn pairs of the active history rendered as labeled `User:`/`Assistant:` text (`runCleanupPass` builds it from `historyMessages`, which the caller already trimmed to the live window). The argument is the number of turn pairs, default `2` when omitted, so the pair count is prompt-controlled rather than hardcoded. A preset that never references `{{prev_turns, N}}` gets no history at all — the author's explicit choice.
3. Character/persona macros (`{{char}}`, `{{user}}`, `{{persona}}`) resolve from the chat's linked character (`characters.name`) and the household persona settings (`persona_name`/`persona_description`), read live per cleanup call — an edit after Apply shows up on the next cleanup. These are fail-soft: a lookup failure degrades them to empty rather than skipping the pass.

### 3.2 Input Message Array Construction
The messages array passed to `turnLlm.complete()` during cleanup is the preset slots, each interpolated as above — except that a preset whose text **never references `{{prev_turns, N}}`** keeps the legacy behavior: the last 2 turn pairs prepended as messages ahead of the slots. That fallback exists so presets written before the macro existed don't silently lose the history they were built against; a preset that does reference the macro gets exactly the requested number of pairs as text (and `{{prev_turns, 0}}` is an explicit opt-out). Either way the pair count ultimately lives in the prompt — where the person running the platform can tune it per bi_principles.md §18 — rather than hardcoded in code.

---

## 4. Execution Sequence (`runCleanupPass`)

The cleanup pass logic is encapsulated in a helper function invoked inside `orchestrator/src/server/httpServer.ts`.

### 4.1 Function Signature
```typescript
async function runCleanupPass(
  db: PostgresClient,
  userId: string,
  chatId: string,
  cleanupPresetId: string,
  turnLlm: LlmProvider,
  rawReply: string,
  historyMessages: LlmMessage[]
): Promise<string>
```

### 4.2 Detailed Execution Flow

```text
[ Main Turn Complete ] ──> `rawReply` generated by `runTurn`
          │
          ▼
 Is `cleanupPresetId` set on chat?
    ├── NO  ──> Return `rawReply`
    └── YES ──> Continue to Cleanup Pass
          │
          ▼
 1. Load slots for `cleanupPresetId` via `loadPromptStackSlots(db, userId, cleanupPresetId)`
    └── If slots are empty ──> Log warning, Return `rawReply`
          │
          ▼
 2. Build `MacroSnapshot` with `{ message: rawReply, charName, userName, ... }`
          │
          ▼
 3. Assemble cleanup messages:
    - Interpolated cleanup preset slots (with `{{message}}` and `{{prev_turns, N}}` resolved from the turn's history)
          │
          ▼
 4. Execute LLM Call:
    `runWithCallContext({ taskId: chatId, kind: 'chat', userId }, ...)`
    `turnLlm.complete(cleanupMessages, [])`
          │
          ├── SUCCESS ──> Return `turn.message.content` (Cleaned Text)
          └── FAILURE ──> Log error, Return `rawReply` (Fail-Open)
```

### 4.3 Call Context & Gate Accounting
* **Kind**: `kind: 'chat'` (it runs within the turn budget, not as a background agent routine).
* **Metering**: The call is logged to `llm_calls` under the same `request_id` and `chat_id` as the turn.
* **Concurrency**: Admitted through the interactive concurrency lane via `llmGate.ts`.

---

## 5. File-by-File Required Changes

### 1. `db/migrations/0066_cleanup_preset_seed.sql`
* Seed the builtin **"Cleanup Pass"** preset (§2.3): one `context_stack_presets` row (`is_builtin = true`, system user) plus one `custom` slot row carrying the slop-list/header/thought-suffix instruction text — same shape migration `0042`'s "Standard"/"Minimal" seed block used.

### 2. `orchestrator/src/io/chatSessions.ts`
* Update `SESSION_COLUMNS` to include `cleanup_preset_id`.
* Update `SessionDbRow`, `ChatSessionRow`, and `toSessionRow()` to map `cleanup_preset_id` $\rightarrow$ `cleanupPresetId`.
* Update `updateChat()` to accept `cleanupPresetId` in its patch object.

### 3. `orchestrator/src/util/interpolateMacros.ts`
* Add `message?: string` to `MacroSnapshot`.
* Add `case 'message': return snapshot.message ?? '';` to `resolveToken()`.

### 4. `orchestrator/src/server/httpServer.ts`
* Add `runCleanupPass()` helper function.
* Update `handleChatCompletions()`:
  * Extract `session.cleanupPresetId`.
  * Post-`runTurn`, invoke `runCleanupPass()` if `cleanupPresetId` is present.
  * Pass the resulting cleaned string to `chats.appendMessages()` and the response payload.
* Update `regenerateSwipe()`:
  * Invoke `runCleanupPass()` before calling `chats.recordSwipe()`.

### 5. `frontend/src/api/types.ts`
* Add `cleanupPresetId?: string | null` to `ChatSessionRow` and `ChatParams`.

### 6. `frontend/src/views/ChatView.tsx` (`ChatSettings` component)
* Add a **Cleanup Preset** selector to the Chat Settings rail (`chat-settings-rail`), allowing users to select an existing prompt stack preset as the chat's cleanup pass.

---

## 6. Verification & Verification Script

A new test script `orchestrator/scripts/verify-cleanup-pass.mjs` will verify:
1. **Pass-Through**: When `cleanupPresetId` is `null`, `runCleanupPass` returns the raw reply without invoking the LLM.
2. **Substitution**: `{{message}}` in a custom slot correctly receives `rawReply`.
3. **Fail-Open Resilience**: When the cleanup LLM call fails (e.g., stub provider throws), `runCleanupPass` swallows the error, logs it, and returns the original `rawReply`.