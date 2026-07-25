# Second Brain — Project Principles

*Read before writing any code. Applies to every session.*

---

## What a Principle Is

**A principle is an enduring statement of design intent.** It says what must be true and why it matters — not how it is currently implemented. A principle should survive a complete rewrite: if you could achieve the same property by different means, the principle still holds.

**A principle is not:** a description of specific functions or file paths, a code recipe, a static analysis rule, or implementation documentation. When a principle references a system by name (Postgres, Notion), that system illustrates the principle in action — it is not the principle itself.

If you find yourself writing "call X" or "sync via Y", move that detail into code comments or documentation. The principle captures the *why*.

---

## 1. The Relational Store is the Canonical Record

The platform exists to build and maintain the **canonical record** of a household's data. That record lives in the central relational store — not in any external app, view, or mirror.

Anything surfaced elsewhere — a synced database, a rendered view, a cached response — is **derived working state**: reconstructible from the canonical record, never an independent source of truth. If a derived surface is lost or corrupted, it can be rebuilt. The reverse must never be true. No external system is ever the only place a fact lives.

---

## 2. The LLM Reasons; Nothing Else Does

Reasoning, classification, and judgment happen in exactly one place: the LLM, invoked server-side. Every other surface — the client, external apps and integrations, sync layers — moves and displays data. It does not decide what that data means.

A surface that starts inferring intent, weighting relevance, or making decisions on the platform's behalf has quietly become a second reasoning engine, and now the system has two brains that can disagree with each other. If a surface needs to "get smarter," that intelligence is missing from the server, not from the surface.

---

## 3. Explicit User Signal Outranks Inferred Signal

When a user directly indicates what something is or what they want — a category hint, a tag, a named destination — that signal takes precedence over whatever the system would have inferred on its own. Inference is a fallback for when the user hasn't told you, not a second opinion once they have.

This is what keeps automated classification trustworthy: it only has to be right when the user hasn't already given the answer for free.

---

## 4. Every Actor is Scoped Server-Side, Never by Content

Which user's data an action reads or writes is determined by trusted, server-assigned context — never inferred from the content of a message, a note, or an inbound payload. A request, a note, or an external webhook can claim to be about anything; none of it is trusted to say *whose* data it is.

This holds regardless of how many users, integrations, or inbound channels the system grows to support.

---

## 5. The Default is Conversation; Specialist Views are Opt-In

Every interaction can be answered in conversation. Structured, specialist presentation of data is always an additional option layered on top — never a requirement to see a result. A user should never have to leave the conversation to find out whether something worked.

---

## 6. The Reasoning Layer is Replaceable

The platform must never depend on the specific behavior, quirks, or pricing of one LLM provider. Prompts, tool manifests, and orchestration logic are written against capabilities — structured output, function calling, streaming — not against a named vendor. Swapping the model behind the reasoning switchboard is a configuration change, not a rewrite.

Where providers differ, the system should degrade gracefully rather than fail outright. Defaults are chosen for robustness and honesty — accurate results, graceful handling of the unexpected, admitting uncertainty rather than guessing — over whatever is cheapest, fastest, or most convenient for a given vendor to ship. A default earns its place by serving the household using the system, not by serving ease of implementation.

---

## 7. The Interface Layer is Replaceable

Every client — chat UI, mobile app, Notion, or any other specialist surface — talks to the platform through a stable API, never through direct access to the database or the reasoning layer. That API is the seam the platform commits to; what sits on the other side of it is not.

If a given frontend or integration becomes limiting, awkward, or unmaintained, it should be replaceable without touching the server, the data model, or the reasoning logic underneath. A UI earns its place by being the most convenient surface right now — not by becoming load-bearing. If Notion makes something hard, the fix is to swap what sits behind the API, not to bend the platform around Notion's limitations.

---

## 8. The Four Kinds of Code

Every module belongs to exactly one of four categories. Mixing them is a defect.

1. **Pure Functions** — Input in, derived output out. No external reads or writes. No UI. No settings access.
2. **Stateful Owners** — The strictly bounded gatekeepers of runtime memory. Only one module may own any given state variable.
3. **IO Wrappers** — Call the LLM, read/write the database, call external APIs. Contain zero reasoning or derivation logic. They move data; they do not interpret it.
4. **Orchestrators** — Sequence calls to the other three layers. Decide what runs and in what order; never what the data means. Own no state. Perform no direct IO. Contain no derivation logic.

Each file declares its category before its implementation. That declaration is the first thing a reviewer checks.

---

## 9. Every Module is Self-Describing

Every source file opens with a structured preamble declaring:

- Its architectural role (Pure / Stateful / IO / Orchestrator, and what it owns or does)
- Its public API surface (what it exports and what those exports do)
- Its contracts (what it reads, what it writes, what it must never do)
- A timestamp marking the last intentional architectural change

This is not documentation for its own sake — it is a forcing function. A module whose role cannot be stated clearly in a preamble has not been designed clearly enough to be implemented. Write the preamble first.

---

## 10. Every File Has One Purpose and a Size Budget

Every source file does exactly one thing. If a file is doing two things, it should be two files.

When you reach 300 lines, split the file along the nearest fault line and continue. The preamble already tells you what the file owns, and the fault lines follow from that. Do not count lines to avoid the split — that is more work than the split itself, and it makes the code worse.

---

## 11. Observability is Not an Afterthought

Every module logs enough, at the seams where things actually go wrong — external calls, state transitions, request boundaries — that a teething issue can be diagnosed from the log itself, without re-running the system under a debugger. A silent failure is a design defect, not bad luck.

This is not a license to log indiscriminately — a log flooded with noise is as useless as no log at all. Log where reasoning happens, log where IO crosses a boundary, log every fallback or discarded path along with why it was taken. If tracing a bug means adding a log line first, the module wasn't observable enough.

---

## 12. A Secret Is Write-Only; Everything Else Stays Visible

A value is a secret exactly when possessing it grants access on its own — an API key, a bearer token, a capability URL that lets anyone holding it read private data. Secrets are encrypted at rest and never round-trip back out through any admin surface once set: an operator can enter or rotate one, and see that it's configured and when it last changed, but never retrieve the value itself again. There is exactly one shape for this — a closed, named vocabulary in the encrypted credential store — and a new secret means adding a name to that vocabulary, not inventing a parallel mechanism.

A value that only configures behavior — an identifier, a flag, a selected profile — is not a secret, even when it lives right next to one in the same feature. It stays visible, in the open settings store or plain config, because hiding it protects nothing and costs real usability: an operator needs to see which user a shared feed is attributed to, confirm a toggle's state, or read back an active connection. Secrecy is decided per value, never inherited from the feature it belongs to.

---

## 13. Runtime Config Lives in the Database; `.env` Is for Bootstrap Only

Once the orchestrator can reach Postgres and authenticate a caller, no further configuration should require editing `.env` and redeploying. `.env` is reserved for what has to exist *before* either of those is true — the database connection itself, the encryption key protecting everything else at rest, the admin key, and whatever tells the system which external identity provider to trust at all (e.g. the Cloudflare Access application's team domain/audience). That last category is not "internal" versus "external-facing" — Access is as external as config gets — it's specifically that a wrong value there breaks authentication for every caller at once, including whoever would need to fix it. A value belongs in `.env` because the system cannot reach a trustworthy state without it already being correct, not because it happened to ship that way first.

That's a narrower category than "anything auth-related," though. A mapping from an already-verified identity to a household member — the Access email allow-list, the manual API-key list — is a different case: editing one doesn't break anyone else's access, since the admin making the edit is themselves already authenticated under the mapping as it stood before the edit. That's household-member data, not a bootstrap value — it belongs with `users`, not `.env`, even though it's currently manual (`db/README-users.md`). Its natural home is a small admin panel for creating/revoking a member's access, not a Settings-tab field, since an API key is itself a secret (§12) while an email is not — one panel, two storage shapes underneath. Flagged as a real gap, not urgent: today's manual flow works.

Everything else — which connection is active, a shared feed's owning user, a masking flag — is DB-backed and editable from the Settings tab, whether or not it's also a secret (§12 decides encrypted-and-write-only vs. plain-and-visible; this decides whether it lives in the database at all). A setting that still requires `.env` and a redeploy to change, with no bootstrap or single-caller-authentication reason for it, is unfinished — not a third category to design around.

---

*Further principles will be added as they emerge from real friction, not anticipated in advance.*
