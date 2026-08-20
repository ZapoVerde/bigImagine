# Chunk 6 — Household Memory Classifier Plain-Text Conversion

Standalone chunk of the chat-memory structured-output migration (see
`docs/plans/chat-memory-structured-output-plan.md` for the migration's overall shape). Chunks 1–5
(chunk summarizer, bridge, world curator, people curator, distill) are landed and green as of this
review. This is the final extraction conversion chunk.

## Goal

Replace the forced `classify_household_memory` tool call in:

`orchestrator/src/io/chatMemory/classifyHouseholdMemory.ts`

with ordinary text completion plus a tiny local parser, while preserving the existing public return type:

```ts
Promise<string[]>
```

This is the final extraction conversion chunk. Unlike distill, this runs **once at explicit archive time** against the whole chat digest + live tail and decides whether anything deserves to escape the chat and become durable `household_memory`. An empty result is expected and common.

Do not fold the final repo-wide audit into this chunk.

---

# 1. Strengthen the prompt before removing the tool schema

The current prompt is far too thin:

> This conversation just ended. Decide whether anything in it is worth remembering beyond this one chat.

The useful qualification rules currently live mostly in the tool description:

* future, unrelated conversations
* standing preference
* correction
* durable household fact
* self-contained
* empty list is normal

Those need to move into the prompt before the schema disappears.

Replace `DEFAULT_HOUSEHOLD_MEMORY_PROMPT` with something like:

```text
**[SYSTEM: TASK — HOUSEHOLD MEMORY CLASSIFIER]**

This conversation has ended.

Decide whether anything established in it is worth remembering beyond this one chat and recalling in future, unrelated conversations.

Keep only durable information about the user or household, such as:
- standing preferences
- stable personal or household facts
- explicit corrections to previously held information
- recurring constraints or circumstances
- durable decisions that will remain relevant outside this conversation

Reject:
- facts that matter only to this specific conversation
- temporary plans, tasks, or current-session state
- narrative or roleplay events
- generic world knowledge
- things that can be inferred again easily
- conversational filler
- duplicated statements of the same underlying fact

Each retained memory must:
- be one durable fact or preference
- be self-contained and understandable with no surrounding chat
- state what remains true, not narrate how it was learned
- preserve concrete names/details when necessary for future recall

Most conversations should produce no household memory.

OUTPUT FORMAT — follow exactly:

- [one durable self-contained memory]
- [another durable self-contained memory]

If nothing qualifies, output exactly:

NO MEMORIES
```

The important principle is conservative promotion.

This is **not** "summarize the chat." It is a cross-chat persistence gate.

---

# 2. Keep the existing archive input unchanged

`classifyHouseholdMemory()` currently receives one `chatSummary: string`.

Keep that API exactly as-is:

```ts
classifyHouseholdMemory(
  llm,
  chatSummary,
  promptOverride?,
): Promise<string[]>
```

Do not change how `archiveChatMemory()` assembles that input.

Do not add raw chat history here.

Do not change the archive trigger.

Do not change household-memory SQL writes.

The current source explicitly defines this as an archive-only one-shot judgment, not part of periodic sync.

---

# 3. Remove forced-tool transport

### Modify

`orchestrator/src/io/chatMemory/classifyHouseholdMemory.ts`

Remove:

* `ToolDefinition`
* `classifyHouseholdMemoryTool`
* `isMemoriesResponse`
* `forceTool`
* `turn.toolCalls`
* every transport reference to `classify_household_memory`

Replace:

```ts
const turn = await llm.complete(
  [
    { role: 'system', content: promptOverride || DEFAULT_HOUSEHOLD_MEMORY_PROMPT },
    { role: 'user', content: chatSummary },
  ],
  [],
);

return parseHouseholdMemoryOutput(turn.message.content);
```

No caller changes.

Also refresh the file's JSDoc header block (`@architectural-role`, `@description`, `@api-declaration`)
to match the plain-text-wrapper framing every sibling file already carries (`distillChatMemory.ts`,
`classifyChatChunk.ts`) — it currently reads "IO Wrapper — forced-schema LLM call" and describes
`forceTool`/tool-call behavior that will no longer exist. This is easy to skip as "just delete the
tool code" but leaves the header lying about the transport; do it as part of this same edit.

---

# 4. Create the parser

### Create

`orchestrator/src/io/chatMemory/parseHouseholdMemoryOutput.ts`

Export:

```ts
export function parseHouseholdMemoryOutput(raw: string): string[]
```

There is no reason to invent an intermediate object type.

This format is intentionally tiny.

---

# 5. Normalisation

Use the same normalization convention as the other migrated parsers:

```text
raw
→ CRLF to LF
→ trim
→ strip one enclosing markdown fence
→ trim
```

Accept case-insensitive:

```text
NO MEMORIES
```

as:

```ts
[]
```

Do **not** reuse `NO CHANGES NEEDED` here. This stage has a different semantic decision and should have its own explicit sentinel.

Do not accept fuzzy prose such as:

```text
Nothing worth remembering.
```

---

# 6. Parse memories as bullets only

The only accepted non-empty format is:

```text
- The household prefers ...
- The user corrected ...
```

For each non-empty line:

1. require it to begin with `- `
2. strip the bullet
3. trim the resulting memory
4. require non-empty text
5. return that string unchanged

Example:

```text
- The family prefers direct flights when practical.
- The home server uses Proxmox for virtualisation.
```

becomes:

```ts
[
  'The family prefers direct flights when practical.',
  'The home server uses Proxmox for virtualisation.',
]
```

No JSON.

No headings.

No numbered lists.

No prose around the list.

---

# 7. Whole-response validation

Because each line becomes a durable cross-chat memory, be strict structurally.

Reject:

```text
Here are the memories:
- ...
```

Reject:

```text
1. memory
2. memory
```

Reject:

```text
- valid memory

random explanation
```

Reject:

```text
-
```

Do not partially salvage a mixed response.

One malformed line fails the classifier response.

---

# 8. Duplicate-memory handling

Reject **exact duplicate strings within the same response** (compared after the per-bullet trim in
§6 — no additional normalization beyond that).

Example:

```text
- The household prefers dark mode.
- The household prefers dark mode.
```

→ fail.

Reason: there is no benefit to inserting identical durable memories twice, and duplicate output is unambiguously malformed.

Do **not** attempt semantic deduplication:

```text
- The household likes dark mode.
- Dark mode is preferred by the household.
```

That requires language understanding and belongs elsewhere.

Only exact normalized duplicates are a parser concern.

---

# 9. Don't over-validate semantics

Do not mechanically determine whether a memory is:

* actually durable
* a preference vs fact
* sufficiently self-contained
* temporary
* narrative
* likely useful in another conversation

Those are classifier-quality decisions controlled by the prompt.

Likewise:

* no sentence-count enforcement
* no length cutoff unless an existing DB constraint already requires one
* no rewriting
* no capitalization/punctuation repair

The parser only guarantees clean list structure.

---

# 10. Exact files touched

### Modify

```text
orchestrator/src/io/chatMemory/classifyHouseholdMemory.ts
```

### Create

```text
orchestrator/src/io/chatMemory/parseHouseholdMemoryOutput.ts
```

### Modify tests

```text
orchestrator/scripts/verify-chat-memory-text-parsers.mjs
orchestrator/scripts/verify-chat-memory-sync.mjs
```

### Do not touch

```text
orchestrator/src/orchestrator/chatMemorySync.ts
orchestrator/src/io/chatMemory/distillChatMemory.ts
orchestrator/src/io/llm/types.ts
orchestrator/src/io/llm/openaiCompatible.ts
db/migrations/*
```

The archive path already calls `classifyHouseholdMemory()` through a clean function boundary.

---

# 11. Parser tests

Add to:

`orchestrator/scripts/verify-chat-memory-text-parsers.mjs`

Required cases:

1. `NO MEMORIES` → `[]`
2. lowercase `no memories` → `[]`
3. one valid bullet
4. multiple valid bullets
5. CRLF accepted
6. enclosing markdown fence accepted
7. surrounding whitespace accepted
8. bullet text is trimmed
9. empty bullet → fail
10. numbered list → fail
11. prose before bullets → fail
12. prose after bullets → fail
13. mixed valid/invalid lines → whole response fails
14. exact duplicate memories → fail
15. similar but non-identical memories → valid
16. returned array contains plain strings only

No semantic-quality tests.

---

# 12. Update fake-backend routing

### Modify

`orchestrator/scripts/verify-chat-memory-sync.mjs`

After Distill lands, all six memory extraction callers will be plain-text:

* chunk summarizer
* bridge
* world curator
* people curator
* distill
* household classifier

Add a stable system marker:

```text
HOUSEHOLD MEMORY CLASSIFIER
```

and route the fake backend on:

```js
sys.includes('HOUSEHOLD MEMORY CLASSIFIER')
```

before the generic classifier/summarizer fallback — i.e. as another `if (sys.includes(...))` branch
in the same chain that already handles `PEOPLE CURATOR` and `CHAT MEMORY DISTILLER`, ahead of the
`return oaiTextResponse(\`Summary[${content}]\`)` fallback.

This is the same stable-prompt-identity pattern now used by Bridge, World, People, and Distill.

---

# 13. Remove the last forced-tool fixture

Search the verify script for:

```text
classify_household_memory
```

Remove the old:

```text
case 'classify_household_memory':
```

fake tool response (the `switch (forceTool)` block's last remaining case).

Replace structured fixtures like:

```js
{
  memories: [
    'The household prefers ...',
  ],
}
```

with:

```text
- The household prefers ...
```

Search all archive-related test setup for object-shaped household classifier overrides and convert every one.

This should be the **last chat-memory forced-tool test fixture**.

---

# 14. Add an explicit call classifier

For this chunk, add:

```js
function isHouseholdMemoryCall(c) {
  return (
    c.options.forceTool === undefined &&
    (c.messages.find((m) => m.role === 'system')?.content ?? '')
      .includes('HOUSEHOLD MEMORY CLASSIFIER')
  );
}
```

Then inspect every:

```js
c.options.forceTool === undefined
```

filter in the test file.

Any helper that actually means "chunk summarizer" must now exclude:

* bridge
* world
* people
* distill
* household

Concretely: `summarizeCalls()` needs `!isHouseholdMemoryCall(c)` added alongside its existing
`!isBridgeCall`/`!isWorldCuratorCall`/`!isPeopleCuratorCall`/`!isDistillCall` exclusions. The other
`forceTool === undefined` filters in the file (the 'rp'-tick tool-free partition, and the
named-connection block's tool-free count) are scoped to contexts where the household classifier
structurally cannot appear — it only ever runs via the separate `archiveChatMemory()` entry point,
never inside `runChatMemorySyncTick()` — so those do not need a household exclusion added. Confirm
that scoping still holds before skipping them; don't add the exclusion reflexively everywhere.

At this point the test's accumulating exclusion list is ugly, but **do not clean it up yet**. The next standalone chunk is the final audit/refactor pass where that test-only classifier can be centralized.

---

# 15. Archive integration fixture

Use a chat whose archive summary contains both durable and non-durable information.

Have the fake classifier return, for example:

```text
- The household prefers compact technical answers over long explanations.
- The home server runs Proxmox.
```

Then assert that `archiveChatMemory()` inserts exactly those two strings into `household_memory`.

Also test:

```text
NO MEMORIES
```

and assert:

* archive succeeds
* zero household-memory rows are inserted

This is important: **empty classification is success, not skipped/failure.**

That behavior already exists conceptually in the current tool implementation and must remain.

---

# 16. Failure-path integration test

Return malformed output:

```text
- Valid durable memory
This line is malformed.
```

Assert:

* archive/classification fails according to the existing archive error contract
* no `household_memory` rows from that classifier response are committed
* the valid first line is not partially inserted

Do not alter archive transaction semantics just to satisfy the test. If the existing archive path already gives atomicity, prove it.

Note: as of this review, `archiveChatMemory()` (`chatMemorySync.ts:1151-1180`) already fully
`await`s `classifyHouseholdMemory()` before its `household_memory` insert loop runs — a thrown parse
error never reaches the loop, so this atomicity already holds today. This test is expected to pass
against the current archive path unmodified; if it doesn't, that's a real gap worth stopping on
(see below), not an expected outcome.

If the test exposes a real partial-write hole, stop and make that a separate hardening change rather than hiding it inside the transport migration.

---

# 17. Preserve source-chat linkage

The household rows currently derive from an archived chat and retain that source relationship.

Verify the converted classifier does not change:

* `user_id`
* `source_chat_id`
* source/type fields
* insertion count semantics

Only the string payload source changes from tool argument to parsed text.

No schema changes.

---

# 18. Prompt override regression

Check the live stored:

```text
chat_memory_household_memory_prompt
```

before deployment.

Any old custom prompt containing:

```text
call classify_household_memory
```

will be incompatible once this chunk lands.

Same established rule as World / People / Distill:

* blank/default → fine
* bespoke override → deliberately migrate it
* do not mutate arbitrary stored prompt text automatically

---

# 19. Mechanical post-chunk check

This chunk is the final conversion, so perform one **narrow mechanical check** before declaring it complete:

Search:

```text
orchestrator/src/io/chatMemory/
```

for:

```text
forceTool
ToolDefinition
toolCalls
```

Expected result:

**no extraction writer remains dependent on those mechanisms.**

If hits remain, identify them, but do not expand this implementation into the full repo-wide hardening/audit pass yet.

That final pass comes next.

---

# Acceptance criteria

* `classifyHouseholdMemory.ts` contains no `ToolDefinition`, `forceTool`, `toolCalls`, or `classify_household_memory` transport dependency, and its JSDoc header reflects the plain-text-wrapper architecture (matching `distillChatMemory.ts`/`classifyChatChunk.ts`), not the old forced-schema description.
* The qualification rules previously hidden in the tool description live in the new prompt.
* Household classification uses ordinary text completion.
* `parseHouseholdMemoryOutput.ts` returns the exact existing `string[]` contract.
* `NO MEMORIES` is a valid successful empty result.
* Only simple bullet-list output is accepted.
* Malformed mixed output fails as a whole.
* Exact duplicate memories in one response are rejected.
* Archive-time invocation semantics remain unchanged.
* `household_memory` SQL/storage behavior and source-chat linkage remain unchanged.
* Fake backend correctly distinguishes all six plain-text memory callers.
* The final forced `classify_household_memory` fake/test path is removed.
* Chunks 1–5 remain green.
* Narrow search confirms no chat-memory extraction writer still uses forced tools.
* **Scope ends here. The next chunk is the final migration audit/hardening pass, not another LLM conversion.**
