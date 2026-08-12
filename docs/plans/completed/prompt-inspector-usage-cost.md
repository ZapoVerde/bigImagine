# Prompt Inspector — Usage & Cost Receipt

*Status: implemented — commit `c88d1ea` ("Prompt Inspector usage cost receipt: per-call
token/$ receipt on the captured Main Prompt group (0089)") shipped this.*

## Goal

Show a per-call usage receipt — prompt/completion/cache-hit token counts, and $ cost when the
connection's price is configured — at the top of the Main Prompt group in the Prompt Inspector,
matching the breakdown Reasonix already shows in its own CLI transcript. Scoped to the main turn
prompt only (not cleanup/title background prompts) for this pass.

## Scope

DeepSeek (OpenAI-compatible) only. Anthropic is deliberately out of scope — this project never
uses it, and nothing here is written against its response shape or billing model. That is why
there is no `cacheWriteTokens` anywhere in this plan: no in-scope vendor has a cache-creation
tier, so the usage type and the price shape only need what DeepSeek actually bills — input,
output, and cache-hit. `anthropic.ts` stays untouched.

## Background (why this needs new plumbing, not just a UI change)

Investigated live: BigImagine currently discards prompt-caching data at the adapter layer.
`openaiCompatible.ts` parses only `promptTokens`/`completionTokens`/`totalTokens` from the vendor
response and drops everything else, even though the raw response carries cache accounting:

- DeepSeek's OpenAI-compatible response `usage` includes `prompt_cache_hit_tokens` and
  `prompt_cache_miss_tokens`; its `prompt_tokens` **is** the sum of the two (verified against
  DeepSeek's API reference) — no adjustment needed, `promptTokens` stays exactly what the vendor
  reports.

Separately, there is no per-call pricing anywhere in the system tied to actual usage. The one
existing pricing surface (`frontend/src/api/pricing.ts`'s `formatPricePerMillion`) only formats
OpenRouter's advertised per-model rate for the model picker; DeepSeek's native `/models` endpoint
has no pricing field at all (existing comment in `openaiCompatible.ts` confirms this was checked
live). Reasonix works around the same DeepSeek gap by letting the user type a price into
`config.toml` per provider — this plan does the same thing, as a per-connection DB field, per
`bi_principles.md` §13 (runtime config lives in the DB, not `.env`) and §6 (the reasoning layer
adapts to per-provider pricing/caching economics rather than assuming one vendor's shape).

Finally, `io/promptTrace.ts`'s `PromptTraceEntry` — the Prompt Inspector's actual data source —
records prompt text *before* the call fires and never attaches the `LlmTurn.usage` the call
returns, so even plain token counts aren't wired to the inspector today (the "192 tk" currently
shown per tag-tree section is a char-count estimate, computed independently, not vendor-reported
usage).

## Files

- `db/migrations/0089_llm_connection_pricing.sql` — created — three nullable `numeric` columns on
  `llm_connections`: `price_input_per_million`, `price_output_per_million`,
  `price_cache_hit_per_million`. USD per 1M tokens, no currency column (matches the existing
  implicit-USD convention in `frontend/src/api/pricing.ts`). `NULL` means "not configured", not
  zero — a connection with no price set shows tokens only, never a fabricated $0.00.
- `orchestrator/src/io/llmConnections.ts` — modified — `LlmConnectionRow`, `LlmConnectionInit`,
  `LlmConnectionPatch` gain the three price fields (camelCase, all optional numbers); `ROW_COLUMNS`,
  `toRow`, `create`, `update`, and `toProfile` read/write/relay them.
- `orchestrator/src/io/llm/profiles.ts` — modified — `LlmProfile` gains the same three optional
  price fields, so every caller that already resolves a profile (`resolveActive`/`resolveByName`/
  `resolveById`) has pricing without a second DB round-trip.
- `orchestrator/src/server/adminServer.ts` — modified — `parseCreateConnectionBody` and
  `parseUpdateConnectionBody` validate and pass through the three price fields (numbers on create;
  number-or-null on patch, same three-state convention `baseUrl`/`providerOrder` already use for
  "leave alone" vs. "explicitly clear").
- `orchestrator/src/io/llm/types.ts` — modified — `LlmUsage` gains `cacheReadTokens?: number`,
  optional and only ever set when the vendor response actually reported it. No
  `cacheWriteTokens` (no in-scope vendor has a cache-creation tier — see Scope).
- `orchestrator/src/io/llm/openaiCompatible.ts` — modified — parses `prompt_cache_hit_tokens` into
  `cacheReadTokens` when present; `promptTokens` is unchanged (`prompt_tokens` already includes
  both hit and miss). `anthropic.ts` is intentionally untouched.
- `orchestrator/src/orchestrator/loop.ts` — modified — `RunTurnResult` gains `usage?: LlmUsage`;
  `runTurnInner`'s zero-tool-calls return path includes `usage: turn.usage` alongside `content`.
- `orchestrator/src/io/promptTrace.ts` — modified — `PromptTraceEntry` gains `usage?: LlmUsage` and
  `price?: { inputPerMillion?: number; outputPerMillion?: number; cacheHitPerMillion?: number }`,
  both attached after the call resolves, mirroring the existing `reply` field's "absent until the
  call returns, absent forever if it failed" contract exactly.
- `orchestrator/src/server/httpServer.ts` — modified — `resolveTurnLlm` additionally resolves and
  returns the acting connection's price (see Logic); `handleChatCompletions` and `regenerateSwipe`
  keep a local reference to the `'main'` trace entry object and set `.usage`/`.price` on it once
  `runTurn` resolves successfully; `PromptPreviewGroup` gains the same `usage`/`price` fields,
  populated only for the `'main'` group from `capturedMain.usage`/`capturedMain.price`.
- `frontend/src/api/types.ts` — modified — mirrors the same `LlmUsage`-shaped fields on
  `PromptPreviewGroup`, and the three price fields on `LlmConnectionSummary`,
  `CreateConnectionInput`, `UpdateConnectionInput`.
- `frontend/src/components/promptInspector/PromptInspectorPanel.tsx` — modified — `PromptGroupSection`
  renders a receipt row under the existing title `<h3>` when `group.usage` is present: prompt
  tokens (split into cache-hit/miss when `cacheReadTokens` is present, plain otherwise),
  completion tokens, total, and $ cost when every price tier the calculation needs is configured.
- `frontend/src/components/promptInspector/PromptInspectorPanel.css` — modified — styling for the
  new receipt row; must hold up at phone width per `bi_principles.md` §19 (stack, don't clip, same
  as every other row in this panel).
- `frontend/src/components/connections/TextConnectionEditor.tsx` — modified — three new optional
  numeric inputs (input / output / cache-hit price, USD per 1M tokens), following the existing
  `quantizations`-style draft/parse/dirty-check/save pattern already in this file.
- `orchestrator/scripts/verify-llm-adapters.mjs` — modified — new fixtures asserting the
  cache-field parsing for the OpenAI-compatible adapter (DeepSeek): `prompt_cache_hit_tokens`
  lands on `cacheReadTokens`, `promptTokens` is unchanged, and a response with no cache fields at
  all leaves `cacheReadTokens` undefined.
- `orchestrator/scripts/verify-loop.mjs` — modified — asserts `RunTurnResult.usage` is the first
  round's usage on a tool-free turn.
- `orchestrator/scripts/verify-server.mjs` — modified — asserts a connection's price fields
  round-trip through create/update/list, and that a captured `'main'` prompt-preview group carries
  `usage`/`price` once a turn has fired against a priced connection.

## Logic

**Adapter.** `openaiCompatible.ts`'s response-parsing function reads the extra `usage` fields the
vendor already sends (see Background for the exact field names) and sets `cacheReadTokens` on the
`LlmUsage` it returns — undefined, not zero, when the vendor's response doesn't include the field
at all (some OpenRouter-routed models report no cache accounting; treat that as "unknown," not
"zero cache hit"). `promptTokens` is not recomputed — DeepSeek's `prompt_tokens` already includes
the cache-hit portion. `anthropic.ts` is not touched.

**Turn result.** `runTurnInner`'s only return path with zero tool calls (`round === 0` for every RP
turn, since `httpServer.ts` always passes an empty tool registry for `session.kind === 'rp'` — both
`handleChatCompletions` line ~1605 and `regenerateSwipe`'s own tool-registry line confirm this) now
also returns that round's `turn.usage`. This is deliberately just round 0's usage, not a sum across
rounds — for a tool-using turn (any non-RP chat) it would only reflect the first of several calls,
but the Prompt Inspector only ever renders the `'main'` group for `session.kind === 'rp'` chats
(`buildPromptPreview` already 422s for any other kind), where round 0 is provably the only round.

**Connection pricing at turn time.** `resolveTurnLlm` currently only resolves a profile when the
chat has a per-chat connection override (`sessionParams.profile` set); the default path just reuses
the boot-time `deps.llm` singleton with no profile in scope. Extend the default branch to also call
`deps.llmConnections.resolveActive()` — used **only** to read that connection's price fields; it
must not replace `turnLlm` or `turnDefaultModel` in this branch, which stay `deps.llm`/
`deps.modelName` exactly as today (avoid building a second, redundant gated provider instance for a
call that's about to use the existing boot-time one). Both branches converge on returning a third
value, `turnPrice: { inputPerMillion?, outputPerMillion?, cacheHitPerMillion? } | undefined`.

**Attaching usage/price to the trace.** `handleChatCompletions` and `regenerateSwipe` already build
a `PromptTraceEntry` object literal and pass it to `recordPromptTrace` before calling `runTurn` —
mirror `cleanupLoop.ts`'s existing pattern for `entry.reply` exactly: keep the local `const
traceEntry` reference, and once `runTurn` resolves successfully, set `traceEntry.usage =
result.usage` and `traceEntry.price = turnPrice`. On a thrown/aborted turn, leave both unset — same
"absent if the call failed" contract `reply` already has.

**Preview and panel.** `buildPromptPreview`'s `capturedMain` branch copies `usage`/`price` from the
trace entry onto the `mainGroup` it returns (undefined when the entry hasn't resolved yet, or when
the trace is the live-reconstruction fallback rather than a captured entry — there is no real call
to report usage for in that case). `PromptGroupSection` renders the receipt only when `group.usage`
is present: total prompt tokens (broken into cache-hit / cache-miss when `cacheReadTokens` is
defined, otherwise shown as a single figure), completion tokens, total tokens, and — only when
`group.price` has every tier the arithmetic needs — a $ figure. The $ computation is a pure function
in the frontend (raw counts × raw per-million rates, the same shape Reasonix's own formula uses),
not a server-computed field, so there is exactly one source of truth for the token counts and one
for the rates, and no third derived number that could drift from either.

## Contracts

- `LlmUsage` (`orchestrator/src/io/llm/types.ts`):
  ```
  interface LlmUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
  }
  ```
- `llm_connections` new columns: `price_input_per_million numeric`, `price_output_per_million
  numeric`, `price_cache_hit_per_million numeric` — all nullable, no default.
- `LlmConnectionRow`/`LlmConnectionInit`/`LlmConnectionPatch`/`LlmProfile` all gain:
  `priceInputPerMillion?: number`, `priceOutputPerMillion?: number`,
  `priceCacheHitPerMillion?: number` (Patch additionally accepts `| null` on each, to explicitly
  clear a previously-set price — same convention `baseUrl` already uses).
- `RunTurnResult` (`orchestrator/src/orchestrator/loop.ts`): adds `usage?: LlmUsage`.
- `PromptTraceEntry` (`orchestrator/src/io/promptTrace.ts`): adds `usage?: LlmUsage` and
  `price?: { inputPerMillion?: number; outputPerMillion?: number; cacheHitPerMillion?: number }`.
- `PromptPreviewGroup` (`orchestrator/src/server/httpServer.ts`, mirrored in
  `frontend/src/api/types.ts`): adds the same two optional fields, populated only on the `'main'`
  group.

## Edge Cases

- **A connection with no price configured at all**: `price` stays fully undefined end to end. The
  receipt shows token counts only — no `$0.00`, no blank/zero-looking cost field.
- **A connection with only some price tiers set** (e.g. input/output but no cache-hit rate,
  plausible for a provider whose caching isn't priced yet): show tokens split by cache-hit/miss as
  normal, but omit the $ figure entirely rather than computing a partially-wrong total — silently
  pricing cache-hit tokens at the miss rate would understate savings, not just omit them.
- **A turn that throws or is aborted mid-call**: `traceEntry.usage`/`.price` are never set (no
  `runTurn` result to read them from) — the panel shows the prompt with no receipt, same as today's
  "no reply" case for an aborted turn.
- **Live-reconstruction fallback** (`buildPromptPreview`'s non-`capturedMain` branch, shown before a
  chat's first turn fires): no real call has happened, so there is nothing to report — `usage`/
  `price` stay undefined on that group regardless of whether the connection has pricing configured.

## Tests

- The OpenAI-compatible adapter (DeepSeek): a fixture response carrying `prompt_cache_hit_tokens`
  produces the expected `cacheReadTokens` on the resulting `LlmUsage`, with `promptTokens`
  unchanged; a fixture with no cache fields at all leaves `cacheReadTokens` undefined (not zero).
- `runTurnInner`: a tool-free turn's `RunTurnResult.usage` matches the stub LLM's first (only)
  response's `usage` exactly.
- `llmConnections`: creating and updating a connection with price fields round-trips through
  `list()`/`resolveById()`/`resolveByName()`; omitting them leaves all three `undefined`, not `0`;
  patching one field to `null` clears only that field.
- `adminServer`'s `parseCreateConnectionBody`/`parseUpdateConnectionBody`: reject a non-numeric
  price field; accept `null` only on the patch parser, not the create parser.
- `httpServer`: a full request against a fake pool with a priced connection produces a `'main'`
  prompt-preview group whose `usage`/`price` match what the stub LLM/connection reported; a turn
  through an unpriced connection produces a group with `usage` set and `price` undefined; a turn
  that throws leaves the next prompt-preview fetch's `'main'` group with `usage`/`price` both
  undefined (falls through to the previous fired entry, if any, unaffected).

## Out of Scope

- Cleanup-pass and title-generation prompts (`PromptTraceEntry`'s other `kind`s) — the receipt is
  `'main'`-only per this plan's scope decision; `PromptTraceEntry`'s new fields are structurally
  available to any kind, so extending coverage later is additive, not a rework.
- Live per-provider pricing lookups (e.g. auto-filling price fields from OpenRouter's `/models`
  response) — the three fields are manually entered only, matching Reasonix's own config-file
  approach; a "prefill from OpenRouter" convenience could be a later, separate addition.
- Any change to `llm_calls`'/`turn_metrics`' own schema or the `agent_routine` cap logic itself —
  `promptTokens` keeps exactly the meaning the vendor reports, so the accounting logic that
  consumes it is untouched.
- Currency other than USD.

## Principles / Conventions in Play

- `bi_principles.md` §6 (Reasoning Layer is Replaceable) — pricing and cache accounting are
  per-provider facts the orchestrator adapts to (optional fields, graceful degradation when a
  vendor doesn't report them), never a single vendor's shape baked into the type.
- §12 (A Secret Is Write-Only) — the new price fields are plain visible/editable config, not
  secrets; no encryption, no write-only round-trip needed, unlike `api_key_ciphertext` on the same
  table.
- §13 (Runtime Config Lives in the DB) — price is a `llm_connections` column, editable from the
  Connections tab, never an env var.
- §19 (Mobile-First) — the new receipt row and the new Settings price inputs must hold up at phone
  width, matching every other row in `PromptInspectorPanel`/`TextConnectionEditor`.
- `conventions.md` — every modified file keeps its existing `@architectural-role`; none of these
  changes cross a file from one of the four kinds into another (the adapter stays an IO Wrapper,
  `promptTrace.ts` stays a Stateful Owner, `PromptInspectorPanel.tsx` stays presentation-only).
