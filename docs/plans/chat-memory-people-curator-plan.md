# Chat-memory People Curator Plain-Text Conversion

Standalone chunk of the chat-memory structured-output migration (see
`docs/plans/chat-memory-structured-output-plan.md` for the migration's overall shape, and
`docs/plans/chat-memory-world-curator-plan.md` — Chunk 3, already implemented — for the
transport/parser pattern this chunk follows). Kept as its own document for the same reason the
world-curator chunk was: self-contained scope, and the parent plan is already long.

This is **Chunk 4**. Chunks 1 (classifier), 2 (bridge), and 3 (world curator) are done and green.
This chunk must not regress any of them.

## Goal

Replace the forced `curate_people` tool call in:

`orchestrator/src/io/chatMemory/curatePeople.ts`

with ordinary text completion plus a local parser, while preserving the existing BI return type:

```ts
export interface PeopleCuratorEntryDraft {
  action: 'update' | 'new' | 'duplicate';
  name: string;
  content?: string;
  appearance?: string;
  duplicateOf?: string;
}
```

Nothing downstream changes. BI still owns person identity, SQL/canon writes, transient/permanent
state, portrait integration, and sync rollback. The only thing changing is the LLM wire format.

This follows the same transport pattern already implemented for chunk summary, bridge, and world
curation.

The important BI-specific constraint is that `appearance` remains a **separate field** because
Portrait Studio consumes it independently. The rest of the person card remains one markdown
`content` block.

---

## 1. Preserve the existing people-curator logic

Do **not** rewrite `DEFAULT_PEOPLE_CURATOR_PROMPT`.

Keep all of its existing behavioural rules:

* every named person gets a living record
* exactly two-word names
* never create an entry for `{{user}}`
* Appearance is stable and physically inherent
* Personality is fixed at creation
* Core Misread is fixed at creation
* Connections tracks structural relationship + current tone
* Relationship with `{{user}}` stores persistent state, not event recap
* Goals contain one major + three minor goals
* duplicate detection remains
* updates only happen on meaningful change
* existing Appearance / Personality / Core Misread are reproduced exactly

That prompt is already the tuned Canonize-derived part worth preserving.

---

## 2. Add a plain-text output contract

Append an explicit output section to the default prompt.

For NEW and UPDATE, return the **whole card**, including Appearance:

```text
OUTPUT FORMAT — follow exactly.

For a new person:

**NEW: [Two Word Name]**

## Appearance
[Physical appearance treatment.]

## Personality
[Existing required format.]

## Core Misread
[Existing required format.]

## Connections
| Person | Relation | Tone |
|--------|----------|------|
...

## Relationship with {{user}}
[Persistent relationship state.]

## Goals
Major: ...
Minor: ...
Minor: ...
Minor: ...

For an existing person that needs changing:

**UPDATE: [Exact Existing Two Word Name]**

## Appearance
[Reproduce exactly.]

## Personality
[Reproduce exactly.]

## Core Misread
[Reproduce exactly.]

## Connections
...

## Relationship with {{user}}
...

## Goals
...

For a redundant person entry:

**DUPLICATE: [Exact Redundant Two Word Name]**
Duplicate of: [Exact Primary Two Word Name]

If nothing needs changing, output exactly:

NO CHANGES NEEDED
```

This is deliberately close to Canonize's actual card format.

The parser then separates `## Appearance` back out into BI's dedicated `appearance` field.

Do **not** invent:

```text
Appearance: ...
Content: ...
```

That would make the model generate an artificial serialization format solely because BI has two
internal fields. Better to let the LLM produce the natural person card it already understands,
then split it deterministically.

---

## 3. Remove the forced-tool transport

### Modify

`orchestrator/src/io/chatMemory/curatePeople.ts`

Remove:

* `ToolDefinition` import
* `curatePeopleTool`
* `PeopleCuratorToolResponse`
* `isPeopleCuratorResponse`
* `forceTool`
* `turn.toolCalls`
* `'Answer by calling curate_people...'`

The call becomes:

```ts
const turn = await llm.complete(
  [
    { role: 'system', content: instructions },
    { role: 'user', content: userMessage },
  ],
  [],
);
```

Then:

```ts
return parsePeopleMemoryOutput(turn.message.content);
```

`curatePeople()` continues returning:

```ts
Promise<PeopleCuratorEntryDraft[]>
```

No caller change. (Confirmed: `chatMemorySync.ts:997-999` calls `curatePeople(sync.llm,
transcriptText, existingBlock, sync.personaName, sync.peopleCuratorPrompt)` and only consumes the
returned array's `content`/`appearance`/`duplicateOf` — nothing there depends on tool-call
transport.)

---

## 4. Create the parser

### Create

`orchestrator/src/io/chatMemory/parsePeopleMemoryOutput.ts`

Export:

```ts
export interface ParsedPeopleMemoryEntry {
  action: 'update' | 'new' | 'duplicate';
  name: string;
  content?: string;
  appearance?: string;
  duplicateOf?: string;
}

export function parsePeopleMemoryOutput(
  raw: string,
): ParsedPeopleMemoryEntry[]
```

Keep it standalone initially.

Even though world and people now both use `NEW / UPDATE / DUPLICATE`, don't refactor them into a
generic parser during this chunk unless the duplication is obviously trivial after implementation.
World blocks have `Category:` metadata; people blocks contain structured markdown sections. Their
semantic parsing is different enough that premature sharing buys little.

---

## 5. Normalisation

Use the same input tolerance as the Bridge and World parsers (mirror `normalize()` in
`parseWorldMemoryOutput.ts:51-60`):

```text
raw
→ CRLF to LF
→ trim
→ strip one enclosing markdown fence
→ trim
```

Exact:

```text
NO CHANGES NEEDED
```

returns:

```ts
[]
```

Do not accept arbitrary prose such as:

```text
There were no meaningful changes.
```

Do not repair malformed headings or guessed person names.

---

## 6. Parse block boundaries

Recognize only:

```text
**NEW: Name**
**UPDATE: Name**
**DUPLICATE: Name**
```

Everything before the first recognized block must be empty after normalization, unless the entire
response is the no-change sentinel.

Everything inside a NEW/UPDATE block belongs to that person until the next recognized top-level
block.

Require a non-empty name.

### Naming validation

The prompt requires exactly two words.

Enforce that here — it's already an explicit hard contract in the existing curator, and BI uses
the name as identity.

Accept:

```text
Elena Valcieri
Queen Elara
Guard Renn
```

Reject:

```text
Elena
Elena Maria Valcieri
Elena (Doctor)
```

Don't mechanically restrict letters to ASCII; names may legitimately contain apostrophes or
non-English characters.

The rule is **two whitespace-separated tokens**, not `[A-Za-z]+ [A-Za-z]+`.

> **Scope note — new validation, not preserved validation.** The forced-tool schema this chunk
> replaces (`curatePeopleTool` in the current `curatePeople.ts`) does **not** enforce word count —
> `isPeopleCuratorResponse` only checks that `name` is a string and `action` is a valid enum. So
> this rule is a **new** hard-failure gate, not a carried-over one. Combined with §12's
> whole-response-failure policy, a sync tick that today would silently write a slightly-off name
> (three words, a parenthetical, whatever the model happens to emit) will, after this chunk ships,
> hard-fail the *entire* people-curator pass for that tick. That's a deliberate tightening — turning
> a documented-but-previously-unenforced prompt contract into an enforced one — and it's the right
> call given BI uses the name as identity. But it is a production behavior change beyond "same
> contract, new wire format," so land it as a conscious decision: watch the first few real syncs
> after deploy for an uptick in `curate_people` step failures, not just parser unit-test green.

---

## 7. NEW / UPDATE section parsing

A valid person block must contain, in order:

```text
## Appearance
## Personality
## Core Misread
## Connections
## Relationship with <resolved user name>
## Goals
```

There is one important implementation detail here:

`{{user}}` is interpolated **before the prompt is sent**. The output may therefore contain:

```text
## Relationship with Jeremy
```

rather than literally:

```text
## Relationship with {{user}}
```

So the parser should **not** depend on the actual user's name.

Recognize the relationship heading structurally as:

```text
## Relationship with ...
```

and preserve the entire heading/body in `content`.

That keeps the parser independent of `userName`.

---

## 8. Extract Appearance separately

For NEW/UPDATE:

Capture everything after:

```text
## Appearance
```

until:

```text
## Personality
```

Trim it and assign:

```ts
appearance
```

Require it to be non-empty.

Do **not** include the `## Appearance` heading in the resulting `appearance` string — the existing
forced tool describes `appearance` as the treatment itself, separate from `content`, so body-only
is the correct equivalent (confirmed: `curatePeopleTool`'s `appearance` parameter description reads
"The physical-appearance treatment for this entry," no heading wrapper).

The remaining sections:

```text
## Personality
...
## Core Misread
...
## Connections
...
## Relationship with ...
...
## Goals
...
```

are retained together, headings included, as:

```ts
content
```

That reproduces the existing BI contract: Appearance separated, everything else still one markdown
document.

---

## 9. Validate required sections

For both NEW and UPDATE require exactly one of each:

* `## Appearance`
* `## Personality`
* `## Core Misread`
* `## Connections`
* `## Relationship with ...`
* `## Goals`

Require them in that order.

Reject:

* missing section
* duplicate section
* wrong order
* empty Appearance
* empty Personality
* empty Core Misread
* empty Relationship section
* empty Goals

### Connections special case

An empty relationship table may be legitimate for a character who has no named connections yet.

So don't require a data row.

But require the section body to contain the expected table structure:

```text
| Person | Relation | Tone |
|--------|----------|------|
```

That prevents a malformed person card from being accepted while still allowing zero connections.

> **Implementation note.** Don't match this byte-for-byte — models vary pipe/dash spacing (`|---|`
> vs `|------|`, extra padding spaces). Match structurally: a header row starting with `| Person`
> and containing `Relation` and `Tone`, followed by a separator row of `|` and `-` characters. Pick
> a specific tolerant regex during implementation rather than treating the literal block above as
> the exact string to require — that's a conscious implementer judgment call, not an oversight to
> leave ambiguous.

---

## 10. Don't over-validate prose semantics

Do **not** write code that checks:

* Personality has exactly 3–5 axes
* Core Misread has exactly 1–2 sentences
* Relationship has 2–4 sentences
* Goals really contain philosophically independent ambitions
* prose is third-person present tense

Those are model-quality rules.

The parser's job is structural integrity, not natural-language grading.

There is one possible exception:

### Goals shape

The prompt explicitly requires:

```text
Major:
Minor:
Minor:
Minor:
```

Validate this minimally because it is a very stable structured part of the card.

Require:

* one `Major:` line
* exactly three `Minor:` lines

Do not judge their content beyond non-empty values.

That preserves a guarantee the tool schema could not itself enforce, but the existing prompt
clearly treats as part of the card contract.

> **Scope note — this is also new, not preserved, validation.** Same caveat as §6: the current
> forced-tool schema has no concept of a Goals sub-structure at all; `content` is an opaque string
> to it. This rule and the two-word-name rule (§6) are the **only two** new hard gates this chunk
> introduces — both are deliberate, both are called out here so the decision is visible rather than
> buried in parser code, and both should be watched the same way after deploy.

---

## 11. DUPLICATE parsing

Recognize:

```text
**DUPLICATE: Redundant Name**
Duplicate of: Primary Name
```

Require:

* redundant name is exactly two words
* target name is non-empty
* target name is exactly two words
* no person-card body follows

Return:

```ts
{
  action: 'duplicate',
  name: 'Elena Vale',
  duplicateOf: 'Elena Valcieri'
}
```

No `content`.

No `appearance`.

---

## 12. Whole-response failure

Use the same policy as the implemented World Curator chunk (`parseWorldMemoryOutput.ts`'s
`parseBlock`/paragraph-count check is the concrete precedent to mirror):

> one malformed block fails the entire response.

Do not silently keep three valid characters and discard one broken one.

For example:

```text
**UPDATE: Elena Valcieri**
[valid]

**NEW: Guard Renn**
[missing Appearance]
```

must fail the people-curator stage.

That is especially important here because silently losing one person's update could leave
relationship/canon state internally inconsistent.

BI's transaction/sync machinery remains responsible for rollback and boundary progression
(`chatMemorySync.ts`'s `step('curate_people', ...)` / `step('upsert_people', ...)` pair — unchanged
by this chunk, see §14).

---

## 13. Existing-content preservation test

This chunk needs one test that the World chunk didn't.

The prompt explicitly says on UPDATE:

* Appearance unchanged
* Personality unchanged
* Core Misread unchanged

The parser cannot determine whether the model followed that instruction unless it has the previous
card, and `parsePeopleMemoryOutput()` should remain pure and context-free.

So **do not add comparison logic to the parser**.

Instead keep that as prompt behaviour.

The existing downstream/current-card logic remains unchanged.

If later you want deterministic enforcement of immutable sections, that's a separate hardening
change where `curatePeople()` could compare parsed UPDATEs to the supplied `existingEntries`. Do
not mix it into this transport migration.

---

## 14. Exact files touched

### Modify

```text
orchestrator/src/io/chatMemory/curatePeople.ts
```

### Create

```text
orchestrator/src/io/chatMemory/parsePeopleMemoryOutput.ts
```

### Modify tests

```text
orchestrator/scripts/verify-chat-memory-text-parsers.mjs
orchestrator/scripts/verify-chat-memory-sync.mjs
```

### Do not touch

```text
orchestrator/src/orchestrator/chatMemorySync.ts
orchestrator/src/orchestrator/personCuratorAppearance.ts
orchestrator/src/io/chatMemory/curateWorldMemory.ts
orchestrator/src/io/llm/types.ts
orchestrator/src/io/llm/openaiCompatible.ts
db/migrations/*
```

Confirmed by reading `chatMemorySync.ts:988-1044`: `upsert_people` only requires a non-empty
`content` string and reads `appearance` independently for the frozen-once-set write-back (writes
only when the matching `characters` row's own `appearance` is still empty) — neither depends on
`content`'s internal structure, so no production code there needs to change.

`APPEARANCE_SECTION_RULE` remains exactly where it is
(`orchestrator/src/orchestrator/personCuratorAppearance.ts`) and continues being interpolated into
the prompt.

---

## 15. Parser tests

Add to:

`orchestrator/scripts/verify-chat-memory-text-parsers.mjs`

Required cases:

1. `NO CHANGES NEEDED` → `[]`
2. valid NEW person
3. valid UPDATE person
4. valid DUPLICATE
5. multiple people
6. mixed NEW + UPDATE + DUPLICATE
7. CRLF accepted
8. enclosing markdown fence accepted
9. surrounding whitespace accepted
10. Appearance body extracted without heading
11. remaining content begins at `## Personality`
12. all remaining headings preserved
13. relationship heading works with an arbitrary interpolated username
14. missing Appearance → fail
15. empty Appearance → fail
16. missing Personality → fail
17. missing Core Misread → fail
18. missing Connections → fail
19. missing Relationship → fail
20. missing Goals → fail
21. sections out of order → fail
22. duplicate section heading → fail
23. Connections header-only table → valid
24. malformed Connections table → fail
25. missing Major goal → fail
26. fewer than three Minor goals → fail
27. more than three Minor goals → fail
28. one-word person name → fail
29. three-word person name → fail
30. duplicate missing target → fail
31. duplicate carrying person-card content → fail
32. malformed block among valid blocks → whole response fails
33. output object keys exactly match `PeopleCuratorEntryDraft` — mirror
    `verify-chat-memory-text-parsers.mjs:449-457`'s pattern for the world parser
    (`Object.keys(x).sort().join(',') === '...'`): for NEW/UPDATE, expect
    `'action,appearance,content,name'`; for DUPLICATE, expect `'action,duplicateOf,name'`.

That is enough coverage without attempting to test prose quality.

---

## 16. Sync integration test changes

### Modify

`orchestrator/scripts/verify-chat-memory-sync.mjs`

The fake backend now needs to identify **four** plain-text callers: classifier, bridge, world
curator, people curator. This section previously under-specified the mechanics; the three edits
below are all required and are each independently easy to miss (the world-curator chunk hit exactly
this class of miss and had to spell it out explicitly — do the same here):

**a) Add a routing branch, before the generic fallthrough, not after.**

The tool-free routing block currently at `verify-chat-memory-sync.mjs:570-602` checks
`sys.includes('NARRATIVE CHRONICLER')`, then `sys.includes('LOREBOOK CURATOR')`, and anything that
matches neither falls through to `return oaiTextResponse(\`Summary[${content}]\`)` — the
classifier's canned reply. Without an explicit people-curator branch inserted **before** that
fallthrough, people-curator calls (system prompt contains `PEOPLE CURATOR`, not `LOREBOOK CURATOR`
or `NARRATIVE CHRONICLER`) will silently receive the classifier's fake summary text instead of a
person card, and fail the new strict parser with a confusing "missing Appearance section" error
rather than a legible routing bug. Add:

```js
if (sys.includes('PEOPLE CURATOR')) {
  return oaiTextResponse(
    backend.curatePeopleOverride ??
      `**UPDATE: Existing Person**
## Appearance
...
## Personality
...
## Core Misread
...
## Connections
| Person | Relation | Tone |
|--------|----------|------|

## Relationship with ...
...
## Goals
Major: ...
Minor: ...
Minor: ...
Minor: ...

**NEW: New Person**
...`,
  );
}
```

before the `return oaiTextResponse(\`Summary[${content}]\`)` line. Use a complete valid person card
(all six sections, correctly ordered) so the real parser gets exercised, not a stub.

**b) Remove the forced-tool fake.**

Remove the `case 'curate_people':` branch from the `switch (forceTool)` block
(`verify-chat-memory-sync.mjs:609-619`).

**c) Add an `isPeopleCuratorCall` helper and wire it into both existing filters that break.**

Add, next to `isBridgeCall`/`isWorldCuratorCall` (`verify-chat-memory-sync.mjs:702-718`):

```js
function isPeopleCuratorCall(c) {
  return (
    c.options.forceTool === undefined &&
    (c.messages.find((m) => m.role === 'system')?.content ?? '').includes('PEOPLE CURATOR')
  );
}

function peopleCuratorCalls() {
  return llm.calls.filter(isPeopleCuratorCall);
}
```

Then update, by name, both existing call sites that assumed only three tool-free callers — do not
just add the helper and assume it's covered:

* `summarizeCalls()` (`verify-chat-memory-sync.mjs:728-729`): currently
  `llm.calls.filter((c) => c.options.forceTool === undefined && !isBridgeCall(c) &&
  !isWorldCuratorCall(c))`. Change to add `&& !isPeopleCuratorCall(c)`.
* The connection-lock assertion (`verify-chat-memory-sync.mjs:1345`): currently
  `namedCalls.filter((c) => c.options.forceTool === undefined && !isBridgeCall(c) &&
  !isWorldCuratorCall(c)).length === 2`. Left as-is, this silently becomes wrong once people joins
  the tool-free pool for that tick. Add the same `&& !isPeopleCuratorCall(c)` exclusion.

**d) Convert `backend.curatePeopleOverride`'s two existing usages from a tool-response object to a
plain-text card string.**

`curatePeopleOverride` is currently a `{ entries: [...] }` object, used at two sites:

* The default fake reply (`verify-chat-memory-sync.mjs:610-619`) — covered by (a) above.
* The appearance-write-back edge-case test (`verify-chat-memory-sync.mjs:1202-1208`), which
  currently sets `curatePeopleOverride` to an object with three entries whose `content` is a stub
  like `'**Personality:** wary.'`. That stub will fail the new strict section-order parser (no
  Appearance/Core Misread/Connections/Relationship/Goals sections). This test must be rewritten so
  `curatePeopleOverride` becomes a single plain-text string containing three full, valid
  `**NEW: ...**` blocks (one per entry: `Mira Vale`, `Unknown Stranger`, `Garrick Stone`), each with
  all six sections, in order — while preserving the test's actual assertions: an exact
  case-insensitive name match writes appearance onto a blank `characters` row (`Mira Vale`), a
  matching row whose appearance is already non-empty is never overwritten (`Garrick Stone`'s
  `## Appearance` body must be present but the assertion afterward still expects the *original*
  `'A heavyset old soldier.'` to survive), and a name with no matching `characters` row still
  inserts its `canon_facts` row (`Unknown Stranger`).

---

## 17. Integration assertions

Prove:

* people-curator request sends no tools
* `forceTool` absent
* `{{user}}` is still interpolated in the sent prompt
* NEW maps to the same proposed person/canon path
* UPDATE maps to the same existing-person update path
* `appearance` lands in the same dedicated field used today
* remaining person-card markdown lands in `content`
* duplicate handling remains unchanged
* malformed people output causes the sync step to fail (mirror the world-curator FAIL test at
  `verify-chat-memory-sync.mjs:1155-1184`: assert `last_status === 'error'` and
  `last_step === 'curate_people'`, and assert zero `canon_facts` rows of category `person` land for
  that chat from that pass — not even a well-formed block preceding the bad one)
* malformed people output does not advance the closed sync boundary
* world/bridge/classifier tool-free routing remains correctly distinguished from people (i.e. all
  four of `isBridgeCall`, `isWorldCuratorCall`, `isPeopleCuratorCall`, and "none of the above ⇒
  classifier" partition the tool-free calls with no overlap — this is what §16(c) exists to keep
  true)

The existing sync/canon code should need no production modification.

---

## 18. Prompt override regression

The people prompt is configurable.

As with the implemented world-curator chunk, check the live stored override before deployment.

An old bespoke prompt may still say:

```text
call curate_people
```

Do not automatically mutate arbitrary stored prompt text.

If the live override is blank/default, nothing to do.

If one exists, deliberately convert it to the new raw-text output contract before deployment.

This check has to happen against the live settings store at deploy time — it isn't something this
plan can resolve by reading source (same caveat the world-curator plan's §13 gave for its own
prompt override).

---

## Acceptance criteria

* `curatePeople.ts` no longer contains `ToolDefinition`, `forceTool`, `toolCalls`, or
  `curate_people` transport logic.
* People curation uses ordinary text completion.
* The existing tuned people-curator behaviour remains intact.
* The model emits a natural full person card rather than an artificial BI serialization format.
* `parsePeopleMemoryOutput.ts` deterministically separates `## Appearance` into `appearance` and
  preserves the remaining card as `content`.
* Exactly-two-word naming remains enforced — understood as a *new* enforced gate, not a carried-over
  one (§6), and watched post-deploy accordingly.
* Required person-card structure is validated, including the Goals major/minor shape — also a *new*
  gate (§10).
* `NO CHANGES NEEDED` returns an empty result.
* A malformed person block fails the whole people-curator response.
* SQL/canon/Portrait Studio code remains untouched.
* The fake sync backend correctly distinguishes all four tool-free memory callers, with the
  fallthrough-ordering, `summarizeCalls()`/connection-lock exclusion, and `curatePeopleOverride`
  format conversion from §16(a)–(d) all done, not just the new helper added.
* Chunks 1–3 remain green.
* Scope ends here; **do not include `distillChatMemory.ts` in this chunk.**
