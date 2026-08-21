# Planning Protocol

This protocol governs production of the planning artifacts.

It intentionally preserves the staged reasoning of the original AI-driven factory while removing the old manual "Proceed" turns.

## Stage 0 — Diagnose when necessary

Use `0_ARCHITECTURAL_DIAGNOSIS.md` only when the root problem is not already sufficiently understood.

Do not diagnose a straightforward feature request.

Exit condition:

- the problem/cause is understood well enough to design the desired behaviour; or
- the diagnosis identifies an unresolved runtime fact that prevents responsible planning.

## Stage 1 — Architectural formalization

Produce `1_ARCHITECTURAL_REPORT.md`.

Inputs:

- human/planning conversation
- relevant project principles and documentation
- diagnosis, if one exists

The planner may inspect repository context for grounding, but the artifact itself remains implementation-agnostic.

Before finalizing:

- resolve material architectural questions
- explicitly state non-goals
- assign stable acceptance criterion IDs
- ensure the desired user/data/logic/failure behaviour is internally consistent

## Stage 2 — Blueprinting

Produce `2_BLUEPRINT.md`.

This stage requires deliberate repository inspection.

Perform the original blueprinting concerns as internal passes:

### Pass A — Core definition
Identify primary ownership/files and logical changes.

### Pass B — Dependency discovery
Trace imports, callers, consumers, state/data paths, persistence, and other collateral effects.

### Pass C — Verification assessment
Inspect existing tests and determine required verification for each changed behaviour/file.

### Pass D — Finalization
Consolidate core + collateral scope, API Delta Ledger, verification mapping, constraints and discovered deviations.

These are analytical passes, not separate conversational turns.

If repository discovery contradicts the architecture materially, return to Stage 1 rather than compensating silently in the Blueprint.

## Stage 3 — Implementation planning

Produce `3_IMPLEMENTATION_PLAN.md`.

Perform the original planner concerns:

1. group work into mission-oriented phases
2. decompose phases into coherent atomic tasks
3. classify task criticality
4. assign validation tier
5. define scope and file responsibilities
6. carry forward relevant API deltas
7. define task-level acceptance criteria
8. define deterministic verification
9. identify cross-task dependencies
10. define final integration verification

Every Blueprint create/modify/delete file must be accounted for by at least one task.

Every Architectural Report acceptance criterion must be traceable through Blueprint verification into one or more implementation tasks or the final integration gate.

## Handoff to coding harness

The Implementation Plan is the final planning-side artifact.

For each task, the coding harness must:

1. select the next ready task
2. inspect current repository state
3. materialize a frozen Task Contract from that task
4. implement
5. run deterministic verification
6. invoke independent review against the Task Contract and actual diff
7. repair and repeat until pass or escalation
8. mark the task complete
9. continue

After all tasks pass, run the final integration review defined in the Implementation Plan.

## Plan change rule

The coding harness may refine implementation detail.

It may not silently change:

- task objective
- architectural intent
- acceptance criteria
- public API contract
- scope in a way that changes architecture
- compatibility promises
- validation tier

A material conflict must be recorded as a planning deviation and escalated back to planning.
