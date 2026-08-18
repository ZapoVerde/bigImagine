# Portrait Studio — make reflection reliable

## Decision

The first change is not a vision harness or a broader curriculum. It is to repair the existing reflection loop so that every episode produces an auditable, actionable lesson—or is explicitly marked incomplete.

Reflection was intended to explain why a candidate won and guide the next mutation. At present it can receive ambiguous evidence, return no useful conclusion, and still leave the round looking successful. Wiki editing cannot fix that; the wiki is downstream of reflection.

## Outcome

For every episode we can answer: what was the parent state; what changed; which candidate won and what the user observed; what lesson reflection derived; which next mutation used it; and whether the result improved.

The configured internal model remains non-vision. Human guidance is the visual evidence. A future vision reviewer can be added later through the same review contract.

## Scope

In scope: structured reflection inputs; a required structured lesson output; truthful reflection status and failure handling; immutable episode and lesson history; explicit linkage from a lesson to the next mutation; bounded, evidence-based wiki projection.

Out of scope: autonomous vision calls, a new external review harness, sprite curriculum work, automatic wiki rewriting without approval, and changing the image provider.

## Reflection contract

Reflection receives one compact episode record:

```text
Goal: <operator's stated goal>
Parent: <layer values>
Candidate changes: <server-computed before -> after diff per candidate>
Human assessment:
  rationale: <required prose>
  optional layer assessments: [{layer, assessment: improved|unchanged|regressed}]
Winner: <candidate id>
Prior lessons used: [lesson ids]
Prior wiki context used: [revision ids]
```

The server computes the diff. The model must not rediscover it from long composed prompts. The UI adds optional per-layer assessments; if omitted, the model may derive them from the diff and must label them as inference in its evidence. A rating without an explanation is preference data, not a completed lesson.

Reflection uses the existing tool-calling path, not raw JSON. The model receives one forced `submit_lesson` tool whose JSON-Schema parameters contain `status`, `lesson`, `evidence`, `next_change`, `preserve`, and `confidence`. `status` is an enum: `conclusion` or `insufficient_evidence`; `confidence` is `low`, `medium`, or `high`. `next_change` is required only for `conclusion`. The schema and server validator reject a layer appearing in both `next_change` and `preserve`. Provider/tool-call failures become `failed`.

Only `conclusion` creates a reusable lesson. The prompt must require supplied evidence only, one actionable change, unchanged layers to preserve, and an explicit insufficient-evidence response; it must never claim to have seen an image.

Prompt tuning follows implementation of this contract and tests against recorded episodes.

## Investigation loop decision

Retire the old multi-turn investigation loop for portrait reflection. Remove the `pull_wiki_entry` and `submit_conclusion` tools, the `visual_wiki_investigation_max_turns` setting, and the old reflection prompt override after the new path is live. The replacement is one bounded call with the forced `submit_lesson` tool and a preselected, bounded wiki context. Keep a compatibility reader for the old setting during migration, but do not execute it; remove it after all existing episodes are outside the rollout window.

## State machine

```text
generated -> awaiting_feedback -> reflecting -> concluded | insufficient_evidence | failed
```

Incomplete and failed states remain visible and retryable. They must not be reported as successfully learned. Feedback without a winner still creates an episode in `awaiting_feedback`, stores ratings/notes/rationale if supplied, and does not trigger reflection. Reflection starts only after an explicit winner is selected (or the operator explicitly records “no acceptable candidate,” which produces `insufficient_evidence`). Winner promotion is recorded in an `visual_episode_events` row with event type `winner_applied`, including the applied chromosome and timestamp; changing slots is not evidence that learning occurred.

## Data model

Add migration `0118_portrait_reflection_learning.sql` (0116 is unused).

### `visual_episode_learning`

One immutable row per reflection attempt: `id`, `episode_id`, `attempt`, `status`, `input_snapshot` (goal, parent, candidate diff, ratings, notes, rationale, prior lesson ids, wiki revision ids), `output_snapshot` (validated response or provider error), model/connection, timestamps.

### `visual_lessons`

Only a validated conclusion creates a lesson: `id`, source episode/learning ids, statement, evidence, next change, preserve list, confidence, and state `provisional | supported | rejected | superseded`.

### `visual_lesson_uses`

Records `lesson_id`, `episode_id`, mutation call, applied change, result candidates, and timestamp.

### `visual_episode_events`

Append-only events such as `winner_applied`, `reflection_started`, `reflection_failed`, and `lesson_created`, with episode id, payload snapshot, and timestamp.

### `visual_wiki_revisions`

Concrete immutable history for each entry: `id`, `entry_id` (FK), `revision_number`, `content`, `kind` (`created|amended|retired`), supporting lesson ids, supporting episode ids, author/source, and timestamps. Existing wiki entries receive a baseline revision with `kind=created`, `source=legacy_backfill`, and no invented lesson provenance. Existing episodes remain outside the new lesson ledger unless replayed; they are labeled historical/baseline rather than falsely marked supported.

Add missing immutable provenance to existing episode/candidate records: parent chromosome, composed prompt, render metadata, and bounded wiki revision ids supplied to mutation.


## API and orchestration

1. Feedback submission requires episode-level rationale when marking a winner and exposes optional per-layer assessment controls. A no-winner submission is retained but does not invoke reflection.
2. A pure formatter builds the reflection input from the immutable snapshot.
3. The existing reflection call validates its response. Invalid output, provider errors, and timeouts become `failed`.
4. Persist the attempt before changing learning state.
5. A conclusion creates one lesson and returns its id.
6. The next mutation accepts `lesson_id` and records lesson use; without one it is explicitly exploratory.
7. Wiki create/amend is a separate projection requiring operator approval initially, with supporting lesson ids. Amendments create revisions.

## Wiki policy

The wiki is a durable summary, not the primary event log.

- Never create or amend from `failed` or `insufficient_evidence`.
- Store provisional lessons in the ledger without putting them in the wiki.
- Promote only after repeated supporting episodes or explicit operator approval.
- Record supporting lesson and episode ids on every wiki revision.
- Send mutation a bounded selected set of current revisions, never the entire wiki.

## UI

Separate candidate ratings, required rationale, reflection status, generated lesson/next change, and whether the next mutation used it. Failed reflection offers retry or manual lesson entry instead of silently closing the round. Add a compact history view: episode → lesson → use → result.

## Implementation order

1. Capture and snapshot evidence; require rationale and persist parent/diff/render/wiki provenance.
2. Enforce reflection truthfulness with the migration, state machine, structured output validation, and corrected UI.
3. Close the next-mutation link with lesson-driven versus exploratory provenance.
4. Add wiki revisions, approval gates, and bounded retrieval.
5. Tune prompt wording, examples, and token budget using recorded episodes.

## Verification

Test tool-schema validation (including enum values and preserve/next-change disjointness), diff generation, rationale and no-winner handling, all reflection outcomes, malformed tool calls/timeouts, idempotent retries, lesson-to-mutation provenance, wiki gating/revisions, and bounded context. Follow repository convention: implement the integration verification as an `.mjs` script with a fake pool/gate (like `verify-visual-wiki.mjs`) and chain it into `npm run verify`. An integration test must assert:

```text
feedback -> immutable snapshot -> reflection attempt -> lesson
         -> next mutation cites lesson -> result records outcome
```

Principle 15 note: provisional lessons remain in the relational learning ledger and are not immediately projected into the wiki. This is deliberate: Principle 15 governs facts extracted from turns, while the wiki is a derived visual-learning summary that requires evidence/approval.

Completion means no episode can silently appear learned after failure; every conclusion has explicit human evidence; lessons and wiki revisions are immutable and attributable; mutations are marked lesson-driven or exploratory; and a recorded episode can be replayed from its snapshot.
