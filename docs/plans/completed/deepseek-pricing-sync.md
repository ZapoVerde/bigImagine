# DeepSeek pricing sync — auto-scrape off-peak + peak rates into llm_connections

## Goal

Stop typing DeepSeek prices by hand. Scrape the official pricing page
(`https://api-docs.deepseek.com/quick_start/pricing/`) and sync the parsed per-1M-token USD
rates into BigImagine's `llm_connections` pricing columns for every **native DeepSeek**
connection — matched by `base_url` host `api.deepseek.com` *and* a `model` id present on the
page. Store **both the off-peak (base) tier and the peak tier** (the page now bills two rates, so
the single-tier 0089 model is a lossy view), and make the cost receipt — server `llm_calls.cost_usd`
and the Prompt Inspector's $ figure — pick the correct tier by the **UTC wall-clock hour of the
call**, never local time (DeepSeek defines peak hours in UTC; this deployment's admin is in Perth,
UTC+8, where e.g. 09:00 local = 01:00 UTC = peak).

Run it two ways per the user's call: a **daily background loop** (composition-root tier, like the
other sync loops) and a **manual "Sync now" admin route** from the Connections tab. Both share one
sync function.

## Background

The page (re-verified live 2026-08-17) is static Docusaurus HTML, no JS rendering — a single
`<table>` whose model header row is `MODEL` followed by the model ids, then
`BASE URL (OpenAI Format)` carrying `https://api.deepseek.com`, then a `PRICING` section of six
rows:

```
PRICING | 1M INPUT TOKENS (CACHE HIT)  (rowspan 2) | OFF-PEAK | $0.007  | $0.022
        |                              | PEAK       | $0.014  | $0.044
        | 1M INPUT TOKENS (CACHE MISS) (rowspan 2) | OFF-PEAK | $0.22  | $0.66
        |                              | PEAK       | $0.44   | $1.32
        | 1M OUTPUT TOKENS             (rowspan 2) | OFF-PEAK | $0.66  | $1.98
        |                              | PEAK       | $1.32   | $3.96
```

with the footnote "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and
06:00 - 10:00 UTC (all other hours are off-peak)." Models today: `deepseek-v4-flash`,
`deepseek-v4-pro`.

The existing `llm_connections` pricing (migration 0089: `price_input_per_million`,
`price_output_per_million`, `price_cache_hit_per_million`, nullable numeric USD-per-1M, NULL = "not
configured", never fabricated $0.00) is the off-peak/base tier — that is what the page's OFF-PEAK
column and the manual entries typed during the 0089 session both hold. The sync adds a peak
tier on top rather than reinterpreting the existing columns.

Cost flow today: `io/llm/callCost.ts`'s pure `computeCallCostUsd(usage, price)` is called by
`io/llm/llmGate.ts` at call resolution (writes `llm_calls.cost_usd`), and the Prompt Inspector's $
figure is computed client-side by `frontend/src/lib/promptReceipt.ts`'s `computeReceiptCost(usage,
price)` from the trace's `price` object (`orchestrator/src/server/turnExecution.ts` `TurnPrice` →
`io/promptTrace.ts` trace entry → `server/httpServer.ts` `PromptPreviewGroup` → frontend). Both
share the "omit rather than guess" rule: a missing tier the arithmetic needs ⇒ `undefined` ⇒ no $
shown, never a partial total or $0.00.

## Design decisions (confirmed with the user)

1. **Store both tiers.** New columns are the peak rates; the existing 0089 columns are the
   off-peak/base rates. One nullable-numeric convention end to end.
2. **Daily loop + manual button.** Loop mirrors `chatMemorySync.ts`/`cleanupLoop.ts`'s
   `setInterval(...).unref()` pattern started from `index.ts`; manual route is
   `POST /v1/admin/connections/pricing-sync`.
3. **Native DeepSeek only.** Match a connection for syncing iff its `base_url` host is
   `api.deepseek.com` and its `model` is exactly one of the parsed model ids. Host check via
   `new URL(baseUrl).host` — tolerant of trailing `/v1` or path suffixes; invalid URLs are skipped
   with a log.
4. **Peak classification is by UTC hour**, half-open ranges `[01:00, 04:00)` and `[06:00, 10:00)`
   UTC (hours 1, 2, 3, 6, 7, 8, 9 peak; all else off-peak). Implemented with `getUTCHours()`,
   never local time. Freeze the effective tier at **call time** so a receipt viewed later never
   drifts from what the call actually cost.

## Files

### Schema

- `db/migrations/0109_llm_connection_pricing_peak.sql` — new — adds to `llm_connections`:
  `price_peak_input_per_million numeric`, `price_peak_output_per_million numeric`,
  `price_peak_cache_hit_per_million numeric` (all nullable, no default, same "NULL = not
  configured" contract as 0089), and `price_synced_at timestamptz` (stamped by the sync;
  NULL = never synced). Header comment mirrors 0089's, including the hand-applied psql command.
  Table-level grants already cover new columns (same as 0089's note).

### Orchestrator

- `orchestrator/src/io/llm/deepseekPricing.ts` — new — **Pure Function**: `parseDeepSeekPricingHtml
  (html: string): DeepSeekPricing[]` where `DeepSeekPricing = { model, offPeak: { inputPerMillion,
  outputPerMillion, cacheHitPerMillion }, peak: { inputPerMillion, outputPerMillion,
  cacheHitPerMillion } }`. Uses `linkedom`'s `parseHTML` (already hoisted in the repo via
  `plugins/documents` — same usage as `plugins/documents/src/htmlToMarkdown.ts`). Algorithm:
  locate the row whose first cell text is `MODEL`, take the remaining cells as model ids; then scan
  the pricing rows after it — a row whose label cell (first cell text, when the row also carries a
  second cell of `OFF-PEAK`) matches `1M INPUT TOKENS (CACHE HIT)` / `1M INPUT TOKENS (CACHE
  MISS)` / `1M OUTPUT TOKENS` yields the off-peak price per model from its trailing cells, and the
  immediately following `PEAK` row yields the peak prices. A cell that doesn't parse to a finite
  number > 0 drops that model (omit-rather-than-guess) — the sync then simply doesn't touch that
  connection. Also exports the peak-hour predicate `isPeakUtcHour(now: Date): boolean`
  (the hours 1,2,3,6,7,8,9) — a shared pure fact the receipt and the sync both document against.
- `orchestrator/src/io/llm/callCost.ts` — modified — `CallCostPrice` gains the three peak fields
  (`pricePeakInputPerMillion?`, `pricePeakOutputPerMillion?`, `pricePeakCacheHitPerMillion?`); new
  pure helper `pickPriceTier(price, now = new Date()): CallCostPrice` returns just the effective
  tier set (base fields when off-peak, peak fields when peak-hour) — the omit-rather-than-guess
  "missing needed tier ⇒ undefined" then falls out of the existing arithmetic untouched (a
  peak-hour call against a connection with no peak tier configured yields `undefined`, no silent
  off-peak fallback, because pricing a peak-hour call at the base rate would understate cost).
  `computeCallCostUsd(usage, price, now = new Date())` internally calls `pickPriceTier` first, so
  **`llmGate.ts` needs no change** — the default `now` is exactly "the moment the call resolved".
- `orchestrator/src/io/llmConnections.ts` — modified — `LlmConnectionRow`/`LlmConnectionInit`/
  `LlmConnectionPatch` gain `pricePeakInputPerMillion?`, `pricePeakOutputPerMillion?`,
  `pricePeakCacheHitPerMillion?` (number-or-null on Patch, same three-state convention) plus
  `priceSyncedAt?: string` on Row only (never admin-writable; the sync writes it). `ConnectionDbRow`,
  `ROW_COLUMNS`, `toRow`, `create`, `update`, `toProfile` read/write/relay them (`toPrice`/`toPriceIso`
  handles numeric-string/null and timestamp).
- `orchestrator/src/io/llm/profiles.ts` — modified — `LlmProfile` gains the same three optional
  peak price fields, so every `resolveActive`/`resolveByName`/`resolveById` caller has both tiers
  (including `llmGate`'s `profile` argument and `httpServer`'s turn-price derivation) without a
  second DB round-trip.
- `orchestrator/src/io/deepseekPricingSync.ts` — new — **IO Wrapper**: `DEEPSEEK_PRICING_URL`
  constant; `fetchDeepSeekPricingPage(fetchImpl?)` (uses `io/httpRetry.ts`'s `fetchWithRetry`, throws
  on non-OK with a logged status — this destination is a fixed first-party docs URL, so no
  `fetchUntrusted`/SSRF treatment needed; the `fetchImpl` seam exists purely so verify scripts can
  inject a fixture, since the destination can't be pointed at a sandbox); `syncDeepSeekPricing(deps)`
  where `deps = { llmConnections, fetchHtml? }` — list all connections, match native DeepSeek by
  host+model against `parseDeepSeekPricingHtml`, and for each match `update(id, { price*...,
  priceSyncedAt: <now ISO> })` with **all six** page rates. Returns `{ checked, updated }`. Manual
  prices on a matched connection are overwritten by the official rates — that is the point of the
  feature ("don't type them"); unmatched connections are never touched. One failed fetch = whole
  pass aborts and the loop retries next tick; individual rows are per-`update` transactions.
- `orchestrator/src/orchestrator/deepseekPricingSyncLoop.ts` — new — **Orchestrator**: the daily
  loop, structured exactly like `chatMemorySync.ts`'s: `startDeepSeekPricingSyncLoop(deps)` runs
  one tick immediately, then `setInterval(tick, 24h).unref()`; `tick` = `syncDeepSeekPricing(deps)`
  with a `.catch` that logs and retries next tick. No in-flight guard needed — a pass is a couple of
  fast DB updates and ticks are 24h apart, far longer than any pass; overlapping ticks are harmless
  (idempotent writes) anyway.
- `orchestrator/src/index.ts` — modified — `startDeepSeekPricingSyncLoop({ llmConnections })` at the
  composition root, same tier as `startChatMemorySyncLoop`/`startCleanupLoop`.
- `orchestrator/src/server/httpServer.ts` — modified — `HttpServerDeps` gains an optional
  `fetchHtml?: (url) => Promise<string>` seam, threaded into the pricing-sync route; omitted in
  production (the sync's own default fetches DeepSeek's domain), present so verify-server.mjs can
  exercise the route without a network call.
- `orchestrator/src/server/handleAdminConnections.ts` — modified — new branch in
  `handleAdminConnectionRoutes`, checked before the id is parsed:
  `segments.length === 1 && segments[0] === 'pricing-sync' && req.method === 'POST'` → run
  `syncDeepSeekPricing(deps)` synchronously; `200 { checked, updated }` on success, `502` when the
  fetch/parse pass threw (the failure seam is logged in the sync function).
- `orchestrator/src/server/adminServer.ts` — modified — `parseCreateConnectionBody` and
  `parseUpdateConnectionBody` validate and pass through the three peak price fields (same `isPrice`
  number rule; number-or-null on patch). `priceSyncedAt` is deliberately not admin-writable.

### Frontend

- `frontend/src/api/types.ts` — modified — `LlmConnectionSummary` gains
  `pricePeakInputPerMillion?`, `pricePeakOutputPerMillion?`, `pricePeakCacheHitPerMillion?`,
  `priceSyncedAt?: string`; `CreateConnectionInput`/`UpdateConnectionInput` gain the three peak
  price fields (mirroring the existing price fields' optionality/nullability).
- `frontend/src/api/client.ts` — modified — `adminSyncDeepSeekPricing(apiKey)` →
  `POST /v1/admin/connections/pricing-sync` returning `{ checked, updated }`.
- `frontend/src/components/connections/TextConnectionEditor.tsx` — modified — three new optional
  peak price inputs (off-peak/base and peak labeled clearly), a "Sync now" button that calls
  `adminSyncDeepSeekPricing` and refetches the list, and a "last synced" read-only line fed from
  `priceSyncedAt`. Follows the file's existing `quantizations`-style draft/parse/dirty-check/save
  pattern; peak inputs ride the same `parsePrice`/draft pipeline.

### Receipt wiring (no shape changes)

- `orchestrator/src/server/turnExecution.ts` — modified — `toTurnPrice` builds the effective
  single-tier `{ inputPerMillion?, outputPerMillion?, cacheHitPerMillion? }` via
  `pickPriceTier(profile, new Date())` instead of copying the base fields verbatim. The trace
  price shape, `PromptTraceEntry.price`, and `PromptPreviewGroup` are unchanged — the effective
  tier is baked server-side at call time, so the frontend's `computeReceiptCost` needs **no**
  `now`/`at` plumbing and can never drift when a receipt is viewed later. `llmGate`'s
  `cost_usd` picks the same tier at call resolution (via `computeCallCostUsd`'s default `now`),
  so the two figures agree.

### Verify scripts

- `orchestrator/scripts/verify-deepseek-pricing.mjs` — new — parser fixtures (the real 2026-08-17
  table structure copied into the fixture, plus an "unparseable price" model variant that must be
  dropped whole), the peak-hour predicate at every boundary hour (00/04/05/10 off-peak; 01/03/06/09
  peak, incl. the Perth 09:00-local-is-peak case), `computeCallCostUsd` with dual-tier price at
  peak vs off-peak `now` (peak-hour calls use peak rates; a peak-hour call against a price with no
  peak tier → `undefined`), and `syncDeepSeekPricing` with an injected `fetchHtml` fixture against
  a fake in-memory `llmConnections` (host+model matching, host-mismatch and model-miss untouched,
  unparseable base URL skipped, `priceSyncedAt` stamped, failed fetch aborts with no writes).
- `orchestrator/scripts/verify-server.mjs` — modified — connection create/update round-trip
  assertions gain the three peak price fields (and `priceSyncedAt` is never admin-writable: a
  spoofed PATCH is ignored, and it survives a full list round-trip once the sync sets it); the
  fake connection store relays peak fields; and a `POST /v1/admin/connections/pricing-sync`
  request against the real HTTP server (with `fetchHtml` injected through `HttpServerDeps`) is
  asserted to write the matched native connection and return `{ checked, updated }`.
- `orchestrator/scripts/verify-llm-gate.mjs` — modified — the shared fake profile gains an
  identical peak tier so the `cost_usd` assertions stay hour-independent (a base-only profile
  would price every call as "no price" whenever the suite runs inside a peak UTC hour).

## Contracts

- `llm_connections` new columns: `price_peak_input_per_million numeric`,
  `price_peak_output_per_million numeric`, `price_peak_cache_hit_per_million numeric`,
  `price_synced_at timestamptz` — nullable, no default.
- `LlmConnectionRow`/`LlmConnectionInit`/`LlmConnectionPatch`/`LlmProfile` gain
  `pricePeakInputPerMillion?`, `pricePeakOutputPerMillion?`, `pricePeakCacheHitPerMillion?`
  (Patch: `| null` to clear; Row additionally `priceSyncedAt?: string`).
- `DeepSeekPricing` (`io/llm/deepseekPricing.ts`): `{ model, offPeak: {...}, peak: {...} }` — all
  six rates finite numbers > 0.
- `parseDeepSeekPricingHtml(html)` — pure; drops (with log) a model whose any required rate is
  unparseable.
- `isPeakUtcHour(now)` — pure; hours 1, 2, 3, 6, 7, 8, 9 UTC are peak.
- `pickPriceTier(price, now = new Date())` — pure; returns the effective tier set.
- `computeCallCostUsd(usage, price, now = new Date())` — pure; unchanged "omit rather than guess"
  contract, now tier-aware.
- `syncDeepSeekPricing(deps)` — impure; `{ checked, updated }`.
- `POST /v1/admin/connections/pricing-sync` — admin-gated; `200 { checked, updated }` |
  `502 { error }`.

## Edge Cases

- **Native DeepSeek matching**: host `api.deepseek.com` with any path suffix matches (base URL is
  matched on `new URL(...).host` only); `anthropic`-kind connections whose base URL is
  `https://api.deepseek.com/anthropic` match too (host is the same) — the page's models are the
  same ones. A connection whose `model` isn't on the page (e.g. a DeepSeek alias id) is never
  touched.
- **Manual prices get overwritten** on a matched connection — the feature's stated point. An admin
  who wants a custom rate should use a non-`api.deepseek.com` base URL or an unlisted model id.
- **Peak-hour call, no peak tier configured** (an existing 0089-only connection before its first
  sync, or a non-DeepSeek connection): `pickPriceTier` selects the peak fields, which are
  undefined ⇒ cost/receipt `$` is omitted — never silently billed at the base rate, never $0.00.
- **Fetch/parse failure**: the whole pass fails loudly (log) and retries on the next loop tick or
  manual click; rows already updated in a prior pass are untouched. Manual route reports 502.
- **Page shape drift** (DeepSeek renames a row or drops a model): the parser matches by exact label
  text, so a renamed section simply yields no prices (pass updates nothing, logs); a removed model
  id stops matching that connection. A changed *hour* definition is the one thing that would be
  silently wrong — noted in the plan; the sync never parses the footnote.
- **Hour boundary crossed between tier resolution and `cost_usd`**: `resolveTurnLlm`'s
  `pickPriceTier(new Date())` runs a beat before `llmGate` logs `cost_usd` with its own `now`; a
  turn that straddles 04:00 or 10:00 UTC could see the two disagree by 2×. This needs an hour
  boundary hit inside the ~seconds of a single turn's resolution — accepted as a documented,
  negligible edge (the receipt stays frozen at the earlier pick).
- **First boot after deploy**: the loop's immediate first tick syncs within seconds, so the window
  where a native DeepSeek connection has base-only prices is essentially the pre-deploy manual
  state.
- **Overlapping ticks**: passes are idempotent overwrites; no in-flight guard needed.

## Out of Scope

- Any UI showing which tier a call was billed at (the receipt shows the effective $ only).
- Deriving peak from base ("half of peak" is the page's own current note, but it's parsed and
  stored explicitly, never assumed — a future pricing shape that breaks the 2× relationship
  doesn't corrupt the data).
- Syncing any other vendor or OpenRouter-style routing.
- Changing `llm_calls`/receipt schema, or `agent_routine`/cap logic.
- Currency other than USD.
- An `orchestrator_settings` toggle for the loop — the user's call was unconditional daily sync.

## Verification

- `npx tsc --noEmit` in `orchestrator` and `frontend`; `npm run verify` (build + the verify-script
  chain, including the new `verify-deepseek-pricing.mjs` and updated `verify-server.mjs`).
- Apply `db/migrations/0109_llm_connection_pricing_peak.sql` by hand against the live DB:
  `docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0109_llm_connection_pricing_peak.sql`
  and confirm `\d llm_connections` shows the four new columns.
- Manual: `POST /v1/admin/connections/pricing-sync` on the live box → `{ checked, updated }` and
  the native DeepSeek connection's six price fields + `price_synced_at` reflect the page's current
  rates; a non-DeepSeek connection is untouched.
- Manual: make a call in a peak UTC hour (e.g. 09:00 Perth = 01:00 UTC) and one off-peak; confirm
  `llm_calls.cost_usd` and the Prompt Inspector receipt differ by the peak factor and match the
  page's rates; confirm a receipt viewed later doesn't change.
- Manual: clear a peak rate on a native DeepSeek connection, then call during peak hours — the
  receipt omits the $ figure (omit-rather-than-guess), and the next sync restores the rate.
- Confirm the Connections editor shows base + peak inputs, last-synced, and that "Sync now"
  refetches the list with the new `priceSyncedAt`.

## Principles / Conventions in Play

- `bi_principles.md` §6 (Reasoning Layer is Replaceable) — pricing is a per-provider fact adapted
  to (optional fields, graceful degradation), never a vendor shape baked into a type.
- §8 / `conventions.md` — the four-kind split holds: `deepseekPricing.ts` and `callCost.ts` stay
  Pure Functions (linkedom parsing and tier selection are derivation, kept testable with no
  DB/HTTP scaffolding), `deepseekPricingSync.ts` is an IO Wrapper, the loop is an Orchestrator,
  `llmConnections.ts`/`handleAdminConnections.ts` keep their existing roles. No file crosses kinds.
- §13 (Runtime Config Lives in the DB) — both price tiers and `price_synced_at` are DB columns,
  editable/syncable from the Connections tab, never env vars.
- §19 (Mobile-First) — the new editor fields and "last synced" line hold up at phone width like
  every other `TextConnectionEditor` row.
- `conventions.md` — 300-line file budget watched on `handleAdminConnections.ts` (the new branch is
  ~15 lines); the sync route lives there rather than a new handler file to keep the admin family
  whole, consistent with the reliability sub-route precedent.