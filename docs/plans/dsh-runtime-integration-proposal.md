# DeepSeek Harness as a BigImagine Runtime Layer

*Created 2026-08-19. Governed by `bi_principles.md`. Proposal only — not yet implemented.
Written after inspecting `/config/workspace/deepseek-harness` as a possible runtime foundation for
BigImagine's completion pipeline.*

---

## Recommendation

Bring DeepSeek Harness (DSH) into BigImagine as a **runtime adapter/plugin used by BI**, not as the
top-level application that hosts BI.

BigImagine should continue to own the completion pipeline, relational story state, prompt contract,
RP constraints, image/portrait workflows, UI/API behavior, metering, and persistence model. DSH is
useful as a generic execution runtime behind those BI decisions: provider adapters, turn lifecycle,
streaming, guarded tools, jobs, session events, scoped capabilities, and replay/debug machinery.

The short rule:

> DSH can execute a BI turn; BI decides what a BI turn means.

## Why this direction

BI is not a generic agent shell. It is the story/product layer and already has domain-specific
rails: scene state, characters, locations, canon facts, rules, swipes, prompt inspection, portrait
generation, background imagery, and RP lanes where tools may need to be absent entirely. Moving BI
inside DSH would require reshaping those semantics around DSH's plugin tree and session model.

The lower-risk shape is to make DSH another runtime behind BI's existing completion boundary. That
lets BI adopt the generic machinery that DSH already has without handing DSH canonical ownership of
story state or prompt semantics.

## What DSH gives BI

### Provider abstraction

DSH has a model adapter layer (`ctx.llm`) with a common stream/message vocabulary. BI could route
model calls through that layer rather than maintaining every provider's request, stream, retry, and
message-shape differences directly.

This lines up with `bi_principles.md` §6 and §14: provider behavior should be replaceable, and all
LLM calls should pass through one accountable gate.

### Streaming and turn lifecycle

DSH defines a lifecycle for turns, steps, model streams, assistant chunks, final messages, tool
calls, tool results, cancellation, and turn stopping. BI currently owns equivalent behavior in its
own rails. Adopting DSH here could reduce BI-specific runtime code around streaming, cancellation,
and partial-result bookkeeping.

The useful DSH concepts are:

- `turn/start` and `turn/end`
- `step/start` and `step/end`
- `assistant/chunk` and `assistant/message`
- `tool/call` and `tool/result`
- cancellation and recovery through the agent handle

### Append-only session event log

DSH's session log is probably the largest practical benefit. It records durable model-visible
events and derives history, replay, forks, transcripts, UI reconstruction, and telemetry from that
stream.

BI already cares about prompt inspection and exact request provenance. DSH's invariant —
model-visible input must be reconstructable from the log — is a strong fit for BI's need to answer:

- what did the model see?
- what state was projected into the prompt?
- what chunks streamed before cancellation?
- what tool calls happened?
- can this turn be replayed or forked?

BI should not replace relational story state with the DSH event log. The event log should be the
execution transcript. The BI database should remain the canonical record for characters, scenes,
facts, rules, locations, swipes, and configured prompts.

### Guarded tools

DSH has a scoped tool registry and tool execution pipeline:

- schema registration
- prompt assembly of allowed tools
- `tools/pre-execute`
- `tools/execute`
- `tools/post-execute`
- durable tool call/result events

This could replace or reduce BI-specific plumbing for model-facing tools in non-RP lanes, analysis
passes, portrait feedback, validation helpers, filesystem/wiki helpers, or future Triggeryze-style
actions.

Important constraint: some BI RP turns may need no tools at all. DSH is useful because capability
sets can be scoped per agent/session, but BI must enforce which lanes get tools.

### Prompt assembly extension points

DSH has a `core/system-prompt` subsystem where plugins contribute prompt sections and tool schemas.
BI could use this to register BI-derived prompt sections instead of building every request as a
single bespoke string assembly path.

This should be done carefully. BI's prompt stack, macro behavior, prompt inspector, manual tuning,
and DB-backed prompt overrides remain BI-owned. DSH prompt assembly should receive already-decided
BI sections, not invent which story context applies.

### Scoped capabilities

DSH can mount different capability sets per profile, bundle, agent, or scoped registration. This
matches BI's likely runtime split:

- ordinary household/admin chat: tools allowed
- RP completion: restricted or no tools
- image/portrait work: image and analysis tools only
- background reflection: specific DB/write tools only
- import/export lanes: card/filesystem tools only

This is more maintainable than one global tool surface with many runtime conditionals.

### Background jobs and subagent-shaped work

DSH has a jobs capability and a subagent interface. BI could use these for long-running or
delegated work such as:

- portrait candidate generation and critique
- background image generation
- visual reflection
- lore/canon reconciliation
- import cleanup
- batch validation
- expensive replay or migration checks

This does not require BI to become "multi-agent by default." It gives BI a standard runtime shape
for work that already behaves like background execution.

### Configurable runtime composition

DSH's profile/bundle system can compose different runtime trees for web, headless, local dev,
hosted prod, and experiments. That could let BI run a native pipeline and a DSH-backed pipeline
side by side while the integration is being evaluated.

## What DSH does not give BI

DSH does not provide BI's domain model. It does not know:

- characters
- scenes
- locations
- canon facts
- rules/status effects
- swipes and alternate completions
- card import/export semantics
- portrait studio semantics
- BI prompt stack behavior
- BI's no-tools RP discipline
- BI's metering policy

Those remain BI responsibilities.

DSH also does not remove integration complexity. It introduces Cordis, DSH plugin composition, and
a developer-preview dependency whose README explicitly warns that compatibility-breaking changes
will happen.

## Proposed integration shape

Add a BI runtime boundary around completion execution:

```ts
interface CompletionRuntime {
  runTurn(input: BigImagineTurnInput): Promise<BigImagineTurnResult>;
  cancelTurn(turnId: string): Promise<void>;
  streamTurn(input: BigImagineTurnInput): AsyncIterable<BigImagineTurnEvent>;
}
```

Then provide at least two implementations:

- `native`: current BI path
- `dsh`: adapter that maps BI turn input into DSH session/agent execution

The adapter should translate in both directions:

- BI relational state -> DSH prompt sections, messages, capabilities
- DSH stream/session/tool events -> BI turn events, prompt inspector data, persisted messages,
  usage records, and logs

DSH should not directly own BI database writes except through BI-owned IO wrappers or explicit
tools approved for a given lane.

## First spike

The first spike should be deliberately narrow.

### Goal

Run one ordinary BI chat/completion lane through DSH while preserving BI's existing response shape,
stream behavior, cancellation behavior, logging, and metering.

Do not start with RP, image generation, swipes, or canon writes.

### Scope

1. Add a `CompletionRuntime` interface around the existing completion path.
2. Implement `native` by wrapping the current path with minimal movement.
3. Implement a `dsh` runtime adapter for ordinary chat only.
4. Create a feature flag or DB-backed setting to choose runtime per lane.
5. Capture equivalent Prompt Inspector/request receipts for both paths.
6. Compare transcripts, streamed chunks, cancellation, usage records, and error handling.

### Acceptance criteria

- The existing native path still works unchanged.
- A DSH-backed ordinary chat turn can stream to the existing UI.
- Cancellation stops the DSH-backed turn and leaves a coherent partial transcript.
- Usage/metering still passes through BI's single LLM gate or an equivalent BI-owned accounting
  seam.
- Prompt Inspector can show what the model saw.
- No RP-specific state or story tables are written directly by DSH.
- The runtime can be switched off without data migration.

## Second spike

If ordinary chat works, test one constrained RP turn.

The RP spike must prove:

- BI chooses the character, scene state, location, canon facts, rules, and prompt stack.
- DSH only sees the projected prompt/messages/capabilities for that turn.
- Tool access can be disabled for that RP lane.
- Swipes and reruns preserve BI semantics.
- Prompt Inspector output is byte-comparable or explainably different from the native path.
- The BI database remains canonical for story state.

## Risks

### Developer-preview churn

DSH is explicitly in developer preview and warns of breaking changes. BI should treat it as an
optional runtime until the adapter survives enough real turns to justify deeper dependency.

Mitigation: keep `native` runtime available; isolate DSH behind the runtime interface; avoid
rewriting BI state or prompts around DSH internals.

### Cordis complexity

DSH's plugin model is powerful but nontrivial. Pulling it in casually could make BI harder to
debug.

Mitigation: start with one adapter package/bundle and a small number of extension points. Do not
convert BI wholesale to Cordis.

### Duplicate session state

BI has relational story state. DSH has an append-only session event log. Treating both as canonical
would create conflicts.

Mitigation: define ownership clearly. BI database is canonical for story/product state. DSH session
log is canonical for execution transcript/replay of DSH-run turns.

### Prompt drift

If DSH assembles prompts differently, BI may lose the exact prompt behavior that makes RP turns
stable.

Mitigation: BI projects explicit prompt sections into DSH. Prompt Inspector compares native and DSH
request material during the spike.

### Tool leakage into RP

DSH is designed around agent/tool extension points. BI RP lanes may need no model-facing tools.

Mitigation: per-lane capability sets are mandatory. RP starts with tools disabled unless a specific
BI feature explicitly opts in.

## Decision to review

Approve a narrow DSH-runtime spike if the goal is to reduce BI's ownership of generic execution
runtime problems: providers, streaming, cancellation, guarded tools, jobs, session event logging,
replay/fork/debug infrastructure, and scoped capabilities.

Do not approve a rewrite where BI becomes a DSH plugin until the runtime-adapter approach proves
insufficient. The adapter path gives BI most of DSH's concrete benefits while preserving BI's
current ownership of domain state, prompt semantics, and product behavior.
