# Chat-memory Distill Plain-Text Conversion

Standalone chunk of the chat-memory structured-output migration (see
`docs/plans/chat-memory-structured-output-plan.md` for the migration's overall shape). Chunks 1–4
(chunk summarizer, bridge, world curator, people curator) are landed and green as of this review —
confirmed by running `verify-chat-memory-sync.mjs` and `verify-chat-memory-text-parsers.mjs`
directly. This is Chunk 5 of 6; `classifyHouseholdMemory.ts` (the household/rp classifier) remains
forced-tool and is the final chunk, out of scope here.

## Goal

Replace the forced `distill_chat_memory` tool call in:

`orchestrator/src/io/chatMemory/distillChatMemory.ts`

with ordinary text completion plus a local parser, while preserving the existing BI return type:

```ts
export interface ChatMemoryEntryDraft {
  topicKey: string;
  content: string;
}
```

Nothing downstream changes. The sync loop (`chatMemorySync.ts`'s `distill` / `upsert_entries`
steps, `chatMemorySync.ts:1057-1088`) still upserts returned entries into `chat_memory_entries` by
`(chat_id, topic_key)`, and omitted entries remain untouched. That existing behavior is the core of
this stage and must stay exactly as-is.

This is **not** a generic summary call. It maintains a set of persistent conversation topics, where
an existing `topicKey` is reused when a thread continues and a new key is created only for
genuinely new material.

---

## 1. Improve the prompt before changing transport

The current default prompt is too thin:

> You maintain a short running digest of key ideas...

Most of the actual behavioral contract currently lives inside the tool schema, especially:

* only return entries that are new or meaningfully changed
* reuse existing topic keys exactly
* invent a new key only for a genuinely new idea
* keep content to 1–3 sentences
* an empty result is valid

Once the tool disappears, those instructions need to move into the prompt or they disappear with
it.

Replace `DEFAULT_DISTILL_CHAT_MEMORY_PROMPT` with a proper standalone prompt, headed the same way
every other converted caller is (`bridgeChatMemory.ts`'s `NARRATIVE CHRONICLER`,
`curateWorldMemory.ts`'s `LOREBOOK CURATOR`, `curatePeople.ts`'s `PEOPLE CURATOR`) — this header is
what the fake-backend routing in §12 keys off of, and every sibling caller sets the precedent of a
`**[SYSTEM: TASK — ...]**` first line:

```text
**[SYSTEM: TASK — CHAT MEMORY DISTILLER]**
You maintain the persistent key-idea digest for one ongoing conversation.

You will receive:
- CURRENT ENTRIES: the key ideas already stored for this conversation
- NEWLY ARCHIVED MEMORY: summaries of the latest conversation chunks

Your job is to return only the entries that are new or whose current state has meaningfully changed.

Rules:
- Reuse an existing topic key exactly when the new material continues or changes the same underlying idea.
- Create a new topic key only when the new material introduces a genuinely distinct idea worth retaining.
- Do not restate entries that remain accurate and unchanged.
- Do not delete or retire entries. Anything you omit remains stored unchanged.
- Each entry should describe the current state of that idea, not narrate the sequence of turns that produced it.
- Preserve concrete names, decisions, commitments, constraints, corrections, preferences, and unresolved matters that will matter later.
- Exclude conversational filler, transient phrasing, repeated information, and details with no likely future value.
- Write each entry in 1–3 concise sentences.
- Topic keys must be short, stable, lowercase snake_case identifiers.

OUTPUT FORMAT — follow exactly:

[topic_key]
Current state of this idea in 1–3 sentences.

[another_topic_key]
Current state of this idea in 1–3 sentences.

If nothing is new or meaningfully changed, output exactly:

NO CHANGES NEEDED
```

This preserves the behavior that currently sits partly in the tool definition.

---

## 2. Data placement: move CURRENT ENTRIES into the user message

The current `distillChatMemory()` appends `Current entries:` onto the *system* message and puts
only the newly-archived summaries in the user message. Every already-converted sibling caller
(`bridgeChatMemory.ts`, `curateWorldMemory.ts`, `curatePeople.ts`) keeps the system message to pure
static instructions and puts **all** per-call dynamic data in the user message — `curateWorldMemory`
even keeps unresolved `{{lorebook_entries}}`/`{{transcript}}` mentions in its system prompt purely
to describe the shape the model should expect, with the real data living only in the user message.

Bring distill in line with that: build one user message carrying both blocks.

```text
CURRENT ENTRIES:
- [topic_key] existing content
- [topic_key] existing content

NEWLY ARCHIVED MEMORY:
1. summary
2. summary
```

Do not alter what data is supplied, the digest horizon, or chunk selection logic — only where in the
message list it's placed.

---

## 3. Remove the forced-tool transport

### Modify

`orchestrator/src/io/chatMemory/distillChatMemory.ts`

Remove:

* `ToolDefinition`
* `distillChatMemoryTool`
* `DistillResponse`
* `isDistillResponse`
* `forceTool`
* `turn.toolCalls`
* references to `distill_chat_memory`

Call:

```ts
const existingList = existingEntries.length
  ? existingEntries.map((e) => `- [${e.topicKey}] ${e.content}`).join('\n')
  : '(none yet)';
const newList = newChunkSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n');

const turn = await llm.complete(
  [
    { role: 'system', content: promptOverride || DEFAULT_DISTILL_CHAT_MEMORY_PROMPT },
    {
      role: 'user',
      content: `CURRENT ENTRIES:\n${existingList}\n\nNEWLY ARCHIVED MEMORY:\n${newList}`,
    },
  ],
  [],
);
```

Then:

```ts
return parseDistillMemoryOutput(turn.message.content);
```

The public function remains:

```ts
distillChatMemory(...): Promise<ChatMemoryEntryDraft[]>
```

No caller changes.

---

## 4. Create the parser

### Create

`orchestrator/src/io/chatMemory/parseDistillMemoryOutput.ts`

Export:

```ts
export interface ParsedChatMemoryEntry {
  topicKey: string;
  content: string;
}

export function parseDistillMemoryOutput(
  raw: string,
): ParsedChatMemoryEntry[]
```

The parser is pure and context-free.

It does not know whether a key already exists. That remains the model's decision plus the existing
SQL upsert behavior.

---

## 5. Normalisation

Use exactly the same tolerance `parseWorldMemoryOutput.ts` and `parsePeopleMemoryOutput.ts`
establish (both have a `normalize()` helper of this identical shape):

```text
raw
→ CRLF to LF
→ trim
→ strip one enclosing markdown fence
→ trim
```

The sentinel check is case-insensitive, matching both siblings' `text.toUpperCase() ===
NO_CHANGES_SENTINEL`:

```text
NO CHANGES NEEDED
no changes needed
```

both return `[]`. Do not accept arbitrary alternatives such as:

```text
Nothing important changed.
```

No fuzzy interpretation beyond that case tolerance.

---

## 6. Parse entry blocks

A valid block is:

```text
[topic_key]
Content.
```

A new block begins only on a line that consists entirely of:

```text
[...]
```

i.e. the trimmed line matches `^\[(.+)\]$` with nothing else on it.

The parser should:

1. find the first `[topic_key]`
2. require no arbitrary prose before it
3. capture content until the next topic-key header or end of response
4. trim content
5. require non-empty content
6. return `{ topicKey, content }`

Example:

```text
[house_move]
The family had decided to move to Fremantle and was comparing schools before choosing a suburb.

[server_upgrade]
The home server upgrade remained blocked on selecting replacement storage.
```

becomes:

```ts
[
  {
    topicKey: 'house_move',
    content:
      'The family had decided to move to Fremantle and was comparing schools before choosing a suburb.',
  },
  {
    topicKey: 'server_upgrade',
    content:
      'The home server upgrade remained blocked on selecting replacement storage.',
  },
]
```

---

## 7. Topic-key validation

This is worth enforcing because `topicKey` is not decorative prose; it becomes the stable SQL
identity for the digest row.

Require:

```text
[a-z0-9]+(?:_[a-z0-9]+)*
```

Accept:

```text
school_choice
server_upgrade
wes_hass_issue
```

Reject:

```text
School Choice
school-choice
school choice
_school
school_
```

### Important scope note

This is slightly stricter than the current runtime validator.

The current tool schema *instructs* the model to produce a short stable snake_case key, but
`isDistillResponse()` only verifies that `topic_key` is a string.

So enforcing snake_case in the parser is a new hard gate — the same kind of tightening
`parsePeopleMemoryOutput.ts` introduced for its two-word-name rule and Goals shape, neither of which
the old forced tool enforced either.

Still enforce it: malformed keys directly damage the identity mechanism this stage relies on. Call
it out as a deliberate tightening and watch initial production runs.

---

## 8. Duplicate keys within one response

Reject a response that contains the same key twice:

```text
[server_upgrade]
...

[server_upgrade]
...
```

Do not silently let "last one wins."

The model should produce one current-state replacement per idea.

This also avoids ambiguous ordering before the SQL upsert stage.

Again, this is parser integrity, not semantic judgment.

---

## 9. Content validation

Require content to be non-empty.

Do not mechanically enforce:

* 1–3 sentences
* tense
* specific keywords
* whether the idea is genuinely durable

Those are prompt-quality rules.

Do not truncate long output.

Do not rewrite prose.

---

## 10. Whole-response failure

Use the same migration rule as the world and people curators.

> one malformed entry fails the entire distill response.

Examples:

```text
[valid_key]
Valid content.

[Bad Key]
Other content.
```

→ fail the whole stage.

Likewise:

* missing key
* empty key
* invalid key syntax
* empty content
* duplicate key
* arbitrary prose outside blocks

must fail rather than partially applying valid entries.

The sync transaction/boundary machinery remains responsible for rollback.

---

## 11. Exact production files

### Modify

```text
orchestrator/src/io/chatMemory/distillChatMemory.ts
```

### Create

```text
orchestrator/src/io/chatMemory/parseDistillMemoryOutput.ts
```

### Modify tests

```text
orchestrator/scripts/verify-chat-memory-text-parsers.mjs
orchestrator/scripts/verify-chat-memory-sync.mjs
```

### Do not touch

```text
orchestrator/src/orchestrator/chatMemorySync.ts
orchestrator/src/io/chatMemory/classifyHouseholdMemory.ts
orchestrator/src/io/llm/types.ts
orchestrator/src/io/llm/openaiCompatible.ts
db/migrations/*
```

The current `distillChatMemory()` boundary already isolates this migration cleanly.

---

## 12. Parser tests

Add to:

`orchestrator/scripts/verify-chat-memory-text-parsers.mjs`

Required cases:

1. `NO CHANGES NEEDED` → `[]`
2. one valid entry
3. multiple valid entries
4. existing-looking key parses unchanged
5. CRLF accepted
6. enclosing markdown fence accepted
7. surrounding whitespace accepted
8. lowercase-variant sentinel (`no changes needed`) accepted, matching sibling parsers' case tolerance
9. multiline content accepted
10. empty key → fail
11. key containing spaces → fail
12. hyphenated key → fail
13. uppercase key → fail
14. leading/trailing underscore → fail
15. missing content → fail
16. duplicate topic key → fail
17. arbitrary prose before first block → fail
18. malformed block among valid blocks → whole response fails
19. object key set exactly matches:

```text
content,topicKey
```

Do not add tests for sentence counting or semantic quality.

---

## 13. Sync fake-backend routing

### Modify

`orchestrator/scripts/verify-chat-memory-sync.mjs`

With this chunk landed there are five tool-free memory callers:

* the chunk summarizer (`summarizeChatChunk`, caught by the existing `summarizeCalls()` fallback
  filter — do not confuse this with `classifyHouseholdMemory.ts`, which is the still-forced-tool
  household/rp classifier and stays out of scope for this chunk)
* bridge
* world curator
* people curator
* distill

So add explicit distill routing before the `summarizeCalls()` fallback, following the exact pattern
already established for the other three:

```js
function isDistillCall(c) {
  return (
    c.options.forceTool === undefined &&
    (c.messages.find((m) => m.role === 'system')?.content ?? '').includes('CHAT MEMORY DISTILLER')
  );
}

function distillCalls() {
  return llm.calls.filter(isDistillCall);
}
```

This is exactly why §1's prompt starts with `**[SYSTEM: TASK — CHAT MEMORY DISTILLER]**` — matching
the `NARRATIVE CHRONICLER` / `LOREBOOK CURATOR` / `PEOPLE CURATOR` precedent so routing and
observability stay uniform across all five callers instead of guessing from the user message.

---

## 14. Remove the old forced-tool test path

In the fake backend remove:

```text
case 'distill_chat_memory':
```

Replace its structured response fixture:

```js
{
  entries: [
    { topic_key: '...', content: '...' }
  ]
}
```

with plain text:

```text
[topic_key]
Current state text.
```

No `distillOverride`-named fixture currently exists in the script, but search thoroughly rather than
trusting that — the existing `distillCalls()` helper (currently `forceTool === 'distill_chat_memory'`)
and every assertion built on it must move to the new `isDistillCall` definition.

Search the entire verify script for:

```text
distill_chat_memory
topic_key
```

and update every fixture and assertion, not just the primary routing branch — this includes the
existing seed fixture at `chatMemoryEntries`/`topic_key: 'topic_a'` (§16 reuses that shape) and the
three existing `distillCalls().length === ...` assertions from the current tool-based tests, which
should keep passing unchanged once `distillCalls()` is redefined via `isDistillCall`.

---

## 15. Update tool-free call filters

Chunks 2–4 each had to update tests that treated "no forceTool" as synonymous with "the chunk
summarizer." Distill adds a fifth tool-free caller, and `summarizeCalls()` must exclude it the same
way it already excludes bridge/world/people:

```js
function summarizeCalls() {
  return llm.calls.filter(
    (c) =>
      c.options.forceTool === undefined &&
      !isBridgeCall(c) &&
      !isWorldCuratorCall(c) &&
      !isPeopleCuratorCall(c) &&
      !isDistillCall(c),
  );
}
```

Then inspect every other filter of the form:

```js
c.options.forceTool === undefined
```

(there are more of these outside `summarizeCalls()` itself — e.g. the connection-routing block
around the `chat_memory_profile` test) and ensure each either:

* intentionally means *all* tool-free memory calls, or
* excludes bridge, world, people, **and distill** when it really means "the fallback/summarizer
  call only."

Do not assume only `summarizeCalls()` needs adjustment. Search the whole verify script — this is
precisely the class of gap that had to be closed for Chunk 4 (People) before it went green, and it
recurs identically here.

This repeated test fragility is now obvious enough that after this migration is finished (Chunk 6:
`classifyHouseholdMemory.ts`), the final cleanup pass should probably introduce a proper test-only
call classifier rather than continuing to accumulate exclusions. Don't refactor it in this chunk.

---

## 16. Integration fixture

The fake distill response should exercise both update-like and new behavior using SQL semantics
rather than explicit action words.

Seed an existing entry:

```text
[server_upgrade]
The server upgrade was awaiting hardware selection.
```

Return:

```text
[server_upgrade]
The server upgrade had moved forward after replacement storage was selected.

[backup_strategy]
A new backup strategy was being planned around off-site replication.
```

Then assert:

* `server_upgrade` is updated, not duplicated
* `backup_strategy` creates a new row
* omitted existing topics remain unchanged

That directly tests the key design of this stage.

---

## 17. Integration assertions

Prove:

* distill request sends no tools
* `forceTool` absent
* existing entries are present in the model's user message
* newly archived summaries are present and ordered
* an existing topic key upserts the same row
* a new topic key creates a new row
* omitted existing entries remain untouched
* `NO CHANGES NEEDED` produces no digest writes but still allows the sync to succeed
* malformed distill text fails the `distill` stage
* malformed output produces no partial `chat_memory_entries` writes
* malformed output does not advance the closed sync boundary
* chunk-summarizer / bridge / world / people / distill routing all remain correctly distinguished

The existing SQL code should not need modification. The current design already expects
`distillChatMemory()` to return only changed/new entries and upserts those by topic key.

---

## 18. Digest-horizon regression

This stage has an important existing behavior that must remain green:

the distiller is fed a trailing horizon of chunk summaries (`chatMemorySync.ts:1064-1072`, reading
`chat_chunks.summary` back `sync.digestHorizonChunks` deep), not only the summaries created in the
current tick.

The existing `verify-chat-memory-sync.mjs` specifically exists in part to prove that behavior.

Do not modify the horizon logic.

Keep/assert the existing test proving:

```text
prior trailing summaries
+
new summaries
→ distill input
```

The transport migration must not accidentally reduce the distiller to current-tick summaries only.

---

## 19. Prompt override regression

The distill prompt is configurable via the `chat_memory_distill_prompt` setting
(`chatMemorySync.ts:366`, `orchestratorSettings.ts:326`, editable through
`server/admin/chatMemoryPromptSettings.ts`).

Check the live stored value before deployment.

An old override may still say:

```text
Always answer by calling distill_chat_memory
```

Do not mutate custom prompt text automatically.

If the live override is blank/default, no issue.

If a custom override exists, update it deliberately to include the raw-text contract.

This is the same deployment rule already established for the world and people curators.

---

## Acceptance criteria

* `distillChatMemory.ts` contains no `ToolDefinition`, `forceTool`, `toolCalls`, or
  `distill_chat_memory` transport dependency.
* The behavioral rules currently hidden in the tool schema are moved into the default prompt before
  the schema is removed.
* Distill uses ordinary text completion, with all dynamic data (current entries + newly archived
  summaries) in the user message and the system message limited to static instructions, matching
  bridge/world/people.
* `parseDistillMemoryOutput.ts` returns the exact existing `ChatMemoryEntryDraft` shape.
* Existing topic keys remain the stable identity mechanism.
* New topic keys are only model-created for distinct ideas.
* `NO CHANGES NEEDED` (case-insensitive) returns `[]`.
* Invalid/duplicate topic-key blocks fail the whole response.
* Existing SQL upsert and digest-horizon logic remain untouched.
* Fake backend correctly distinguishes all five plain-text memory callers (chunk summarizer, bridge,
  world curator, people curator, distill) — not just the newly added one.
* Existing/new/omitted topic behavior is covered by integration tests.
* `verify-chat-memory-sync.mjs` and `verify-chat-memory-text-parsers.mjs` both pass in full — not
  just the new assertions — before this chunk is considered done.
* **Scope ends here. Do not include `classifyHouseholdMemory.ts`; that is Chunk 6, the final
  conversion chunk.**
