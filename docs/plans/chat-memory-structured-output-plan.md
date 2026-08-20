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

- **Chunk 1 (this plan's immediate scope):** `classifyChatChunk.ts` — detailed
  below.
- **Later chunks (not yet scoped in detail):** `bridgeChatMemory.ts`,
  `curateWorldMemory.ts`, `curatePeople.ts`, `distillChatMemory.ts`,
  `classifyHouseholdMemory.ts`. Chunk 1 is the template: raw text out, a
  small tolerant local parser, no forced tool, no mode abstraction.

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

## Acceptance criteria

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
