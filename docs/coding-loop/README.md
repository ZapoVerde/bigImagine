# Coding Loop — Planning Side

This directory defines the planning artifacts produced before work is handed to the coding harness.

The structure deliberately follows the refined NetballNotepad AI factory:

1. **Architectural Report** — why the change exists and what behaviour must result.
2. **Blueprint** — what the repository actually contains, what files/contracts are affected, and how the change can be verified.
3. **Implementation Plan** — the ordered, atomic work schedule consumed by the coding harness.
4. **Architectural Diagnosis** — optional front-end artifact for bugs or unclear failures.

The coding harness is responsible for turning each Implementation Plan task into its own frozen Task Contract before coding begins. The planning side does not create Work Cards.

## Core rule

Each artifact answers a different question:

- **Architectural Report:** Why / desired system behaviour.
- **Blueprint:** What changes in the existing repository.
- **Implementation Plan:** In what order, with what boundaries and verification.
- **Task Contract (coding harness):** What exactly this one coding iteration must satisfy.

Do not collapse these questions into one document.

## Standard flow

```text
Human + Planning AI
        |
        v
Architectural Report
        |
        v
Repository inspection
        |
        v
Blueprint
        |
        v
Implementation Plan
        |
        | handoff
        v
Coding Harness
        |
        v
Task Contract -> Code -> Tests -> Independent Review -> Repair/Pass
```

For a bug whose cause is not yet established:

```text
Observed Problem
      |
      v
Architectural Diagnosis
      |
      v
Architectural Report
      |
      v
Blueprint
      |
      v
Implementation Plan
```

## Planning invariants

- Planning must be grounded in the actual repository before the Blueprint is finalized.
- Architectural intent is not allowed to drift during repository discovery.
- Every affected file must have a stated reason for changing.
- Public API changes must be explicitly recorded.
- Testing requirements are part of the plan, not an afterthought.
- Core and collateral changes must be distinguished.
- Implementation tasks must be independently completable and reviewable.
- Critical work receives a higher validation tier.
- The coding harness may discover implementation details, but it must not silently redefine a task's goal or acceptance criteria.
