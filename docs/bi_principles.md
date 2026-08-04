# BigImagine — Project Principles

*Read before writing any code. Applies to every session.*

---

## What a Principle Is

**A principle is an enduring statement of design intent.** It says what must be true and why it matters — not how it is currently implemented. A principle should survive a complete rewrite: if you could achieve the same property by different means, the principle still holds.

**A principle is not:** a description of specific functions or file paths, a code recipe, a static analysis rule, or implementation documentation. When a principle references a system by name (Postgres, ComfyUI), that system illustrates the principle in action — it is not the principle itself.

If you find yourself writing "call X" or "sync via Y", move that detail into code comments or documentation. The principle captures the *why*.

---

## What BigImagine Is

A self-hosted, single-user interactive fiction and roleplay platform, forked from the bigBrain core engine and re-pointed at narrative instead of household data. It replaces a personal SillyTavern installation entirely — not alongside it forever, but until it earns that replacement on its own merits. Canonize, Vistalyze, and Triggeryze — previously three separate SillyTavern extensions — become native, relational features of this platform rather than extensions stapled onto a flat-file host.

---

## 1. The Relational Store is the Canonical Record

The platform exists to build and maintain the **canonical record** of a story: its characters, scenes, locations, canon facts, and rules. That record lives in the central relational store — not in any external app, view, or mirror.

Anything surfaced elsewhere — an exported character card, a rendered scene image, a cached response — is **derived working state**: reconstructible from the canonical record, never an independent source of truth. If a derived surface is lost or corrupted, it can be rebuilt. The reverse must never be true.

---

## 2. The LLM Reasons; Nothing Else Does

Reasoning, classification, and judgment happen in exactly one place: the LLM, invoked server-side. Every other surface — the client, the prompt stack assembler, the image pipeline — moves and displays data. It does not decide what that data means.

This applies directly to the Director Pass: which character speaks next is a judgment call about the scene, made by the LLM, never a hardcoded round-robin or a heuristic bolted onto the orchestrator. A surface that starts inferring intent or making narrative decisions on the platform's behalf has quietly become a second reasoning engine.

---

## 3. Explicit User Signal Outranks Inferred Signal

When you directly indicate what something is or what you want — approving a canon fact, naming the active location, pinning a status effect — that signal takes precedence over whatever the system would have inferred on its own. Inference is a fallback for when you haven't told it, not a second opinion once you have.

---

## 4. Every Turn is Scoped by Explicit Scene State, Never by Content

Which characters, location, rules, and canon apply to a turn is determined by trusted scene state — the active `scene_id`, the presence table, the active location pointer — never inferred by parsing the message text. A message can say anything; none of it is trusted to say which scene, which characters, or which world it belongs to.

This is what keeps multiple concurrent stories from bleeding into each other as the platform grows past a single active scene.

---

## 5. The Story is the Default; Specialist Views are Opt-In

The cinematic chat view is the platform's home surface. Every swipe, rerun, edit, and reply happens there. The Inspector Canvas, the Character Roster, and the canon-approval queue are always additional — layered on top, never required to advance the story or see what happened.

---

## 6. The Reasoning Layer is Replaceable

The platform must never depend on the specific behavior, quirks, or pricing of one LLM provider. Prompts, tool manifests, and orchestration logic are written against capabilities — structured output, function calling, prompt caching — not against a named vendor. Swapping the model behind a scene, or behind the whole platform, is a configuration change, not a rewrite.

Where providers differ, the system should degrade gracefully rather than fail outright. This includes prompt-caching economics: which model benefits from a cached static prefix is a per-provider fact the orchestrator adapts to, never a design the orchestration logic is welded to.

---

## 7. The Interface Layer is Replaceable

Every client — the React chat UI, a future mobile shell, an export tool — talks to the platform through a stable API, never through direct access to the database or the reasoning layer. If a given frontend becomes limiting, it should be replaceable without touching the server, the data model, or the reasoning logic underneath.

This holds for content, not just UI: a character's canonical representation must always be round-trippable to the community V2/V3 card spec. The database is the working copy; the ability to export it losslessly is what proves the platform isn't a trap for creative effort you've already put into a character.

---

## 8. The Four Kinds of Code

Every module belongs to exactly one of four categories. Mixing them is a defect.

1. **Pure Functions** — Input in, derived output out. No external reads or writes. No UI. No settings access.
2. **Stateful Owners** — The strictly bounded gatekeepers of runtime memory. Only one module may own any given state variable.
3. **IO Wrappers** — Call the LLM, read/write the database, call external APIs (image generators, etc.). Contain zero reasoning or derivation logic.
4. **Orchestrators** — Sequence calls to the other three layers. Decide what runs and in what order; never what the data means. Own no state. Perform no direct IO.

Each file declares its category before its implementation. The prompt stack assembler is the platform's canonical example of a Pure Function — see §17 below for why that specific module's purity is load-bearing, not incidental.

---

## 9. Every Module is Self-Describing

Every source file opens with a structured preamble declaring:

- Its architectural role (Pure / Stateful / IO / Orchestrator, and what it owns or does)
- Its public API surface (what it exports and what those exports do)
- Its contracts (what it reads, what it writes, what it must never do)
- A timestamp marking the last intentional architectural change

A module whose role cannot be stated clearly in a preamble has not been designed clearly enough to be implemented. Write the preamble first.

---

## 10. Every File Has One Purpose and a Size Budget

Every source file does exactly one thing. If a file is doing two things, it should be two files.

When you reach 300 lines, split the file along the nearest fault line and continue. Do not count lines to avoid the split — that is more work than the split itself, and it makes the code worse.

---

## 11. Observability is Not an Afterthought

Every module logs enough, at the seams where things actually go wrong, that a teething issue can be diagnosed from the log itself. This matters most exactly where a silent failure would be invisible in the story rather than in an error message: a director pass that silently picks the wrong speaker, a stale cached image reused after a location's description changed, a status effect that failed to expire. A silent failure at these seams doesn't crash — it corrupts the story quietly.

This is not a license to log indiscriminately. Log where reasoning happens, log where IO crosses a boundary, log every fallback or discarded path along with why it was taken.

---

## 12. A Secret Is Write-Only; Everything Else Stays Visible

A value is a secret exactly when possessing it grants access on its own — an LLM API key, an image-generation API key or token. Secrets are encrypted at rest and never round-trip back out through any admin surface once set: you can enter or rotate one, and see that it's configured and when it last changed, but never retrieve the value itself again.

A value that only configures behavior — which provider is active, a model name, a cache setting — is not a secret, even when it lives right next to one. It stays visible, because hiding it protects nothing and costs real usability.

---

## 13. Runtime Config Lives in the Database; `.env` Is for Bootstrap Only

Once the orchestrator can reach Postgres, no further configuration should require editing `.env` and redeploying. `.env` is reserved for what has to exist before that's true — the database connection itself, the encryption key protecting everything else at rest. Everything else — active model, active image-gen backend, prompt-caching preferences — is DB-backed and editable from the Settings surface.

---

## 14. Every LLM Call Passes Through One Gate, Carrying a Task Id

No module may reach the model directly. Every call — a live turn, a director-pass speaker selection, a canon-fact extraction pass, an image-prompt composition — passes through the same single metering seam, and every call names an explicit task id: whose behalf it's running on.

This is what makes usage accountable rather than merely visible after the fact, and it matters more here than in a household assistant: a single multi-character scene turn can fan out into several calls (director pass, per-character generation, background fact extraction), and prompt-caching economics only pay off if those calls are actually tracked as belonging to one turn, not counted as unrelated noise.

---

## 15. Canon Requires Approval Before It Becomes Truth

A fact extracted from a turn — a plot beat, a relationship shift, a world-rule change — is a **proposal**, not canon, until it is explicitly approved. Only approved canon facts are ever injected into a prompt or treated as established world state. An unapproved proposal is inert: visible for review, invisible to the story.

This is Principle 3 applied at its highest-stakes point. A hallucinated inference that quietly becomes permanent world truth doesn't just corrupt one turn — it corrupts every future turn built on top of it, and unlike a bad reply, a bad canon fact doesn't announce itself as wrong.

---

## 16. Injected Context is Always Attributable and Bounded

Every piece of context injected into a turn — a status effect, an active rule, a canon fact, a memory recall — must trace back to a specific row and be individually removable. Nothing stays in the prompt stack just because it was relevant once.

A status effect that doesn't expire, or a canon fact with no way to un-inject it, doesn't fail loudly — it just quietly grows the context window and dilutes everything else in it, turn after turn, until the story's voice degrades for reasons nobody can point to.

---

## 17. The Prompt Stack Assembler is a Pure Function of Scene State

Given identical scene state — the same active characters, location, approved canon, active rules, and recent history — the assembled prompt is always identical. No hidden mutation, no randomness, no side effects during assembly.

This isn't just Principle 8's Pure Functions category applied generically — it's the specific property that makes prompt caching actually work. A cached static prefix only pays off if it's byte-identical across every character's turn in the same scene; a prompt stack that isn't a pure function of its inputs breaks the cache silently and turns a near-free multi-character turn back into a full-price one, with no error to signal that it happened.

---

## 18. Every Prompt is Surfaced for Manual Tuning

Any prompt string that drives an internal LLM call — a classification pass, a rolling summary, a digest, a director-pass decision — ships with a sensible built-in default, but that default is never the only copy that matters. It is always readable and overridable from the Settings surface, in full, as plain text.

A prompt that only lives in source is a prompt only a rebuild can change. The person running the platform is the one who notices when a summary is too verbose or a digest keeps missing the point — they must be able to fix it themselves, immediately, the same way any other DB-backed runtime config changes under Principle 13. An empty override means "use the built-in default"; there is no separate reset action, because clearing a text field is already the obvious way to ask for that.

---

## 19. The Platform is Mobile-First, Not Mobile-Tolerated

A screen you check a story on is as likely to be a phone as a desktop. Every surface — the cinematic chat view, the Settings surface, the Inspector Canvas — must remain fully usable at phone width: legible without zooming, operable without a mouse-precision tap target, and readable without horizontal scrolling.

Concretely, this rules out layouts that only hold together at desktop width: multi-column rows that silently become vertical dividers slicing through wrapped content on a narrow screen. A row of fields stacks top-to-bottom before it breaks. If a layout choice makes sense in a wide flex/grid row but turns into a cramped or overlapping mess at phone width, the narrow case wins — pick the layout that degrades gracefully, not the one that looks best on the widest screen in the room.

---

*Further principles will be added as they emerge from real friction, not anticipated in advance.*
