# BigImagine

A self-hosted, single-user interactive fiction and roleplay platform, forked from the bigBrain
core engine and re-pointed at narrative instead of household data. It is meant to fully replace a
personal SillyTavern installation — native relational storage and `pgvector` semantic recall
standing in for ST's flat JSON files, regex keyword lorebooks, and DOM-injected extensions — once
it earns that replacement on its own merits.

Three previously separate SillyTavern extensions become native, relational features rather than
bolted-on extensions:

- **Canonize** → approved canon facts, with human-in-the-loop proposal review.
- **Vistalyze** → locations, with cached generated background imagery.
- **Triggeryze** → rules and status effects, with conditional context injection.

Read before touching code:
- `docs/bi_principles.md` — design intent, read first
- `docs/spec.md` — the target architecture for the narrative engine (status-tagged: **(built)**,
  **(designed)**, **(parked)** — see the note on status below)
- `docs/conventions.md` — module preamble format and file-organization rules
- `docs/verification.md` — the verify-script testing philosophy (no unit-test framework)
- `docs/bootstrap.md` — orientation for a new session; still bigBrain's own workspace/stacks/
  secrets setup, largely reusable as-is (see below)

## Status: fork in progress, narrative engine not yet built

This repo is a fork of bigBrain, not yet a working roleplay platform. What's happened so far is
subtraction, not addition: the household-specific plugins (recipes, meal planning, shopping lists/
analytics, calendar, Notion sync, weather) have been removed, but the narrative-specific schema and
plugins `docs/spec.md` describes — `characters`, `scenes`, `scene_presence`, `canon_facts`,
`locations`, `rules`, `status_effects`, and the Canonize/Vistalyze/Triggeryze plugins themselves —
do not exist yet. Neither does the single-user conversion: the database schema underneath is still
bigBrain's original multi-user, Row-Level-Security-enforced design (`docs/spec.md` §3 describes
pruning this, but that pruning hasn't happened yet).

In other words: `docs/spec.md` is a target, not a build log — its own header says so. Everything
below marked **(inherited)** is real, running code carried over unmodified from bigBrain. Everything
marked **(designed)** is `docs/spec.md`'s plan and has no code behind it yet.

## Layout

- `orchestrator/` — the reasoning/orchestration layer (tool manifest, LLM client, agentic loop)
  **(inherited)**
- `plugins/*` — microservice plugins, one per domain, registered as orchestrator tools
  **(inherited)**
- `frontend/` — the native tabbed UI **(inherited)**
- `backup/` — offsite backup sidecar, still shaped for bigBrain's household scale **(inherited,
  unreviewed for single-user)**
- `db/migrations/` — Postgres+pgvector schema, still bigBrain's multi-user/RLS design
  **(inherited)**
- `docker-compose.yml` — the Dockge-managed stack definition **(inherited)**

## What's actually running today (inherited from bigBrain)

Everything here is household/multi-user infrastructure that happens to also be useful for a
narrative platform, kept because ripping it out wasn't necessary to start narrative work:

- **Chat** — persisted chat history, folders, branching, prompt presets, per-chat model override,
  Canvas (a split-screen panel that opens when a tool call touches something canvas-worthy — the
  same mechanism the Inspector Canvas below is meant to generalize).
- **Chat memory** — rolling summarization, RAG recall, session sync (`plugins/chat-memory`) —
  adapted from Canonize once already; needs its own BigImagine-framed pass (`docs/spec.md` §4.1,
  §8).
- **Notes** — freeform notes with pin/archive lifecycle, semantic ingestion.
- **Documents** — save/clip content into a per-user git repo, chunked embeddings, semantic search
  (`plugins/documents`, `plugins/document-ingestion`).
- **Web search** — Brave Search-backed tool (`plugins/web`).
- **Timers & scheduled routines** — `set_timer`/`cancel_timer`, background job dispatch
  (`plugins/temporal`) — infrastructure the narrative engine's own background passes (fact
  extraction, rule evaluation) are expected to reuse, not infrastructure specific to households.
- **Push notifications** — ntfy-backed (`plugins/notifications`).
- **Math/date utilities** — calculation and date-math tools (`plugins/math-utils`).
- **LLM-agnostic orchestration** — named connection profiles, swappable per chat, no vendor-specific
  logic in prompts or tools.
- **Runtime settings in Postgres** — active LLM profile/model, timezone; no redeploy needed to
  change (`bi_principles.md` §13).

## What's designed but not built (`docs/spec.md`)

The actual roleplay engine — the part that makes this BigImagine rather than a renamed bigBrain:

- **Canonize** — `propose_canon_fact`/`approve_canon_fact`/`reject_canon_fact`/`recall_canon_facts`;
  semantic-search canon replacing keyword lorebooks entirely.
- **Vistalyze** — `set_active_location`/`generate_location_image`; cache-first image generation
  against a configurable backend (local ComfyUI/Automatic1111 or a cloud API).
- **Triggeryze** — `apply_status_effect`/`clear_status_effect`/`evaluate_rules`; conditional context
  injection with mandatory expiry.
- **The Director Pass** — LLM-driven speaker selection for multi-character scenes, never a
  round-robin.
- **Character Roster** — drag-and-drop V2/V3 PNG/JSON import and lossless export, URL/text import
  with LLM-fallback extraction.
- **Inspector Canvas** — on-scene character cards, active location metadata, active rules/statuses,
  and the canon-approval queue.
- **Single-user conversion** — dropping RLS/multi-tenancy and field-level encryption, since there's
  no household member to scope against or protect data from (`docs/spec.md` §3).

Full detail, including the schema and the agentic loop's exact sequencing, is in `docs/spec.md`.

## What was pruned from bigBrain

Removed already, not just planned: `plugins/recipes` (recipes & meal planning),
`plugins/shopping-analytics`, `plugins/calendar` (Cozi/Outlook/Google Calendar sync), Notion
two-way list sync, `plugins/weather`. None of this is narrative-relevant, and none of it is coming
back.
