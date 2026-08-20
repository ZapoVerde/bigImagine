# Chat-memory World Curator Plain-Text Conversion

Standalone chunk of the chat-memory structured-output migration (see
`docs/plans/chat-memory-structured-output-plan.md` for the migration's overall shape and
Chunks 1–2, which this follows the same pattern as). Kept as its own document rather than folded
into that plan, since that plan is already long and this chunk's scope is fully self-contained.

## Goal

Replace the forced `curate_lorebook` tool call in:

`orchestrator/src/io/chatMemory/curateWorldMemory.ts`

with ordinary text completion and a local parser, while preserving the existing BI return type:

```ts
export interface WorldMemoryCuratorEntryDraft {
  action: 'update' | 'new' | 'duplicate';
  name: string;
  category?: 'place' | 'thing' | 'concept';
  content?: string;
  duplicateOf?: string;
}
```

Nothing downstream changes. SQL/canon handling (`chatMemorySync.ts`'s `upsert_world_memory` step,
`chatMemorySync.ts:953-986`) continues to consume exactly this type. The existing world curator is
already a Canonize-derived prompt whose main deliberate BI differences are: no keyword `Keys:`
field, no person handling, and proper BI categories rather than lorebook tags.

This chunk follows the already-implemented pattern from Chunks 1–2: plain text across the LLM
boundary, strict local conversion back into BI's existing typed structure.

---

## 1. Preserve the curator logic

Do **not** rewrite or simplify `DEFAULT_WORLD_MEMORY_CURATOR_PROMPT`
(`curateWorldMemory.ts:44-79`).

Its existing behavioural rules are the valuable part:

- durable world-state entries, not narrative summaries
- logistical persistence
- explicit `place / thing / concept` classification
- person exclusion
- entity resolution
- duplicate detection
- hard-data tracking
- rejection of mundane/noisy/flavour-only concepts
- complete replacement entries
- conservative inclusion

Those rules remain intact. The change is to the **output contract**, not what the curator decides.

---

## 2. Add an explicit plain-text output format

Append an output section to `DEFAULT_WORLD_MEMORY_CURATOR_PROMPT`.

Use BI-native fields rather than restoring Canonize's `Keys:` and hashtag categories:

```text
OUTPUT FORMAT — follow exactly.

For an existing entry that needs changing:

**UPDATE: [Exact Existing Entry Name]**
Category: place
[Full replacement content, 3–6 sentences.]

For a new entry:

**NEW: [New Entry Name]**
Category: concept
[Full entry content, 3–6 sentences.]

For an existing redundant entry:

**DUPLICATE: [Exact Redundant Entry Name]**
Duplicate of: [Exact Primary Entry Name]

If nothing needs changing, output exactly:

NO CHANGES NEEDED
```

Allowed categories are only:

```text
place
thing
concept
```

### Why not Canonize's exact format?

Do **not** reintroduce:

```text
Keys: ...
#place
#thing
```

BI intentionally removed keys because vector recall owns retrieval, and category is already
structured state in BI. Reintroducing either would add output the application then immediately
throws away.

---

## 3. Remove the forced-tool transport

### Modify

`orchestrator/src/io/chatMemory/curateWorldMemory.ts`

Remove:

- `ToolDefinition` import
- `curateWorldMemoryTool` (lines 81-127)
- `WorldMemoryCuratorToolResponse`, `isWorldMemoryCuratorResponse` (lines 137-158)
- the `forceTool` option and `turn.toolCalls` handling
- `'Answer by calling curate_lorebook...'` (line 171)

The call becomes:

```ts
const turn = await llm.complete(
  [
    { role: 'system', content: instructions },
    { role: 'user', content: userMessage },
  ],
  [],
);
```

Then:

```ts
return parseWorldMemoryOutput(turn.message.content);
```

`curateWorldMemory()` still returns `Promise<WorldMemoryCuratorEntryDraft[]>`. No caller changes —
`chatMemorySync.ts:962-964` calls it exactly the same way it does today.

---

## 4. Add a world-curator parser

### Create

`orchestrator/src/io/chatMemory/parseWorldMemoryOutput.ts`

Keep this parser specific to the actual format we have today. Do **not** prematurely build a
generic `parseCuratorBlocks` abstraction just because people curation is coming next. Once both
grammars exist, extract a shared block parser only if they genuinely match.

Export:

```ts
export interface ParsedWorldMemoryEntry {
  action: 'update' | 'new' | 'duplicate';
  name: string;
  category?: 'place' | 'thing' | 'concept';
  content?: string;
  duplicateOf?: string;
}

export function parseWorldMemoryOutput(raw: string): ParsedWorldMemoryEntry[]
```

Structurally this matches `WorldMemoryCuratorEntryDraft`, avoiding a type dependency back into the
IO wrapper — the same pattern `parseBridgeOutput.ts` uses for `BridgePlotEntryDraft`.

---

## 5. Normalisation rules

Before parsing:

```text
raw response
→ trim
→ strip one enclosing markdown fence if present
→ normalize CRLF/LF as needed for parsing
→ trim
```

Reuse the same `normalize()` shape `parseBridgeOutput.ts:57-66` already uses (CRLF→LF, trim, strip
one enclosing ``` fence) — same allowed formatting noise, nothing new to invent here.

Do not repair:

- misspelled actions
- invented categories
- missing names
- missing duplicate targets
- malformed blocks

Exact:

```text
NO CHANGES NEEDED
```

returns `[]`. Case sensitivity for the sentinel can be tolerant if desired, but don't accept
arbitrary prose such as "Nothing needed changing." The prompt gives the model a deterministic no-op
value; use it.

---

## 6. Parse UPDATE and NEW blocks

Recognize only `**UPDATE: Name**` and `**NEW: Name**`.

For each:

1. extract action
2. extract and trim name
3. require non-empty name
4. require the next metadata field: `Category: place`
5. category must be exactly one of `place`, `thing`, `concept`
6. everything after the category line until the next recognized block is `content`
7. trim content
8. require non-empty content

Return e.g.:

```ts
{ action: 'update', name: 'The Wandering Pavilion', category: 'place', content: '...' }
{ action: 'new', name: 'Ash Covenant', category: 'concept', content: '...' }
```

Do not enforce 3–6 sentences mechanically. That remains a prompt-quality rule, just as the bridge
parser does not count SCENE words (`parseBridgeOutput.ts` has no length checks either).

---

## 7. Parse DUPLICATE blocks

Recognize:

```text
**DUPLICATE: Redundant Name**
Duplicate of: Primary Name
```

Require:

- non-empty redundant name
- exactly one `Duplicate of:` line
- non-empty primary name
- no content body

Return:

```ts
{ action: 'duplicate', name: 'The Pavilion', duplicateOf: 'The Wandering Pavilion' }
```

Do not require a category on duplicate entries — the current tool schema doesn't either
(`curateWorldMemory.ts:108`: `"Required for 'update'/'new'; omit for 'duplicate'."`), and
`chatMemorySync.ts:971,973` resolves a duplicate's category from the matched existing row, not from
the model's output.

Do not reinterpret Canonize's old prose (`**dup** — duplicate of ...`). The new prompt gives BI a
cleaner scrapeable representation; there's no compatibility requirement with old raw text since BI
never stored that raw format.

---

## 8. Strict whole-response failure

Unlike Canonize, BI automatically writes these results into its SQL-backed canon path.

Therefore: **one malformed block fails the entire curator response.**

Do not do this:

```text
3 valid blocks
1 malformed block
→ silently keep 3
```

Do:

```text
3 valid blocks
1 malformed block
→ throw
→ sync stage fails
→ transaction/boundary does not advance
```

Examples that must fail:

- `**UPDATE:**` with no name
- UPDATE without Category
- `Category: person`
- `Category: location`
- empty content
- DUPLICATE without `Duplicate of:`
- duplicate with trailing replacement content
- unrecognized `**DELETE:**` block
- arbitrary text between structured blocks

This preserves the validation strength the tool schema previously supplied.

**Note on `chatMemorySync.ts:968-985`'s existing per-entry skip.** `upsert_world_memory` already
has `if (!category || !content) { log.error(...); continue; }`. This chunk does not need to touch
or remove it (see §9 — that file is out of scope), and it should not be read as contradicting the
"whole response fails" rule above: it operates one layer downstream of the parser, on the array
`curateWorldMemory()` already returned successfully. Once the parser guarantees `category`/`content`
are non-empty for every `update`/`new` entry, that check becomes unreachable for those two actions
— but it stays live for `duplicate`: `category` there comes from `categoryByName.get(entry.name...)`
(`chatMemorySync.ts:971,973`), a lookup against `existingRows` the parser has no visibility into at
parse time. A `**DUPLICATE: Some Name**` block that is structurally well-formed but names an entry
that doesn't actually exist in `existingRows` will still parse successfully and still get skipped
here, individually, without failing the sync — that's correct and intentional, not a gap this chunk
introduces or needs to close.

---

## 9. Exact production files

### Modify

```text
orchestrator/src/io/chatMemory/curateWorldMemory.ts
```

### Create

```text
orchestrator/src/io/chatMemory/parseWorldMemoryOutput.ts
```

### Do not touch

```text
orchestrator/src/orchestrator/chatMemorySync.ts
orchestrator/src/io/chatMemory/curatePeople.ts
orchestrator/src/io/llm/types.ts
orchestrator/src/io/llm/openaiCompatible.ts
db/migrations/*
```

If this chunk requires edits to any of those, stop and inspect why. The current
`curateWorldMemory()` API already isolates this conversion cleanly.

---

## 10. Parser tests

Add world-curator cases to `orchestrator/scripts/verify-chat-memory-text-parsers.mjs` (the shared
parser-verification file Chunk 2 created — join it rather than starting a new script, matching that
file's own stated intent at its header comment: "Later chunks (world/people/digest) can join this
file rather than each getting their own verify script.").

Required cases:

1. exact `NO CHANGES NEEDED` → `[]`
2. one UPDATE
3. one NEW
4. one DUPLICATE
5. mixed UPDATE + NEW + DUPLICATE
6. multiple entries of the same action
7. CRLF accepted
8. enclosing markdown fence accepted
9. surrounding whitespace accepted
10. `place` accepted
11. `thing` accepted
12. `concept` accepted
13. missing name → fail
14. missing Category → fail
15. `Category: person` → fail
16. unknown category → fail
17. empty UPDATE content → fail
18. empty NEW content → fail
19. DUPLICATE without target → fail
20. DUPLICATE with empty target → fail
21. unknown action such as `DELETE` → fail
22. malformed block among otherwise valid blocks → whole response fails

Also assert the parsed object is structurally identical to the existing
`WorldMemoryCuratorEntryDraft` — same style as that file's existing test 18 for the bridge parser
(`verify-chat-memory-text-parsers.mjs:202-224`, asserting exact top-level key sets).

---

## 11. Integration test

### Modify

`orchestrator/scripts/verify-chat-memory-sync.mjs`

The fake HTTP backend's tool-free branch (`installSyncFetchMock`, lines 569-587) now needs a third
tool-free case alongside the classifier and the bridge: check for the world curator's own header,
`[SYSTEM: TASK — LOREBOOK CURATOR]` (confirmed present verbatim in
`DEFAULT_WORLD_MEMORY_CURATOR_PROMPT`, `curateWorldMemory.ts:44`, distinct from the bridge's
`NARRATIVE CHRONICLER` and the classifier's headerless prompt — no collision). Remove the
`case 'curate_lorebook':` branch from the `switch (forceTool)` block (line 593-594).

The fake world-curator response should be plain text, e.g.:

```text
**UPDATE: Existing Place**
Category: place
[replacement text]

**NEW: New Concept**
Category: concept
[new content]

**DUPLICATE: Redundant Thing**
Duplicate of: Primary Thing
```

Add an `isWorldCuratorCall(c)` helper next to the existing `isBridgeCall(c)`
(`verify-chat-memory-sync.mjs:688-693`), same shape:

```js
function isWorldCuratorCall(c) {
  return (
    c.options.forceTool === undefined &&
    (c.messages.find((m) => m.role === 'system')?.content ?? '').includes('LOREBOOK CURATOR')
  );
}
```

**Two existing call sites break without an explicit fix — update both, don't just add the new
helper and assume it's covered:**

- `summarizeCalls()` (`verify-chat-memory-sync.mjs:699-701`): currently
  `llm.calls.filter((c) => c.options.forceTool === undefined && !isBridgeCall(c))`. Once the world
  curator is also tool-free, this starts matching it too. Change to
  `!isBridgeCall(c) && !isWorldCuratorCall(c)`.
- The connection-lock assertion at `verify-chat-memory-sync.mjs:1265`:
  `namedCalls.filter((c) => c.options.forceTool === undefined && !isBridgeCall(c)).length === 2`
  currently counts exactly the 2 chunk-summarize calls for that tick. Left as-is, it silently
  becomes 3 once the world curator joins the tool-free pool, and the assertion fails. Add the same
  `&& !isWorldCuratorCall(c)` exclusion.

Then prove the same downstream records are produced as before.

---

## 12. Integration assertions

Verify:

- world-curator request has no tools and no `forceTool`
- UPDATE maps to the same existing-entry update path
- NEW maps to the same proposed canon-fact creation path
- `place`, `thing`, and `concept` survive unchanged
- duplicate action maps to the same existing duplicate handling
- malformed curator text fails the sync
- on parser failure, no world-curator results from that pass are committed
- sync boundary does not advance because of a malformed world result

The last two should preferably exercise existing rollback semantics, not require production
changes — the same `step(...)` failure/rollback machinery Chunk 2's bridge failure tests already
exercise, not anything new.

---

## 13. Prompt override regression

The world-curator prompt is configurable (`chat_memory_world_curator_prompt`, wired end-to-end:
`orchestratorSettings.ts:329`, `chatMemorySync.ts:369,400`, and the admin settings surface in
`server/admin/chatMemoryPromptSettings.ts`).

Confirm an existing custom override still passes through unchanged as the system prompt.

There is an important consequence here: **old custom prompts may still instruct the model to call
`curate_lorebook`.** Because transport is changing, a bespoke prompt authored against the old
forced-tool contract can become incompatible.

Handle this explicitly. For this chunk, do **not** silently mutate stored custom prompts. Instead
verify what the actual deployment has stored in `chat_memory_world_curator_prompt` before deploying
this chunk. If it's blank/default, no problem. If a custom override exists, either update it
deliberately as part of deployment, or document that the override must adopt the new text format.
Do not quietly append contradictory instructions to an arbitrary bespoke prompt. This check has to
happen against the live settings store at deploy time — it isn't something this plan can resolve by
reading source.

---

## Acceptance criteria

- `curateWorldMemory.ts` contains no `ToolDefinition`, `forceTool`, `toolCalls`, or
  `curate_lorebook` transport dependency.
- World curation uses ordinary text completion.
- The rich existing curator behaviour remains unchanged.
- BI-specific design remains intact: no Keys, no person entries, explicit category field.
- `parseWorldMemoryOutput.ts` converts text into the exact existing draft shape.
- `NO CHANGES NEEDED` is a valid empty result.
- Any malformed result fails the whole world-curator stage.
- Existing SQL/canon code (`chatMemorySync.ts`) is untouched — including its pre-existing
  per-entry duplicate-target skip, which stays correct and doesn't need touching (§8).
- `verify-chat-memory-sync.mjs` correctly distinguishes classifier, bridge, and world-curator
  plain-text calls, and both pre-existing call-count assertions that assumed only two tool-free
  callers (`summarizeCalls()`, and the connection-lock assertion at line 1265) are updated to
  exclude the world-curator call, not just left to rot.
- Existing default prompt settings continue to work, and any bespoke world-curator override is
  explicitly checked against the live settings store for old tool-call instructions before deploy.
- Chunks 1 and 2 remain green.

**Scope ends there. Do not fold people curation into this change.** People has the additional
`appearance` split and deserves its own standalone chunk.
