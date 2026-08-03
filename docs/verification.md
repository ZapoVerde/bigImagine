Verifying bigBrain — Method
===========================

bigBrain's correctness claims (principles 2, 4, 6, 11) are statements about *what actually
crosses a wire*: does the LLM's tool call get scoped to the right `user_id`, does a real
provider's request shape survive a multi-round tool call without a malformed history, does an
unrecognized API key actually get rejected. `tsc` passing proves none of that — it proves the
code compiles, not that a request was scoped correctly or a response was shaped right. The only
real evidence is running the actual code and inspecting what it did.

This doc is the recipe, written down once so it doesn't get re-derived each time bigBrain is
touched — the same reason `vamp/docs/verification.md` exists, adapted for a very different kind
of system (a stateless HTTP backend talking to Postgres and LLM APIs, not a real-time audio
engine).

---

1. The two tiers
-----------------

Nothing in this sandbox can reach the real deployed Postgres or a real LLM/embeddings API —
there's no network route to the Docker network the stack actually runs on, and no live API keys
are available here. That splits verification into two tiers that must not be confused:

- **Local** (this sandbox, `npm run verify`): every package's own scripts, run in plain Node
  against the real compiled code, substituting a fake only at the one true I/O boundary
  (`fetch`, or a `pg`-shaped `Pool`) — never inside the logic under test. Proves *wiring*: does
  the right SQL get issued, does the right shape get sent over the wire, does auth actually
  reject a bad key. Runs on every change, no deployed stack needed.
- **Deployed** (the real homelab stack): scripts that must run against the actual running
  Postgres/orchestrator, via `docker exec` (see each script's own header comment for the exact
  command). Proves the *policy itself* — RLS actually denies cross-user access, a real model
  actually calls the tool it was asked to. Run after a schema or deployment change, not on every
  edit.

Conflating the two is the failure mode this split exists to prevent: a local script passing
proves the orchestrator *would* scope a query correctly if RLS is doing its job — it doesn't
reprove RLS itself. `db/checks/verify_rls.sql` is what actually proves that, once, against the
real database (Phase 1) — local scripts lean on that result rather than re-deriving it.

---

2. Local tier: the pattern
----------------------------

Every `scripts/verify-*.mjs` follows the same shape: build first, then run in plain Node — no
test framework, no mocking library.

```
npm run verify   # from repo root: builds everything, then every package's verify chain in order
```

Each package's own `npm run verify` is the routine a new script joins — add the file, then add
one line to that package's `package.json` `verify` script. Nothing to register elsewhere,
mirroring vamp's "directory membership is the routine" convention (`scripts/checks/` there;
one script per concern here, since bigBrain's checks are wiring-shaped, not a batch of small
pure-logic assertions).

**What the fakes actually are** — this is the part worth getting right on every new script:

| Boundary | Fake | Lives in |
|---|---|---|
| Postgres | An object shaped like `pg.Pool` (`{ connect() }` returning `{ query(), release() }`), simulating exactly `BEGIN`/`set_config`/the one query under test | inline in each script — see `verify-loop.mjs`'s `createFakePool()` |
| LLM / embeddings provider | `createStubLlmProvider([...scripted turns])` / `createStubEmbeddingProvider(dim)` — real modules, not test-only mocks, exported alongside the real Anthropic/OpenAI-compatible/Voyage adapters | `io/llm/stub.ts`, `io/embeddings/stub.ts` |
| The wire itself (Anthropic/OpenRouter/DeepSeek) | `globalThis.fetch` monkey-patched to capture the outgoing request and return a canned response | `verify-llm-adapters.mjs` only — everywhere else uses the stub provider instead, since the adapters themselves are what that script exists to test |

The rule: the fake sits at the boundary, never inside the module under test. `verify-llm-adapters.mjs`
runs the *real* `createAnthropicLlmProvider`/`createOpenAiCompatibleLlmProvider` — only `fetch`
is substituted — specifically because that adapter's own request-building logic is what needs
proving, and a stub provider would prove nothing about it.

---

3. Current scripts and what each one actually proves
--------------------------------------------------------

| Script | Proves | Does NOT prove |
|---|---|---|
| `orchestrator/scripts/verify-logger.mjs` | Real file writes: bounded buffer (oldest evicted), immediate flush on error, request-id tagging | — |
| `orchestrator/scripts/verify-loop.mjs` | `runTurn`'s control flow and `user_id` scoping plumbing (fake pool) | RLS itself |
| `orchestrator/scripts/verify-llm-adapters.mjs` | The real Anthropic and OpenAI-compatible adapters produce a well-formed multi-round tool-calling request (see §4) | Whether a real model actually *makes* good tool calls |
| `orchestrator/scripts/verify-server.mjs` | The plugin loader dynamically importing the real `plugins/` directory from disk; a broken plugin is skipped, not fatal; the HTTP server's auth, routing, and OpenAI-shaped (streaming + non-streaming) responses, over real sockets | Anything about a real chat client's behavior (Open WebUI itself) |
| `plugins/document-ingestion/scripts/verify-ingest.mjs` | The plugin's `info`/`registerTools` contract (the same one the loader uses), the forced-schema classification call shape, the insert statement's columns | Real Voyage embeddings, real classification quality |
| `db/checks/verify_rls.sql` | **Deployed tier.** RLS actually denies cross-user reads and rejects cross-user writes, against the real Postgres | — this is the ground truth the local scripts lean on |

---

4. Worked example: the bug `verify-llm-adapters.mjs` actually caught
-------------------------------------------------------------------------

`runTurn` records tool-call history for the LLM to see on the next round. The first version only
pushed the assistant's *text* onto that history, not which tool it called — so a second request
in the same conversation replayed an empty assistant turn followed by a tool result with nothing
for it to point back at. A real API rejects that outright; the stub provider used everywhere else
doesn't care about message shape, so it never would have caught this.

`verify-llm-adapters.mjs` catches it by driving a real two-round tool call through the real
adapter, with `fetch` mocked only to capture the request and return a canned response:

```
npm run verify --workspace=@bigbrain/orchestrator   # or just `npm run verify` from repo root
```

It asserts the *second* captured request actually contains a `tool_use` block (Anthropic) /
`tool_calls` entry (OpenAI-compatible) whose `id` matches the tool result that follows it — not
just that the call succeeded. The fix was carrying `toolCalls` through onto the assistant
`LlmMessage` in `loop.ts` and having each adapter reconstruct the original block from it, not
just the leftover text, when replaying history.

---

5. Proving a fix actually caused the observed change
----------------------------------------------------------

Same discipline as vamp: a script passing only shows the *current* code passes, not that the
script would actually have caught the bug it claims to catch. Before trusting a new verification
script, revert the fix and confirm the script fails:

```
git stash push --keep-index -m "temp-revert-for-verify" -- orchestrator/src/orchestrator/loop.ts orchestrator/src/io/llm/anthropic.ts orchestrator/src/io/llm/openaiCompatible.ts
npm run verify --workspace=@bigbrain/orchestrator   # should now FAIL
git stash pop                                       # restore the fix
npm run verify --workspace=@bigbrain/orchestrator   # should PASS again
```

---

6. Deployed tier: what still needs the real stack
-------------------------------------------------------

Anything that depends on RLS, a real model, or real embeddings can only be proven against the
actual homelab deployment, via `docker exec` (see each script's own header for the exact form).
Two homes, by convention:

- `db/checks/` — database-specific checks, mounted straight into the Postgres container
  (currently just `verify_rls.sql`, run once after any schema migration).
- `deployed-checks/` — everything else that needs a live stack (a real LLM/embeddings key, a
  running orchestrator). Empty as of Phase 4 — the orchestrator isn't deployed as a service yet —
  but the standing plan is a live-model check there once it is: a real chat request that should
  trigger `ingest_note`, confirming a real row lands in `unstructured_notes` with a real Voyage
  embedding. No local script can substitute for this — it's a live-model behavior question
  (does the active profile actually honor `forceTool`?), not a wiring question.

---

7. A recurring false negative: transient container egress failures
-------------------------------------------------------------------------

Outbound calls from the orchestrator container — a DNS lookup, the page fetch inside
`ingest_url`, a call to Voyage or an LLM provider — occasionally fail transiently (a bare
`getaddrinfo EAI_AGAIN`, or a bare `TypeError: fetch failed`) with no code-level cause; a plain
retry succeeds without any change. Confirmed live during a `documents` plugin smoke test: both
failures resolved on retry alone. `io/httpRetry.ts`'s `fetchWithRetry`/`retryOnFailure` now covers
this for every outbound call in the app (`fetchUntrustedUrl`'s DNS lookup included, and Voyage's
embeddings client, the last caller still on a bare `fetch`) — see that file's own header for the
policy. Before chasing a live-tier failure as a real bug, retry it once; if it still fails, it's a
real bug.

---

8. What this can't do
-------------------------

Local verification proves the code *would* behave correctly if the systems on the other end of
each wire behave as documented. It cannot tell you whether a specific cheap model (DeepSeek's
`deepseek-chat`, Gemini Flash-Lite via OpenRouter) reliably honors a forced `tool_choice`, or
whether its classification quality is actually good enough for `docs/spec.md` §6.1's auto-tagging
— those are live-model judgment calls that need a real request against a real deployment, not
something a mock can ever settle. Nor does anything here check cross-file consistency or
adherence to `docs/bi_principles.md`'s architecture rules — that's `code-review`'s job, not this
doc's.
