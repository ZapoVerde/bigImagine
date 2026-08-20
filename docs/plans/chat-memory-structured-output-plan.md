# Chat-Memory Plain-Text Sync Conversion Plan

## Goal

Move every chat-memory LLM extraction call off forced-tool/structured-output
transport onto ordinary text completion with local parsing, matching
SillyTavern-Canonize's own design. Canonize never uses tool calling for these
passes — precisely because it has to run across whatever model the user has
connected, including ones with unreliable structured-output support.
BigImagine ported Canonize's prompts but wrapped their output in forced tools,
which reintroduced the fragility Canonize deliberately avoided.

## Context

The active connection is `Openrouter Deepseek V4` (`kind = openrouter`, model
`deepseek/deepseek-v4-flash-0731`). Sync has failed before any data commits
because each sync stage forces an OpenAI function call (`tools` plus
`tool_choice`); DeepSeek's pinned provider route (`GMICloud`, then `Novita`)
has no endpoint for that model with forced tool use, returning OpenRouter's
`No endpoints found` 404.

That's a routing-level failure, not a model-behavior one — but it rhymes with
what CNZ saw running against Gemini: Gemini would sometimes balk outright at a
forced-schema call (refuse or mishandle it) even when a route existed.
DeepSeek doesn't do that. Two different symptoms, same underlying fragility:
requiring forced tool-call transport ties chat-memory's reliability to
whichever model/route is active, in a way plain-text extraction never does.
Going tool-less end-to-end removes both failure modes at once, and is the
reason Canonize was built that way from the start.

The legacy `orchestrator_settings.active_llm_profile = deepseek` is not part
of this runtime issue. `llm_connections.is_active` is authoritative after
initial migration; both normal chat and sync are currently using the
OpenRouter row.

## Non-goals

- Do not switch the household's active model or change provider credentials.
- Do not build a per-profile output-mode capability contract (`text` /
  `json_object` / `json_schema` / `tool`) with request-builder mode
  switching. Plain text works everywhere the household currently connects,
  including DeepSeek; a real need for structured output on some future
  connection is a separate problem to design against when it exists, not
  speculative infrastructure to build now.
- Do not weaken transaction rollback, sync health, permanent-failure
  suppression, or output validation.
- Do not alter the canonical data model (`chat_sync_points`, `chat_chunks`,
  `chat_memory_entries`, or `canon_facts`).

## Design

Every chat-memory extraction call becomes an ordinary completion (`tools: []`,
no `forceTool`) whose raw text is parsed locally, the same shape Canonize
uses. No mode negotiation, no per-profile capability flags. Where a caller
currently expects structured data (bridge, world/people curation, household
digest), the prompt asks for a Canonize-style raw-text convention and a small
pure parser turns it into the existing internal draft type — the database
writes and internal types don't change, only the wire format between the LLM
and the parser.

The chunk classifier gets more than a transport change: the current BI prompt
("Summarize... in one or two sentences") is a generic digest, but BI stores
this text as a **retrieval header** — it's embedded separately and used to
decide whether a chunk is relevant to a later query (0094's summary lane).
Canonize's classifier prompt is written for exactly that job: identify the
single most important durable development (event, revelation, confrontation,
decision, emotional shift) rather than summarizing every exchange, in past
tense, compact. That quality bar carries over even though the tool-schema
wrapper doesn't.

## Chunked rollout

This is a multi-caller change; roll it out one extraction path at a time so
each conversion is independently testable and revertible.

- **Chunk 1 (done):** `classifyChatChunk.ts` — detailed below. Landed
  2026-08-20.
- **Chunk 2 (this plan's current scope):** `bridgeChatMemory.ts` — detailed
  below. Unlike Chunk 1, this caller depends on three structured outputs
  (`events`, `scene`, `plotEntries`), so it needs a real parser rather than
  pass-through text.
- **Later chunks (not yet scoped in detail):** `curateWorldMemory.ts`,
  `curatePeople.ts`, `distillChatMemory.ts`, `classifyHouseholdMemory.ts`.
  Chunk 1 is the template for transport (raw text out, no forced tool, no
  mode abstraction); Chunk 2 is the template for parsing (small tolerant
  local parser, strict on structure, matches the existing draft type
  exactly).

## Chunk 1: `classifyChatChunk.ts`

### 1. Remove the forced tool transport

`orchestrator/src/io/chatMemory/classifyChatChunk.ts`:

```text
forced summarize_chat_chunk tool
```

becomes

```text
ordinary completion
→ turn.message.content
```

No `ToolDefinition`, no `forceTool`, no `toolCalls`. `summarizeChatChunk`
still returns `Promise<string>`; nothing downstream changes shape.

### 2. Replace the summary prompt with a proper classifier prompt

```text
You are a precise conversation memory classifier.

Write a compact memory header for the conversation slice provided below. This header will be embedded and used later to decide whether the underlying conversation is relevant to a future query.

Identify the most important durable development in the slice rather than summarising every exchange.

For roleplay or narrative conversation, prioritise:
- significant events or actions
- revelations or discoveries
- confrontations or decisions
- meaningful relationship or emotional shifts
- changes in goals, threats, circumstances, or story state

For ordinary conversation, prioritise:
- decisions or conclusions
- important facts established
- plans or commitments
- corrections or changed understanding
- the central subject when no stronger development occurred

Preserve the concrete names, places, objects, concepts, and distinctive terms that would make this memory discoverable later.

Do not include conversational filler, repeated detail, prose atmosphere with no lasting significance, or a turn-by-turn recap.

Write 2–4 concise sentences in past tense.

Output only the memory header. No title, label, bullets, explanation, quotes, or markdown.
```

2–4 sentences (not Canonize's 3–4): BI also classifies non-RP chats, where
four sentences is often more than the content warrants.

**Open decision, not yet resolved:** Canonize's prompt also carries an
explicit uncensoring line ("violence, explicit language, adult themes...
permitted without restriction"), because it classifies RP scenes that are
often explicit. The prompt above drops it. If a chunk classifier ever hits a
model that sanitizes or refuses on an intense scene, that's a different
failure mode than the tool-transport problem this plan fixes, and dropping
the line is the likely cause — decide explicitly whether to carry it over
rather than rediscovering this by accident later.

Not porting: Canonize's `PRECEDING TURNS` context distinction.
`summarizeChatChunk()` receives exactly one chunk's `content` — there's no
preceding-history parameter in its API today, and adding one would widen this
chunk into chunk-context architecture. Leave it alone.

### 3. Parsing/validation

Deliberately boring:

```text
raw assistant response
→ trim
→ strip one enclosing markdown fence if present
→ trim
→ require non-empty
→ return
```

No sentence parser, no JSON, no mechanical past-tense enforcement — the
prompt controls quality, the code only establishes the text is usable. No
hard character cutoff either: `chat_chunks.summary` is `text not null` with
no length constraint, so an arbitrary size limit here would just risk turning
a valid classifier response into a failed sync for no benefit. Let the
model's output-token limit and the prompt's own "2–4 sentences" instruction
constrain it.

### Exact implementation scope

**Touched:**

- `orchestrator/src/io/chatMemory/classifyChatChunk.ts`
- `orchestrator/scripts/verify-chat-memory-sync.mjs`
- `orchestrator/scripts/verify-eager-chunk-sync.mjs` (eager chunking calls the
  same summarizer)
- `orchestrator/scripts/verify-chat-chunk-resize.mjs` — the size-resize
  backfill (`chatChunkResize.ts`) is a **third** caller of
  `summarizeChatChunk`, alongside `chatMemorySync.ts` and
  `eagerChunkSync.ts`. Easy to miss since it's a one-off admin backfill, not
  part of the regular sync tick, but it hits the exact same forced-tool
  assumption and needs the same fix.

All three verify scripts' fake HTTP backends currently dispatch purely on
`body.tool_choice?.function?.name` and throw on anything unrecognized
(`verify-chat-memory-sync.mjs` multiplexes `summarize_chat_chunk` against
`distill_chat_memory` and `bridge_chat_memory` through the same switch). Once
`summarizeChatChunk` stops sending `tool_choice`, each backend needs a new
branch keyed on its *absence* — not a large change, but real work in three
places, not just "add an assertion."

**Not touched:**

- `chatMemorySync.ts`
- `eagerChunkSync.ts`
- `chatChunkResize.ts` (caller only — its call site doesn't change shape)
- `openaiCompatible.ts`
- `types.ts`
- SQL/migrations
- Settings storage — `chatMemoryPromptSettings.ts` already imports
  `DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT` generically, so changing the constant
  changes the built-in default while preserving custom overrides.

### Tests

1. Fake LLM gets `tools.length === 0`.
2. `forceTool` is absent.
3. Plain assistant text becomes the stored `chat_chunks.summary`.
4. The same summary is passed to the summary embedding call.
5. Leading/trailing whitespace is removed.
6. One enclosing markdown fence is tolerated.
7. Empty/whitespace response throws and no chunk is committed.
8. Eager chunk sync (`eagerChunkSync.ts`) uses the same tool-free summarizer.
9. The chunk-resize backfill (`chatChunkResize.ts`) uses the same tool-free
   summarizer.
10. Existing custom `chunk_summary_prompt` is still passed through unchanged.
11. RP and ordinary-chat chunks both exercise this classifier, since the
    prompt deliberately covers both.

## Chunk 1 acceptance criteria

- `classifyChatChunk.ts` makes no forced-tool call; `summarizeChatChunk`
  works against any connection that can return plain text, including routes
  that reject or mishandle forced `tool_choice`.
- All three callers (`chatMemorySync.ts`, `eagerChunkSync.ts`,
  `chatChunkResize.ts`) and their verify scripts pass on the new transport.
- Chunk summaries read as retrieval headers (most-important-development,
  past tense, 2–4 sentences) rather than generic digests.
- No change to `chat_chunks` schema, transaction rollback behavior, or
  Settings override behavior.
- Later chunks (bridge/world/people/digest) are unblocked to repeat the same
  pattern, but not built here.

## Chunk 2: `bridgeChatMemory.ts`

### Goal

Replace the forced `bridge_chat_memory` tool call with the original
Canonize-style text output, then parse that text back into the **existing**
BI `BridgeResult`:

```ts
{
  events: string;
  scene: string;
  plotEntries: {
    name: string;
    content: string;
    arcTag: string;
  }[];
  prompt: string;
}
```

Nothing downstream changes shape — the SQL-facing code does not know this
migration happened.

### 1. Remove the forced tool transport

`orchestrator/src/io/chatMemory/bridgeChatMemory.ts`:

Remove `ToolDefinition` import, `bridgeChatMemoryTool`, `BridgeToolResponse`,
`isBridgeResponse`, `forceTool`, `turn.toolCalls`.

`DEFAULT_BRIDGE_PROMPT` (the PART 1/2/3 system prompt) does not change — it
is already the verbatim, tuned Canonize prompt and already documents the
output shape inline per-part. The only thing that changes is the tail of the
**user message** built inside `bridgeChatMemory()`: the line

```text
Answer by calling bridge_chat_memory with the EVENTS table, SCENE prose, and
any PLOT entries.
```

is replaced with Canonize's own literal `OUTPUT FORMAT` block (confirmed
against `extension_settings.cnz.activeState.hookseekerPrompt` in
`stacks/sillytavern/st-data/default-user/settings.json` — that block sits
after `TRANSCRIPT`/`PREVIOUS OUTPUT`/`existing_threads` in Canonize's flat
template, which is exactly where BI's user-message builder sits relative to
the system prompt, so this is a straight port, not a guess):

```text
OUTPUT FORMAT — follow exactly:

EVENTS:
| When | What | Who |
|------|------|-----|
| [when] | [what] | [who] |

SCENE:
[approximately 150–200 words of present-tense prose]

**NEW: [Entry Name]**
[2–4 sentences in past tense.]
#thread_tag
```

Retain the existing rule: if no plot development qualifies, output only
EVENTS and SCENE.

Replace the call with:

```ts
const turn = await llm.complete(
  [
    { role: 'system', content: instructions },
    { role: 'user', content: userMessage },
  ],
  [],
);
```

matching Chunk 1's already-landed call shape in `classifyChatChunk.ts`
exactly (two-arg `complete()`, empty tools array, no third `options` arg).

Then:

```ts
const parsed = parseBridgeOutput(turn.message.content);
```

The prompt-snapshot logic is unchanged: BI persists the fully rendered
bridge prompt on the sync point for inspection (`prompt` field), and that
continues to be built and returned exactly as now.

### 2. Add a dedicated parser

Create `orchestrator/src/io/chatMemory/parseBridgeOutput.ts`. Do not bury
this inside `bridgeChatMemory.ts` — the IO wrapper stays `build prompt → call
model → parse result → return BridgeResult`, and the parser is pure and
independently testable.

```ts
export interface ParsedBridgeOutput {
  events: string;
  scene: string;
  plotEntries: BridgePlotEntryDraft[];
}

export function parseBridgeOutput(raw: string): ParsedBridgeOutput
```

`BridgePlotEntryDraft` is only defined in `bridgeChatMemory.ts` today, and
`parseBridgeOutput.ts` needs it while `bridgeChatMemory.ts` needs to import
`parseBridgeOutput` — that's a genuine cycle (confirmed: no existing shared
type file, `BridgePlotEntryDraft` has exactly one definition site). Don't
move the type to chase it: define a structurally equivalent result type
locally in `parseBridgeOutput.ts` instead. No type refactor beyond that.

### 3. Parsing rules

Stay close to Canonize's own `core/hookseeker-output.js`, slightly stricter
because BI commits into SQL automatically.

**Normalize:** allow leading/trailing whitespace, LF or CRLF, one enclosing
markdown code fence. Do not "repair" arbitrary output. After normalization,
require non-empty text.

**EVENTS:** require `EVENTS:` at the start, or present before `SCENE:`.
Capture everything between. Store **the table only** (header + separator +
zero or more rows), not the literal `EVENTS:` heading — the current tool
schema's `events` field already carries table-only text (confirmed against
the fake test response, `events: '| When | What | Who |\n|------|------|-----|'`
in `verify-chat-memory-sync.mjs`, and against how `chatMemorySync.ts:891`
reconstructs `PREVIOUS OUTPUT` by prepending `EVENTS:\n` itself). Don't parse
rows into structured objects — BI deliberately stores EVENTS as plain text.
Validation: EVENTS section must exist, header row must exist, separator row
must exist; zero data rows is valid.

**SCENE:** require `SCENE:`. Capture from immediately after that heading
until the first `**NEW:` block or end of response. Trim it.

Store **the body only, with the `SCENE:` heading stripped** — this is a
resolved decision, not an open one:

- Canonize's own `hookseeker-output.js:57` strips `/^SCENE:\s*/i` before
  ever storing or re-using the scene text, and its `_priorSituation` /
  `prev_scene` round-trip (`core/sync.js:259-260`, `core/llm-calls.js:119`)
  never re-adds the heading — the stored value is always headless.
- BI's own `chatMemorySync.ts:891` already builds `PREVIOUS OUTPUT` as
  `` `EVENTS:\n${previousEvents}\n\nSCENE:\n${previousScene}` `` — i.e. it
  already assumes `previousScene` has no heading, exactly mirroring how it
  treats `previousEvents`.
- The *current* tool schema's `scene` field description tells the model to
  begin its value with `SCENE:` on its own line, and the existing test
  fixture reflects that (`scene: 'SCENE: A quiet square at dusk.'`). If a
  compliant model has been doing that in production, every second-and-later
  sync tick has been feeding the model a doubled `SCENE:\nSCENE: ...` header
  — a latent bug in the current forced-tool implementation, not something
  this migration needs to preserve. Stripping the heading in the new parser
  both matches Canonize's actual behavior and fixes this as a side effect.

Validation: SCENE heading must exist, scene body must be non-empty. Don't
enforce the 150–200 word count in code — that's prompt quality, not storage
validity.

**Plot entries:** everything after the SCENE block can contain zero or more
`**NEW: Name**` blocks. For each block: extract the name from the header,
require it non-empty; take the remaining body; identify the final non-empty
line; require that line to be exactly one hashtag-style arc tag matching
`#[a-z0-9]+(?:_[a-z0-9]+)*` (lowercase snake_case, matching the existing
tool schema's own instruction to the model — `#clara_seat`,
`#foundation_contest`); strip the leading `#`; the rest of the body (with
the tag line removed) is `content`.

This validation is worth being strict about beyond just "match the tool
schema's wording": `memoryInjection.ts:212` splices `arc_tag` directly into
a literal, unescaped `<{{arc_tag}}>...</{{arc_tag}}>` wrapper in the
recall-injection prompt. A malformed tag (spaces, symbols, mixed case used
inconsistently) doesn't just violate a style convention — it corrupts that
wrapper for every future recall render referencing that arc. Reject:
multiple tags, missing tag, hyphenated tags, empty name, empty content.

### 4. Failure semantics

Do not partially salvage a malformed Bridge response — EVENTS, SCENE, and
PLOT entries are one coherent LLM product. Valid outcomes:

- **No plot change:** EVENTS + SCENE present, valid → succeeds with
  `plotEntries: []`.
- **Plot change:** EVENTS + SCENE + all plot blocks valid → succeeds.
- **Malformed required structure:** missing EVENTS, missing SCENE, empty
  SCENE, or any malformed `**NEW:` block/tag → throw
  `bridgeChatMemory: ...`. Existing sync rollback/status machinery handles
  the failure. This is deliberately stricter than Canonize, which tolerates
  partial/malformed entries silently.

### 5. Exact files touched

**Modify:** `orchestrator/src/io/chatMemory/bridgeChatMemory.ts`

**Create:** `orchestrator/src/io/chatMemory/parseBridgeOutput.ts`

**Modify (tests):** `orchestrator/scripts/verify-chat-memory-sync.mjs`

**Create (tests):** `orchestrator/scripts/verify-chat-memory-text-parsers.mjs`
— the first genuinely structured text format, so later world/people/digest
parsers can join this file rather than each getting their own.

**Not touched, unless implementation reveals a reason to:**
`chatMemorySync.ts`, `io/llm/types.ts`, `io/llm/openaiCompatible.ts`,
`db/migrations/*`.

**A gap Chunk 1's precedent doesn't cover:** `verify-chat-memory-sync.mjs`'s
fake fetch backend currently routes on a single `if (!forceTool)` check
(`verify-chat-memory-sync.mjs:549`) to serve `summarizeChatChunk`'s tool-free
call — safe in Chunk 1 because summarize was the *only* tool-free caller. An
`'rp'`-kind sync tick calls **both** `summarizeChatChunk` (once per chunk,
`chatMemorySync.ts:815`) and `bridgeChatMemory` (`chatMemorySync.ts:907`)
against the same connection in the same tick. Once bridge also drops
`forceTool`, that boolean check can no longer tell the two callers apart —
it needs content-based routing (e.g. checking the user message for
`TRANSCRIPT:`/`PREVIOUS OUTPUT:`, or a distinguishing string in the system
prompt) instead of a presence/absence check. Skipping this would silently
route bridge calls to the classifier's canned response and surface as a
confusing parser failure rather than a clear test failure.

### 6. Parser tests (`verify-chat-memory-text-parsers.mjs`)

1. EVENTS + SCENE, no plots → valid
2. empty EVENTS table (header + separator, no rows) → valid
3. one plot entry → valid
4. multiple plot entries → valid
5. CRLF → valid
6. enclosing markdown fence → valid
7. surrounding whitespace → valid
8. missing EVENTS → fail
9. malformed EVENTS table → fail
10. missing SCENE → fail
11. empty SCENE → fail
12. `**NEW:**` with empty name → fail
13. plot with empty content → fail
14. plot missing arc tag → fail
15. plot with two arc tags → fail
16. malformed arc tag (hyphenated, uppercase, no leading #) → fail
17. parser output's `scene` never contains a `SCENE:` heading, even when the
    raw input did
18. parser output exactly matches the existing `BridgeResult` draft shape

### 7. Integration test changes (`verify-chat-memory-sync.mjs`)

Prove:

- bridge request has no `tools`, `forceTool` absent
- raw text response is parsed; `scene`/`events`/plot entries land exactly
  where they do today (same `chat_memory_entries` rows, same proposed
  `canon_facts`)
- `arcTag` is preserved
- the fake backend correctly discriminates bridge's tool-free call from
  summarize's tool-free call within the same 'rp' tick (see §5's gap)
- persisted sync-inspection `prompt` still contains the rendered system
  prompt, transcript, previous output, and existing-thread block — removing
  the forced-tool sentence will change the captured prompt slightly, but the
  inspection feature itself must remain intact

### 8. One thing not to change in this chunk

Don't "improve" the Hookseeker prompt while here. Unlike Chunk 1, the
current BI Bridge prompt is already the rich tuned Canonize prompt — the
problem is specifically that the raw markdown output was replaced by a
forced tool. Chunk 2 is surgical: restore the missing Canonize output
section, parse it locally, leave the chronicler logic alone.

### Chunk 2 acceptance criteria

- `bridgeChatMemory.ts` makes no forced-tool call; `bridgeChatMemory()`
  works against any connection that can return plain text.
- `parseBridgeOutput.ts` is pure, independently tested, and its output
  matches the existing `BridgeResult` shape exactly — no downstream (SQL,
  `canon_facts`, `memoryInjection.ts`) code changes.
- Stored `scene`/`events` content in `chat_memory_entries` carries no
  redundant heading, resolving the latent doubled-`SCENE:` issue described
  in §3.
- A malformed Bridge response fails the sync stage outright rather than
  silently dropping a plot development.
- `verify-chat-memory-sync.mjs`'s fake backend correctly distinguishes
  bridge's and summarize's tool-free calls within the same sync tick.
- Later chunks (world/people/digest) are unblocked to repeat the same
  parsing pattern, but not built here.
