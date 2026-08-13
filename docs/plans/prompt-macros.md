# Inline Prompt Macros — Staged Implementation Plan

*Created 2026-08-05, revised 2026-08-06. Governed by `bi_principles.md`; scoped against `spec.md`
§5 (The Agentic Interaction Loop), §7.3 (Triggeryze), and §7.4 (Context Stack Presets). Status:
**(Stage 1 live)** — see §1.1 and §4. Written in response to an assessment
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
`{{...}}` macros **inline**, inside the text of any field, at render time. BigImagine's own Stage 1
subset of that range is now live (§1.1) — `assemblePromptStack()`
(`plugins/context-stack-presets/src/assemblePromptStack.ts`) still inserts whole slot values
verbatim, tokens included, but `orchestrator/src/util/interpolateMacros.ts` scans an RP chat's
final system-prompt text for `{{...}}` and substitutes fresh on every turn (§4).

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

**Live (`orchestrator/src/util/interpolateMacros.ts`, `server/httpServer.ts`):** the Stage 1
`{{...}}` scanning engine itself — `{{char}}`, `{{user}}`, `{{persona}}`, `{{description}}`,
`{{scenario}}`, `{{trim}}`, `{{reverse}}`, `{{newline}}`, `{{noop}}`, usable inline inside a
character's own fields or a chat's freely hand-edited `system` prompt text, not just as a
whole-slot marker. See §4 below for exactly where and when it runs — the shape that actually
shipped there deliberately differs from this document's original speculative framing (§4 is
corrected to match), though the substance §2 requires is unchanged.

---

## 2. The mechanism: turn-scoped resolution, not per-read evaluation

**Every macro resolves once, at the top of the turn, against a frozen snapshot of that turn's
scene state — never re-evaluated per character, per slot, or per read within the same turn.**

This applies at every stage below, including the variable stage. It falls directly out of two
things already true of the platform:

- **§4 (scoped by explicit scene state):** a turn's scene state — active characters, location,
  presence, canon — is fixed the moment the Director Pass reads it (`spec.md` §5 step 2).
  Nothing about "now" should change mid-turn just because macro resolution happened to run twice.
- **The assembler's purity (§8) + the caching rationale in step 3:** a multi-character scene turn
  calls the LLM once per speaking character, and the whole point of the fixed-order static prefix
  is that it's **byte-identical across every one of those calls** so a caching-capable provider
  only pays full price once. If a macro re-resolved on every character's call, the "static" prefix
  would silently stop being static, and the cache discount `spec.md` §5 step 3 depends on would
  silently stop applying — with no error to signal it.

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

### Stage 1 — Deterministic core (live)

**Categories:** `NAMES`, `CHARACTER`, `UTILITY` — `{{char}}`, `{{user}}`, `{{persona}}`,
`{{description}}`, `{{scenario}}`, `{{trim}}`, `{{reverse}}`, `{{newline}}`, `{{noop}}`.

Pure lookups and text transforms — no timing sensitivity, no open design question. Shipped as
`interpolateMacros(text, snapshot)` (`orchestrator/src/util/interpolateMacros.ts`), a single
non-recursive regex pass with a closed registry for the 9 tokens above; an unrecognized token
(a typo, or a later-stage macro not yet implemented) passes through verbatim rather than being
deleted. Ships the mechanism (§2) and the substitution engine every later stage reuses — nothing
here gets thrown away when Stage 2 or 3 lands. An unset source resolves to empty, not to a
hardcoded fallback: `{{user}}` with no `persona_name` configured substitutes to `''` (so a
greeting written against it renders with a leading space, e.g. `, welcome!`) — deliberately no
"User" fallback, same fail-visible shape as every other empty field on the platform.

One deliberate deviation from this section's original framing (which assumed the pass would scan
`fields` and run inside `assemblePromptStack`'s caller): it instead scans the chat's *final*,
already-persisted system-prompt string, in `server/httpServer.ts`, fresh on every turn — see §4 for
why, and for how that's still §2-compliant. `{{user}}`/`{{persona}}`'s data source (the household
persona settings) and their whole-slot marker form (§1.1) are unchanged by this — a slot whose
entire text is a single `{{persona}}` token is just one more string the same pass resolves.

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
that's a mutation with no attribution, which conflicts with §16 (injected context must be
attributable) and the assembler's own purity (§8: no side effects during assembly).
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

## 4. Where the resolution pass lives (as built)

This section originally assumed the resolution pass would need a Director-Pass-shaped turn-loop
caller that didn't exist yet (`spec.md` §7.4: `assemblePromptStack` "has no caller in the actual
turn loop"). That's still true for multi-character *scenes* — untouched by this build — but it
turned out not to block Stage 1: a single-character **RP chat** already runs through exactly one
request handler per turn (`server/httpServer.ts`'s `handleChatCompletions`), and that request
boundary already *is* the per-turn boundary §2 asks for. No new caller had to be invented.

What actually shipped:

- `interpolateMacros(text, snapshot)` (`orchestrator/src/util/interpolateMacros.ts`) is a pure
  function (§8) — no IO, no clock reads, no RNG calls, no DB reads inside it. Its shape
  ended up simpler than originally planned: it substitutes into one flat string (the chat's
  already-assembled system-prompt text), not into `assemblePromptStack`'s `fields`/`slots`
  arguments separately. `assemblePromptStack` itself is untouched — `apply_prompt_stack_to_chat`
  still bakes a template into `chat_sessions.params.system` with `{{...}}` tokens left verbatim; a
  character field or a hand-typed custom slot both end up as substrings of that one persisted
  string by the time this pass ever sees them, so scanning the flat string catches both without
  needing to touch the plugin at all.
- The caller is `handleChatCompletions` itself, immediately before `sessionParams.system` is folded
  into the outgoing `systemPrompt` — run fresh on **every** turn, not baked once at Apply time. This
  was a deliberate correction from the plan's first draft: baking at Apply time is timing-safe for
  Stage 1's macros (§2 says so explicitly), but it would have had to be ripped out for Stage 2
  anyway, and it left `{{user}}`/`{{persona}}`/`{{char}}` silently stale whenever the household
  persona or a character card was edited mid-chat — exactly the live-read guarantee
  `bi_principles.md` §13 requires elsewhere. Resolving fresh every turn fixes both at once.
- Building the snapshot means one cheap `characters` row lookup (by the chat's `character_id`) plus
  `getPersonaSettings` (`server/adminServer.ts`, already used elsewhere) — gated on the chat being
  `kind: 'rp'` and its system text actually containing `{{`, so an ordinary household chat (which
  could legitimately contain literal `{{...}}`-looking text) is never scanned, and an RP chat with
  no macros in it pays for none of the extra reads.
- **Message history is resolved at the same seam, against the same snapshot** — the one thing this
  section's original framing missed: a character's `first_mes`/alternate greetings (seeded verbatim
  into `chat_messages` by `apply_character_to_chat`/`apply_prompt_stack_to_chat`) carry `{{user}}`
  more often than any other field in real cards, and stored messages are re-sent as-is by the
  frontend every turn — so the literal token reached the LLM (and got echoed into replies) even
  though the system prompt resolved perfectly. `assembleSessionTurnContext` (and the Prompt
  Inspector's live fallback) now interpolates each message whose content contains `{{` against the
  same frozen snapshot, gated the same way ('rp' + `.includes('{{')`); the canonical message is
  never rewritten, only the wire copy the LLM sees.
- **The chat UI resolves the same tokens for display without baking them into the wire copy**:
  GET `/v1/chats/:id` (and the swipe routes) attach `resolvedContent` — a per-read derived copy —
  to every 'rp' message whose stored text contains `{{`, and the frontend renders that while
  continuing to re-send the verbatim `content`. This keeps §2's live-read guarantee intact: a
  persona edit updates the greeting on the next read/turn with no re-apply, because the canonical
  store never holds resolved text. (Derived working state per `bi_principles.md` §1, never
  persisted.)
- Stage 2 extends `MacroSnapshot` with a clock read and an RNG roll, computed at the same call site,
  the same way. Stage 3 extends it again with a Triggeryze variables read — still only reads at this
  seam; the writes live in `evaluate_rules`, downstream, in the background step, unchanged from this
  section's original design.

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
