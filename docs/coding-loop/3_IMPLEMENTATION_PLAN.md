# Implementation Plan

> Purpose: turn the finalized Blueprint into an ordered set of independently implementable and independently reviewable coding tasks.
>
> This is the handoff artifact for the coding harness. Each task contains enough information for the harness to materialize a frozen Task Contract before coding begins. Do not create a separate Work Card during planning.

## 1. Mission Summary

Summarize the implementation mission in 2–5 sentences.

Reference the governing Architectural Report and Blueprint as the source of intent and repository scope.

## 2. Validation Classification

Use the following criticality rubric.

A task is **Critical** if it materially touches one or more of:

1. shared state ownership
2. core business/domain logic
3. high fan-out interfaces or modules
4. canonical domain models/schemas
5. I/O, persistence, concurrency, or cross-process/thread behaviour
6. authentication, authorization, secrets, or security boundaries

Assign:

- **Tier 1 — Basic:** low-risk/config/presentation/test-only work.
- **Tier 2 — Standard:** normal feature logic with bounded impact.
- **Tier 3 — Critical:** any task matching the criticality rubric or otherwise carrying meaningful architectural risk.

Validation tier describes review rigor, not coding difficulty.

## 3. Implementation Phases

Group tasks into phases with explicit mission-oriented names.

A phase represents a coherent intermediate system state.

Do not create phases solely because files are in different directories.

---

# Phase 1 — [Mission Title]

**Phase objective:**  
Describe the meaningful system state established by this phase.

**Phase completion condition:**  
State what must be true before proceeding.

## Task 1.1 — [Concrete Task Title]

### Objective

State one coherent implementation outcome.

### Architectural Intent

Explain how this task contributes to the Architectural Report.

### Scope

**Create:**
- `path/to/file`

**Modify:**
- `path/to/file`

**Delete:**
- None

**Expected but unchanged dependencies:**
- `path/to/dependency`

The coding harness must treat this scope as authoritative unless repository inspection during execution proves it inaccurate.

### Required Logical Changes

For each changed file:

#### `path/to/file`

- current responsibility relevant to this task
- required new responsibility/behaviour
- important integration points
- required public API delta, if any
- compatibility behaviour that must be preserved

Do not prescribe incidental implementation syntax unless the Blueprint established a hard contract.

### Acceptance Criteria

Use task-local IDs.

- **T1.1-AC01:** ...
- **T1.1-AC02:** ...

Every criterion must be independently judgeable by the later reviewer.

### Verification

**Automated:**
- exact targeted tests/checks expected
- typecheck/build/lint where applicable

**Runtime/manual (if applicable):**
- explicit behaviour to verify

### Constraints & Anti-Patterns

List task-specific prohibitions.

Examples:

- no unrelated refactor
- do not change persistence schema
- preserve legacy key format
- use existing abstraction X rather than introducing another owner

### API Delta

Copy the relevant finalized Blueprint entries, or state:

`None.`

### Validation

- **Tier:** Tier 1 / Tier 2 / Tier 3
- **Criticality:** Critical / Not Critical
- **Reason:** cite the applicable rubric item(s) or explain the bounded risk

### Task Completion Boundary

State the exact stable point at which this task can be considered complete and the next task can safely begin.

---

Repeat the task format for every task in the phase.

Repeat phases until the complete Blueprint file manifest is covered.

## 4. Cross-Task Dependency Ledger

Record dependencies where one task relies on a contract or behaviour established by another.

| Task | Depends on | Dependency |
| --- | --- | --- |
| `2.1` | `1.2` | New exported interface exists |
| `3.1` | `2.2` | Migration completed |

Tasks without dependencies should not be artificially chained.

## 5. Final Integration Verification

After all individual tasks pass their task-level verification and independent review, the coding harness must perform a final integration gate against the complete plan.

### Required checks

- full relevant test suite
- project typecheck/build
- lint/static checks as applicable
- review full branch diff for unrelated changes
- confirm every Architectural Report acceptance criterion is satisfied
- confirm every Blueprint file is accounted for
- confirm every API Delta matches the finalized Blueprint
- confirm no task-level repair silently changed later task assumptions

### Final Review Inputs

The integration reviewer must receive:

1. Architectural Report
2. finalized Blueprint
3. Implementation Plan
4. full implementation diff
5. deterministic verification results

The final question is:

**Did the completed implementation faithfully deliver the original architectural intent across the whole change?**

This is separate from task review, whose question is:

**Did this task satisfy its frozen Task Contract?**
