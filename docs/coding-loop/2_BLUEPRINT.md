# Blueprint

> Purpose: translate the Architectural Report into a repository-grounded definition of **what must change**.
>
> The Blueprint is file-centric and evidence-based. It defines scope, contracts, dependencies, collateral effects, and verification requirements. It should not become a line-by-line coding recipe.

## 1. Repository Findings

Summarize the existing implementation discovered during repository inspection.

Include:

- current ownership of relevant behaviour
- important call/data paths
- existing abstractions that should be reused
- discrepancies between initial assumptions and actual code
- existing tests covering the affected area

This section exists to prove that planning is grounded in the repository rather than inferred from filenames or architecture alone.

## 2. Core Scope & Changes

For every primary file that must change:

---

### File: `path/to/file`

**Current responsibility:**  
Describe what the file owns today.

**Required logical change:**  
Describe what must become different after implementation.

**Reason this file is core:**  
Explain why this file directly implements the Architectural Report rather than merely adapting to another change.

**API Delta Ledger:**

For every changed exported/public contract:

- **Symbol:** `symbolName`
- **Before:** `existing signature/contract`
- **After:** `required signature/contract`
- **Reason:** why the public contract must change

If no public contract changes:

`None.`

---

Repeat for every core file.

## 3. Dependency Discovery

Trace the consequences of the core changes through the repository.

For each discovered dependency, classify it:

- **Collateral modification** — must change to remain compatible.
- **Verification-only** — does not change, but must be exercised by tests/checks.
- **Inspected / no change** — relevant dependency deliberately confirmed unaffected.

### Discovered File Manifest

| File | Classification | Why it is affected |
| --- | --- | --- |
| `path/to/file` | Collateral modification | ... |
| `path/to/file` | Verification-only | ... |
| `path/to/file` | Inspected / no change | ... |

## 4. Collateral Changes

For every collateral modification:

### File: `path/to/collateral-file`

**Current responsibility:**  
...

**Fixing logic required:**  
Describe the compatibility/adaptation change made necessary by the core work.

**API Delta Ledger:**  
Record public deltas using the same Before/After format, or state `None`.

## 5. Complete API Delta Ledger

Consolidate every public API change from core and collateral files.

If none:

`No public API changes.`

## 6. Verification Assessment

Assess every modified file and every meaningful behaviour introduced or changed.

### File Verification

| File | Verification requirement | Reason |
| --- | --- | --- |
| `path/to/source.ts` | Add/update targeted unit tests | New domain logic |
| `path/to/view.tsx` | Existing integration coverage + manual/UI check | Presentation-only change |

### Behaviour Verification

Map Architectural Report acceptance criteria to concrete verification.

| Acceptance Criterion | Verification method |
| --- | --- |
| `AC-01` | `path/to/test` — named scenario |
| `AC-02` | Typecheck + integration test |
| `AC-03` | Runtime/manual verification |

Do not invent tests solely to satisfy a format. State when existing coverage is sufficient and why.

## 7. Complete File Manifest

### Create
- ...

### Modify
- ...

### Delete
- ...

### Inspected but deliberately unchanged
- ...

## 8. Blueprint Constraints & Risks

Record implementation-relevant constraints discovered from the repository.

Examples:

- compatibility requirements
- ordering dependencies
- migration constraints
- concurrency/state hazards
- legacy behaviour that must be preserved
- areas the coder must not refactor incidentally

## 9. Discovery Deviations

Record any material difference between the Architectural Report's assumed system shape and the actual repository.

For each deviation state:

- assumption
- repository reality
- impact on the Blueprint
- whether the architectural intent remains valid

If repository discovery invalidates the architectural intent, stop planning and return to the Architectural Report instead of silently redesigning the feature here.
