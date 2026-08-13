# BigImagine — Roles: Claude Code and Reasonix

*How planning, implementation, and review are divided between the two agents working on this codebase.*

---

## The Split

**Claude Code plans and reviews. Reasonix implements.**

- **Claude Code** writes the implementation plan, then — once Reasonix has built it — reviews the resulting code and tests: checks edge cases, confirms coding conventions (`conventions.md`) and principles (`bi_principles.md`) are followed, and judges whether the implementation actually matches the plan's intent.
- **Reasonix** takes the plan and implements it, including the tests that exercise it.

Reasonix is the one writing code day to day. Claude Code's job is to make sure the plan is sound going in, and that what comes out the other side is correct, idiomatic, and doesn't quietly violate a principle.

---

## Fix Loop

When review finds a problem, the size of the fix decides who makes it:

- **Small issues** (typos, a missed edge case, a small convention violation) — Claude Code patches directly rather than round-tripping through a full plan cycle.
- **Deep or structural issues** (wrong approach, missing a principle at the design level, a fix that touches multiple files or changes the plan's shape) — Claude Code writes a repair doc and Reasonix implements it, same as the original plan.

In practice, deep repairs haven't been needed yet — review has stayed within small-patch territory so far. If that stops being true, revisit whether plans need to be more detailed going in, rather than treating repair docs as the default.

**Naming a repair doc**: file it as `docs/plans/<name>-repair.md`, not `-plan.md` — the suffix is
load-bearing, not cosmetic. A repair doc fixes one narrow, already-built thing; unlike a plan, it
has no lasting explanatory value once Reasonix implements it (the code + its commit is the record),
so once it's done it should be deleted rather than kept around. A `-plan.md` documents an
architectural decision and is worth keeping as reference even after it ships — don't delete those,
even once **implemented**. The `-repair.md` suffix is what makes a doc's disposable-once-done
status obvious at a glance instead of requiring a read.

---

## Why Reasonix Doesn't Implement Unsupervised

Reasonix has no GitHub access, so it can't push what it builds. **Reasonix commits** its own work locally once it's done implementing a plan — that's part of implementing the plan — but never pushes. **Claude Code pushes** that commit to the remote, since Reasonix has no GitHub access to do it itself. Push is also a natural checkpoint to hold at until review has passed — nothing reaches the remote until Claude Code has reviewed the result.

---

## Plan Template

Plans are written in prose and file references, not code. Reasonix reads the actual files at implementation time — a literal snippet in a plan can drift out of date between planning and implementation, and it invites copying something wrong instead of reasoning about the file as it actually is. Describe what must be true; let Reasonix write the code that makes it true. This is the same rule `bi_principles.md` applies to principles ("a principle is not a code recipe") applied one layer down, to plans.

The exception is **contracts** — anything another module depends on (an API request/response shape, a schema column, a function signature). Ambiguity there breaks callers, so that's the one place being code-precise is worth it.

```
## Goal
One or two sentences: what this achieves and why it's needed.

## Files
- `path/to/file.ts` — created | modified | deleted — one line on what changes and why
- ...
(Every file expected to be touched. If Reasonix finds an unlisted file needs to
change, that's a signal to stop and flag it back, not to silently expand scope.)

## Logic
Prose description of the behavior: what triggers it, what it does, what state
it reads or writes. Cover non-obvious cases explicitly — don't rely on "handle
errors appropriately" if there's a specific case that matters (concurrent
writes, empty results, a null owner, etc).

## Contracts
(Only where precision matters.) Exact shape of anything another module calls
or depends on — request/response, function signature, column name and type.

## Edge Cases
Explicit list of cases the implementation must handle, especially ones easy
to miss.

## Tests
What Reasonix's tests need to prove true, not how to write them.

## Out of Scope
What this plan deliberately does not touch.

## Principles / Conventions in Play
Reference specific sections of `bi_principles.md` or `conventions.md` that
bear on this plan, if any are non-obvious.
```

---

## What This Doc Doesn't Cover

- Merge/deploy authority — not yet defined here; add a section if that becomes ambiguous in practice.
