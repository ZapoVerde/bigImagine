# SYSTEM SPECIFICATION v2: AGENTIC SECOND BRAIN PLATFORM
## ARCHITECTURE: MANIFEST-DRIVEN TOOL REGISTRY WITH RELATIONAL DATASTORE AND REPLACEABLE SURFACES

*Governed by `principles.md`. Where this spec and the principles disagree, the principles win — update this spec.*

---

### 1. SYSTEM OVERVIEW

This specification defines the architectural design for a self-hosted, multi-user, family-oriented "Second Brain" platform. The platform provides a **conversational-first** interface backed by an intelligent reasoning engine, with **optional specialist surfaces** (e.g. Notion) for structured domains like shopping lists, calendars, and recipes. It blends unstructured note-taking (semantic hybrid search) with deterministic household operations (grocery logistics, scheduling, email parsing) via a decoupled, data-first relational model.

The central design commitment: **all reasoning happens server-side, behind a stable API. Every client — chat UI, mobile app, Notion, or anything that replaces them later — is a replaceable consumer of that API, never a participant in it.**

---

### 2. CORE ARCHITECTURAL PRINCIPLES

*(Full detail in `principles.md`; summarized here as they bear on this spec.)*

- **Data-First Priority:** The relational store is the canonical record. Any external mirror (Notion, a cache, a rendered view) is reconstructible from it — never the reverse.
- **Reasoning Stays Server-Side:** The LLM is the only component that classifies, infers, or judges. Clients and integrations move and display data; they do not reason about it.
- **Reasoning Layer is Replaceable:** No prompt, tool manifest, or orchestration logic depends on one LLM vendor's specific behavior. Swapping models is a config change.
- **Interface Layer is Replaceable:** Every surface talks to the platform through a stable API. If Notion (or any client) becomes limiting, it is swapped behind that API — the platform is never bent to accommodate a surface's limitations.
- **Explicit Signal Outranks Inferred Signal:** User-provided hints (category ticks, tags) always outweigh automatic classification.
- **Server-Side Trust Scoping:** Which user's data an action touches is determined by trusted server context, never by the content of a message, note, or inbound webhook.
- **Chat is the Default:** Every interaction can be answered in conversation. Structured/specialist views are always additive, never required to see a result.

---

### 3. RELATIONAL SCHEMATIC & REGISTRY (POSTGRESQL + PGVECTOR)

Unchanged in shape from v1, with two corrections and one addition.

```
+--------------------+
|       USERS        |
+--------------------+
| PK | user_id        |<---------+
|    | name            |          |
+--------------------+           |
        |                        |
                | (1:N)                  | (1:N)
                        v                        |
                        +--------------------+           |
                        | UNSTRUCTURED_NOTES |           |
                        +--------------------+           |
                        | PK | note_id         |          |
                        | FK | user_id          |          |
                        |    | raw_text          |          |
                        |    | vector_embed (Vector)|      |
                        |    | auto_tags (Array)  |          |
                        |    | pinned_tags (Array)|          |
                        |    | category (Correction 3)|    |
                        |    | summary_short (Correction 3)|
                        +--------------------+           |
                                |                        |
                                        | (1:N)                  |
                                                v                        |
                                                +--------------------+           |
                                                |  RECIPES_MEALS      |          |
                                                +--------------------+           |
                                                | PK | recipe_id        |<--------+ (1:N)
                                                | FK | user_id           |
                                                |    | meal_name          |
                                                +--------------------+
                                                        |
                                                                | (1:N Conditional)
                                                                        v
                                                                        +--------------------+
                                                                        |  SHOPPING_LOGS       |
                                                                        +--------------------+
                                                                        | PK | log_id            |
                                                                        | FK | user_id            |<--------+
                                                                        | FK | recipe_id           |
                                                                        |    | timestamp             |
                                                                        |    | item_name             |
                                                                        |    | is_staple             |
                                                                        +--------------------+
                                                                        ```

                                                                        **Correction 1 — Tag split.** `unstructured_notes.tags` is split into `auto_tags` (LLM-proposed at ingestion, noisy, many) and `pinned_tags` (small, user-curated, stable — the vocabulary used for manual tag-browse fallback when semantic search misses).

                                                                        **Correction 2 — Row-Level Security.** Every table carrying `user_id` gets a Postgres RLS policy scoping reads/writes to the requesting user. This is enforced in the database, not just the app layer — the app-layer/Cloudflare Access check is a second line of defense, not the only one.

**Correction 3 — `unstructured_notes` was missing two columns the ingestion pipeline (§6.1) actually produces.** `category` and `summary_short` are added alongside the existing `auto_tags`, mirroring `documents.summary_short`. `vector_embed` on both `unstructured_notes` and `documents` is `vector(2048)`, not `vector(1536)` as originally specified — Voyage AI's models don't support a 1536-dimensional output at all (confirmed against current docs: `voyage-4`'s `output_dimension` is one of {2048, 1024, 512, 256}); 2048 was chosen over the usual web-scale default of 1024 since storage/latency don't matter at household-notes scale and quality does. See `db/migrations/0003_phase3_schema_updates.sql`.

**Correction 4 — At-rest field encryption, and the scope it deliberately does not cover.** `unstructured_notes.raw_text` and `.summary_short` are encrypted (AES-256-GCM, `orchestrator/src/io/fieldCipher.ts`) before they're written, using a single server-held key (`BIGBRAIN_FIELD_ENCRYPTION_KEY`). `category`/`auto_tags` stay plaintext (needed for filtering, lower sensitivity); `vector_embed` cannot be encrypted at all without breaking pgvector similarity search, so it remains a queryable semantic fingerprint of the plaintext even though the plaintext itself isn't stored.

This protects against filesystem/DB access without the key — a stolen disk, a leaked backup, casual `psql` access — which is the threat model this was built for now (single user, host is otherwise trusted). It explicitly does **not** protect one user's content from another user who controls the deployment (e.g. a parent from a child's notes, in a future multi-user household) — whoever holds `BIGBRAIN_FIELD_ENCRYPTION_KEY` can always decrypt everything, and today that's the same person managing `.env`. A genuinely admin-blind scheme needs per-user key material the deployer never possesses (e.g. derived from a user-held secret, unlocked only for the duration of that user's own request) — deliberately deferred rather than built now: it would mean bigBrain can't process a user's content (ingest, embed, chat) unless that user's key is present for that specific request, which rules out any background/passive processing while they're not actively "unlocked," and it would need every user to supply real key material bigBrain's admin doesn't already hold — in tension with the stated goal of not asking users to maintain a credential beyond the household's existing Google/Cloudflare Access login. Revisit if/when the household actually grows past one person.

**Addition — `lists` / `list_items` (Phase 8 prerequisite).** A generic, domain-agnostic todo-list primitive, added while designing the Notion Sync Gateway: "Grocery List," "Home Depot Run," "Books to Read" are all just a `lists` row (`name`, optional informational `tags`) with `list_items` under it (`item_name`, `status` — `'pending'`/`'done'`, `completed_at`), not separate tables or a shopping-specific schema. `list_items.user_id` is denormalized (not just reachable via a join to `lists`) so RLS applies directly. Both tables carry the same `user_scoped` RLS policy as everything else. See `db/migrations/0004_lists.sql`.

Deliberately **not** wired into `shopping_logs` or any inventory/pantry concept: completing a list item only records that it happened (`status`/`completed_at`) — it does not insert into `shopping_logs`, even for a list tagged `shopping`. Considered and rejected: maintaining real inventory/pantry state was judged a large, open-ended effort (deduplication, staleness, "did I actually use it") for a payoff that doesn't exist yet. `shopping_logs`/§6.2's analytics engine stays fed only by the explicit `log_purchase` tool, entirely independent of lists. Revisit if a concrete downstream use for the linkage shows up (e.g. a time/deadline-aware nudge — "you wanted groceries done today and it's 1pm").

**Correction 5 — outbound Notion sync was missing an owner check.** `plugins/lists/src/notionSync.ts`'s `syncListItemToNotion` and `plugins/recipes/src/shoppingListFromMealPlanTool.ts`'s equivalent now both no-op unless `userId === notion.ownerUserId`, in addition to the existing `notion === undefined` no-op. Caught live: a second bigBrain account (`bb-test`, created purely for isolated testing) had its `add_list_item` call push straight into the real owner's Notion workspace — nothing was checking that the calling user was actually the one Notion workspace's designated owner. `notion.ownerUserId` was already used correctly on the *inbound* side (`notionReconcile.ts` always attributes adopted pages to it); this closes the same gap on the outbound side. A non-owner user's lists/list_items now stay Postgres-only, isolated by RLS same as everything else they write — this gateway remains one Notion workspace synced to one owning user, not one per household member, and non-owner accounts (test accounts, or future household members without their own Notion workspace) never leak into it.

**Addition — `lists.section_order` & `list_items.section` (store-layout ordering).** `lists` gains `section_order text[]` (default `'{}'`); `list_items` gains a nullable `section text`. A new `set_list_section_order(list_name, sections)` tool (`plugins/lists`) lets a list define its own ordering conversationally — e.g. one household's actual grocery-store aisle sequence, in the order they walk it — rather than a fixed enum or a one-off SQL script, since store layouts are arbitrary and stores rearrange constantly. Whenever an item is added to a list that has a section_order (`add_list_item`, and `generate_shopping_list_from_meal_plan` for meal-plan-generated groceries), it's classified into one of that list's own sections via a forced-schema LLM call bounded to that exact vocabulary (`classifySection.ts`, an `enum` in the tool's JSON Schema so the model can't invent a section that isn't there) — best-effort, same as Notion sync: a classification failure never blocks the item from being added, it's just left unsectioned. `get_list_items` then sorts by each item's position in its own list's section_order (computed in JS, not SQL, since a query spanning multiple lists at once — list_name is optional — would otherwise need a per-row-dependent ORDER BY); a list with no section_order, or an item with no classified section, falls back to creation order exactly as before this existed. Live-verified against a real 24-section grocery-store layout: items added out of order (`carrots`, `cheddar cheese`, `toilet paper`, `ice cream`) came back correctly sorted by aisle, with pre-existing unclassified items correctly sorting last. See `db/migrations/0007_list_sections.sql`.

**Addition — `recipes_meals` extension & `meal_plan_entries` (Phase 8.5: Recipes & Meal Planning).** `recipes_meals` (a `recipe_id`/`user_id`/`meal_name` stub since Phase 1) gains `ingredients jsonb`, `instructions jsonb`, `tags text[]`, `prep_time`/`cook_time`/`servings text`, `source_url text`. Ingredients stay flat strings (`"3 chicken breasts (300g/10oz each)"`) rather than decomposed quantity/unit/item fields — verified live against a real recipe site's own `schema.org/Recipe` structured data that even that spec doesn't decompose ingredient lines, so there's no reason bigBrain should either. Instructions preserve schema.org's optional section grouping (a plain string, or `{section, steps}` for recipes with labeled stages like "Sauce," "Assembly"). A new `meal_plan_entries` table (`plan_entry_id`, `user_id`, `recipe_id`, `planned_date`, nullable free-text `meal_label`) deliberately has no slot enum (breakfast/lunch/dinner) — the household's actual pattern is "usually just dinner, but Christmas has breakfast and lunch planned with no dinner," which a nullable label (null implies dinner) handles without rebuilding the parked Communications Gateway's calendar concept. See `db/migrations/0006_recipes_mealplan.sql`.

                                                                        **Addition — `notion_sync_map`:**

                                                                        ```
                                                                        +-----------------------+
                                                                        |   NOTION_SYNC_MAP      |
                                                                        +-----------------------+
                                                                        | PK | sync_id             |
                                                                        | FK | user_id              |
                                                                        |    | source_table          | (e.g. 'shopping_logs')
                                                                        |    | source_row_id           |
                                                                        |    | notion_database_id      |
                                                                        |    | notion_page_id           |
                                                                        |    | last_synced_at            |
                                                                        +-----------------------+
                                                                        ```

                                                                        This table is the CNZ-style "label everything" mechanism: it's how an inbound Notion webhook gets matched back to the row that produced it, and how the `user_id → notion_database_id` mapping is enforced server-side rather than inferred from webhook content.

                                                                        **Addition — `documents`:**

                                                                        ```
                                                                        +-----------------------+
                                                                        |      DOCUMENTS         |
                                                                        +-----------------------+
                                                                        | PK | doc_id               |
                                                                        | FK | user_id               |
                                                                        |    | repo                   | (e.g. 'docs')
                                                                        |    | file_path                |
                                                                        |    | last_synced_sha            |
                                                                        |    | vector_embed (Vector)        |
                                                                        |    | summary_short                  |
                                                                        |    | status (fresh/stale)             |
                                                                        +-----------------------+
                                                                        ```

                                                                        Unlike every other table, `documents` is **not** canonical for its own content — the file at `file_path`, in git, is. This row exists purely so the LLM can find and summarize the document via chat. If a row and its file ever disagree, the file wins. `last_synced_sha` is the dedup key: re-ingestion only touches files changed since that commit, never the whole repo (§6's "additive sync" pattern applies here too).

                                                                        ---

                                                                        ### 4. THE AGENTIC INTERACTION LOOP

                                                                        Two additions to the v1 loop: an optional **write-time hint** and an optional **read-time render tick**. Both are additive to the default conversational path, never required.

                                                                        ```
                                                                        User App                Server                 Cloud LLM              Local Tool / DB / Notion
                                                                           |                       |                       |                          |
                                                                              |--(1) Text + optional--+                       |                          |
                                                                                 |    write-time hint    |                       |                          |
                                                                                    |    (shopping/event/   |--(2) Forward + hint---+                          |
                                                                                       |    recipe/note/email) |    weights classifier |                          |
                                                                                          |                       |                       |--(3) Classify + reason--+
                                                                                             |                       |<--(4) Tool call--------|                          |
                                                                                                |                       |--(5) Execute + scope---+------------------------->|
                                                                                                   |                       |    to user_id (RLS)    |                          |
                                                                                                      |                       |<--(6) Raw result------+--------------------------|
                                                                                                         |                       |--(7) Forward result---+                          |
                                                                                                            |                       |<--(8) Chat reply------+                          |
                                                                                                               |<--(9) Render reply + [optional: read-time render tick →                  |
                                                                                                                  |    optional Notion    |  deep-linked Notion hop, if domain has a mirror]|
                                                                                                                     |    hop link            |                       |                          |
                                                                                                                     ```

                                                                                                                     - **Write-time hint** (tickbox: shopping / event / recipe / note / email) weights the classifier at step 3. Absence of a hint falls back to pure inference (vector + structured signal, arbitrated by the LLM) as previously scoped.
                                                                                                                     - **Read-time render tick**, if present, tells the server which domain's Notion mirror (if any) to deep-link to, rather than asking the LLM to guess a presentation shape. Default is always plain chat.
                                                                                                                     - **Tag-browse fallback** (not shown above) bypasses the LLM and hits Postgres directly: `WHERE pinned_tags @> ARRAY[...]`. This exists for the case where inference — with or without a hint — still isn't returning what the user wants.

                                                                                                                     ---

                                                                                                                     ### 5. INTERFACE & RENDERING MODEL

                                                                                                                     - **Default:** conversational markdown, always. No user action is ever only visible via a specialist surface.
                                                                                                                     - **Specialist surfaces:** shopping lists, calendar, recipes — domains with a natural tabular/board shape — get a Notion mirror. Raw notes stay chat/vector-only; there is no natural "specialist view" for them and none is planned.
                                                                                                                     - **Sync direction:** two-way, but Notion is never trusted. Inbound webhooks are treated as untrusted external writes, identical in kind to an inbound email — parsed via the same deterministic/LLM-assisted pipeline, matched to a `user_id` and row via `notion_sync_map`, never inferred from payload content.
                                                                                                                     - **Hop button:** server-constructed, view-scoped Notion deep link (e.g. filtered to unchecked shopping items), not a static workspace link. Always presented alongside a chat confirmation, never in place of one.

                                                                                                                     **Source vs. mirror — not symmetrical, and GitHub is two different things depending on the repo.** Notion and GitHub sit on opposite sides of the canonical relational store in general, but "GitHub" isn't one relationship:
                                                                                                                       - **Notion is a mirror.** Postgres data flows *out* to it. Notion is reconstructible; if wiped, it's rebuilt from Postgres.
                                                                                                                         - **The `docs` repo is the platform's own storage, git-backed.** It's not a foreign integration — it's where authored documents canonically live, per §3's `documents` table design. The platform is permitted to write here, deliberately and only on explicit user action (e.g. a chat-initiated "save this to docs"). It never authors or edits a doc autonomously.
                                                                                                                           - **Any other repo (application code, unrelated projects) is a true external source.** Read-only, same as before — the platform has no more business writing there than it does in someone else's Notion workspace.

                                                                                                                             The distinction that matters isn't "GitHub vs. not GitHub" — it's **platform-owned storage vs. external system**, regardless of which host it happens to sit on. Write scope is granted per-repo, not per-service.

**Addition — the Open WebUI integration boundary.** Open WebUI (the chosen interface layer, Phase 4) ships a lot of its own extensibility surfaces beyond being a chat window. Deciding which of those to actually use came down to one question per feature: does it own a second copy of bigBrain's data, or is it just UI/text? The former is rejected regardless of how convenient it looks; the latter is fair game.

*Using:*
- **The chat UI itself** (streaming, markdown, mobile layout, history, search) — no reason to rebuild or fork something already good.
- **Models connection** (`/v1/models` + `/v1/chat/completions`) — the core integration since Phase 4.
- **Trusted-header SSO** (`WEBUI_AUTH_TRUSTED_EMAIL_HEADER`, Cloudflare Access) — no second password beyond the household's existing Google OAuth.
- **Tools, via an OpenAPI tool-server connection** (`orchestrator/src/server/openApiToolServer.ts`): `GET /v1/tools/openapi.json` (a spec generated mechanically from the existing `ToolRegistry` — every tool's JSON-Schema `parameters` already *is* an OpenAPI request-body schema) plus `POST /v1/tools/:name`, authenticated identically to chat completions, bypassing `runTurn` entirely — the external caller's own model already decided which tool and with what arguments. Chosen over Open WebUI's native **MCP** support specifically because Open WebUI's own docs describe MCP as admin-gated and running "inside Open WebUI's trust boundary with the connecting user's full scope" (stateful, capable of host command execution over its transport) — heavier than bigBrain's stateless, already-scoped action set needs. OpenAPI tool servers are Open WebUI's own stated preferred path "for most deployments."
- **Skills** (verified against the actual running backend, `open_webui/models/skills.py` / `utils/middleware.py`, not just docs): a named block of reusable plain-text `content`, with no execution and no external call — the opposite kind of thing from a Tool. Either explicitly mentioned inline (`<$skillId|label>`, pulling the full `content` into that turn) or attached to a model's own metadata (`skillIds`), in which case every conversation with that model gets a short `<available_skills>` listing (id/name/description only) so the model can reach for one without the full content costing tokens on every turn. Used to hold reusable procedural guidance (e.g. a meal-planning workflow: check `get_recipes` before proposing a plan, don't repeat a meal within N days, offer to generate a shopping list afterward) attached to bigBrain's own model connection — modular behavioral guidance, not baked permanently into one giant system prompt.
- **Folders' system-prompt field** — cheap, per-context text injection, no data-ownership question.

*Not using, and why:*
- **Knowledge** (Open WebUI's own file/RAG store) — a second, separate embedding store. Using it means either duplicating notes into an unsynced second copy, or running two independent retrieval passes stacked on top of each other. `unstructured_notes`/`documents` (§6.1) stay the one source of truth.
- **Notes** (Open WebUI's own built-in note-taking) — same problem as Knowledge: a second place notes could live, disconnected from `ingest_note`. Real notes go in via chat.
- **Calendar, Channels** (newer Open WebUI features) — Calendar would directly conflict with the explicitly parked Communications Gateway (§6.3); Channels is team-chat, not relevant at household scale.
- **Open Terminal** (newer Open WebUI feature) — real host/terminal access from a chat UI. Flagged explicitly to stay off regardless of version; a genuine risk surface, not a knob to enable casually.

*Considered and rejected: forking Open WebUI.* Forking means owning its entire codebase going forward (its RAG pipeline, its own auth/migration system, its admin panels) for the ~10% actually used, permanently welding the interface layer to one upstream project's internals — the opposite of "Interface Layer is Replaceable" above. A minimal from-scratch frontend was also considered and shelved for the same reason in spirit: the existing chat UI is already good, and the actual pain point (no onboarding, generic suggested prompts) has a much cheaper fix — custom Prompts — than rebuilding a chat interface from zero.

                                                                                                                             ---

                                                                                                                             ### 6. MICROSERVICE PLUGIN SPECIFICATIONS

                                                                                                                             #### 6.1 Document Ingestion Pipeline & Auto-Taxonomy
                                                                                                                             Unchanged from v1, with tag output now split at write time:
                                                                                                                             ```json
                                                                                                                             {
                                                                                                                               "category": "string",
                                                                                                                                 "auto_tags": ["string", "string", "string"],
                                                                                                                                   "summary_short": "string"
                                                                                                                                   }
                                                                                                                                   ```
                                                                                                                                   `pinned_tags` are never written by this pipeline — only promoted from `auto_tags` by explicit user action, or added directly by the user.

                                                                                                                                   #### 6.2 Chronological Shopping Analytics Engine
                                                                                                                                   Corrected query — `days_between_purchases` does not exist as a stored column; it's derived via window function before aggregation:
                                                                                                                                   ```sql
                                                                                                                                   WITH deltas AS (
                                                                                                                                     SELECT
                                                                                                                                         item_name,
                                                                                                                                             timestamp - LAG(timestamp) OVER (
                                                                                                                                                   PARTITION BY item_name ORDER BY timestamp
                                                                                                                                                       ) AS days_between
                                                                                                                                                         FROM shopping_logs
                                                                                                                                                           WHERE user_id = $1
                                                                                                                                                           )
                                                                                                                                                           SELECT item_name, COUNT(*), AVG(days_between)
                                                                                                                                                           FROM deltas
                                                                                                                                                           GROUP BY item_name;
                                                                                                                                                           ```

                                                                                                                                                           #### 6.3 Unified Communications Gateway (Google Calendar & Gmail)
                                                                                                                                                           Email parsing is upgraded from string-matching to LLM-based structured extraction, matching the ingestion pipeline's pattern — a forced-schema call against the email body rather than a brittle substring search (e.g. "Order Confirmation"), so it tolerates vendor template changes.

                                                                                                                                                           #### 6.4 Notion Sync Gateway *(built, revised from the original sketch below during Phase 8)*
                                                                                                                                                           Syncs `list_items` (the generic `lists`/`list_items` primitive, not `shopping_logs`/`recipes_meals`/calendar tables — those either don't exist yet or were deliberately never wired to Notion) into one Notion database ("bigBrain Lists": `Item`/`List`/`Done`/`Completed At` properties), scoped to one Notion workspace tied to one owning bigBrain user (`BIGBRAIN_NOTION_OWNER_USER_ID`) — not a separate workspace per household member.

                                                                                                                                                           - **Outbound** (`orchestrator/src/io/notion.ts`, `plugins/lists/src/notionSync.ts`): `add_list_item`/`complete_list_item` push to Notion right after their Postgres write succeeds — best-effort, never fails the tool call if Notion is unreachable. Mint-and-stamp identity, same trust model as CNZ: `notion_sync_map` is the only place a `list_items` row is linked to a Notion page, keyed by `(source_table, source_row_id)`; first sync creates the page and mints the mapping, later syncs update the existing page by looked-up `notion_page_id`. Rate-limited to Notion's ~3 req/sec via a simple serializing throttle, not a durable queue — an unsynced write during a process restart just stays unsynced until the next edit touches that row.
                                                                                                                                                           - **Inbound** (`plugins/lists/src/notionReconcile.ts`): **polling** (~30s), not webhooks — despite Notion's webhook system existing and being confirmed available, polling avoids exposing a new public inbound route (the orchestrator accepts zero unauthenticated inbound traffic) and avoids webhook payload signature verification, for a household-scale feature where the delay is imperceptible. Adopts **only** a page's Done/Completed-At state into Postgres — never its Item/List (name) properties, which stay authoritative in Postgres; renaming in Notion is simply overwritten by the next outbound push. A page with no matching `notion_sync_map` row (typed directly into Notion, not yet tracked) is adopted as a brand-new item, attributed to the owning user — this is deliberately different from CNZ's orphan-*purge* pattern, since here an "orphan" is a legitimate new item, not stale state to discard.
                                                                                                                                                           - **Reconciliation / the race that was actually caught live:** Postgres always wins on divergence — no LLM-guessed merges. Outbound sync creates the Notion page, *then* inserts `notion_sync_map` — a real window exists between those two steps where an inbound poll landing in it sees the brand-new page as unmapped and would otherwise adopt it a second time, producing a duplicate `list_items` row for one Notion page. Fixed with a unique constraint on `notion_sync_map.notion_page_id` (`db/migrations/0005_notion_sync_map_page_unique.sql`) plus per-page transactions in the reconciliation poll (not one transaction for the whole batch), so a conflict on one page is logged and skipped without rolling back everything else that poll would have reconciled.

                                                                                                                                                           <details><summary>Original sketch (superseded above)</summary>

                                                                                                                                                           - **Outbound:** on writes to `shopping_logs` / `recipes_meals` / calendar-adjacent tables, an async, queued push (respecting Notion's ~3 req/sec rate limit) updates the mapped Notion database row, creating a `notion_sync_map` entry if none exists.
                                                                                                                                                           - **Inbound:** Notion webhooks are received, matched against `notion_sync_map` to resolve `user_id` and target row, and written back through the same IO-wrapper layer as any other tool — never given direct write access, never trusted to self-report whose data it is.
                                                                                                                                                           - **Reconciliation:** if Postgres and Notion state diverge, the resolution is always "re-push from Postgres" — Notion is never treated as authoritative, and no reasoning is invoked to guess the "correct" merged state.

                                                                                                                                                           </details>

                                                                                                                                                           #### 6.5 Recipes & Meal Planning *(built)*
                                                                                                                                                           Six tools (`plugins/recipes`), no Notion surface of their own — meal-plan-generated groceries ride the existing `lists`/`list_items` primitive and its Notion sync (§6.4) rather than getting a separate gateway.

                                                                                                                                                           - **`import_recipe(url | raw_text)`:** cheap-and-precise before expensive-and-fuzzy, same ordering as the write-time hint/inference fallback elsewhere. A `url` is fetched and checked first for embedded `schema.org/Recipe` JSON-LD (`plugins/recipes/src/schemaOrgRecipeParser.ts`) — the same structured data virtually every serious recipe site embeds for Google's rich-snippet requirement, verified live against a real page's actual markup rather than assumed from the spec. Only when that's missing or incomplete (or when `raw_text` was given directly, e.g. a pasted recipe with no source page) does it fall back to a forced-schema LLM extraction call (`extractRecipeWithLlm.ts`, mirroring `classifyNote.ts`'s pattern exactly).
                                                                                                                                                           - **`get_recipes` / `get_recipe`:** list-summary and full-detail reads, matched by case-insensitive name like every other chat-facing lookup in this platform (`findOrCreateList`, `complete_list_item`).
                                                                                                                                                           - **`add_meal_plan_entry` / `get_meal_plan`:** application-level upsert on `(user_id, planned_date, meal_label)` — replanning a date replaces rather than duplicates, but two different labels on the same date (the Christmas case) coexist deliberately.
                                                                                                                                                           - **`generate_shopping_list_from_meal_plan`:** aggregates ingredient strings across every recipe planned in a date range, dedupes case-insensitively (no quantity math/unit conversion — `list_items` has no quantity column, and unit arithmetic is exactly the kind of complexity this project keeps deciding to punt on, per the lists-vs-inventory decision above), skips ingredients already pending on the target list, then writes through the same find-or-create-list-and-sync-to-Notion primitive `plugins/lists` uses. Duplicated rather than imported across the plugin boundary — plugins are siblings with no exports map for cross-plugin imports today, and it's a small enough amount of logic that a first-ever plugin-to-plugin dependency wasn't worth introducing for it.
                                                                                                                                                           - **Live-tested end to end:** a real RecipeTin Eats URL imported via the deterministic JSON-LD path (28 ingredients, 5 instruction sections, tags/times/servings all matching the page's own structured data), planned for a real date, and turned into a real Notion-synced shopping list — which is exactly how the Correction 5 owner-check gap above was caught, and then re-verified clean using the `bb-test` account after the fix.

                                                                                                                                                           #### 6.6 GitHub Ingestion Gateway *(new)*
                                                                                                                                                           - **Trigger:** GitHub webhook on push to the private `docs` repo (preferred), or scheduled poll as a fallback.
                                                                                                                                                           - **Diffing:** compares the incoming commit SHA against each affected file's `last_synced_sha` in `documents`; only changed or new files are processed. Unchanged files are skipped entirely — no full-repo reprocessing on every push.
                                                                                                                                                           - **Processing:** each changed markdown file is read, chunked, and passed through the same forced-schema structural evaluation as note ingestion (§6.1) to produce a `summary_short` and embedding. The `documents` row is upserted with the new `last_synced_sha`.
                                                                                                                                                           - **Deletions:** a file removed from the repo does not delete its `documents` row — it's marked `status = stale`. Git history is the record of true deletion; a stale index entry is a safer failure mode than a chat query silently losing a document it can no longer find.
                                                                                                                                                           - **Scope:** repo-scoped, not host-scoped. Read-only against any connected code repo. Write access exists only for the designated `docs` repo, and only as a deliberate, user-initiated action (e.g. "save this spec to docs") — never autonomous authoring by the LLM, consistent with §5's platform-owned-storage-vs-external-source distinction.

                                                                                                                                                           ---

                                                                                                                                                           ### 7. NETWORK INGRESS & SECURITY POLICIES

                                                                                                                                                           Unchanged from v1 (perimeter closed, Cloudflare Tunnel, Access-layer OAuth check), plus:

                                                                                                                                                           - **Row-Level Security** enforced in Postgres per §3, not just at the app layer.
                                                                                                                                                           - **Notion trust boundary:** inbound sync traffic is scoped via `notion_sync_map`, never via claims in the payload itself.
                                                                                                                                                           - **Reasoning-layer portability:** credentials and prompts are structured so switching LLM providers touches configuration, not the security model.

                                                                                                                                                           **Correction 6 — the orchestrator gets one public, human-facing hostname.** `bigbrain.your-domain.example` (Traefik + Cloudflare Access, `docker-compose.yml`) fronts the orchestrator's HTTP server directly — for now, the admin credential-rotation page (§ Provider Credentials, `orchestrator/src/server/adminPage.ts`); planned to grow into a data verification/visualization surface for household members. This is additive, not a reversal of §6.4's "zero unauthenticated inbound traffic" rationale for choosing Notion polling over webhooks — that choice is about *unauthenticated* traffic specifically, and nothing about this hostname is unauthenticated: Cloudflare Access requires a Google login before a request ever reaches Traefik, same gate as `webui.your-domain.example`, and every route underneath still enforces its own bearer token exactly as before (`BIGBRAIN_ADMIN_API_KEY` for `/v1/admin/*`, `BIGBRAIN_API_KEYS` for chat/tools) — Access adds a household-identity check in front, it doesn't replace app-level auth. Open WebUI's own traffic is unaffected: it still reaches the orchestrator over `traefik-net` by container name, never through this hostname.

                                                                                                                                                           ---

                                                                                                                                                           *Open items for next pass: composite-query rendering when a request spans two specialist domains (recipe + shopping in one ask); whether `pinned_tags` needs its own promotion UI or is edited inline on the note.*
                                                                                                                                                           