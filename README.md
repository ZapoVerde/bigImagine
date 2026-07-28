# bigBrain

Self-hosted, multi-user "Second Brain" platform: Postgres+pgvector canonical store, a server-side
LLM reasoning/orchestration layer, a replaceable interface layer (Open WebUI plus a native
frontend), and a set of microservice plugins covering notes, lists, recipes, calendar, documents,
and more.

Read before touching code:
- `docs/bb_principles.md` — design intent, read first
- `docs/spec.md` — architecture spec (principles win where they disagree)
- `docs/conventions.md` — module preamble format and file-organization rules
- `docs/verification.md` — the verify-script testing philosophy (no unit-test framework)
- `docs/bootstrap.md` — orientation for a new session, the workspace/stacks split, secrets

## Layout

- `orchestrator/` — the reasoning/orchestration layer (tool manifest, LLM client, agentic loop)
- `plugins/*` — microservice plugins, one per domain, registered as orchestrator tools
- `frontend/` — the native tabbed UI (Chat, Lists, Recipes, Calendar, Notes, Documents, Settings)
- `backup/` — offsite backup sidecar (nightly DB + documents + secrets, `age`-encrypted, pushed to R2)
- `db/migrations/` — Postgres+pgvector schema
- `docker-compose.yml` — the Dockge-managed stack definition

## Features

Status tags: **(built)** is live today, **(designed)** is spec'd but not implemented,
**(parked)** was scoped and deliberately shelved. Full detail for anything below is in
`docs/spec.md`, section numbers noted where useful.

### Chat & interaction
- Conversational chat via Open WebUI, plus a parallel native frontend tab strip that talks to
  the same tool surface directly, never through Open WebUI (§5, Correction 7).
- Persisted chat history, folders, and reusable prompt presets (§3 additions).
- Per-chat model and connection override, no restart needed (§3, "per-chat connection override").
- Canvas: a split-screen note panel that opens automatically in Chat when a tool call touches a
  note, so the LLM's edits are visible live (§3, "Canvas").
- Landing Deck: a pinned-notes reference drawer and today's calendar shown above the chat bar
  before the first message of a new chat (§5).
  - Reference Drawer, pinned notes **(built)**.
  - Tier 1 active-focus view (overdue/due-today tasks ranked into one queue) **(designed)**.
- Write-time hint and read-time render tick to steer classification/presentation without
  forcing a rigid menu-driven flow (§4).
- Tag-browse fallback: a direct Postgres query on `pinned_tags` when semantic search misses (§4).

### Notes
- Semantic ingestion (`ingest_note`): auto-tagged, categorized, summarized, vector-embedded for
  hybrid search (§6.1).
- Freeform notes (separate from the above, for content a user edits directly): pin/archive
  lifecycle, optional reminder timestamps, Canvas editing (§3 additions).

### Lists
- Generic list/list-item primitive covering groceries, errands, or any todo list, not a
  shopping-specific schema (§3, "lists/list_items").
- Store-layout aware section ordering: a list can define its own aisle order and items get
  auto-classified into it (§3, "section_order").
- Due dates and priority (P1/P2/P3) on individual items (§3, "action dates & priority").
- Two-way Notion sync for one household's Notion workspace (§6.4).

### Recipes & meal planning
- Import a recipe from a URL (reads `schema.org/Recipe` structured data first, falls back to LLM
  extraction) or from pasted text (§6.5).
- Conversational authoring: build or edit a recipe turn by turn without a re-extraction call
  (`create_recipe`/`update_recipe`).
- Meal plan entries by date, with a free-text label so an unusual day (e.g. a holiday with three
  meals) isn't forced into a fixed breakfast/lunch/dinner slot.
- Auto-generate a shopping list from a date range's planned meals, deduped and merged into the
  Lists primitive above.

### Household calendar
- Aggregates read-only Cozi and Outlook ICS feeds alongside native, user-created events in one
  calendar (§6.7).
- Bidirectional Google Calendar sync via OAuth: create, edit, and delete propagate both ways,
  with last-write-wins conflict resolution.
- Per-event visibility (`private`/`shared`) gating whether it reaches the shared Google calendar.
- A task or note deadline can be explicitly promoted to a real calendar event, linked back to its
  source row.
- Optional work-calendar privacy masking (`BIGBRAIN_MASK_WORK_CALENDAR`) replaces Outlook event
  details with a placeholder before they ever reach the database.

### Documents & web clipping
- Save authored content or clip a web page (`save_document`/`ingest_url`) into a per-user,
  local git repository, no shared repo, no remote credential to leak (§6.6).
- Web clips go through Readability + Turndown for clean Markdown, with metadata extraction
  (author, site, published date) and normalized heading levels.
- Chunked embeddings per document (heading-aware) for semantic `search_documents`, plus ranked
  full-text search and tag filtering for the in-app search box.
- Read-only in-app viewer; the git repo itself is the edit surface.

### Shopping analytics
- Purchase logging (`log_purchase`) feeding a chronological analytics query: average days
  between purchases per item, for restock timing (§6.2).

### Integrations
- **Notion** — two-way sync for Lists, one owning household user, polling reconciliation rather
  than webhooks (§6.4).
- **Google Calendar** — OAuth-based two-way sync (§6.7). Needs `BIGBRAIN_ORCHESTRATOR_BASE_URL`
  set to the real public hostname and a matching redirect URI registered on the OAuth client.
- **Web search** — a single Brave Search-backed tool covering recipe discovery, documentation
  lookup, and general facts (§6.8).
- **Weather** — Open-Meteo backed, no API key required (§6.9).
- **Gmail email parsing** (LLM-based structured extraction of order confirmations etc.)
  **(parked)** — split out from the original calendar sketch, no live driver yet (§6.3).

### Platform & admin
- Multi-user with Postgres Row-Level Security enforced at the database layer, not just the app
  (§3, Correction 2).
- At-rest field encryption for note content (AES-256-GCM), protecting against a stolen disk or
  leaked backup; not admin-blind, whoever holds the encryption key can decrypt everything (§3,
  Correction 4).
- LLM-agnostic orchestration: named connection profiles, swappable per household or per chat,
  no vendor-specific logic in prompts or tools.
- Provider credential vault (Settings tab): rotate LLM/Notion/Calendar/Brave keys without a
  redeploy (`provider_credentials`, §3).
- Offsite backup **(built)**: nightly `pg_dump` plus every user's document repo plus
  `secrets.enc.env`, `age`-encrypted before leaving the host, pushed to an S3-compatible bucket
  (Cloudflare R2 today, provider-agnostic mechanism). See `backup/README.md` for restore.
- Cloudflare Access SSO (Google login) on the one public hostname; every route underneath still
  enforces its own bearer token regardless (§7, Correction 6).

### Not yet built
- Landing Deck Tier 1 active-focus queue (overdue/due-today tasks, ranked) **(designed)**.
- Composite task sort: time bucket first, priority second **(designed)**.
- Gmail email parsing gateway **(parked)**.
