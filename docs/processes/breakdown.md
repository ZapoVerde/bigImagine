# Breakdown Approach

## Purpose

BigImagine keeps source files small and single-purpose to maintain a healthy documentation-to-code ratio.

Every source file should have a structured preamble that accurately describes its role, public API, contracts, ownership, and boundaries. That works best when the file is small enough for the preamble to meaningfully describe the code beneath it.

As files grow, documentation becomes coarse, responsibilities blur, and more behaviour depends on implicit context.

The 300-line budget is therefore a pressure toward clear module boundaries and useful local documentation, not a target for arbitrary slicing.

## When to Break a File Down

Break down a file when it:

- approaches or exceeds 300 lines
- contains multiple responsibilities
- has distinct comment-delimited sections
- mixes unrelated domains or architectural roles
- requires understanding unrelated code for small changes
- has a preamble that can no longer describe the whole file precisely

## Breakdown Process

### 1. Map Responsibilities

Read the file as a set of responsibilities.

Look for fault lines in:

- section comments
- public exports
- data models
- settings families
- providers or external systems
- database tables
- pipelines or lifecycle stages
- groups of imports

Do not start by dividing the file into 300-line chunks.

### 2. Split by Reason to Change

Code belongs together when it changes for the same reason.

If two sections usually change independently, they should probably be separate modules.

Prefer domain boundaries over UI layout, historical placement, or superficial similarity.

### 3. Preserve Stable Boundaries

If a large file is widely imported, keep it as a thin façade where that reduces churn.

The façade may re-export implementation from smaller modules, but must not accumulate new implementation.

### 4. Make the First Pass Structural

The first pass should preserve behaviour.

Do not combine breakdown work with:

- API redesign
- renaming
- validation changes
- SQL changes
- new abstractions
- performance tuning
- unrelated cleanup

Target:

> Same behaviour, clearer ownership.

### 5. Extract One Domain at a Time

For each domain:

1. identify its responsibility
2. identify required imports
3. identify public exports
4. move the code
5. preserve exported names
6. re-export through the façade if needed
7. typecheck and test
8. continue

Keep the repository working after each extraction.

### 6. Re-evaluate the Result

After the first split, inspect the new modules again.

If a module is still too large, look for another real fault line.

Common second-level splits include:

- parsing vs IO
- CRUD vs import/export
- configuration vs diagnostics
- orchestration vs execution
- sync settings vs recall settings vs prompt settings

Do not split coherent code merely to satisfy line count.

## Architectural Roles

Each resulting module should move toward one architectural role:

- **Pure Function** — parsing, validation, mapping, derivation
- **Stateful Owner** — sole owner of bounded runtime state
- **IO Wrapper** — database, filesystem, network, provider, or settings IO
- **Orchestrator** — sequences other modules without owning state or performing direct IO

The first structural split does not need to solve every mixed-role module. Preserve behaviour first, then refine boundaries where needed.

## Avoid

Do not replace one large file with:

- arbitrary 300-line slices
- one-file-per-helper fragmentation
- generic dumping grounds such as `helpers.ts`, `utils.ts`, or `common.ts`
- broad caller rewrites when a façade can preserve compatibility

The unit of decomposition is a responsibility, not a function.

## Definition of Done

A breakdown is successful when:

- each module has one clear purpose
- its preamble accurately describes the code beneath it
- unrelated responsibilities no longer share one file
- public behaviour remains unchanged
- compatibility is preserved where useful
- dependencies are clearer
- modules fit the project size budget or have an obvious reason not to
- future changes require less unrelated context

## Working Rule

> Map responsibilities → identify fault lines → extract coherent domains → preserve stable boundaries → validate → split deeper only where necessary.