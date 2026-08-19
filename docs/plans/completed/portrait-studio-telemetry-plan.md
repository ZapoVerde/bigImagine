# Portrait Studio — round telemetry, provider failures, and left-panel receipts

## Goal

Give Portrait Studio an honest, per-round account of every provider call involved in generating and
evaluating a portrait: mutation, optional Wiki pulls, image renders, Reflection, and Reflection
retries. Show the account in the Studio's left-side panel in the same spirit as RP chat's Prompt
Inspector and Timing drawer.

The panel must answer, without opening logs:

- Which call is running or failed?
- Which provider and model handled it?
- How many input, output, total, and cache-read tokens did each LLM call use?
- How long did each LLM or image call take?
- What are the round's total LLM tokens, LLM time, image time, and wall-clock time?
- What exact provider, parser, network, or image-render error occurred?

This plan covers observability only. It does not change provider selection, retry policy, mutation
prompting, Reflection rules, image composition, or the existing RP chat telemetry.

*Revision note (2026-08-19): the original draft had every LLM call write a second, portrait-specific
token/duration/error record, duplicating what `llmGate.ts` already writes to `llm_calls` for the
same call. This revision keeps `llm_calls` the sole source of LLM accounting and correlates it to a
round via one new nullable column, instrumented the same way `call_label` already is. Only image
renders — which have no existing ledger — get a new table.*

## Background

RP chat already has the required accounting primitives:

1. `llmGate.ts` receives vendor-reported `LlmUsage` and writes the universal `llm_calls` ledger —
   provider, model, prompt/completion/total/cache tokens, duration, and outcome/error — for every
   call, keyed by `task_id` and an optional `call_label` (`bi_principles.md` §14).
2. `portraitGeneration.ts` and `portraitFeedback.ts` already tag their calls via `withCallLabel`:
   `'portrait:mutation'` for the mutation loop and `'portrait:reflection'` for Reflection. These
   labels already exist on `llm_calls` rows today.
3. Prompt Inspector exposes per-call prompt/completion/total/cache tokens from the same ledger.
4. `TurnTimeline` and `turn_display_metrics` expose client-observed RP timing.
5. The Stats and Timing plans establish the project's conventions: nullable unavailable values,
   no fabricated zeroes, pure aggregation helpers, and exact provider errors preserved as data.

Portrait Studio currently has a different shape:

- One generation round can issue one mutation call plus Wiki-pull calls — but today every call in
  that loop (initial and every post-pull continuation) shares the single label `'portrait:mutation'`,
  so a wiki pull is not yet distinguishable from the mutation call itself.
- It can issue several image-provider calls, one per candidate. Image calls are not LLM calls at
  all — `llm_calls` has no visibility into them, and nothing else records their timing today
  (`visual_candidates.render_metadata` stores model/size/sampler settings, but no duration).
- Feedback can issue a Reflection call and later retry calls. Reflection's task id
  (`visual-<subjectEntityId>-reflection`) has no episode or attempt component, so it collides
  across different episodes for the same subject — it cannot serve as a round correlation key on
  its own.
- Generation occurs before a feedback episode exists, so an episode is not a sufficient primary
  correlation key either.
- Structured failures are returned to the UI, but the individual provider call and its exact
  failure are not currently visible beside the round.

The central design decision is therefore a Portrait `roundId`, created when generation starts and
carried through candidates, feedback, Reflection, retries, and telemetry — **as a correlation key
layered on top of the existing ledgers, not a replacement for them**. `llm_calls` remains the only
place LLM token/duration/error data is written; it gains one nullable `round_id` column, populated
through the same ambient-context mechanism `call_label` already uses. Image calls, which have no
existing ledger, get one new table.

## Files

### New

- `db/migrations/xxxx_portrait_round_telemetry.sql` — creates `visual_rounds` and
  `visual_round_image_calls`, adds nullable `round_id` to `visual_episodes`, and adds nullable
  `round_id` to the existing `llm_calls` table.
- `orchestrator/src/portraits/portraitTelemetry.ts` — Pure Function helpers that merge an
  `llm_calls`-shaped row list and a `visual_round_image_calls`-shaped row list into one
  chronological call list, derive each LLM row's `phase`/`label` from its `call_label`, and compute
  round totals. No database or provider calls.
- `orchestrator/src/server/portraitTelemetryRoutes.ts` — IO Wrapper for the user-scoped
  `GET /v1/portraits/rounds/:roundId/telemetry` endpoint.
- `frontend/src/components/portraits/PortraitTelemetryPanel.tsx` — left-panel renderer for calls,
  failures, per-call receipts, and round totals.
- `frontend/src/components/portraits/PortraitTelemetryPanel.css` — responsive panel, status rows,
  token receipts, and failure styling.
- `orchestrator/scripts/verify-portrait-telemetry.mjs` — database, merge/aggregation, route,
  ownership, success, and failure fixtures following the existing visual verification scripts.

### Modified

- `db/migrations/...` — no existing migration is edited; the new migration owns all telemetry
  schema changes, including the `llm_calls` alteration.
- `orchestrator/src/io/llm/callContext.ts` — adds an ambient `roundId` field alongside the existing
  `callLabel`, and a `withRoundId(roundId, fn)` helper mirroring `withCallLabel`. This is the only
  new plumbing `llmGate.ts` needs.
- `orchestrator/src/io/llm/llmGate.ts` — reads `ctx.roundId` and adds `round_id` to the `llm_calls`
  insert (both `complete()` and `completeStream()` paths, and the `'refused'` logging path for
  consistency, though portrait calls are `kind: 'system'` and never refused). No token/duration
  parsing logic changes — this is a one-column addition to an existing insert.
- `orchestrator/src/orchestrator/portraitGeneration.ts` — creates the `visual_rounds` row before the
  first mutation call, wraps every call in the mutation loop in `withRoundId(roundId, ...)`,
  **alternates the call label** so the first call uses `'portrait:mutation'` and every call after a
  `pull_wiki_entry` round-trip uses `'portrait:wiki-pull'`, writes one `visual_round_image_calls`
  row per candidate render, sets the round's terminal status/`completed_at`, and returns `roundId`.
- `orchestrator/src/orchestrator/portraitFeedback.ts` — reads the episode's `round_id` and wraps the
  Reflection call in `withRoundId(episodeRoundId, ...)`; a retry reuses the same `round_id` and the
  same `'portrait:reflection'` label (attempt numbering stays owned by `visual_episode_learning`,
  which this plan does not duplicate).
- `orchestrator/src/server/portraitRoutes.ts` — accepts/returns `roundId`, wires telemetry route
  registration if the route remains colocated, and includes it in generation/feedback responses.
- `orchestrator/src/server/httpServer.ts` — registers the telemetry route behind normal user auth.
- `orchestrator/src/io/llm/types.ts` — only if the existing `LlmTurn` usage shape lacks a field the
  merge helper needs (not expected — `LlmUsage` already carries everything required).
- `frontend/src/api/types.ts` — adds `PortraitRoundTelemetry`, `PortraitCallTelemetry`, and
  generation/feedback `roundId` fields.
- `frontend/src/api/client.ts` — adds `getPortraitRoundTelemetry`.
- `frontend/src/views/PortraitStudioView.tsx` — stores the active round, refreshes telemetry after
  generation/feedback/retry, and mounts the panel in the Studio's left-side area.
- `frontend/src/views/PortraitStudioView.css` — only for layout integration not owned by the new
  panel stylesheet.
- `frontend/src/App.tsx` or `frontend/src/components/sidebar/Sidebar.tsx` — only if the existing
  application sidebar is the correct host for a Portrait-specific section; the RP Prompt Inspector
  must remain unchanged.
- `package.json` / workspace verification wiring — adds the new verification script.

## Contracts

### Database

```sql
visual_rounds(
  round_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(user_id),
  goal text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  status text not null default 'running', -- running | succeeded | failed | partial
  created_at timestamptz not null default now()
)
-- RLS: same user_scoped shape as every visual_* table (0105_visual_studio.sql's precedent).

visual_round_image_calls(
  call_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(user_id),
  round_id uuid not null references visual_rounds(round_id),
  candidate_id uuid null references visual_candidates(candidate_id),
  status text not null, -- running | succeeded | failed
  provider_kind text null,
  model text null,
  duration_ms integer null,
  error_code text null,
  error_message text null,
  started_at timestamptz not null,
  completed_at timestamptz null,
  created_at timestamptz not null default now()
)
-- RLS: same user_scoped shape.

-- llm_calls (existing, RLS-exempt — llmGate.ts's own documented household-wide-table exemption)
-- gains a correlation column. No token/duration/provider/model columns are added anywhere else for
-- LLM calls; that accounting stays exclusively here.
alter table llm_calls add column round_id uuid null;
create index llm_calls_by_round on llm_calls (round_id) where round_id is not null;
```

`visual_episodes.round_id` is nullable for historical episodes created before this plan. Every new
generation/feedback path supplies it.

### HTTP

`GET /v1/portraits/rounds/:roundId/telemetry`

```ts
interface PortraitRoundTelemetry {
  roundId: string;
  status: 'running' | 'succeeded' | 'failed' | 'partial';
  calls: PortraitCallTelemetry[];
  totals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    llmDurationMs: number;
    imageDurationMs: number;
    wallClockDurationMs: number;
  };
}

interface PortraitCallTelemetry {
  callId: string;
  phase: 'mutation' | 'wiki_pull' | 'image_render' | 'reflection';
  label: string;
  status: 'running' | 'succeeded' | 'failed';
  providerKind?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  /** Set only on phase 'image_render' rows — visual_round_image_calls.candidate_id. LLM-sourced
   *  rows never carry one. */
  candidateId?: string;
  createdAt: string;
}
```

Unavailable token fields are omitted, not returned as zero. Image calls therefore have duration
and provider information but no misleading token values. For LLM-sourced rows, `phase` and `label`
are derived at read time from `llm_calls.call_label` (`'portrait:mutation'` → `mutation`,
`'portrait:wiki-pull'` → `wiki_pull`, `'portrait:reflection'` → `reflection`) — they are not stored
columns on any portrait-specific table.

## Logic

### Round lifecycle

`runPortraitGenerationRound` creates a `visual_rounds` row (status `'running'`) before the first
mutation call and uses its ID for every subsequent call in the round. The generation response
returns that ID with the candidates. Once dispatch finishes, the round is set to `'succeeded'`,
`'failed'`, or `'partial'` with `completed_at` — the same three-way outcome
`runPortraitGenerationRound`'s own result (`ok`, all-candidates-failed, some-candidates-failed)
already distinguishes.

The frontend keeps the ID in Portrait Studio state. Feedback submits it with the winner/rationale.
`submitPortraitFeedback` stores it on the episode and uses it for Reflection and Reflection retry
calls. A feedback retry never deletes or overwrites an earlier failed call; it reuses the same
`round_id` and the same `'portrait:reflection'` label — each attempt is its own `llm_calls` row,
ordered chronologically. This plan does not add a second attempt counter: `visual_episode_learning`
already owns reflection attempt numbering and stays the source of truth for it.

### LLM calls

No new recorder or token-recording table exists for LLM calls. Every actual `llm.complete()`
invocation already passes through `llmGate.ts`, which is the single write path for token, duration,
provider/model, and error data (`bi_principles.md` §14). This plan extends that one seam with a
single nullable `round_id` column, populated the same way `call_label` already is: ambiently, via
`callContext.ts`.

- `portraitGeneration.ts`'s mutation loop wraps every call in `withRoundId(roundId, ...)`. The first
  call uses the existing `'portrait:mutation'` label; every call made after a `pull_wiki_entry`
  tool round-trip uses a new `'portrait:wiki-pull'` label — this is the one real behavior change
  the loop needs, since today every round-trip shares one label.
- `portraitFeedback.ts`'s Reflection call keeps its existing `'portrait:reflection'` label, wrapped
  in `withRoundId(episodeRoundId, ...)`.

On thrown provider, network, timeout, or parsing errors, `llmGate.ts` already writes a failed
`llm_calls` row with the exact provider/error message, duration up to failure, and any usage
available before the failure — no new failure-handling code is needed for LLM calls, because there
is no separate portrait recorder for them. The existing response error and top toast remain in
place; the ledger is an additional durable diagnostic surface, not a replacement for the request's
error handling.

### Image calls

Image renders have no existing ledger, so this is the one place this plan adds real call-recording
code. Each candidate image render receives its own `visual_round_image_calls` row, written by
`portraitGeneration.ts` (and `retryPortraitCandidateRender`) directly around the existing
`createImageGenProvider(...).generate()` call: candidate ID, provider, model, start/end timestamps,
duration, success/failure, and exact error. Image calls are measured in parallel, so the UI can show
both:

- sum of individual image durations, useful for provider work;
- wall-clock round duration, useful for what the operator experienced.

Image failures remain attached to their candidate and do not fabricate token counts.

### Totals

`portraitTelemetry.ts` provides the single aggregation implementation, over two already-fetched
sources rather than one homogeneous table:

- `promptTokens`, `completionTokens`, and `totalTokens` sum only non-null values from the round's
  `llm_calls` rows.
- `cacheReadTokens` is present only when at least one `llm_calls` row reported cache accounting.
- `llmDurationMs` sums `llm_calls.duration_ms` for the round.
- `imageDurationMs` sums `visual_round_image_calls.duration_ms` for the round.
- `wallClockDurationMs` is `visual_rounds.completed_at` (or `now()` while running) minus
  `started_at`, not the sum of parallel calls.

Failed calls are included in duration totals. Token values are included only when reported by the
provider. A failed round can therefore have useful partial totals.

### Endpoint and polling

The route first loads the `visual_rounds` row through the normal user-scoped RLS path
(`db.withUserScope`) — this is the ownership check, and it must succeed before anything else runs.
Only then does it query `llm_calls` explicitly filtered by both `round_id` **and** `user_id`:
`llm_calls` itself carries no RLS (`llmGate.ts`'s own documented household-wide-table exemption for
the same reason `provider_credentials`/`orchestrator_settings` are exempt), so the route must never
rely on `round_id` alone to scope that query. It separately queries `visual_round_image_calls`,
which does carry normal RLS. `portraitTelemetry.ts` merges the two lists into one chronological
list, ordered by `llm_calls.created_at` for LLM rows (call-completion order — adequate since
portrait LLM calls in a round are sequential, never parallel) and `visual_round_image_calls.started_at`
for image rows (which do run in parallel).

The frontend fetches immediately after generation and feedback, then polls while the round has a
`running` call. Polling stops when the round is terminal or when the request has returned a terminal
failure.

The endpoint is user-gated. A missing or foreign `roundId` returns the same not-found shape as other
user-scoped Portrait resources and never reveals whether another user's round exists.

### Left-panel presentation

The panel is independently collapsible. Its collapsed summary keeps the round status and compact
totals visible. Expanded content renders one row per call:

```text
Mutation       12,430 in · 842 out · 13,272 total · 4.8s   succeeded
Wiki pull       3,015 in · 210 out ·  3,225 total · 1.9s   succeeded
Image render   Candidate 1 · 9.2s                           succeeded
Image render   Candidate 2 · 4.1s                           failed
Reflection     3,120 in · 416 out · 3,536 total · 6.2s      failed
```

Failed rows open by default and display the exact error message. Long messages wrap rather than
being truncated; a native title or copy affordance may be added if the final layout needs it.

The totals block separates LLM tokens, LLM duration, image duration, and wall-clock duration. This
prevents parallel image work from being mistaken for sequential elapsed time.

## Testing and verification

### Pure tests

Test `portraitTelemetry.ts` with fixtures for:

- merging an `llm_calls`-shaped row list with a `visual_round_image_calls`-shaped row list into one
  chronological call list;
- phase/label derivation from `call_label` (`portrait:mutation`, `portrait:wiki-pull`,
  `portrait:reflection`);
- image calls with null token fields;
- cache-hit accounting;
- partial provider usage on failure;
- failed calls included in duration totals;
- parallel image durations versus wall-clock duration;
- empty and all-failed rounds;
- exact error-message preservation from `llm_calls.reason` / `visual_round_image_calls.error_message`.

### Backend verification

`verify-portrait-telemetry.mjs` should verify:

1. A round is created before the first mutation call.
2. The mutation call's `llm_calls` row carries the round's `round_id`.
3. A wiki-pull round-trip is labeled `portrait:wiki-pull`, not `portrait:mutation`, and shares the
   round's `round_id`.
4. Image renders write distinct `visual_round_image_calls` rows with `candidate_id` set.
5. Provider and parser failures persist exact `llm_calls.reason` text.
6. Reflection's `llm_calls` row carries the episode's `round_id`.
7. A reflection retry appends a new `llm_calls` row under the same `round_id`, preserving the failed
   attempt; `visual_episode_learning`'s own attempt numbering is untouched by this plan.
8. Totals correctly split LLM totals (from `llm_calls`) from image totals (from
   `visual_round_image_calls`), handling null token fields.
9. The endpoint returns calls in chronological order across both sources.
10. A different user cannot read the round, and separately cannot read another user's `llm_calls`
    rows even by guessing a `round_id` — proving the endpoint's explicit `user_id` filter, not just
    RLS, since `llm_calls` has none.
11. Historical episodes without `round_id` remain readable elsewhere.

Existing visual verification scripts and `npm run check` remain required. No test should call a real
provider or expose a real API key.

### Manual deployment verification

After deployment:

1. Generate a normal round and confirm mutation, image, and totals appear.
2. Configure an invalid LLM model and confirm the exact provider error appears in both the top toast
   and the failed telemetry row.
3. Configure an image provider failure and confirm the affected candidate identifies the failed call.
4. Trigger a Wiki pull during mutation and confirm it renders as its own "Wiki pull" row, distinct
   from "Mutation".
5. Submit feedback and confirm Reflection is appended to the same round.
6. Retry a failed Reflection and confirm both attempts remain visible.
7. Confirm refresh/polling does not duplicate calls.
8. Confirm the panel collapses independently and remains usable at the mobile breakpoint.
9. Inspect orchestrator logs and compare call labels, statuses, and durations with the UI.

## Edge cases

- A provider returns no usage: show timing and status, omit token fields.
- A provider fails before returning a model response: persist the exact error with null usage.
- Candidate image calls run in parallel: show per-call duration, summed image duration, and separate
  wall-clock duration.
- Mutation makes several Wiki pulls: each is its own `'portrait:wiki-pull'`-labeled `llm_calls` row,
  included in totals.
- The browser closes during a round: server-side call rows remain available on the next load.
- A historical episode has no round ID: do not invent telemetry; show no linked round data.
- A telemetry write fails: for image calls, preserve the primary Portrait operation and log the
  write failure — telemetry must not make generation or feedback fail. For LLM calls, this cannot
  happen independently of the call itself, since `llmGate.ts` already writes the row as part of
  metering every call; a failure there is an existing `llm_calls` concern, out of this plan's scope.
- A provider error contains markup or long JSON: render it as escaped text, never as HTML.
- A round is retried: use a new call row and the same round ID; never overwrite history.
- `llm_calls` is household-wide and RLS-exempt by design: the telemetry route must filter it by
  `user_id` explicitly on every query and never trust `round_id` alone to scope it.

## Out of scope

- Changing provider selection or enforcing a new hard-link policy.
- Token estimation when a provider does not report usage.
- Storing a second copy of token/duration/provider/model data for LLM calls — that accounting stays
  solely in `llm_calls`, correlated by the new `round_id` column and the existing `call_label`
  field.
- Replacing or restructuring the universal `llm_calls` ledger beyond the one added column.
- Adding Portrait telemetry to RP chat's existing timing database.
- Building a historical Portrait analytics page; this plan covers the active round's left panel and
  its durable per-round endpoint.
