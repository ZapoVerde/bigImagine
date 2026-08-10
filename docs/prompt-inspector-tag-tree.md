# Technical Specification: Loss-Tolerant Prompt Tag Tree (Prompt Inspector)

**Status**: Designed — pending approval
**Scope**: A pure, loss-tolerant parser that groups the main prompt's subsections by the author's
own HTML-style tags, rendered as nested collapsible sections with per-section token counts in the
Prompt Inspector. Plus the (separately-approved) cache-coverage mapping onto the existing
byte-prefix diff.
**Personal build**: Built for a single user on their own `Comfy 2` preset. The parser must not
fail on that preset's real quirks — duplicate tag names, spaces in tag names, tags that span
multiple prompt-stack slots, nested trees, and intentionally broken/missing tags. It must degrade
to "content shows at the enclosing level" rather than erroring or hiding text.
**Governing Principles**: `bi_principles.md` §8 (Four Kinds of Code — the parser is a Pure
Function), §10 (300-line budget), §16 (bounded, attributable context — the tree never alters the
sent prompt), §17 (assembler purity untouched — this is a read-only view over the already-sent
text), §19 (mobile-first — nested sections must stay usable at phone width).

---

## 1. Overview & System Intent

The Prompt Inspector currently renders the Main Prompt as **one collapsed block** of the complete
sent text (`PromptInspectorPanel.tsx:140-152` — the "completely collapses" decision). The user's
`Comfy 2` preset is authored as a hierarchy of HTML-style tags:

```
---
All instructions after this line MUST supersede ...
<main_instructions> ... </main_instructions>
<earthy_physicality> ... </earthy_physicality>
<point_of_view> ... </point_of_view>
<character_behavior_and_memory_protocol> ... </character_behavior_and_memory_protocol>
<constraints>
  <language> ... </language>
  <naming_constraints> ... </naming_constraints>
  <No Deepity> ... </No Deepity>
</constraints>
...
<narrative_execution>          ← opens in one prompt-stack slot (pos 16)
  [recent_history content]     ← history sits between the pair
</narrative_execution>         ← closes in a later slot (pos 18)
```

The tag hierarchy is real structure, but it is **author-written prose**, not a contract the
platform controls. The parser must therefore treat every tag as *optional scaffolding*: a section
exists **only when both its open and close tags match**. Anything unmatched — a missing close, a
dangling close, a crossed pair, an unknown tag — is inert text that renders at the enclosing
level. Nothing is ever dropped, reordered, or hidden. This is the user's stated model: *"if the
tags are broken or missing, the summary just rolls back up to the next level up."* This spec makes
that roll-up the designed behavior, not an accident.

The tree is **display-only**: it is computed from the exact joined text the turn sent, never fed
back into the prompt or into any assembly path. `bi_principles.md` §17's pure-assembler contract
is untouched.

---

## 2. The Parser (`orchestrator/src/util/promptTagTree.ts`)

### 2.1 Role and placement

Pure Function, same category and home as `util/assemblePromptStack.ts` and
`util/interpolateMacros.ts` (pure text processing that outlives any single caller). Exported via
the package exports map (`./prompt-tag-tree` → `dist/util/promptTagTree.js`), consumed by the
frontend the same way plugins consume core utils (`@bigbrain/orchestrator/prompt-tag-tree`), and
gated by its own verify script in the orchestrator suite (`verify-prompt-tag-tree.mjs`), mirroring
`verify-assemble-prompt-stack.mjs`.

Rationale for core over `frontend/src/util/`: the frontend has no behavior-test harness — its only
gate is `tsc --noEmit` (`frontend/package.json`). This parser is exactly the kind of logic that
needs fixture-based verification (its whole job is graceful failure), and the repo's gate for that
is the orchestrator verify suite. It also keeps the door open for a future server-side consumer
(e.g. the cache diff computing section boundaries server-side) without a move.

### 2.2 Input

The main prompt's items joined with `\n\n` — byte-identical to the sent text
(`PromptInspectorPanel.tsx` already joins `group.items.map(i => i.content).join('\n\n')` for
"Copy all"). **Must run over the joined text, not per-item**: the user's `<narrative_execution>`
pair spans two slots with the history between them.

### 2.3 Tag token rules

Scan left-to-right with a single regex over the whole text:

- **Open candidate**: `<` name `>` where `name` = the text between the angle brackets, trimmed,
  with these rejections:
  - empty after trim;
  - starts or ends with whitespace in its raw form (kills prose like `a < b > c`, whose raw name
    is ` b `);
  - contains `<` or `>`;
  - ends with `/` (self-closing, e.g. `<br/>` — inert).
- **Close candidate**: `</` name `>` with the same name rules.
- **Canonical name** (used for matching): `name`, then — only if the raw name contains an `=` —
  cut at the first `=` and take the part before the whitespace preceding it. This makes the
  template-emitted `<memory turns="1">` blocks match their plain `</memory>` closes, while the
  user's `<inner thoughts>` / `<No Deepity>` (no `=` anywhere) keep their full spaced names.
  Example: `<memory turns="1">` → canonical `memory`; `<inner thoughts>` → canonical
  `inner thoughts`.

There is **no tag vocabulary/denylist**. `<details>`, `<summary>`, `<mira_seat>`, whatever the
user or a template emits — if both sides match, it is a section. Special-casing HTML tags would
be a second, contradictory contract; the roll-up rule already makes any of them harmless.

### 2.4 Matching — the roll-up contract

Maintain a stack of open frames `{name, start, children[]}`. Walk the tokens in order:

1. **Open `<X>`** → push `{name: X, start: tokenStart}`.
2. **Close `</X>`** → search the stack top-down for the nearest frame with canonical name X.
   - **Found**: pop every frame above it (those are *recovery-closed*: they are **not** sections —
     their text rolls up into X, exactly the crossed-pair case `<a><b></a></b>` where only `a`
     survives and `b`'s content sits inside it). Close X: its span is `[start, closeEnd)`; attach
     any sections that were completed inside it as its children; push the closed section onto the
     enclosing frame's (or root's) children.
   - **Not found**: dangling close — inert text, no effect.
3. **EOF**: every frame still on the stack is **not** a section (missing close → rolled up into
   its enclosing level; a top-level unclosed open rolls up into the root).

**Invariant — a section exists iff both its open and close tags matched.** Unmatched tokens remain
in the raw text of the enclosing section. The tree is a set of non-overlapping matched spans;
children are exactly the matched spans fully contained in a parent's span.

### 2.5 Data model

```ts
export interface PromptTagSection {
  /** Canonical tag name; empty only for the root. */
  name: string;
  /** Char offsets into the source text — [start, end) of the full span, tags included. */
  start: number;
  end: number;
  /** Direct children in document order. */
  children: PromptTagSection[];
}

export function parsePromptTagTree(text: string): PromptTagSection;
```

- Root = the whole text (`name: ''`, `start: 0`, `end: text.length`), always present. A prompt
  with no matched tags yields root-only → the panel renders exactly today's single block. Graceful
  degradation is the default state.
- Each section's content is the **raw slice** `text.slice(start, end)` — original bytes including
  tag lines and nested sections' text. The UI renders a section's own text as the slice minus its
  children's spans, with children as nested collapsibles, so no text is duplicated or lost.
- Per-section `chars = end - start`; `estimatedTokens = ceil(chars / 4)` — the server's existing
  heuristic (`httpServer.ts:408-410`), applied client-side so headers reconcile with the panel's
  totals (same ≤1-token-per-section over-report the per-item display already accepts).
- **Losslessness invariant (tested)**: walking the tree in document order — root own-text, then
  each child recursively — reproduces the input byte-for-byte.

### 2.6 Worked examples against the live `Comfy 2` preset

| Input (from the live DB) | Tree result |
|---|---|
| `<main_instructions>…</main_instructions>` | one root child |
| `---` preamble, `All instructions…` line | root own-text (untagged) |
| pos 3 slot: two sibling blocks in one slot | two root children |
| `<constraints>` > `<language>`/`<naming_constraints>`/`<No Deepity>` | one section, three children (space tag name works) |
| `<internal thinking>` (Comfy 2's outer tag — renamed from `<inner thoughts>` to break the same-name collision) containing a `<details><summary>` example that re-opens `<inner thoughts>` inside it | nearest-close matching: the example's own `<inner thoughts>` (and `<details>`/`<summary>`) become nested child sections — matched, not garbled. Nested same-name tags would have worked too (kept as a synthetic fixture) |
| `<narrative_execution>` … `</narrative_execution>` spanning pos 16 → history → pos 18 | one matched section wrapping the history text |
| `<a><b></a></b>` | only `a` is a section; `b`'s text inside `a`; trailing `</b>` inert |
| `<x>` with no close before EOF | no section; text at root |
| `</y>` with no open | inert text |

Every case preserves all text; the only variable is *which level* it displays at.

---

## 3. Panel Rendering (`frontend/`)

### 3.1 Behavior

- The Main Prompt group renders through `parsePromptTagTree(joinedText)`: the root stays the
  top-level "Main Prompt" collapsible; each matched section is a nested `<details>` with:
  - the tag name as its label (`<inner thoughts>` shown as `inner thoughts`),
  - an `N tk · M ch` badge (same style as today's item badges),
  - indentation per depth (mobile-safe: a single indent step, `padding-left`, no horizontal
    scroll — `bi_principles.md` §19),
  - children rendered recursively inside.
- **Default collapsed state**: outermost sections collapsed (the "completely collapses" behavior
  the user asked for originally, now per-section), matching today's main-prompt default.
- Token totals in the panel header stay unchanged (sum over root content).
- The other groups (cleanup, title, …) are untouched — the tree is a Main-Prompt feature.

### 3.2 Cache-coverage badges (companion change, implemented)

Maps the recorded byte diff onto sections. The server diffs the **last fired** `main` trace entry
against the **one before it** — both are bytes recorded at send time (`io/promptTrace.ts`), so
the diff is deterministic; no live reconstruction is involved. `buildPromptPreview` emits on the
main group:

- `stablePrefixChars` = length of the longest common prefix (UTF-16 code units, the same unit as
  the tag-tree's section offsets — no conversion) of the two joined items texts.
- `previousCallAt` = epoch ms of the previous fired `main` entry, for the legend.
- Both are **omitted when fewer than two `main` entries are on record** (fresh chat, or trace
  lost to restart — in-memory by design, `promptTrace.ts:18-23`): the panel then shows no cache
  badges at all, exactly as before this change.

Coverage rule:

- A section is **cache-covered** iff `section.end <= stablePrefixChars` — the section and
  everything upstream of it is byte-identical to the previous call ("any words in it or upstream
  have changed" is exactly `section.end > stablePrefixChars`; a prefix cache cannot replay past
  the first differing byte, so everything downstream of an edit is changed too).
- Badge per section: `⚡ cached` (covered) / `✎ changed` (not covered). The root "untagged text"
  block is badged by the max end of its own-text runs; the no-tags fallback "Complete prompt
  text" block by the whole text length. A one-line legend (with `previousCallAt` in local time)
  sits above the tree when badges are shown.
- Honest labeling: coverage is an *estimate* of provider prefix-caching; Anthropic connections
  cache nothing today (the adapter sends no `cache_control`) — the badge set shows that fact.
  Coverage describes the diff between the two recorded calls, the only deterministic ground
  truth the server has without real cache instrumentation (which does not exist yet).

No live-flip UX question remains: the diff never involves the live reconstruction, so the Main
Prompt group keeps preferring the captured last turn unchanged.

---

## 4. Files

| File | Change |
|---|---|
| `orchestrator/src/util/promptTagTree.ts` | **new** — Pure Function parser (§2), preamble per `conventions.md` |
| `orchestrator/package.json` | add `"./prompt-tag-tree"` to `exports`; append `verify-prompt-tag-tree.mjs` to the `verify` chain |
| `orchestrator/scripts/verify-prompt-tag-tree.mjs` | **new** — fixtures from §2.6 + losslessness invariant + determinism (same input ⇒ same tree) |
| `frontend/package.json` | add `"@bigbrain/orchestrator": "*"` dependency (first frontend→core import; same mechanism plugins use) |
| `frontend/src/components/promptInspector/PromptInspectorPanel.tsx` | render main group through the tree (§3.1) |
| `frontend/src/components/promptInspector/PromptInspectorPanel.css` | nested-section styles (indent, depth badge) |

Phase 2 (implemented): `orchestrator/src/util/commonPrefix.ts` (**new** — pure
`longestCommonPrefixLength`), `orchestrator/scripts/verify-common-prefix.mjs` (**new** — LCP +
coverage-rule assertions, wired into the verify chain), `orchestrator/src/server/httpServer.ts`
(main group gains `previousCallAt`/`stablePrefixChars`), `frontend/src/api/types.ts` mirror,
`PromptInspectorPanel.tsx`/`.css` (badges + legend).

## 5. Out of Scope (deliberately)

- **No server/DB changes for the parser itself.** The tree is computed client-side from data the
  preview endpoint already returns (`PromptPreviewItem.content` per item).
- **No change to what is sent to the model.** The tree is a read-only view; §17 stays intact.
- **No tag editing/authoring surface.** This spec only groups; authoring lives in Prompt Stacks
  today.
- **No real cache instrumentation** (recording provider cache-hit tokens). Phase 2 is the
  *estimate* path; capturing actual hits is a separate change (adapter + `llm_calls` column) and
  deliberately not bundled.
- **Memory-component inner tags** (`<mira_seat>`, `<memory turns>` blocks from the CNZ templates)
  are handled *by* the generic parser, not special-cased: attribute-stripped names make the
  `<memory>` blocks match, `<mira_seat>` pairs match directly, and any mismatch rolls up.

## 6. Verification

- `verify-prompt-tag-tree.mjs` fixtures: §2.6's twelve cases verbatim from the live preset's
  content, plus the losslessness invariant (§2.5) and a determinism check.
- `npm run verify` (root) stays green — the new script joins the existing chain; frontend
  `tsc --noEmit` gates the panel changes.
- Manual: open the Prompt Inspector on a live RP chat with the `Comfy 2` preset; confirm the tree
  matches §2.6, all text is present under some section, and phone-width rendering doesn't scroll
  horizontally.
