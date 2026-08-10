# SYSTEM SPECIFICATION v1: BIGIMAGINE ROLEPLAY ENGINE
## ARCHITECTURE: MANIFEST-DRIVEN TOOL REGISTRY WITH RELATIONAL DATASTORE AND REPLACEABLE SURFACES

*Governed by `bi_principles.md`. Where this spec and the principles disagree, the principles win — update this spec.*

*Status tags used throughout: **(built)** is live today, **(designed)** is spec'd but not implemented, **(parked)** was scoped and deliberately shelved. Everything in this v1 document is **(designed)** unless marked otherwise — this is a fork of bigBrain's spec, not bigBrain's build log, so there is no history to report yet.*

---

### 1. SYSTEM OVERVIEW

This specification defines the architecture for a self-hosted, single-user interactive fiction and roleplay platform, forked from the bigBrain core engine and re-pointed at narrative instead of household data. It replaces a personal SillyTavern installation: native relational storage and `pgvector` semantic recall stand in for ST's flat JSON files, regex keyword lorebooks, and DOM-injected extensions.

The platform bakes in, as native features rather than bolted-on extensions, the functionality of three previously separate SillyTavern extensions:

- **Canonize** → approved Canon Facts, with human-in-the-loop proposal review.
- **Vistalyze** → Locations, with cached generated background imagery.
- **Triggeryze** → Rules and Status Effects, with conditional context injection.

The central design commitment, carried over unchanged from bigBrain: **all reasoning happens server-side, behind a stable API. Every client — the React chat UI, or anything that replaces it later — is a replaceable consumer of that API, never a participant in it.**

---

### 2. CORE ARCHITECTURAL PRINCIPLES

*(Full detail in `bi_principles.md`; summarized here as they bear on this spec.)*

- **Data-First Priority:** The relational store is the canonical narrative record. Any export (a character PNG card, a generated image) is reconstructible from it — never the reverse.
- **Reasoning Stays Server-Side:** The LLM is the only component that classifies, infers, or judges — including which character speaks next (the Director Pass).
- **Scene-Scoped, Never Content-Scoped:** Which characters, location, rules, and canon apply to a turn comes from trusted scene state, never from parsing the message text.
- **Canon Requires Approval:** An extracted fact is a proposal until explicitly approved. Only approved facts are ever injected into a prompt.
- **Injected Context is Bounded:** Every status effect, rule, and canon fact injected into a turn traces back to a row and is individually removable.
- **The Prompt Stack Assembler is Pure:** Identical scene state always produces an identical assembled prompt — the property that makes prompt caching actually work.
- **Reasoning and Interface Layers are Replaceable:** No prompt, tool manifest, or orchestration logic depends on one LLM vendor or one frontend.
- **Chat is the Default:** Every turn happens in the cinematic chat view. The Inspector Canvas, Roster, and canon queue are always additive.

---

### 3. WHAT WAS PRUNED FROM BIGBRAIN

Removed wholesale from the forked codebase before any narrative feature work began:

- **Security & multi-tenancy (aspirational, not yet done)** — the eventual single-user conversion would drop Row-Level Security policies, session user-scoping functions, and Cloudflare Access SSO, with every `user_id` column removed rather than kept unused. **This has not happened and is not scheduled** — every table added since the fork (`characters`, `locations`, `scenes`, `scene_presence`, `canon_facts`, and everything before them) still carries `user_id` under the same `user_scoped` RLS policy bigBrain used, and per `docs/canonize-plan.md` §3.1 this is a deliberate standing deviation, not an oversight. Single-user conversion is a distinct, separately-decided future step — not bundled into "what gets pruned" — and should not be assumed by new schema work.
- **Field-level encryption** — `unstructured_notes`-style AES-256-GCM wrapping. All narrative text stays plaintext and searchable; there is no household member to protect it from.
- **Household plugins** — recipes, meal planning, shopping lists/analytics, calendar, Notion sync, Google Calendar OAuth, ntfy push.
- **Admin overhead** — the encrypted credential vault's multi-user surface, the offsite backup pipeline's household-scale retention logic (a simpler single-user backup, if wanted, is a later decision, not carried over by default).

What's kept unmodified: the orchestrator's tool-registry/agentic-loop shape, the LLM gate (`bi_principles.md` §14), the four-kinds-of-code discipline, and the module-preamble convention (`docs/conventions.md`).

---

### 4. RELATIONAL SCHEMA (POSTGRESQL + PGVECTOR)

```
+----------------------+          +----------------------+
|      CHARACTERS      |          |       LOCATIONS       |
+----------------------+          +----------------------+
| PK | character_id      |          | PK | location_id       |
|    | name                |          |    | name                |
|    | persona              |          |    | visual_description  |
|    | scenario              |          |    | environment (jsonb) | (time_of_day, weather, mood)
|    | system_prompt          |          |    | seed                 |
|    | example_dialogue        |          |    | image_path           |
|    | greetings (jsonb array)  |          |    | image_generated_at    |
|    | avatar_path                |          +----------------------+
|    | spec_version ('v2'|'v3')     |                    ^
|    | source_json (jsonb)            |                    |
|    | created_at, updated_at            |                    |
+----------------------+                       |
                                        |
                        +----------------------+           |
                        |        SCENES        |-----------+
                        +----------------------+  active_location_id (FK, nullable)
                        | PK | scene_id           |
                        |    | name                 |
                        | FK | active_location_id     |
                        |    | created_at               |
                        |    | last_active_at             |
                        |    | archived_at                  |
                        +----------------------+
                                |
                                | (M:N via junction)
                                v
                        +----------------------+
                        |    SCENE_PRESENCE     |
                        +----------------------+
                        | FK | scene_id            |
                        | FK | character_id           |
                        |    | joined_at                |
                        |    PK (scene_id, character_id) |
                        +----------------------+
```

**Characters.** `source_json` holds the original imported V2/V3 card verbatim (unparsed fields included) so export is a lossless round-trip, not a lossy reconstruction from the columns the platform happened to use (Principle 7). `greetings` is an array — cards commonly ship several alternate openers.

**Scenes & Presence.** `scene_presence` is the many-to-many "who's in the room" table the Director Pass reads before selecting a speaker. A scene has at most one `active_location_id`; moving between locations is an update to this single pointer, not a new scene.

**Locations (Vistalyze, native).** `image_path` is cache, not source — `visual_description` plus `environment`/`seed` are what regenerate it. Returning to a previously visited location reuses the cached image instantly; nothing re-generates on revisit unless the description or environment actually changed.

```
+----------------------+          +----------------------+
|      CANON_FACTS     |          |     RULES            |
+----------------------+          +----------------------+
| PK | fact_id            |          | PK | rule_id           |
| FK | scene_id (nullable)   |          | FK | scene_id (nullable, null = global) |
|    | category ('place'|'thing'| |          |    | trigger_condition  |
|    |   'concept'|'person'|'plot') |          |    | description         |
|    | arc_tag (nullable, required |          |    | active (boolean)     |
|    |   iff category='plot')      |          +----------------------+
|    | summary                 |
|    | detail                    |
|    | vector_embed (Vector)       |
|    | status                        |
|    |   ('proposed'|'approved'|       |
|    |    'rejected')                    |
|    | linked_character_ids (uuid[])        |
|    | linked_location_id (FK, nullable)     |
|    | proposed_at, approved_at                |
+----------------------+

+----------------------+
|    STATUS_EFFECTS    |
+----------------------+
| PK | status_id          |
|    | target_type ('character'|'location') |
|    | target_id             |
|    | label                   |
|    | description               |
|    | event_payload (jsonb)       |
|    | applied_at                    |
|    | expires_at (nullable)            |
+----------------------+
```

**Canon Facts (Canonize, native).** `status` is the human-in-the-loop gate (`bi_principles.md` §15): a background extraction step writes `'proposed'` rows after a turn; only an `'approved'` row is ever selected into a prompt or a vector-similarity query. `'rejected'` rows are kept (not deleted) as a record of what was proposed and turned down, so the extraction step's own behavior stays auditable. `vector_embed` enables semantic recall scoped to present characters/location, replacing keyword lorebooks entirely — there is no keyword-match fallback anywhere in this schema. `category` is a MECE curator tag; `arc_tag` (required only for `category = 'plot'`) keeps a continuing plot thread's successive proposals linked without an in-place `UPDATE` — every proposal for the same `arc_tag` gets its own row, kept forever, and `recall_canon_facts` selects only the most-recently-approved row per `arc_tag` at read time (`docs/canonize-plan.md` §3.2).

**Rules & Status Effects (Triggeryze, native).** A `rules` row with `scene_id = null` is a global world rule; a scoped one applies only within its scene. `status_effects` is polymorphic over `target_type`/`target_id` (a character or a location can carry one) rather than two near-identical tables, since the shape — label, description, an optional expiry, an optional event payload — is identical either way. `expires_at` is what keeps `bi_principles.md` §16 (injected context is bounded) mechanically true: an expired status stops being selected into the prompt stack without any cleanup job needing to delete the row.

```
+----------------------+          +----------------------+
|     CHAT_SESSIONS    |          |     CHAT_MESSAGES      |
+----------------------+          +----------------------+
| PK | chat_id             |<---------| FK | chat_id            |
| FK | scene_id               |          | PK | message_id          |
|    | params (jsonb)            |          | FK | speaker_character_id | (nullable — null = user/narrator)
|    | parent_chat_id (nullable)     |          |    | role ('user'|'assistant'|'system') |
|    | fork_message_id (nullable)       |          |    | content                |
|    | archived_at (nullable)              |          |    | created_at               |
+----------------------+          +----------------------+
        |
        | (1:N)
        v
+--------------------------+
|   CHAT_MEMORY (adapted     |
|   from bigBrain's own,     |
|   itself adapted from      |
|   Canonize — see §4.1)       |
+--------------------------+
```

**Chat & memory.** `chat_sessions`/`chat_messages`/branching (`parent_chat_id`/`fork_message_id`) carry over from bigBrain's own chat tab unchanged in shape — that system was already adapted from Canonize once (`docs/chat-memory.md`, pending its own BigImagine-specific pass, out of scope for this revision). `speaker_character_id` is the one real addition: a message either came from the user/narrator (`null`) or from a specific character, which is what lets a multi-character scene's transcript reconstruct who said what without re-deriving it from `content`.

#### 4.1 Chat Memory — reused pattern, narrative framing

bigBrain's rolling summarization/RAG/digest system was itself adapted from Canonize's pattern once already (`docs/chat-memory.md`), then reshaped around bigBrain's relational store being the canonical world model. BigImagine inherits that same reshaped version, keyed by `scene_id` instead of a household:

- Full-turn recall stays an explicit tool call (`recall_chat_history`) in the 'chat' lane; the 'rp' lane additionally auto-injects it every turn, CNZ-style, per user decision (2026-08-08) — see `docs/chat-memory.md`'s "The RP Read Path". `bi_principles.md` §2 holds everywhere except that one documented carve-out.
- The per-scene "key ideas" digest and chat-lane RAG chunks replace ST's keyword lorebook the same way approved Canon Facts do (§4 above) — this is a second, complementary recall path (recent-history-shaped) alongside Canon Facts' (fact-shaped) semantic recall, not a duplicate of it.
- Branching is a new `chat_sessions` row constructed correct from birth, not a divergence-detection system — unchanged rationale from bigBrain, since this platform owns every mutation to its own `chat_messages` exactly as bigBrain does.

`docs/chat-memory.md` itself still describes the household framing and needs its own BigImagine pass; this section is the authoritative narrative-framed summary until that happens.

---

### 5. THE AGENTIC INTERACTION LOOP

A multi-character scene turn:

```
User / Narrator          Orchestrator              LLM (Director)          LLM (Character)         Vistalyze/Triggeryze IO
       |                       |                          |                        |                          |
       |--(1) Message--------->|                          |                        |                          |
       |                       |--(2) Scene state--------->|                        |                          |
       |                       |    (presence, location,   |                        |                          |
       |                       |     active rules/statuses) |                        |                          |
       |                       |<--(3) Speaker selection----|                        |                          |
       |                       |--(4) Assemble prompt stack-|-----------------------|                          |
       |                       |    (pure function, §6)     |                        |                          |
       |                       |--(5) Generate turn------------------------------->|                          |
       |                       |<--(6) Character reply-----------------------------|                          |
       |                       |--(7) Background: fact extraction, rule evaluation-|------------------------->|
       |                       |                          |                        |    (proposals, status     |
       |                       |                          |                        |     changes, new image     |
       |                       |                          |                        |     if location changed)   |
       |<--(8) Render reply---|                          |                        |                          |
```

1. **Director Pass (speaker selection).** The LLM evaluates scene state — who's present, what just happened — and picks the next speaker. A judgment call, per `bi_principles.md` §2; never a hardcoded round-robin.
2. **Context Assembly (the pure function).** Fixed order, always: System Prompt + Global Rules → speaking character's Persona/Scenario → active Location's visual description → approved Canon Facts for present entities → that character's own memory recall → recent on-scene history. Identical scene state always yields an identical stack (`bi_principles.md` §17) — this is what makes step 5 below actually cheap.
3. **Generation.** Because the stack's static prefix (rules, location, canon, history) is identical across every character's turn in the same scene, a caching-capable provider (e.g. DeepSeek Flash) reads that prefix at a steep token discount on every character after the first.
4. **Background evaluation.** After the reply, rule triggers are evaluated and canon-fact proposals are extracted — both write rows, neither injects anything into the prompt until a human approves it (canon) or a rule's own trigger condition is met (status effects). A rule cascade may prompt Vistalyze to regenerate a location's image if the scene moved somewhere new.

Every LLM call in this loop — director, character generation, fact extraction, rule evaluation — passes through the one gate (`bi_principles.md` §14) carrying a task id scoped to the turn, so a scene's actual per-turn cost (several calls, most of them cache-discounted) is accountable as one unit.

---

### 6. INTERFACE & RENDERING MODEL

- **Default: the cinematic chat view**, always. The active location's image renders as a styled background behind the conversation; message bubbles carry the usual swipe/rerun/edit/delete controls. No story action is ever visible only through a specialist surface (`bi_principles.md` §5).
- **Avatar & status badges.** Character avatars render alongside their turns, with active Triggeryze status badges and relationship indicators layered on top — sourced directly from `status_effects` and approved `canon_facts`, never a separate display-only copy of that state.
- **The Inspector Canvas.** A split-screen HUD panel (the same tool-driven `focusHint` mechanism bigBrain's own Canvas uses, generalized beyond notes) showing on-scene character cards, active location metadata, active rules/statuses, and the pending canon-fact approval queue. Opens when a tool call touches something canvas-worthy; approving or rejecting a proposal here is the human-in-the-loop step `bi_principles.md` §15 depends on.
- **Character Roster.** The management surface for creating, editing, and organizing character cards: drag-and-drop PNG/JSON import (chunk-parsed into `characters` columns plus a verbatim `source_json`), a URL/raw-text importer with LLM-fallback extraction, and an export path that repacks a row back into a spec-compliant V2/V3 PNG — the mechanical proof of `bi_principles.md` §7's portability requirement.

---

### 7. PLUGIN SPECIFICATIONS

#### 7.1 Canonize (native)

- `propose_canon_fact` — background tool, called after a turn; writes a `'proposed'` row, never selectable into a prompt.
- `approve_canon_fact` / `reject_canon_fact` — human-in-the-loop, called from the Inspector Canvas's approval queue.
- `get_canon_fact_proposals` — lists `status = 'proposed'` rows for the approval queue (§9); never selectable into a prompt.
- `recall_canon_facts` — semantic search scoped to present characters/location, `status = 'approved'` only. This is the platform's entire lorebook-replacement mechanism; there is no keyword-triggered fallback.

#### 7.2 Vistalyze (native)

- `set_active_location` — updates `scenes.active_location_id`; the only way a scene's location changes.
- `generate_location_image` — interfaces with a configurable image backend (local ComfyUI/Automatic1111, or a cloud API — provider swap is a config change per `bi_principles.md` §6). Writes `locations.image_path`/`image_generated_at`.
- **Cache-first.** Before generating, checks whether the location's `visual_description`/`environment`/`seed` have changed since the last generation. Unchanged → reuse the existing `image_path`, no call made. This is the platform's main image-cost control, not a nice-to-have.

#### 7.3 Triggeryze (native)

- `apply_status_effect` / `clear_status_effect` — direct mutation of `status_effects`, always carrying an explicit `expires_at` or an explicit "no expiry, cleared manually" choice — never an ambiguous default.
- `evaluate_rules` — background tool, checks each active rule's `trigger_condition` against current scene state after a turn; a match can apply a status effect, update a character/location field, or call `generate_location_image`.
- Active, unexpired status effects are injected into the prompt stack (§5 step 2) as short instructions; an expired one stops being selected automatically — no separate cleanup pass needed, per `bi_principles.md` §16.

#### 7.4 Context Stack Presets

- `create_context_stack_preset` / `get_context_stack_presets` / `update_context_stack_preset` /
  `delete_context_stack_preset` — full CRUD over `context_stack_presets` and their ordered
  `context_stack_slots`. Standard `user_scoped` RLS, plus a read-only carve-out: two shipped
  built-in presets (`Standard`, `Minimal`) are visible to every user via a `select`-only policy
  gated on `is_builtin = true`, but not editable or deletable by anyone but the fixed system owner
  — an edit/delete against a builtin id simply returns zero rows, the same "not found" a caller
  gets for an id that never existed.
- **Slot vocabulary.** A slot is either `marker` (injects one named field: `system`,
  `description`, `personality`, `scenario`, `mes_example`, `post_history_instructions`,
  `global_rules`, `location`, `canon_facts`, `memory_recall`, `recent_history`) or `custom` (a
  static block with its own caller-chosen role). The marker vocabulary deliberately reuses V2/V3
  character-card field names — a freshly imported card assembles into a coherent stack immediately,
  with no separate mapping layer between "card field" and "prompt slot."
- **The assembler is a pure function.** `assemblePromptStack(fields, slots)` (`plugins/
  context-stack-presets/src/assemblePromptStack.ts`) takes a flat `fields` object (one string per
  marker, including `recent_history` — since 2026-08-10 this one is live-rendered by the narrator
  path from the live-window turns, but it still reaches the assembler as one pre-rendered string)
  and the preset's ordered `slots`, and returns
  the `LlmMessage[]` to send. It never queries the database itself — whatever resolves a turn's
  active preset (an Orchestrator, once `scenes`/`characters` exist) hands it plain data. This is
  what makes §5 step 2's fixed order into saveable, swappable data without breaking `bi_principles.
  md` §17's purity requirement: the assembler's own determinism doesn't depend on where `fields`
  came from.
- **Deferred (not yet wired):** `scenes.active_context_stack_preset_id` / a per-character override
  — both need the `scenes`/`characters` tables this plugin was built ahead of (`docs/bootstrap.md`).
  Until those land, `assemblePromptStack` is a working, tested pure function with no caller in the
  actual turn loop; §5 step 2's fixed order remains the literal live behavior. Resolution order
  once wired: character override → scene default → builtin (`Standard`). The Director Pass /
  `invoke_character` tool this eventually feeds is likewise out of scope here.

---

### 8. NOT YET DESIGNED

Flagged here rather than silently deferred, so a future session doesn't have to rediscover the gap:

- **Multi-scene concurrency UX** — the schema supports multiple `scenes` rows, but the frontend's scene-switching interaction hasn't been designed.
- **`docs/chat-memory.md`'s own BigImagine pass** — §4.1 above is the authoritative narrative-framed summary for now; the source doc still describes bigBrain's household framing.
- **Single-user backup strategy** — bigBrain's offsite backup pipeline was pruned wholesale (§3); whether BigImagine wants a simpler equivalent is an open, not-yet-raised question.
