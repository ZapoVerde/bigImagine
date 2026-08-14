# LLM Stats Page

## Goal

Add a "Stats" specialist view, reachable from the top-left hamburger (AppNavDrawer), with two
sections:

1. **Usage & Cost** — every LLM call's tokens (including cache hit/miss), cost, and which
   provider/model handled it, whatever kind of call it was (a live RP turn, a chat-memory sync
   digest, a canon extraction pass, a background description — everything that already passes
   through the one gate `bi_principles.md` §14 requires).
2. **Timing** — how long an RP reply actually takes to land and settle on screen, end to end:
   dispatch, first token, last token, per-region cleanup (header/body/footer) start and stop, and
   the moment the display is truly final (`display settle`) — not just raw LLM latency, which
   already undercounts the real thing (see Background).

Both sections are plain dropdown-driven "group by X, show Y" views with filter chips, rendered as
a stacked bar-list — the news-site pattern, not a drag-and-drop pivot grid, so it holds up at
phone width with no library and no compromise (see the "alternatives" discussion this plan
replaces the earlier `react-pivottable` draft with).

## Background

Investigated live, this matters:

- `llm_calls` (the universal per-call audit log every LLM call already writes to, via
  `llmGate.ts`) currently has no idea which provider/model/connection served a call, no cache-hit
  token count, and no cost. Nothing to fix architecturally — the one gate already sees everything;
  it just isn't recording these fields yet.
- RP turn timing (`turn_metrics`, written by `streamingTurn.ts`) stops the clock the instant the
  raw LLM stream itself resolves — **before** `finishStream` (footer inspection + the one
  deferred whole-message `'llm'`-action slop rule, run by the caller in `handleChatCompletions.ts`
  after `runStreamingRpTurn` already returned) and before `finalizeCleanupResult`'s writeback. So
  today's own metrics already miss exactly the gap the user experiences as "it doesn't land until
  it's been cleaned" — a real, currently invisible tail where a second full LLM call can run after
  the last visible word appears, before the turn is actually done.
- The in-stream-cleanup work (`docs/plans/completed/in-stream-cleanup-plan.md`) already streams
  everything needed to reconstruct this timeline client-side: `bigimagine_cleanup` frames carry
  each region's state transitions, content-delta frames mark first/last token, and the terminal
  frame marks the true end. No new server-side transport is needed for the raw signal — the
  client is also, honestly, the *right* vantage point for "did the user actually see it," which a
  server timestamp can never fully capture (network time is real time).

## Files

### Usage & Cost (every LLM call)

- `db/migrations/0101_llm_calls_cost_provider.sql` — created — widens `llm_calls` with
  `provider_kind`, `model`, `cache_read_tokens`, `cost_usd`. All nullable, no backfill (see Edge
  Cases).
- `orchestrator/src/io/llm/callCost.ts` — created — a new Pure Function module: derives a call's
  USD cost from its token counts and the resolved connection's price tiers. Its own file because
  `llmGate.ts` is an IO Wrapper (`bi_principles.md` §8: "contain zero reasoning or derivation
  logic") and cost arithmetic is derivation.
- `orchestrator/src/io/llm/llmGate.ts` — modified — `createGatedLlmProvider` gains a fourth
  parameter carrying the resolved `LlmProfile` for the base provider it wraps. All three `logCall`
  call sites (`complete()`, `completeStream()`, and the preflight `refused` path in
  `resolveGateCallConfig`) gain the new fields — the refused path logs `providerKind`/`model`
  only, with usage/cost staying `null` (the profile was already resolved before the refusal).
- `orchestrator/src/index.ts` — modified — passes the already-resolved `activeProfile` into its
  one `createGatedLlmProvider` call site.
- `orchestrator/src/orchestrator/chatMemorySync.ts` — modified — passes its already-resolved
  `profile` into its own call site.
- `orchestrator/src/orchestrator/eagerChunkSync.ts` — modified — passes its already-resolved
  `profile` into its own call site (the `chat_memory_profile`-override construction path; the
  `deps.llm` fallback is covered by `index.ts`'s boot-time wrap).
- `orchestrator/src/orchestrator/chatChunkResize.ts` — modified — passes its already-resolved
  `profile` into its own call site, same shape as `eagerChunkSync.ts`.
- `orchestrator/src/server/turnExecution.ts` — modified — passes the already-resolved `profile`
  into the per-chat-override construction in `resolveTurnLlm` (the one place a chat turn builds
  its own gated provider at runtime; the no-override `deps.llm` branch is covered by `index.ts`).
- `orchestrator/src/server/adminServer.ts` — modified — new `handleLlmStatsGet`.
- `orchestrator/src/server/httpServer.ts` — modified — registers `GET /v1/admin/llm-stats` behind
  `withAdmin`.
- `orchestrator/scripts/verify-llm-gate.mjs` — modified — every existing
  `createGatedLlmProvider(base, db, settings)` construction (15 of them) gains the fake profile
  argument, plus new fixtures for the widened `logCall` payload.
- `orchestrator/scripts/verify-server.mjs` — modified — new fixture for the endpoint.

### Turn display timing (RP turns only)

- `db/migrations/0102_turn_display_metrics.sql` — created — new table, one row per RP turn,
  client-reported (see Contracts).
- `orchestrator/src/io/turnDisplayMetrics.ts` — created — IO Wrapper, same shape as
  `io/turnMetrics.ts`: one exported insert function.
- `orchestrator/src/server/handleTurnDisplayMetrics.ts` — created — validates and inserts a
  client-reported timing record. Same auth resolution `handleChatCompletions.ts` already uses for
  `POST /v1/chat/completions` (household key / Access identity) — this is written by every regular
  chat turn, not an admin action.
- `orchestrator/src/server/httpServer.ts` — modified (same file as above) — registers
  `POST /v1/turn-display-metrics` (regular auth) and `GET /v1/admin/turn-display-stats` (admin).
- `orchestrator/src/server/adminServer.ts` — modified (same file as above) — new
  `handleTurnDisplayStatsGet`.
- `orchestrator/scripts/verify-turn-display-metrics.mjs` — created — drives the insert function and
  the two new HTTP routes directly.
- `orchestrator/package.json` — modified — adds the new verify script to the `verify` chain.

### Frontend (shared Stats view + the client-side timeline recorder)

- `frontend/src/api/types.ts` — modified — `LlmCallStatRow`, `TurnDisplayMetricRow`, and the
  client-only `TurnTimelineEventDetail` type.
- `frontend/src/api/client.ts` — modified — `adminListLlmStats`, `adminListTurnDisplayStats`,
  `postTurnDisplayMetrics`.
- `frontend/src/hooks/useTabs.ts` — modified — `TabType` gains `'stats'`.
- `frontend/src/components/appNav/AppNavDrawer.tsx` — modified — adds the Stats nav option.
- `frontend/src/App.tsx` — modified — renders `<StatsView />` for `tab.type === 'stats'`.
- `frontend/src/lib/aggregateRows.ts` — created — pure `groupBy`/aggregate helper, shared by both
  Stats sections (no library — see the alternatives discussion this plan resolves).
- `frontend/src/components/stats/StatBarList.tsx` — created — the shared stacked bar-list renderer
  both sections use.
- `frontend/src/components/stats/StatBarList.css` — created.
- `frontend/src/views/StatsView.tsx` — created — admin-gated (`useAdminUnlock`, same as
  `ConnectionsView.tsx`), two sections (Usage & Cost, Timing), each a group-by dropdown + metric
  dropdown + filter chips over `StatBarList`.
- `frontend/src/views/StatsView.css` — created.
- `frontend/src/lib/turnTimeline.ts` — created — the client-side recorder: dispatches real
  `CustomEvent`s on `window` at each milestone (listenable in devtools, same spirit as Loggeryze's
  `window.loggeryze.time()`), accumulates the record in memory, and finalizes/POSTs it once the
  turn is done (success, abort, or error).
- `frontend/src/views/ChatView.tsx` — modified — creates one `turnTimeline` recorder per `send()`/
  `swipe()` call, marks `'dispatch'` before calling the API, threads marks into the existing
  `onDelta`/`onCleanupStatus`/`onTerminalFrame` callbacks, and finalizes once the awaited call
  resolves or throws.

## Logic

### Usage & Cost

**Cost.** `callCost.ts` exports a function taking token counts (prompt, completion, optional
cache-read) and the resolved profile's three optional price-per-million fields, returning a USD
number or `undefined`. It only returns a number when every price tier actually needed is present
(input and output always; cache-hit only when `cacheReadTokens` is a positive number) — same
"omit rather than guess" rule the existing Prompt Inspector receipt already uses
(`docs/plans/completed/prompt-inspector-usage-cost.md`).

**Threading the profile into the gate.** All five existing `createGatedLlmProvider` call sites
already have the resolved `LlmProfile` in scope right where they construct the base provider — so
adding a fourth parameter is additive: `index.ts` (`activeProfile`), `chatMemorySync.ts`,
`eagerChunkSync.ts`, and `chatChunkResize.ts` (each a `chat_memory_profile`-override `profile`),
and `turnExecution.ts`'s `resolveTurnLlm` (a per-chat override `profile`). The `deps.llm` fallback
branches are covered by `index.ts`'s boot-time wrap, which closes over the same `activeProfile`
the household's calls actually use. `llmGate.ts` closes over the profile and reads
`profile.kind`/`profile.model` for every `logCall` — the `complete()`/`completeStream()` paths
plus the preflight `refused` path — passing the profile's price fields plus the turn's `usage`
into `callCost.ts`.

**Endpoint.** `handleLlmStatsGet` reads a `days` query param (default 30, clamped to 365), queries
`llm_calls` via `db.withSystemScope` (same RLS-exempt, no-caller-filter pattern `tallySince`
already uses), and maps rows to `LlmCallStatRow` — substituting `'(pre-tracking)'` for
`providerKind`/`model` when those columns are `null` (rows written before this migration).
`cost_usd` is a `numeric` column, which node-postgres returns as a string — the mapping casts it
with `Number()` before emitting `costUsd` (the same cast `tallySince` already applies to its own
`count(*)`/`sum()` text results), so the wire type stays `number | null` as contracted.

### Turn display timing

**What "start"/"stop" mean per event.** The client already receives every signal it needs from
the existing SSE stream (`consumeSseCompletionStream` in `api/client.ts`) — no new server
transport:

- `dispatch` — marked client-side, the instant before `chatCompletion()`/`swipeMessage()` is
  called.
- `first-token` / `last-token` — `first-token` marks on the first `onDelta` call; `last-token` is
  **not** predicted, it's read back from a running "most recent delta timestamp" variable once the
  turn resolves — you can't know a delta is the last one until the terminal frame arrives, so this
  is captured retroactively, not live. For a buffered/non-streaming turn (turn 1, or a connection
  with no `completeStream`) there is exactly one relayed chunk, so `first-token` and `last-token`
  land at the same instant.
- `display-land` — marked in a `requestAnimationFrame` callback scheduled right after the first
  `onDelta` fires, capturing the next actual paint rather than just the wire arrival. In practice
  this is usually a few milliseconds after `first-token`, sometimes identical — an honest
  distinction kept even though the values are often close, the same way Loggeryze keeps its own
  near-zero "UI ready" phase separate rather than folding it into the previous one.
- `cleanup-start` / `cleanup-stop`, per region — derived from `bigimagine_cleanup` frames'
  `state` field: a transition to `'in-flux'` is a start, a transition to `'deployed'` or
  `'flagged'` is a stop. A region that never leaves `'not-called'` never fires either event —
  those columns simply stay `null` for that turn, same "omit, don't fabricate a zero" convention
  `cost_usd` already uses. **Body can cycle more than once** (per-paragraph repairs, each its own
  `dispatchStep`) — the recorder tracks the *first* start and the *last* stop across however many
  cycles happen in one turn, compressing multiple repair windows into one outer span rather than
  storing a variable-length list; a deliberate simplification, not an oversight (see Edge Cases).
  Header and footer are each one-shot (checked once, early and at stream-end respectively), so no
  compression question arises for them.
- `stop` (user-initiated abort, distinct from natural completion) — marked when the client either
  calls `POST /v1/chat/abort` itself or receives the abort-flavored `bigimagine_error` terminal
  frame (`isAbortError`, per `handleChatCompletions.ts`).
- `display-settle` — marked the moment the resolved `chatCompletion()`/`swipeMessage()` promise
  returns (or the abort/error terminal frame is observed). Because `finishStream` (footer +
  deferred `'llm'`-action) and `finalizeCleanupResult` both complete server-side, and any resulting
  patch frame is sent, *before* the `stop`/`[DONE]` frame per the in-stream-cleanup-plan's own
  contract, this single client-observed moment is already the true "nothing can silently change
  again" instant — no additional waiting or polling needed.

**Message id, needed only at the end.** The assistant message's own id (already present on the
first OpenAI-style SSE chunk, per existing convention) isn't needed for any mark during the turn —
every mark is just an elapsed-ms bookkeeping entry. It's only read once, from the resolved
`chatCompletion()`/`swipeMessage()` return value, at finalize time, to attach to the POST body.

**Persistence.** Once finalized (`ok`, `aborted`, or `error`), `turnTimeline.ts` POSTs the whole
record in one call to `POST /v1/turn-display-metrics` — fire-and-forget, same "a metrics write
must never fail the user's actual turn" convention `io/turnMetrics.ts` already documents. A failed
POST just means that turn is missing from Timing stats, nothing else.

## Contracts

`llm_calls` new columns (migration 0101, all nullable, no default):
```
provider_kind      text
model              text
cache_read_tokens  int
cost_usd           numeric
```

`callCost.ts`:
```
computeCallCostUsd(
  usage: { promptTokens: number; completionTokens: number; cacheReadTokens?: number },
  price: { priceInputPerMillion?: number; priceOutputPerMillion?: number; priceCacheHitPerMillion?: number },
): number | undefined
```

`createGatedLlmProvider(base: LlmProvider, db: PostgresClient, settings: OrchestratorSettingsStore, profile: LlmProfile): LlmProvider`

`GET /v1/admin/llm-stats?days=<int>` → `{ calls: LlmCallStatRow[] }`:
```
interface LlmCallStatRow {
  callId: string;
  createdAt: string;        // ISO
  userId: string;
  kind: 'chat' | 'agent_routine' | 'system';
  taskId: string;
  jobId: string | null;
  outcome: 'ok' | 'refused' | 'error';
  providerKind: string;     // profile.kind, or '(pre-tracking)'
  model: string;            // profile.model, or '(pre-tracking)'
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  attempt: number;
}
```

`turn_display_metrics` (migration 0102):
```sql
create table turn_display_metrics (
  turn_display_metric_id  uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references users(user_id),
  chat_id                 uuid not null references chat_sessions(chat_id) on delete cascade,
  message_id              text not null,
  dispatch_at             timestamptz not null,
  first_token_ms          int,
  last_token_ms           int,
  display_land_ms         int,
  display_settle_ms       int,
  header_start_ms         int,
  header_stop_ms          int,
  body_start_ms           int,
  body_stop_ms             int,
  footer_start_ms          int,
  footer_stop_ms           int,
  outcome                  text not null check (outcome in ('ok', 'aborted', 'error')),
  terminated_at_ms         int,
  created_at               timestamptz not null default now()
);
create unique index turn_display_metrics_message on turn_display_metrics (message_id);
create index turn_display_metrics_recent on turn_display_metrics (created_at);
alter table turn_display_metrics enable row level security;
alter table turn_display_metrics force row level security;
create policy user_scoped on turn_display_metrics using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on turn_display_metrics to bigimagine_app;
```
Standard `user_scoped` RLS (unlike `llm_calls`) — this is per-user chat-experience data with no
household-wide cap check reading it, so the usual pattern applies. The explicit `bigimagine_app`
grants follow the new-table convention established by 0088 (new tables get their own grant
statement; `llm_calls`-style column additions like 0101 need none since table-level grants are
column-agnostic). The admin stats endpoint reads
across every user via `db.withSystemScope`, same as `handleLlmStatsGet`.

`POST /v1/turn-display-metrics` body (regular chat auth, not admin):
```
{
  chatId: string; messageId: string; dispatchAt: string; // ISO
  firstTokenMs?: number; lastTokenMs?: number; displayLandMs?: number; displaySettleMs?: number;
  headerStartMs?: number; headerStopMs?: number;
  bodyStartMs?: number; bodyStopMs?: number;
  footerStartMs?: number; footerStopMs?: number;
  outcome: 'ok' | 'aborted' | 'error';
  terminatedAtMs?: number;
}
```

`GET /v1/admin/turn-display-stats?days=<int>` → `{ turns: TurnDisplayMetricRow[] }`, mirroring the
table's columns (camelCase) on the frontend.

`turnTimeline.ts`'s DOM event:
```
window.dispatchEvent(new CustomEvent('bigimagine:turn-event', { detail: TurnTimelineEventDetail }))

interface TurnTimelineEventDetail {
  messageId: string | null;  // null until known (see Logic) — devtools listeners get it once the first delta lands
  event: 'dispatch' | 'stop' | 'first-token' | 'last-token' | 'cleanup-start' | 'cleanup-stop' | 'display-land' | 'display-settle';
  region?: 'header' | 'body' | 'footer';  // only present on cleanup-start/cleanup-stop
  tsMs: number;  // elapsed ms since this turn's dispatch
}
```

## Edge Cases

- **Rows written before migration 0101**: `providerKind`/`model` map to `'(pre-tracking)'`;
  numeric columns stay `null`, excluded from sums/averages, not treated as zero.
- **A `refused`/`error` `llm_calls` row**: the profile was already resolved before the attempt in
  every case, so `providerKind`/`model` are still populated — only usage/cost stay `null`.
- **A connection with no price configured, or only some tiers**: `costUsd` is `null`, never a
  guessed `$0.00`.
- **Turn 1's header repair is invisible to this client-side timeline.** Turn 1 is fully buffered
  and header-repaired *before* streaming begins at all (`ensureFirstTurnHeader`) — there is no live
  SSE frame for the client to observe that timing against. `header_start_ms`/`header_stop_ms` stay
  `null` for every turn-1 row even though a repair may genuinely have happened. Documented gap, not
  a bug; fixing it would need a server-side timestamp threaded through a fundamentally different
  (buffered, pre-stream) code path for one turn per chat — judged not worth the complexity here.
- **A connection with no `completeStream`**: the whole reply buffers, cleanup only happens via the
  5s poll tick afterward — `first-token`/`last-token`/`display-land` still work (one buffered
  chunk, one timestamp), but no live `bigimagine_cleanup` frames ever arrive, so all six cleanup
  columns stay `null` even if the poll tick later did repair something. The Usage & Cost side still
  sees the call normally (`llm_calls` doesn't care how it streamed).
- **Body's multiple repair cycles compressed to one span.** If paragraph 2 settles before
  paragraph 5 even starts, `body_start_ms`/`body_stop_ms` describe the *outer* window (first start
  to last stop), not each cycle individually — a deliberate simplification (see Logic) to avoid a
  variable-length jsonb column for a case the stats page doesn't need cycle-level detail on.
- **Aborted/errored turns are still recorded**, not dropped — `outcome` and `terminatedAtMs` let
  the Timing view answer "how often does this actually get cancelled," matching Loggeryze's own
  "uncompleted turns are flagged, not silently dropped from the averages" precedent.
- **`display-land` and `first-token` are often numerically identical.** Kept as separate marks
  anyway (wire-arrival vs. next-paint) — see Logic.
- **Mobile width.** Both Stats sections are dropdowns + filter chips + a stacked bar-list — no
  drag-and-drop grid, no horizontal scroll needed, holds up at phone width by construction (the
  reason this plan replaced the earlier `react-pivottable` draft).
- **Unbounded growth**: no pagination on either admin GET — household scale, a bounded lookback
  window (max 365 days) keeps both comfortably small.

## Tests

- `callCost.ts`: full price computes the expected total; a cache-hit split prices miss/hit
  portions correctly; a missing needed tier returns `undefined`; zero `cacheReadTokens` with no
  cache-hit price still prices the full prompt at the input rate.
- `verify-llm-gate.mjs`: a successful `complete()`/`completeStream()` call logs
  `providerKind`/`model`/`costUsd` matching the fake profile passed in; a `refused` call still logs
  `providerKind`/`model` with usage/cost `null`.
- `verify-server.mjs`: `GET /v1/admin/llm-stats` rejects with no admin auth, returns
  `'(pre-tracking)'` for a seeded null-provider row, respects/clamps `days`.
- `verify-turn-display-metrics.mjs` (new): the insert function round-trips every field; `POST
  /v1/turn-display-metrics` rejects with no chat auth, accepts a partial payload (only the fields
  reached before an abort), and the unique index on `message_id` rejects a duplicate insert for the
  same turn; `GET /v1/admin/turn-display-stats` requires admin auth and respects `days`.

## Out of Scope

- `react-pivottable` / any drag-and-drop pivot library — superseded by the dropdown+filter
  approach in this plan.
- Recovering turn-1's header-repair timing (see Edge Cases) — would need new server-side
  instrumentation on a fundamentally different code path for one turn per chat.
- Timing instrumentation for non-RP `chat`-kind turns — streaming and cleanup have always been
  RP-only, so there is no comparable timeline to capture there.
- Retrying a failed `POST /v1/turn-display-metrics` — fire-and-forget, same as every other
  metrics-recording call in this codebase.
- Backfilling historical `llm_calls` rows' new columns — not recoverable.
- Per-cycle (vs. outer-span) body repair timing, and any chart type beyond a stacked bar-list.
- Currency other than USD.

## Principles / Conventions in Play

- §5 (The Story is the Default; Specialist Views are Opt-In) — Stats is a hamburger-menu
  specialist view, never intruding on the chat/RP surface.
- §8 (The Four Kinds of Code) — `callCost.ts` and `aggregateRows.ts` are Pure Functions, kept
  separate from the IO Wrappers (`llmGate.ts`, `turnDisplayMetrics.ts`, the new handlers) that call
  them; `turnTimeline.ts` is a small client-side Stateful Owner (one recorder instance per turn).
- §11 (Observability is Not an Afterthought) — this feature *is* that principle made visible,
  including the honest choice to record aborted/errored turns rather than drop them.
- §12 (A Secret Is Write-Only) — nothing new here is a secret; same visibility tier as the
  existing `llm_connections` pricing fields.
- §14 (Every LLM Call Passes Through One Gate) — the Usage & Cost widening deepens what the
  existing single gate records; it adds no second path to the model.
- §18 (Mobile-First) — the dropdown+filter+bar-list shape was chosen specifically because it holds
  up at phone width without the tension a pivot grid would have introduced.
