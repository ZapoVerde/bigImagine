# LLM Gate — Queueing & Retry Plan

*Status: designed, not yet built. Extends the existing `orchestrator/src/io/llm/llmGate.ts` seam
(`bi_principles.md` §14) rather than replacing it.*

## 1. Purpose

`llmGate.ts` already is the one seam every LLM call passes through — every caller (`runTurn`,
`generateChatTitle`, `chatMemorySync.ts`, every plugin's forced-schema helper) is unaware it's
gated, because `index.ts` wraps `deps.llm` exactly once at boot. Today that seam does metering
(`llm_calls`), task/job attribution, and `agent_routine` daily caps with a breaker. It does **not**
retry: a failed `base.complete()` call is logged with `outcome: 'error'` and rethrown immediately,
full stop.

The result is that nothing in the codebase retries an LLM call at the logical level today.
`chatMemorySync.ts`'s only resilience is coarse — a failed tick's transaction rolls back and the
next 30s poll tries again — which is a feature-specific workaround, not a retry policy, and every
future caller (the turn loop, canon extraction, a rule-eval pass) would otherwise have to invent
its own version of the same thing. Per the original CNZ design, this should instead live once, in
the gate, exactly like metering already does — a call site never needs to know it happened.

## 2. Non-Goals

- **Not** a distributed or cross-restart-durable queue. In-process, in-memory only — matching how
  every existing caller already tolerates a restart (`chatMemorySync`'s tick just re-attempts;
  nothing here needs to survive a process bounce that those callers don't already survive).
- **Not** a change to `LlmProvider`'s public shape (`bi_principles.md` §6). Call sites keep calling
  `complete()` exactly as they do today.
- **Not** caller-visible job ids. Per direction: the gate assigns and tracks job/request identity
  internally, purely for its own bookkeeping (retries, concurrency, logging) — no caller ever
  passes or receives one.
- **Not** touching `httpRetry.ts`. That file already retries transient, thrown (no-response) fetch
  failures one layer further down (stale sockets, DNS blips) — orthogonal to this plan, which is
  about retrying a logical LLM call, including ones that returned a real-but-bad response.
- **Not** a priority/fairness scheduler across users initially. Single-user platform; plain FIFO is
  enough. Noted as a possible later refinement only if real contention shows up.

## 3. Current State (verified against the code)

- Every `complete()` call reads `{taskId, kind, userId}` from ambient `AsyncLocalStorage`
  (`callContext.ts`) — never a `complete()` argument — and throws if called outside a tagged scope.
- Only `kind === 'agent_routine'` calls are preflight-checked against per-job and household daily
  caps (`scheduled_jobs.max_runs_per_day`/`max_tokens_per_day`, `agent_routine_max_runs_per_day`/
  `agent_routine_max_tokens_per_day`) and can trip a breaker (`job.status = 'capped'` or flipping
  `agent_routines_enabled` off). A live chat turn or a system classification call is metered but
  never capped.
- On any failure, `logCall(..., outcome: 'error', ...)` is written and the error is rethrown
  immediately — one attempt, no backoff, no retry.
- No concept of "queued" or "pending" work exists anywhere in the LLM call path. Every call runs
  the instant its caller invokes `complete()`, fully concurrent with every other in-flight call.
- "Job number" as a concept exists only for `agent_routine` kind (`scheduled_jobs.job_id`), and only
  for cap accounting — not a general per-call identifier.

## 4. Design

### 4.1 Queueing model — internal factory, FIFO admission, nothing caller-visible

Every `complete()` call arriving at the gate is wrapped internally as a request:
`{ requestId (gate-generated), ctx, messages, tools, options, attempt: 0 }`. Requests are admitted
into an in-memory FIFO queue behind a concurrency limit (a settings-backed max-in-flight count,
default e.g. 3) — bounding how many calls run against the provider at once, so a burst (a
multi-character turn's several character-generation calls, a sync tick, a canon-extraction pass all
landing around the same moment) can't saturate a rate limit.

The caller's `await complete(...)` is untouched by any of this — it's still one promise, resolving
once the request (successful immediately, or after internal retries) finishes. No call site sees a
request id, a queue position, or anything new. This preserves the exact "zero call sites touched"
property the gate already has for metering.

### 4.2 Retry policy — classify before retrying, bounded exponential backoff

Not every failure should retry:

- **Retryable**: transport/timeout errors, and provider responses indicating a transient condition
  (429 rate-limited, 500/502/503/504) — the same class `httpRetry.ts` already targets one layer
  down, but classified here at the logical-call level so a *whole* attempt (not just the underlying
  fetch) can be redone.
- **Not retryable**: anything indicating the request itself is wrong and will fail identically every
  time — 400 malformed request, 401/403 auth, a tool-schema validation failure, a content-policy
  refusal. Also not retryable: `preflightAgentRoutineCheck` refusals — retrying past a cap defeats
  the cap's own purpose.

Backoff: exponential with jitter — proposed default base 500ms, ×2 per attempt, capped at 8s, ±20%
jitter (to avoid every queued call retrying in lockstep during a provider-wide blip). Bounded at a
small default max attempt count (proposed 3), both configurable via `orchestrator_settings` the same
way `chat_memory_*` keys already are, so they're tunable without a redeploy.

Once attempts are exhausted, the final failure is what gets logged (`outcome: 'error'`) and
rethrown to the caller — same external contract as today, just after the gate has already tried on
the caller's behalf.

### 4.3 Observability

`llm_calls` gains attempt tracking: proposed as one row per attempt (not a counter column) sharing a
`request_id`, since "every call is metered" already means every attempt is a call in the sense that
matters, and this gives per-attempt latency/outcome for free without a schema branch.

This shouldn't need any change to the Review Panel's semantics — a chat-memory-sync call that
succeeds on its 2nd internal attempt is still `'ok'` from `chat_memory_sync_status`'s point of view,
exactly as intended (retries are meant to be invisible to the caller). A worthwhile follow-up, not
scoped here: a lightweight "how often is the gate actually retrying" signal somewhere admin-visible,
since a feature that's quietly needing 2-3 attempts every time is a signal worth seeing even though
the feature itself reports healthy.

### 4.4 Concurrency & fairness

Plain FIFO admission behind the concurrency cap from 4.1. A saturated queue (unlikely at single-user
scale) just makes new calls wait their turn rather than firing unbounded — no "reject if full"
behavior needed unless real contention shows up in practice.

## 5. Concrete build steps

Rough sequencing, to be broken down further once scheduled:

1. Add request wrapping, FIFO admission, and the concurrency limit inside `llmGate.ts` — likely
   split into a new `llmQueue.ts` for the pure queue/backoff-decision logic, kept separate from the
   impure Postgres-touching parts of `complete()`, per the four-kinds-of-code split
   (`docs/conventions.md`).
2. Add a small, independently-testable retry-classification function (retryable vs not, given a
   thrown error / response).
3. Migration: `request_id` + `attempt` columns on `llm_calls` (or equivalent).
4. `complete()` loops attempts internally instead of calling `base.complete()` exactly once.
5. New `orchestrator_settings` keys: `llm_gate_max_concurrent`, `llm_gate_max_retries`,
   `llm_gate_retry_base_ms`, `llm_gate_retry_max_ms`, with defaults, read the same way
   `chat_memory_*` settings already are.
6. New `verify-llm-gate.mjs`: a fake `LlmProvider` that fails N times then succeeds, asserting
   retry count, backoff timing, eventual success, and that a non-retryable error skips retry
   entirely.

## 6. Open questions for the user

- **Concurrency lanes.** One global max-in-flight, or separate lanes for `agent_routine` vs a live
  turn's calls, so a background sync/canon-extraction burst can never delay an interactive turn?
  Leaning toward separate lanes — `llmGate.ts`'s own existing comment ("an unattended routine's
  budget should never be able to interrupt the household's own chat") already sets this precedent
  for caps, and the same reasoning plausibly extends to concurrency.
- **Do retries count against `agent_routine` caps?** A retried call is still real provider spend.
  Leaning toward yes — every attempt counts, not just the final one.
- **Backoff numbers.** 500ms/×2/8s-cap/3-attempts above is a starting guess, not pulled from CNZ's
  actual values — if you remember CNZ's real numbers, those should replace mine directly rather than
  guessing again.

## 7. Follow-up doc updates (once this plan is approved — not part of this document)

- `bi_principles.md` §14 should gain a line noting retry/queueing is now part of "the one gate," so
  a future reader doesn't rediscover this as a gap the way this doc did.
- The turn-loop design doc (once written) should reference this doc for its "fire the prompt" step
  rather than re-describing retry behavior inline.
