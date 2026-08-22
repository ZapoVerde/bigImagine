# Coding Harness

> Purpose: execute one Implementation Plan task at a time without allowing architectural intent or acceptance criteria to drift during coding.
>
> The planning artifacts define **why**, **what**, and **in what order**. The coding harness materializes one frozen **Task Contract**, implements only that contract, verifies it deterministically, invokes independent review, repairs findings, then advances to the next ready task.

## 1. Governing inputs

Before coding begins, read the current planning artifacts for the change:

1. `1_ARCHITECTURAL_REPORT.md`
2. `2_BLUEPRINT.md`
3. `3_IMPLEMENTATION_PLAN.md`
4. `0_ARCHITECTURAL_DIAGNOSIS.md`, if one exists and is relevant

The Implementation Plan is the execution schedule. The Architectural Report and Blueprint remain governing context and are used to resolve ambiguity without redefining the task.

The harness must not create a parallel Work Card system. The frozen Task Contract below is the execution artifact for one coding iteration.

## 2. Task selection

Select the next ready task from the Implementation Plan.

A task is ready when:

- all tasks listed as dependencies are complete;
- its required repository state exists;
- no unresolved planning deviation blocks it.

Do not combine adjacent tasks merely because they touch the same files. Do not skip ahead to convenient later work.

If the Implementation Plan tasks are too large to implement and review coherently, stop before coding and report that further planning decomposition is required.

## 3. Pre-contract repository check

Before freezing the Task Contract, inspect the current repository state relevant to the selected task.

Confirm:

- files listed in task scope still exist where expected;
- stated owners/integration points are materially correct;
- dependencies established by earlier tasks are present;
- relevant tests and verification commands still exist;
- the task can be completed without changing its architectural objective or acceptance criteria.

Repository inspection may refine implementation detail. It may not silently change architectural intent.

If repository reality materially contradicts the plan, record a **Planning Deviation** and stop before coding.

A Planning Deviation is required when execution would otherwise change any of:

- task objective;
- Architectural Report intent;
- acceptance criteria;
- public API contract;
- compatibility promise;
- validation tier;
- scope in a way that changes architecture or ownership.

## 4. Frozen Task Contract

Create the Task Contract immediately before implementation and freeze it for the duration of that coding iteration.

Use exactly this format:

```markdown
# Task Contract — <task id>: <task title>

## Source

- Implementation Plan: `docs/.../3_IMPLEMENTATION_PLAN.md`
- Task: `<task id>`
- Validation Tier: `Tier 1 | Tier 2 | Tier 3`
- Criticality: `Critical | Not Critical`

## Objective

<copy the task objective faithfully; clarify wording only where repository inspection resolved a non-material implementation detail>

## Architectural Intent

<carry forward the task's architectural intent and any directly governing Architectural Report constraints>

## Frozen Scope

### Create
- `<path>`

### Modify
- `<path>`

### Delete
- `<path>`

### Expected but unchanged dependencies
- `<path>`

Any scope correction discovered during the pre-contract repository check must be recorded here with a short reason. A correction that changes architecture requires a Planning Deviation instead of proceeding.

## Required Logical Changes

### `<path>`
- <required responsibility/behaviour>
- <integration points>
- <required API delta, if any>
- <compatibility behaviour that must be preserved>

## Acceptance Criteria

- **<task AC id>:** <criterion>
- **<task AC id>:** <criterion>

Acceptance criteria are frozen. Implementation and review are judged against these exact criteria.

## Verification Contract

### Automated
- `<exact targeted test/check/command>`

### Runtime / Manual
- <explicit behaviour to verify, or `None`>

## Constraints & Anti-Patterns

- <task-specific prohibition>
- no unrelated refactor
- no opportunistic scope expansion

## API Delta

<copy the task API Delta exactly, or `None.`>

## Completion Boundary

<copy the task's Task Completion Boundary faithfully>

## Repository Observations

Record only execution-relevant facts discovered during the pre-contract inspection that do not change the frozen goal, for example:

- exact symbol or caller location;
- existing helper to reuse;
- test file actually covering the behaviour;
- harmless path correction.

Do not place new requirements here.
```

The Task Contract is derived from the selected Implementation Plan task. It is not an opportunity to redesign the task.

## 5. Implementation

Implement only the frozen Task Contract.

During implementation:

- inspect surrounding code before editing;
- reuse existing ownership and abstractions where the plan requires them;
- keep collateral changes limited to what is necessary to satisfy the contract;
- preserve stated compatibility behaviour;
- do not pre-implement later tasks;
- do not perform unrelated cleanup or refactors.

If implementation reveals a material conflict with the frozen contract, stop and record a Planning Deviation rather than silently changing the contract.

## 6. Deterministic verification

Run the Verification Contract before requesting review.

Record:

- commands/checks executed;
- pass/fail result;
- any required runtime/manual observations;
- any verification item that could not be run and the concrete reason.

A task is not ready for independent review merely because the code compiles or the agent believes it is complete.

If deterministic verification fails, repair within the frozen contract and rerun verification before review.

## 7. Independent review

Independent review is mandatory for every completed Task Contract.

The reviewer must receive:

1. the frozen Task Contract;
2. the actual task diff / current working-tree changes relevant to the task;
3. deterministic verification results;
4. relevant repository context needed to judge the contract.

The reviewer must independently inspect the repository and must not rely solely on the implementer's summary.

The review question is:

**Did this implementation satisfy the frozen Task Contract without introducing material regressions or violating its stated constraints?**

The reviewer must return one of:

### PASS

No material contract failure found.

### FINDINGS

One or more concrete findings, each tied to:

- an Acceptance Criterion;
- Required Logical Change;
- Verification Contract;
- API Delta;
- explicit constraint; or
- material regression introduced by the task diff.

Do not create findings for personal style preference, speculative future improvement, or work belonging to a later task.

## 8. Repair loop

If review returns FINDINGS:

1. return the findings to the implementer;
2. repair only within the frozen Task Contract;
3. rerun affected deterministic verification;
4. invoke independent review again against the same frozen Task Contract;
5. repeat until PASS or escalation.

Do not weaken or rewrite Acceptance Criteria to make a finding disappear.

If a finding reveals that the frozen contract itself is materially wrong, stop and raise a Planning Deviation.

## 9. Task completion

A task is complete only when:

- all Acceptance Criteria are satisfied;
- required deterministic verification passes, or an explicitly accepted limitation is recorded;
- independent review returns PASS;
- the Task Completion Boundary is reached;
- no unresolved Planning Deviation remains.

Only then mark the Implementation Plan task complete and select the next ready task.

## 10. Final integration gate

After every task in the Implementation Plan has passed its Task Contract review, perform the plan's Final Integration Verification as defined in `FINAL_INTEGRATION_REVIEW.md`.

This gate does not replace task-level review. It exists because task-level review only judges one frozen contract against one diff; it does not re-verify that the seams between tasks agree with each other, or that a task's assumption about unchanged code was correct.

## 11. Harness invariants

These rules are non-negotiable:

- one frozen Task Contract per implementation task;
- no coding before the Task Contract is materialized;
- no silent architectural drift;
- no self-declared completion without deterministic verification;
- independent review is required before task completion;
- review findings repair the implementation, not the contract;
- later-task work is not pulled forward for convenience;
- unresolved material conflicts return to planning rather than being improvised in code.
