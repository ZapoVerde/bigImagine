# bigBrain — Module Conventions

*Companion to `bb_principles.md`. Principles say why; this says how.*

---

## Module Preamble

Every source file opens with this block, per `bb_principles.md` §9 (Every Module is Self-Describing):

```ts
/**
 * @file path/from/repo/root.ts
 * @stamp 2026-07-21
 * @architectural-role Orchestrator | Stateful Owner | IO Wrapper | Pure Function — one line on what it owns or does
 * @description
 * Prose: what this file is for, what it deliberately does not do, and why it's shaped the
 * way it is if that's not obvious from the code itself.
 *
 * @api-declaration
 * exportedThing(args) — what it does and any non-obvious contract on its caller
 *
 * @contract
 *   assertions:
 *     purity:          pure | impure (reason if impure)
 *     state_ownership: [] | [what this module is the sole owner of]
 *     external_io:     [] | [LLM, Postgres, Notion API, Gmail API, ...]
 */
```

`@stamp` updates only on an intentional architectural change — not on every edit.

## The Four Kinds of Code

Per `bb_principles.md` §8. Every file is exactly one:

1. **Pure Functions** — input in, derived output out. No IO.
2. **Stateful Owners** — the one place a given piece of runtime memory lives.
3. **IO Wrappers** — call the LLM, read/write Postgres, call Notion/Gmail/GitHub. Zero reasoning.
4. **Orchestrators** — sequence calls to the other three. Own no state. Do no direct IO.

If a file's `@architectural-role` can't be stated in one line, it's not designed clearly enough to write yet.

## File Size

300-line budget per `bb_principles.md` §10. Split along the fault line the preamble already implies.
