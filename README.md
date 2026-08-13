# BigImagine

A self-hosted, single-user interactive fiction and roleplay platform. It's running today as a
working replacement for a personal SillyTavern installation, and the goal is to replace it
entirely: native relational storage and `pgvector` semantic recall standing in for ST's flat JSON
files, regex keyword lorebooks, and DOM-injected extensions.

The platform exists to build and maintain the canonical record of a story — its characters,
scenes, locations, canon facts, and rules — in a central relational store, not scattered across
flat files and browser-side extension state. Reasoning and judgment happen in exactly one place,
the LLM, invoked server-side; everything else moves and displays data. Three ideas that started
life as separate SillyTavern extensions are native, relational features of that store instead of
bolted-on scripts:

- **Canonize** — canon facts, live the moment they're proposed, with a human review queue.
- **Vistalyze** — locations, with cached generated background imagery.
- **Triggeryze** — rules and status effects, with conditional context injection. Not built as its
  own general system yet, though its trigger→action model is already doing real work in two
  hardwired places (see "Not yet built" below).

## What it does

- **Roleplay chat** — live SSE streaming turns, swipe/regenerate sharing one turn-execution core,
  in-stream header/body/footer repair as a reply streams in (with a status pill showing progress),
  branch/fork with a visual lineage map, and mobile UI (PWA-installable, edge-grip drawers,
  swipe navigation) built mobile-first rather than mobile-tolerated.
- **Canonize** — canon facts proposed from play and approved before they become established world
  state (`plugins/canonize`: propose/approve/reject/recall), extended by a chat-memory bridge and
  curators that auto-approve arc-tagged plot/place/thing/concept/person facts through the same
  pipeline.
- **Vistalyze (as `locations`)** — location tracking with a parent/sub-location model, and
  cache-first background image generation across five providers (ComfyUI, fal.ai, OpenAI Images,
  Pollinations, Runware). The active location renders as the chat background and stays live in
  every turn's prompt.
- **Character Roster** — create/update/delete, drag-and-drop V2/V3 PNG/JSON import and lossless
  export (`cardCodec.ts` ports SillyTavern's own PNG encoder, so cards round-trip losslessly
  between the two platforms), plus Chub.ai search, browsing, and import.
- **Lorebooks** — a full ST-World-Info-compatible system built from scratch: vector-recall
  discovery instead of keyword matching, ported gating semantics (probability, sticky/cooldown/
  delay, inclusion groups, budget), a management page, chat-sidebar panel, and import/export hub
  with Chub-embedded-lorebook support.
- **Chat memory / RAG recall** — dual-lane: general chat sessions keep a rolling digest; roleplay
  sessions run a bridge (scene/events/plot, adapted from SillyTavern-Canonize's hookseeker prompt)
  plus world-memory and people curators, injecting three independently-orderable markers every
  turn. A RAG settings view exposes every retrieval knob and every prompt involved as editable
  text.
- **Prompt Inspector** — a live per-turn debugging view: a loss-tolerant tag-tree of the assembled
  prompt, cache-coverage badges, per-subsection stability stats, and a token/cost receipt per call.
- **Prompt stacks** — CRUD-managed prompt assembly presets, per-slot HTML-style tag wrapping, slot
  grouping, clone-with-dedup, selectable per chat.
- **Notes, documents, web search, timers/scheduled routines, push notifications, math/date tools**
  — notes with pin/archive + semantic ingestion; save/clip-to-git-repo documents with chunked
  embeddings and semantic search; Brave-backed web search; `set_timer`/`cancel_timer` background
  jobs; ntfy push notifications; calculation/date utilities.
- **LLM-agnostic orchestration** — named connection profiles swappable per chat, a single metering
  gate with retry/backoff and per-provider prompt-caching handling, no vendor-specific logic
  anywhere in prompts or tools.
- **Runtime config in Postgres** — active LLM profile/model, timezone, and every tunable prompt
  editable from Settings; no redeploy needed.

## What it's trying to be

Every client — the chat UI, a future mobile shell, an export tool — talks to the platform through
a stable API, never through direct access to the database or the reasoning layer, so the interface
layer stays replaceable. The reasoning layer is meant to be equally replaceable: prompts, tool
manifests, and orchestration logic are written against capabilities (structured output, function
calling, prompt caching), not a named vendor, so swapping the model behind a scene — or the whole
platform — is a configuration change, not a rewrite. And a character's canonical representation
must always be round-trippable to the community V2/V3 card spec, so the database is a working
copy, never a trap for creative effort already put into a character.

Full design intent is in `docs/bi_principles.md`; the target architecture (schema, agentic loop
sequencing) is in `docs/spec.md`.

## Layout

- `orchestrator/` — the reasoning/orchestration layer (tool manifest, LLM client, agentic loop,
  HTTP server split into per-concern handlers under `orchestrator/src/server/`)
- `plugins/*` — microservice plugins, one per domain, registered as orchestrator tools:
  `canonize`, `characters`, `chat-memory`, `context-stack-presets`, `document-ingestion`,
  `documents`, `locations`, `math-utils`, `notes`, `notifications`, `prompt-presets`, `scenes`,
  `temporal`, `web`
- `frontend/` — the native tabbed UI: chat, canon queue, characters/Chub browsing,
  locations/backgrounds, lorebooks, prompt stacks, prompt inspector, RAG settings, branch map
- `backup/` — offsite backup sidecar
- `db/migrations/` — Postgres+pgvector schema, 75 migrations as of this writing
  (`db/migrations/README.md` is a well-maintained running log of every migration)
- `docker-compose.yml` / `stacks/bigimagine/` — dedicated infra with its own Postgres instance

## Not yet built

- **Triggeryze as a general, user-authorable system** — no `rules`/`status_effects` table, no
  plugin, no way for a user to define an arbitrary rule and have it conditionally injected into a
  scene. Its trigger→action model is already live in two hardwired, single-purpose forms though:
  in-stream cleanup (`cleanupHeuristics.ts`, `cleanupLoop.ts`, explicitly documented as a direct
  port of Triggeryze's `actions/text.js` ruleset shape — same regex-trigger/action semantics, user-
  editable rules and prompts, just scoped to cleaning a reply rather than general-purpose) and
  location handling (`locationAndPresenceScraper.ts`, a fixed header-format contract rather than a
  registrable rule). Neither lets another feature register its own trigger — that's the gap
  between what exists and Triggeryze as spec'd.
- **The Director Pass** — LLM-driven speaker selection for multi-character scenes. RP chats are
  currently single-character (`chat_sessions.character_id` is one nullable FK, not a roster).
- **A unified Inspector Canvas** — one HUD surface merging on-scene character cards, active
  location, active rules/statuses, and the canon-approval queue. Today these are separate views
  (`CanonQueueView.tsx`, `CharactersView.tsx`, the Canvas split-panel) rather than one surface.
- **Single-user conversion** — the schema is still a multi-user, Row-Level-Security design; RLS
  policies are still being added to new tables, not removed.

`docs/spec.md` has the full target architecture, but its **(built)**/**(designed)** tags and its
`docs/canonize-plan.md` references are stale — cross-check anything it claims against actual code
or `git log`. Same goes for `docs/plans/*.md`: several status headers say "planned, not yet
implemented" for work that has since shipped.

## Read before touching code

- `docs/bi_principles.md` — design intent, read first
- `docs/spec.md` — target architecture (see staleness caveat above)
- `docs/conventions.md` — module preamble format and file-organization rules
- `docs/verification.md` — the verify-script testing philosophy (no unit-test framework)
- `docs/bootstrap.md` — orientation for a new session
- `docs/chat-memory.md` — the dual-lane chat memory design
- `docs/lorebook-plan.md` — the lorebook system
- `docs/plans/*.md` — per-feature build plans (status headers unreliable, see above)
