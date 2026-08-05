# Inline Prompt Macros — Staged Implementation Plan

*Created 2026-08-05, revised 2026-08-05. Governed by `bi_principles.md`; scoped against `spec.md`
§5 (The Agentic Interaction Loop), §7.3 (Triggeryze), and §7.4 (Context Stack Presets). Status:
**(Stage 1 partially live)** — see §1.1. Written in response to an assessment
of SillyTavern's `{{macro}}` system (`stacks/sillytavern/st-source/public/scripts/macros/`) as a
candidate to port.*

*Revision note: the first pass of this document rejected the `VARIABLE` macro category outright.
That was wrong to settle this early — Triggeryze is one of the three native plugins (`spec.md`
§7.1–7.3, alongside Canonize and Vistalyze) and its rule engine is explicitly the platform's
highly-nondeterministic layer, built to consume exactly this kind of mutable state. Variables
aren't off the table; they're staged behind Triggeryze's own design, below.*

---

## 1. What this is

SillyTavern resolves `{{char}}`, `{{time}}`, `{{setvar::x::y}}`, `{{random::a::b}}` and ~65 other
`{{...}}` macros **inline**, inside the text of any field, at render time. BigImagine currently has
no equivalent: `assemblePromptStack()` (`plugins/context-stack-presets/src/assemblePromptStack.ts`)
inserts whole slot values verbatim — a character's `description` or a preset's `custom` slot text
is never scanned for embedded placeholders.

This document lays out a staged path to adding that range, starting with the deterministic core
that has no open design questions, and pushing anything that depends on not-yet-built platform
pieces (Triggeryze's rule engine) to a later stage rather than deciding its shape now.

### 1.1 Implementation status

**Live (migration 0053, `plugins/context-stack-presets`):** the household's own persona — a name
and description, the BigImagine analogue of ST's `{{user}}`/`{{persona}}`. This landed *before* the
Stage 1 inline `{{...}}` engine below, and deliberately doesn't need it: `{{user}}` and `{{persona}}`
in ST are always whole-field lookups (nothing composes them with surrounding text in practice), so
the simplest correct version is a new **whole-slot marker**, not a text-scanning interpolation
pass. Concretely:

- `persona_name`/`persona_description` are two plain `orchestrator_settings` keys
  (`orchestrator/src/io/orchestratorSettings.ts`), set from the Settings tab's new "Persona"
  fieldset (`frontend/src/views/SettingsView.tsx`), admin-authed and read live, same no-restart
  shape as `household_timezone`.
- `'persona'` is a new `MarkerKey` (`assemblePromptStack.ts`), selectable in the Prompt Stack
  preset editor (`frontend/src/views/PromptStacksView.tsx`) exactly like `description`/`scenario`
  — an ordinary slot a preset can enable or omit, not a special case.
- `applyPromptStackToChatTool.ts` reads both settings live on every apply and folds them into
  `fields.persona` as `"{name}: {description}"` (or just whichever half is set) before calling
  `assemblePromptStack`. This deliberately does **not** touch `character.persona` — that column is
  the character card's own description field (confusingly named; maps to `fields.description`),
  orthogonal to the household's persona.

**Not yet live:** the actual inline `{{...}}` scanning engine Stage 1 describes below (`{{char}}`,
`{{trim}}`, etc., substituted *inside* arbitrary slot text) — nothing in the codebase scans a
string for `{{...}}` yet. `{{user}}`/`{{persona}}` are covered today only as whole-slot values, not
as tokens usable inside e.g. a custom slot's free text or a character's `scenario` field. That gap
is exactly what Stage 1 below still closes.

---

## 2. The mechanism: turn-scoped resolution, not per-read evaluation

**Every macro resolves once, at the top of the turn, against a frozen snapshot of that turn's
scene state — never re-evaluated per character, per slot, or per read within the same turn.**

This applies at every stage below, including the variable stage. It falls directly out of two
things already true of the platform:

- **§4 (scoped by explicit scene state):** a turn's scene state — active characters, location,
  presence, approved canon — is fixed the moment the Director Pass reads it (`spec.md` §5 step 2).
  Nothing about "now" should change mid-turn just because macro resolution happened to run twice.
- **§17 (the assembler is a pure function of scene state) + the caching rationale in step 3:** a
  multi-character scene turn calls the LLM once per speaking character, and the whole point of the
  fixed-order static prefix is that it's **byte-identical across every one of those calls** so a
  caching-capable provider only pays full price once. If a macro re-resolved on every character's
  call, the "static" prefix would silently stop being static, and the cache discount `spec.md` §5
  step 3 depends on would silently stop applying — with no error to signal it (exactly the failure
  mode §17's own text warns about).

Concretely: macro resolution is a pass that runs **once**, immediately after the Director Pass
(`spec.md` §5, between steps 2 and 4), producing a plain key→value snapshot for that turn. That
snapshot is what every macro reference reads, for every character generated in that turn. The
snapshot itself is derived data, not new canonical state (`bi_principles.md` §1): it's discarded at
the end of the turn, never written back to the relational store *by the assembler*. (Stage 3 below
introduces a case where the underlying data the snapshot is *read from* does get written back — but
never by the assembly pass itself. See §3.3.)

For macros that are already deterministic given `fields` (name lookups, text transforms), this
mechanism is invisible — resolving once or resolving five times produces the same string either
way. It has visible teeth wherever "now" can change between calls: time, randomness, and variables.

---

## 3. Staged rollout

### Stage 1 — Deterministic core (build first)

**Categories:** `NAMES`, `CHARACTER`, `UTILITY` — `{{char}}`, `{{user}}`, `{{persona}}`,
`{{description}}`, `{{scenario}}`, `{{trim}}`, `{{reverse}}`, `{{newline}}`, `{{noop}}`.

Pure lookups and text transforms against the `fields` object `assemblePromptStack` already
receives — no new data source, no timing sensitivity, no open design question. The full version of
this stage is a single interpolation pass that scans a slot's text for `{{...}}` and substitutes
from `fields`, run before `assemblePromptStack(fields, slots)`, keeping the assembler itself
untouched and still a pure function per §17. Ships the mechanism (§2) and the parser/substitution
engine that every later stage reuses — nothing here is thrown away when Stage 2 or 3 lands.

`{{user}}`/`{{persona}}`'s *data source* (the household persona settings) and their *whole-slot*
form already shipped ahead of the rest of this stage — see §1.1. What's left of Stage 1 is the
actual `{{...}}`-scanning engine, which subsumes that whole-slot form as one case (a slot whose
entire text is a single `{{persona}}` token) rather than replacing it.

### Stage 2 — Turn-scoped snapshot (time, randomness)

**Categories:** `TIME`, `RANDOM` — `{{time}}`, `{{date}}`, `{{isodate}}`, `{{weekday}}`,
`{{idleDuration}}`, `{{random::a::b}}`, `{{roll::2d6}}`, `{{pick::...}}`.

These need the actual turn-scoped snapshot from §2, not just the Stage 1 substitution engine: a
value computed once (clock read, RNG roll) at turn start, frozen, then read identically by every
character generated in that turn. This is where the snapshot data structure gets built for real,
since Stage 1 didn't need one. Once this lands, Stage 3's reads slot into the same snapshot without
changing its shape.

### Stage 3 — Variables (gated on Triggeryze)

**Category:** `VARIABLE` — `{{setvar}}`, `{{getvar}}`, `{{incvar}}`, `{{hasvar}}`,
`{{setglobalvar}}`, and counterparts.

Not rejected — deferred, because its correct shape depends on a plugin that doesn't exist yet.
`spec.md` §7.3 already names Triggeryze as the rule engine whose `trigger_condition` evaluation
(`evaluate_rules`, run in the loop's background-evaluation step, `spec.md` §5 step 4) is the
platform's designated highly-nondeterministic layer — rules that read counters and flags, and
whose *effects* are exactly "set a value," "increment a value," conditionally. That's the same job
ST's `{{setvar}}`/`{{getvar}}` do; the question isn't whether BigImagine needs mutable scoped state,
it's where the write happens.

The one constraint carried over from the original assessment, and the reason this is staged behind
Triggeryze rather than shipped as a standalone macro pair: **the write can never happen inline,
during prompt assembly.** `{{setvar::x::y}}` in ST fires wherever the text happens to be scanned —
that's a mutation with no attribution and no gate, which is what conflicted with §15 (canon needs
approval), §16 (injected context must be attributable), and §17 (no side effects during assembly).
Routing the write through Triggeryze's own governed path removes that conflict entirely, using the
same pattern `status_effects` already uses (`apply_status_effect`/`clear_status_effect`, always
explicit, always in the background step, never inline text):

- **Storage:** a relational table Triggeryze owns (scene-scoped and/or global, mirroring ST's
  local/global split) — not free text embedded in a prompt.
- **Writes:** only from `evaluate_rules`' own tool calls (e.g. a `set_variable`/`increment_variable`
  tool, symmetric with `apply_status_effect`), running in the background-evaluation step, after the
  turn's reply — never during assembly, never triggered by inline `{{setvar}}` text.
  Every write is attributable to the rule that made it, satisfying §16.
- **Reads:** once that table exists, `{{getvar}}`/`{{hasvar}}` become ordinary Stage-2-style
  snapshot entries — read once at turn start alongside `{{time}}`/`{{random}}`, frozen for the
  turn, no different in kind from any other snapshot value. This is the only piece that's really a
  "prompt macro" in the ST sense; the write half of the feature belongs to Triggeryze's design, not
  to this document.

**This stage starts once Triggeryze's rule engine and its trigger-condition schema are designed**
(tracked as not-yet-built per `spec.md` §7.3/§8) — building the read-only macro half first would
mean guessing at a storage shape this document isn't positioned to settle.

### Out of scope (not staged, not reconsidered)

- **`CHAT`** (`{{lastMessage}}`, message-id macros) — `assemblePromptStack` already receives
  `recent_history` as one pre-rendered slot (`spec.md` §7.4); message-level macros assume a flat
  per-message array the assembler deliberately doesn't expose.
- **`STATE`/`PROMPTS`** (`{{model}}`, `{{maxContext}}`, `{{lastGenerationType}}`) — leans on
  provider-specific facts the platform is supposed to stay decoupled from (§6). No plugin depends
  on this the way Triggeryze depends on variables, so there's no forcing function to revisit it.

---

## 4. Where the resolution pass lives

Not yet designed in code, but its shape is constrained by what already exists, across all three
stages:

- It runs **before** `assemblePromptStack(fields, slots)`, not inside it — the assembler stays a
  pure function of its two arguments per §17; it must not itself do string-scanning/interpolation
  keyed off external state like the clock, an RNG, or the variables table.
- It produces the turn-scoped snapshot described in §2 (trivial at Stage 1, real at Stage 2, backed
  by Triggeryze's table at Stage 3), then does a single interpolation pass over every string in
  `fields` (and over `custom` slot content) before handing the result to `assemblePromptStack`.
  That interpolation step is itself a pure function: `(fields, snapshot) => fields'`, snapshot
  supplied by the caller, no IO, no clock reads, no RNG calls, no DB reads inside it.
- Whatever resolves the turn's scene state today (`spec.md` §7.4 notes this caller doesn't exist
  yet — `assemblePromptStack` currently has "no caller in the actual turn loop") is the natural
  owner of building the snapshot, since it already sits at the point in the loop (`spec.md` §5,
  between steps 2 and 4) where scene state is read once per turn. At Stage 3 that same caller reads
  Triggeryze's variables table as part of building the snapshot — it still only reads; the writes
  live in `evaluate_rules`, downstream, in the background step.

---

## 5. Open questions

- Exact snapshot shape (flat string map vs. typed record) — deferred until the turn-loop caller
  that was already flagged as not-yet-built in `spec.md` §7.4 actually gets written.
- Triggeryze's variable schema (scene-scoped vs. global, typed vs. string-only, per-character) —
  belongs to Triggeryze's own design pass, not this document; Stage 3 above is intentionally
  written to not presuppose it.
- Whether `{{roll}}`/`{{random}}` results, and Stage-3 variable writes, should be visible anywhere
  in the Inspector Canvas (so a dice roll or a rule-driven counter change is auditable) — likely
  yes, per §11's observability bar, but not scoped here.
- Custom macro registration (ST allows extensions to register their own) is out of scope — not
  requested, and every current BigImagine plugin (Canonize, Vistalyze, Triggeryze) already has a
  structured way to inject content that doesn't need a text-macro escape hatch beyond what's staged
  above.
