# Final Integration Review Protocol

> Purpose: after every task in an Implementation Plan has individually passed its Task Contract review, determine whether the completed change works correctly as an integrated whole — not merely whether each task satisfied its own frozen contract in isolation.

Task-level review answers: **did this task satisfy its frozen Task Contract?**

This gate answers a different question: **did the completed implementation faithfully deliver the original architectural intent across the whole change?**

A plan where every task passed review can still fail this gate. Task review judges one frozen contract against one diff; it does not re-verify that the seams between tasks actually agree with each other, or that a task's assumption about unchanged code was correct.

## 1. Trigger condition

Run this gate once, after the last task in the Implementation Plan reaches task completion under `CODING_HARNESS.md` §9. Do not run it early, and do not let it substitute for any individual task's independent review.

## 2. Required inputs

The integration reviewer must receive:

1. `1_ARCHITECTURAL_REPORT.md`
2. the finalized `2_BLUEPRINT.md`
3. `3_IMPLEMENTATION_PLAN.md`, including the Cross-Task Dependency Ledger
4. the full implementation diff for the whole plan, not per-task slices
5. every task's deterministic verification results
6. every task's independent review outcome (PASS record, and any findings that were repaired)

Prior task reviews are evidence that a task satisfied its own contract. They are not proof that the plan integrates correctly — treat them as input, not as a substitute for independent inspection.

## 3. Method

Perform these passes. They are analytical passes, not separate conversational turns.

### Pass A — Acceptance criteria coverage

Walk every Architectural Report acceptance criterion. Confirm it is actually satisfied by the finished repository state, not merely that some task claimed to address it.

### Pass B — Cross-task seam verification

Independently re-inspect every row in the Cross-Task Dependency Ledger, and any additional cross-task seam discovered in the finished implementation that the ledger did not record. For each one, confirm the producing task and the consuming task actually agree on the contract between them (data shape, state semantics, identifiers, success/failure states, ordering, error behaviour). Do not accept that a seam is sound just because both tasks individually passed review — each task review only had visibility into its own frozen contract, and the ledger itself may be incomplete.

### Pass C — Unchanged-dependency check (inward)

For every new or modified consumer, identify the unchanged code it now depends on (producers, persistence, existing APIs). Inspect that unchanged code directly and confirm its actual behaviour matches what the new code assumes. A task-level review may have stayed inside its own diff; this pass exists specifically to catch the case where changed code's assumption about unchanged code is wrong.

This is investigation scope, not flagging scope: do not report unrelated pre-existing defects in that unchanged code. Do report a mismatch between what it actually does and what the new code assumes it does — that mismatch is a defect in the change.

For each consumed state or persisted value, this means inspecting every materially distinct outcome the producer can actually leave behind — success, failure, fallback/fail-open, disabled, absent, interrupted — not only its schema and its normal-path outcome. A consumer that correctly parses a schema-valid value is still wrong if the producer can leave behind a valid-but-unexpected value the consumer never accounts for.

This pass checks one direction only: does the changed code correctly understand the unchanged things it consumes? Pass D checks the other direction.

### Pass D — Blast-radius / contract preservation (outward)

Pass C asks whether changed code correctly understands what it depends on. This pass asks the reverse: do unchanged consumers still correctly understand the things we changed?

```text
             unchanged producer
                    ↓
         [ changed implementation ]
                    ↓
             unchanged consumer
```

Check both arrows. This pass checks the lower one.

For each materially changed file, exported symbol, persistence shape, API, shared state owner, or UI ownership boundary:

1. Inspect one level outward: what existing code depends on this changed code (direct callers, importers, consumers of the data/state it produces).
2. Identify the contracts that existed before the change: function/API shape, return semantics, persistence/schema expectations, ordering, lifecycle, error/fallback behaviour, side effects, ownership/responsibility, responsive/UI reachability where relevant.
3. Where the changed contract has bounded fan-out, inspect all direct callers/consumers and confirm those contracts still hold. Where fan-out is large, inspect at least one consumer from every distinct consumer class or usage pattern, plus any consumer the Blueprint names explicitly.
4. If the changed code intentionally alters an existing contract, confirm the Blueprint/API Delta explicitly authorizes it, and that every affected consumer was updated.

Follow one additional hop where the changed contract has meaningful fan-out or a shared abstraction is involved (for example `api/types.ts`, a shared cache schema, a state store, a router, or a central UI container can break code that doesn't appear in the feature diff at all). Do not perform an unlimited repository audit — expand only along concrete dependency edges from the plan diff; don't wander the repo.

The purpose is to detect regressions caused by changing a shared contract even when the changed implementation is locally correct. Examples:

- a return value changed from nullable to absent;
- an ordering guarantee changed;
- a shared state owner stopped emitting an update another component relies on;
- a UI container was removed and a secondary control became unreachable;
- a database row now represents different semantics than an existing consumer assumes;
- an API field or fallback meaning changed without updating all callers.

### Pass E — Verification audit

Passing tests and deterministic checks are evidence, not authority. For verification tied to a material acceptance criterion, cross-task seam, fallback path, or compatibility promise, check what the assertion actually encodes against the Architectural Report's intended behaviour. A test that passes while encoding the wrong expected behaviour is a finding, not a pass.

### Pass F — Adversarial consistency

Actively try to falsify the plan's integration assumptions rather than confirming them. Examples of the kind of question to ask:

- Does the producer actually persist what a consumer now queries for?
- Are "requested," "enabled," "succeeded," and "actually applied" being treated as equivalent when they aren't?
- Does declared fallback behaviour actually run when the preferred path is unavailable?
- Can a code path exist but never be reached from any entry point?
- Are cancellation and error paths symmetrical with the happy path across the task boundary?
- Did a later task's repair silently invalidate an earlier task's assumption?

Follow concrete evidence only. Do not invent hypothetical defects that have no realistic trigger.

When concluding that a cancellation, interruption, or error path is handled, identify the concrete entry point that triggers it (the actual event, exception, abort signal, or unmount) and trace execution from that entry point to cleanup. Do not infer cancellation/interruption handling from happy-path cleanup alone — the two can diverge (AbortController signals, socket/stream teardown, transaction rollback, and component unmount are common places this happens).

### Pass G — Regression and scope scan

Review the full plan diff for changes not accounted for by any task, and for behaviour the Blueprint identified as needing preservation. Confirm every Blueprint file is accounted for and every API Delta matches what was actually shipped.

For every component, control, or ownership boundary removed or relocated by the plan, enumerate the responsibilities it previously carried and confirm each required responsibility has a valid replacement in the finished implementation, or was intentionally dropped by the Architectural Report. A relocation that preserves the primary behaviour can still silently drop a secondary responsibility (a switch, a shortcut, a fallback trigger) that had no line of its own in the diff to draw attention to it.

Also confirm that relocated ownership was not duplicated unintentionally: a responsibility should not remain active in both the old and new owner unless the Architectural Report explicitly requires dual ownership.

## 4. Before flagging something

Be certain. Investigate before flagging — trace the realistic execution path and confirm the actual consequence.

Distinguish:

- a defect introduced by this change, or a seam the plan got wrong — this is a finding;
- a pre-existing defect merely observed while inspecting unchanged dependencies — this is not a finding, unless it makes the change itself unsafe or the acceptance criteria unreachable.

Do not flag style preference, speculative future improvement, or work explicitly deferred to a later plan.

## 5. Output

Return one of:

### PASS

No material integration failure found. The completed implementation delivers the Architectural Report's intent across the whole change.

### FINDINGS

One or more concrete findings, each tied to:

- an Architectural Report acceptance criterion;
- a Cross-Task Dependency Ledger entry;
- a Blueprint file or API Delta; or
- a material regression introduced by the plan diff.

Each finding states: the defect, the governing requirement it violates, file:line evidence, the realistic scenario that triggers it, and the consequence.

Any confirmed violation of an explicit acceptance criterion, Blueprint requirement, compatibility promise, or required-and-not-authorized-to-drop responsibility is a finding, regardless of whether the reviewer judges it central to the feature. Severity may be recorded as Minor. Severity does not determine whether something is reported as a finding.

## 6. Escalation

If a finding is clearly attributable to one completed task, and repairing it does not alter architecture, acceptance criteria, API contracts, or task ownership, open a repair iteration governed by that task's original frozen contract plus the integration finding. The task contract itself stays frozen — this is a new iteration against it, not a reopening of it. Rerun the affected deterministic verification and this gate afterward.

If a finding reveals that the Blueprint or Implementation Plan itself was wrong — not just the implementation — do not patch around it in code. Record a Planning Deviation and return to planning.

Do not weaken or reinterpret an acceptance criterion to make a finding disappear.
