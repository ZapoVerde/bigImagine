# Implementation Plan — Cards, Chat Lineages, and Runtime Characters

> Purpose: turn `1_ARCHITECTURAL_REPORT.md` and `2_BLUEPRINT.md` into an ordered set of independently implementable and independently reviewable coding tasks.
>
> This is the handoff artifact for `docs/coding-loop/CODING_HARNESS.md`. The harness must execute one ready task at a time, freeze a Task Contract before coding, run deterministic verification, obtain independent review, repair findings, then advance.

## 1. Mission Summary

BigImagine currently stores reusable Cards and runtime Characters in one `characters` domain and uses `chat_sessions.character_id` to mean the Card that started an RP. This mission separates Cards into their own canonical domain while preserving the intended runtime model: every independently started RP has its own Character population, forks may share Characters through `character_chat_links`, Card fields remain live-read by linked RPs, and deleting a Card deletes every dependent RP before normal membership/orphan cleanup removes its runtime Characters.

The governing intent is `docs/plans/cards-runtime-characters/1_ARCHITECTURAL_REPORT.md`; the repository-grounded scope and API deltas are `docs/plans/cards-runtime-characters/2_BLUEPRINT.md`.

## 2. Validation Classification

This change is architectural and persistence-heavy. Most implementation tasks are **Tier 3 — Critical** because they touch canonical domain models, shared state ownership, high-fan-out interfaces, persistence, migration, and cross-domain lifecycle behaviour.

Presentation-only or compatibility cleanup tasks may be Tier 2 where they do not alter ownership or persistence.

## 3. Implementation Phases

The plan deliberately uses additive intermediate states before destructive cleanup. Temporary compatibility is allowed only while later tasks still depend on it. The final phase removes the old Card-as-Character representation completely.

---

# Phase 1 — Establish the Card Domain Without Breaking Existing Runtime Paths

**Phase objective:**  
Create the canonical Card persistence/domain and migrate existing Card-owned data into it while leaving current Card-as-Character consumers temporarily functional.

**Phase completion condition:**  
Every existing reusable Card has an equivalent canonical Card record; Card-owned supporting content can be associated with Cards; existing RP chats have an explicit Card reference; no runtime Character row or `character_chat_links` membership has been altered; the application can still run before consumer cutover.

## Task 1.1 — Add Canonical Card Persistence and Backfill Existing Data

### Objective

Add the Card persistence model, explicit chat→Card relationship, and Card-owned lorebook association, and deterministically backfill existing reusable Card rows without yet removing the legacy rows or legacy chat source column.

### Architectural Intent

This creates the canonical Card identity required by AR AC-01/02/03/28 while keeping the branch in an additive, reviewable state until all live consumers have moved.

### Scope

**Create:**
- next `db/migrations/` migration for Cards/domain split foundation

**Modify:**
- `db/migrations/README.md`

**Delete:**
- None

**Expected but unchanged dependencies:**
- `db/migrations/0044_characters.sql`
- `db/migrations/0049_chat_kind.sql`
- `db/migrations/0088_lorebook_runtime.sql`
- `db/migrations/0096_location_character_chat_links.sql`

### Required Logical Changes

#### New migration

- create canonical `cards` storage containing the reusable Card fields currently owned by status-null `characters` rows;
- preserve existing Card UUIDs as `card_id` where practical;
- create the explicit RP chat→Card relationship (`chat_sessions.card_id` or Blueprint-equivalent explicit Card FK);
- backfill `chat_sessions.card_id` wherever the legacy source `character_id` points at a Card/library row;
- create explicit Card-owned association for embedded/imported Card lorebooks rather than reusing `lorebook_character_links`;
- migrate existing Card-linked lorebook associations to the Card association when the linked legacy row is a Card/library row;
- copy existing Card/library rows into `cards` using the current canonical discriminator before any discriminator removal;
- do **not** remove the legacy Card rows from `characters` yet;
- do **not** drop `chat_sessions.character_id` yet;
- do **not** modify runtime `character_chat_links` rows;
- ensure Card references use appropriate user ownership/RLS and FK behaviour;
- preserve current Card delete semantics for later cutover: Card chats are dependent state, not `ON DELETE SET NULL` survivors.

#### `db/migrations/README.md`

- register the migration according to current repository convention;
- document any manual apply command required by the repo's migration workflow.

### Acceptance Criteria

- **T1.1-AC01:** Every legacy Card/library row is copied exactly once into canonical Card storage with its reusable Card fields preserved.
- **T1.1-AC02:** Runtime status-bearing Character rows are not copied into Cards.
- **T1.1-AC03:** Every existing RP chat whose legacy source points at a Card receives the corresponding explicit Card reference.
- **T1.1-AC04:** Forked chats preserve the same Card reference as their source where the legacy relationship already did so.
- **T1.1-AC05:** Existing Card-linked embedded lorebooks gain a Card association without creating any runtime Character relationship.
- **T1.1-AC06:** Existing `character_chat_links` rows are byte-for-byte semantically untouched.
- **T1.1-AC07:** Legacy rows/columns remain available for current code until later cutover tasks.

### Verification

**Automated:**
- add a deterministic migration verification script/fixture covering mixed Card/runtime rows, independent chats, forks, and Card-linked lorebooks;
- run DB migration verification using the repository-standard Postgres test procedure;
- verify RLS/FK constraints for `cards`, chat Card reference, and Card-lorebook association.

**Runtime/manual:**
- inspect representative migrated records and counts against pre-migration source data.

### Constraints & Anti-Patterns

- do not delete legacy Card rows yet;
- do not reinterpret runtime Character rows as Cards;
- do not add `card_id` to runtime `characters`;
- do not create a lineage table;
- no name-based migration/reconciliation;
- no unrelated schema cleanup.

### API Delta

Persistence-only foundation:

- add canonical Cards persistence;
- add explicit chat→Card source relationship;
- add explicit Card-lorebook association;
- legacy interfaces remain temporarily available.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** canonical schema, data migration, shared ownership, foreign-key lifecycle, and RLS.

### Task Completion Boundary

The additive migration is applied and verified; canonical Cards/chat Card references/Card-lorebook associations exist for legacy data; no current application consumer has yet been required to stop using the legacy representation.

---

## Task 1.2 — Create the Canonical Cards Plugin and Card CRUD

### Objective

Introduce a first-class Cards plugin/domain for Card list/detail/create/update/delete while preserving existing Card-delete behaviour through the new explicit Card relationship.

### Architectural Intent

Card operations must operate on Cards, not on runtime Characters. This task establishes the canonical Card API before import/export and frontend consumers move.

### Scope

**Create:**
- `plugins/cards/package.json`
- `plugins/cards/tsconfig.json`
- `plugins/cards/src/index.ts`
- `plugins/cards/src/getCardsTool.ts`
- `plugins/cards/src/getCardTool.ts`
- `plugins/cards/src/createCardTool.ts`
- `plugins/cards/src/updateCardTool.ts`
- `plugins/cards/src/deleteCardTool.ts`
- Card-domain shared row/type helpers as required
- `plugins/cards/scripts/verify-cards.mjs`

**Modify:**
- Card/plugin bootstrap registration surface discovered during pre-contract inspection
- `Dockerfile` if required for plugin package installation/build at this stage
- `package-lock.json`

**Delete:**
- None

**Expected but unchanged dependencies:**
- `plugins/characters/src/index.ts`
- `plugins/characters/src/deleteCharacterTool.ts`
- `db/migrations/0096_location_character_chat_links.sql`

### Required Logical Changes

#### Cards plugin

- expose canonical Card CRUD tools using Card IDs and Card terminology;
- Card list/detail reads only `cards`;
- Card create/update writes only `cards`;
- Card create does not create any runtime Character or chat membership;
- Card update does not mutate runtime Character rows;
- Card delete identifies and deletes every chat carrying that Card reference, returns deleted chat IDs for UI reconciliation, deletes the Card row, and triggers/executes Card-owned media/supporting-content cleanup as appropriate;
- runtime Characters are never selected/deleted by Card ID; they disappear only after chat membership cascades and existing orphan lifecycle rules run;
- tool registration and build wiring make the Cards plugin available in the normal runtime/tool registry.

#### Verification

- prove multiple independent chats and forked chats under one Card are all deleted by Card deletion;
- prove runtime Characters disappear only after their final chat links disappear;
- prove deleting one Card cannot affect chats/Characters under another Card.

### Acceptance Criteria

- **T1.2-AC01:** Card CRUD operates exclusively on canonical Card storage.
- **T1.2-AC02:** Creating/updating a Card never creates or mutates a runtime Character.
- **T1.2-AC03:** Deleting a Card deletes every chat linked to that Card and returns those chat IDs.
- **T1.2-AC04:** Runtime Character deletion resulting from Card deletion occurs only through chat-link/orphan lifecycle.
- **T1.2-AC05:** A Character still linked to a surviving chat cannot be directly deleted by the Card tool.
- **T1.2-AC06:** Cards plugin is registered and production-buildable.

### Verification

**Automated:**
- `plugins/cards/scripts/verify-cards.mjs`;
- affected tool-registry/plugin bootstrap verification;
- package build/typecheck;
- production Docker/plugin build check if plugin enumeration is explicit.

**Runtime/manual:**
- invoke Card CRUD against representative migrated data and inspect deleted-chat result.

### Constraints & Anti-Patterns

- do not remove legacy Character-named Card APIs yet;
- no runtime Character CRUD inside the Cards plugin;
- do not replace chat-link orphan lifecycle with Card-driven Character deletes;
- no frontend migration in this task.

### API Delta

Add canonical Card CRUD surfaces corresponding to Blueprint entries:

- Card list;
- Card detail;
- Card create;
- Card update;
- Card delete returning deleted chat IDs.

Exact tool names must be consistent and Card-named.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** new domain API, deletion lifecycle, plugin/build interface.

### Task Completion Boundary

Canonical Card CRUD is callable and verified against `cards`; legacy Card-as-Character consumers remain operational but are no longer required for new backend Card CRUD.

---

# Phase 2 — Move Card Ingestion, Media, Supporting Content, and RP Start to Cards

**Phase objective:**  
Make every backend Card-specific write/read path target the Card domain, including import/export, Chub, imported media, embedded lorebooks, and Card→chat application.

**Phase completion condition:**  
All backend Card acquisition/export/start-RP behaviour has a canonical Card path; new Card imports never create `characters` rows; live Card consumers can switch without depending on legacy Card rows.

## Task 2.1 — Move Card Codec, Import/Export, Chub, and Imported Media to Cards

### Objective

Move all Card acquisition/export/media responsibilities out of the Characters domain so every newly authored/imported Card exists only as a Card.

### Architectural Intent

AR AC-02/23/25 require Card ingestion and imported media ownership to be independent from runtime Character creation and runtime visual identity.

### Scope

**Create:**
- Card-owned codec/import/export/media modules under `plugins/cards/src/`
- Card-owned Chub search/import tool modules
- Card HTTP import/export/avatar handlers/routes as required by current architecture
- focused Card codec/Chub/media verification under `plugins/cards/scripts/`

**Modify:**
- `orchestrator/src/server/httpServer.ts`
- current Character-named Card import/export HTTP handler files, splitting/renaming as appropriate
- Card media IO helper currently named/owned as Character media, if required
- `Dockerfile`
- `package-lock.json`

**Delete:**
- None in this task; legacy modules remain until consumers cut over

**Expected but unchanged dependencies:**
- `orchestrator/src/util/parseCharacterBookEntries.ts`
- embedding provider utilities
- existing Card source format conventions

### Required Logical Changes

- uploaded PNG/JSON Card import writes `cards`, not `characters`;
- Chub import writes `cards`, not `characters`;
- original source JSON/spec metadata remains losslessly preserved for export;
- imported Card image is keyed/owned by Card identity;
- Card export reads Card source/material and Card media;
- Card HTTP routes use Card-domain paths/contracts rather than runtime `/characters` semantics;
- import results return `cardId`, never `characterId`;
- importing a Card produces zero runtime Character rows and zero `character_chat_links` rows;
- reuse existing storage strategy rather than introducing generated-image/local-file changes.

### Acceptance Criteria

- **T2.1-AC01:** File import creates exactly one Card and no runtime Character.
- **T2.1-AC02:** Chub import creates exactly one Card and no runtime Character.
- **T2.1-AC03:** PNG/JSON round-trip behaviour remains lossless to the current supported degree.
- **T2.1-AC04:** Imported Card image is retrievable/exportable through Card ownership.
- **T2.1-AC05:** Card media cleanup is reachable from `delete_card` and missing-file cleanup remains harmless.
- **T2.1-AC06:** Runtime Character avatar/visual paths are not used as the owner of newly imported Card media.

### Verification

**Automated:**
- migrated Card codec/import/export tests;
- Chub import/search verification;
- Card media read/write/delete verification;
- Card HTTP route verification;
- package build/typecheck.

**Runtime/manual:**
- import representative PNG and JSON Cards and export both formats.

### Constraints & Anti-Patterns

- no generated runtime portrait work;
- no remote migration of imported Card images;
- no Card import fallback that creates a runtime Character;
- preserve external Chub vocabulary only where imposed by Chub, but internal result is a Card.

### API Delta

- Character-card import/export HTTP/client/tool contracts gain canonical Card equivalents;
- import results use `cardId`;
- Card media endpoint is Card-scoped.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** external I/O, persistence, media lifecycle, high-fan-out import/export interfaces.

### Task Completion Boundary

Every new Card ingestion/export/media path uses canonical Cards; legacy Character-named Card paths may still exist only for not-yet-migrated consumers.

---

## Task 2.2 — Move Embedded Card Lorebooks to Explicit Card Ownership

### Objective

Complete the supporting-content split so embedded Card lorebooks are Card-owned and become available to linked RPs through the Card relationship, never through Card-as-Character linkage.

### Architectural Intent

This delivers AR AC-26 and removes the largest hidden Card↔runtime-Character identity coupling discovered in Blueprint Pass B.

### Scope

**Create:**
- Card-lorebook association helper(s) as required

**Modify:**
- Card import insert path from Task 2.1
- `orchestrator/src/io/lorebook/recallLorebookEntries.ts`
- `orchestrator/src/orchestrator/resolveLorebook.ts`
- `orchestrator/src/server/admin/lorebooks.ts` where ownership/admin queries require adaptation
- `orchestrator/src/io/lorebook/panelData.ts` where association display/queries require adaptation
- lorebook verification scripts

**Delete:**
- None yet

**Expected but unchanged dependencies:**
- runtime `lorebook_character_links` for genuinely runtime Character-scoped books
- `orchestrator/src/util/parseCharacterBookEntries.ts`

### Required Logical Changes

- newly imported Card books link to Cards, not runtime Characters;
- migrated Card books from Task 1.1 remain reachable;
- RP lorebook resolution can include the source Card's Card-owned book through the chat's Card reference;
- genuinely runtime Character-scoped lorebook behaviour remains Character-scoped;
- same-named Characters in separate RP lineages do not inherit Card/Character links by name;
- Card deletion cleans Card-owned associations/books according to established ownership semantics without directly targeting runtime Characters.

### Acceptance Criteria

- **T2.2-AC01:** Embedded Card import creates no `lorebook_character_links` row to represent the Card.
- **T2.2-AC02:** A linked RP can recall/resolve its Card-owned embedded lorebook under the same feature gating as today.
- **T2.2-AC03:** Runtime Character-scoped lorebooks continue to resolve using runtime Character identity.
- **T2.2-AC04:** Card deletion removes/detaches Card-owned supporting content according to defined lifecycle without cross-Card leakage.
- **T2.2-AC05:** Independent RPs from the same Card remain separate runtime Character scopes even while reading the same live Card-owned book.

### Verification

**Automated:**
- `orchestrator/scripts/verify-lorebook-io.mjs` updated/extended;
- Card import embedded-book verification;
- same-name/independent-RP scope test;
- runtime Character lorebook regression tests.

**Runtime/manual:**
- import a Card with embedded lorebook, start RP, confirm gated recall, then delete Card and inspect cleanup.

### Constraints & Anti-Patterns

- do not repurpose `lorebook_character_links` with Card IDs;
- no direct Card→runtime Character association;
- preserve lorebook mode/default-off behaviour;
- no unrelated lorebook feature redesign.

### API Delta

Persistence/scoping delta only: embedded Card books use Card association; runtime Character book association remains distinct.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** persistence ownership and prompt/runtime recall behaviour.

### Task Completion Boundary

Card-imported supporting content is fully Card-owned and RP-resolvable through Card→chat context; no backend Card import path needs a Character ID.

---

## Task 2.3 — Cut RP Start, Live Prompt Reads, and Fork Source References Over to Cards

### Objective

Move the complete live RP Card-consumption path from legacy `chat_sessions.character_id`/`characters` reads to the canonical Card relationship/domain while preserving current live-edit behaviour and fork Character sharing.

### Architectural Intent

This task delivers the central runtime boundary: Cards remain live configuration for their chats, while runtime Character identity remains entirely membership/lineage scoped.

### Scope

**Create:**
- Card-to-chat apply/start tool module under Cards domain if not already created

**Modify:**
- `orchestrator/src/server/promptAssembly.ts`
- `plugins/context-stack-presets/src/applyPromptStackToChatTool.ts`
- `orchestrator/src/io/chatSessions.ts`
- Cards plugin registration/tool surface
- prompt macro/prompt assembly verification
- context-stack verification
- chat-session/fork verification

**Delete:**
- None yet

**Expected but unchanged dependencies:**
- `character_chat_links`
- `orchestrator/src/orchestrator/locationAndPresenceScraper.ts`
- runtime Character settlement and visual-state systems

### Required Logical Changes

#### Card→chat apply/start

- canonical operation takes `cardId` and `chatId`;
- stamps/validates explicit chat Card reference;
- seeds greeting/swipes under existing zero-message rules;
- never creates/links a runtime Character.

#### `promptAssembly.ts`

- resolve Card-owned narrator/macro fields from the chat's Card reference and `cards`;
- preserve live Card reads on every turn;
- do not snapshot Card data into chat-owned copies as the canonical source;
- remove source-Card use of ambiguous runtime `characterId` parameters where applicable;
- keep runtime Character/canon/lorebook inputs separate where genuinely required.

#### `applyPromptStackToChatTool.ts`

- resolve Card fields through chat Card reference;
- reapplication reads current Card values;
- greeting semantics remain unchanged;
- source Card is no longer read from `characters`.

#### `chatSessions.ts`

- chat session wire/storage type exposes Card source explicitly;
- fork copies/inherits `card_id` independently from Character membership propagation;
- existing fork Character links remain the same Character rows for eligible copied history;
- independent `createChat`/Start RP does not inherit another root chat's Character memberships.

### Acceptance Criteria

- **T2.3-AC01:** New RP start links the chat to a Card and creates no runtime Character.
- **T2.3-AC02:** Per-turn narrator/macro Card fields are read live from `cards` through the chat Card reference.
- **T2.3-AC03:** Editing the Card changes subsequent linked RP prompt assembly without directly changing any runtime Character row.
- **T2.3-AC04:** Prompt-stack reapply uses the current Card values from `cards`.
- **T2.3-AC05:** Forks inherit Card reference and share eligible runtime Character identity through `character_chat_links` as separate mechanisms.
- **T2.3-AC06:** Starting a second independent RP from the same Card does not reuse Characters from the first RP.
- **T2.3-AC07:** No normal RP prompt path requires the legacy Card row in `characters` after this task.

### Verification

**Automated:**
- prompt assembly/macro verification;
- context-stack verification;
- `orchestrator/scripts/verify-chat-sessions.mjs` with explicit Card-reference + fork assertions;
- presence scraper independent-start versus fork Character tests;
- server/tool invocation verification as affected.

**Runtime/manual:**
- start two RPs from one Card, introduce same-named Character in both, verify different IDs; fork one RP and verify shared Character ID; edit Card and verify both linked RPs see new Card prompt content.

### Constraints & Anti-Patterns

- no chat Card snapshot as authoritative prompt source;
- no lineage table;
- no Card ID on runtime Character rows;
- do not broaden Character resolution beyond current lineage/membership behaviour;
- preserve existing greeting swipe semantics.

### API Delta

- `apply_character_to_chat` Card use → canonical Card-to-chat operation;
- `chat_sessions.character_id` source meaning → explicit Card reference;
- prompt assembly/context-stack internal contracts distinguish Card source from runtime Character identity.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** core business/domain logic, high-fan-out prompt interfaces, chat persistence, fork behaviour.

### Task Completion Boundary

All backend RP-start and live prompt consumers use canonical Cards; legacy Card rows remain only for frontend/legacy API compatibility pending Phase 3/4.

---

# Phase 3 — Cut User-Facing Card Surfaces Over to the Card Domain

**Phase objective:**  
Move the Cards UI, frontend API contracts, Chub UI, and persisted navigation identity to canonical Card APIs so no user-facing Card workflow depends on Card-as-Character compatibility.

**Phase completion condition:**  
Users can list/create/edit/import/export/delete Cards, start RP, browse/import Chub, and reconcile deleted RP tabs entirely through Card-domain contracts.

## Task 3.1 — Migrate Frontend Card Types, Client Helpers, and HTTP Contracts

### Objective

Introduce Card-specific frontend API types/helpers and move Card import/export/avatar HTTP usage to Card-domain endpoints while keeping runtime Character APIs distinct.

### Architectural Intent

This removes the frontend API-layer ambiguity that currently presents reusable Cards as Character data.

### Scope

**Create:**
- Card-specific frontend API types/helpers as appropriate
- `frontend/src/components/CardAvatarThumb.tsx` if split from the existing mixed component

**Modify:**
- `frontend/src/api/types.ts`
- `frontend/src/api/client.ts`
- current mixed `CharacterAvatarThumb.tsx` as required to leave runtime semantics clean

**Delete:**
- None

**Expected but unchanged dependencies:**
- runtime Cast/Character detail types and tools
- Card HTTP routes from Task 2.1

### Required Logical Changes

- define `CardSummary`/`CardDetail`/Card import result types separately from runtime Character types;
- Card client helpers use Card IDs/routes;
- Card avatar thumbnail reads Card-owned imported media;
- runtime Character thumbnail/Cast path no longer implies Card image ownership;
- runtime Character API contracts remain available for Cast/persona/appearance editing.

### Acceptance Criteria

- **T3.1-AC01:** Frontend code can represent Card and runtime Character detail without a shared ambiguous type.
- **T3.1-AC02:** Card import/export/avatar helpers use Card IDs and Card routes.
- **T3.1-AC03:** Runtime Character client types do not contain Card-only source/export ownership solely for Cards UI compatibility.
- **T3.1-AC04:** Frontend typecheck succeeds before Cards view cutover.

### Verification

**Automated:**
- frontend typecheck/build;
- API helper tests if present.

**Runtime/manual:**
- None beyond API smoke if convenient; primary UI behaviour belongs to Task 3.2.

### Constraints & Anti-Patterns

- no Cast portrait feature work;
- no UI redesign;
- preserve existing visual styling;
- do not remove legacy backend APIs until Task 4.1.

### API Delta

Add explicit Card frontend types and Card HTTP/client helpers; runtime Character types become semantically runtime-only.

### Validation

- **Tier:** Tier 2
- **Criticality:** Not Critical
- **Reason:** frontend contract/type migration with bounded ownership already established by prior tasks.

### Task Completion Boundary

Card-domain frontend contracts compile and are ready for the Cards/Chub views to consume; existing views may still call legacy APIs until the next task.

---

## Task 3.2 — Migrate Cards View, Chub UI, Start RP, Delete Reconciliation, and Persisted Tab Identity

### Objective

Move all user-facing Card workflows to canonical Card APIs and rename internal navigation/view identity from Character-library terminology to Cards without changing the visual product design.

### Architectural Intent

AR AC-20/22 require Card-facing operations to operate against Cards while Cast remains runtime Character-only.

### Scope

**Create:**
- `frontend/src/views/CardsView.tsx`
- `frontend/src/views/CardsView.css` if file rename is used

**Modify:**
- `frontend/src/App.tsx`
- `frontend/src/hooks/useTabs.ts`
- sidebar/navigation/type-picker surfaces using the internal `characters` Card tab type
- `frontend/src/components/ChubCardModal.tsx`
- `frontend/src/views/BrowseChubView.tsx`
- `frontend/src/components/ChubResultCard.tsx`
- Card refresh-key wiring in `App.tsx` or current owner

**Delete:**
- `frontend/src/views/CharactersView.tsx` after CardsView is wired
- `frontend/src/views/CharactersView.css` after replacement

**Expected but unchanged dependencies:**
- `frontend/src/components/sidebar/CastSection.tsx`
- runtime Character APIs

### Required Logical Changes

#### Cards view

- list/get/create/update/delete through Card APIs;
- imports return/select `cardId`;
- export uses Card route/helper;
- Card thumbnail uses Card-owned image;
- Start RP creates fresh RP chat then applies the selected Card through canonical Card-to-chat operation;
- delete consumes returned deleted chat IDs and closes/reconciles affected open RP tabs/history exactly as current behaviour intends;
- no Card action calls runtime Character CRUD.

#### Chub

- search/import result semantics are Card-oriented internally;
- importing from Chub refreshes Cards list;
- no runtime Character is created.

#### Tabs/navigation

- canonical internal singleton tab type becomes `cards` if renamed;
- persisted legacy `type: "characters"` Card-library tabs normalize one-way to `cards` during rehydration;
- do not retain both as summonable canonical types;
- user-facing label remains Cards.

### Acceptance Criteria

- **T3.2-AC01:** Cards library uses only Card-domain APIs.
- **T3.2-AC02:** Create/edit/import/export/delete behaviour remains functionally equivalent from the user's perspective.
- **T3.2-AC03:** Start RP uses Card→chat and creates no runtime Character until runtime discovery occurs.
- **T3.2-AC04:** Card deletion closes/removes every deleted RP tab returned by backend deletion.
- **T3.2-AC05:** Chub import creates/refreshes Cards, not runtime Characters.
- **T3.2-AC06:** Persisted legacy Cards tab state rehydrates successfully under the canonical Cards tab type.
- **T3.2-AC07:** Cast remains backed by runtime Character APIs and is not changed to read Cards.

### Verification

**Automated:**
- frontend typecheck/build;
- targeted persisted-tab normalization test where the repo has a suitable test harness;
- affected server/API integration verification.

**Runtime/manual:**
- Card create/edit;
- PNG/JSON import/export;
- Chub import;
- Start RP;
- Card edit then next-turn live prompt behaviour;
- Card delete closes/deletes linked RP tabs;
- existing persisted Cards tab opens after reload.

### Constraints & Anti-Patterns

- no Cards visual redesign;
- do not make Card avatar a Cast portrait;
- no runtime Character naming/identity fallback from Card;
- no compatibility duplication of Cards and Characters UI.

### API Delta

Frontend Card workflows migrate from Character-named Card APIs/types to canonical Cards contracts; legacy persisted tab type gets one-way compatibility only.

### Validation

- **Tier:** Tier 2
- **Criticality:** Not Critical
- **Reason:** broad frontend migration, but core persistence/ownership contracts already established and independently verified.

### Task Completion Boundary

Every user-facing Card workflow uses canonical Cards; no known frontend consumer needs the legacy Card rows or Character-named Card APIs.

---

# Phase 4 — Remove the Legacy Card-as-Character Compatibility Layer

**Phase objective:**  
Make the architectural split real and final by removing legacy Card rows, Card-only Character fields/interfaces, ambiguous source columns, and compatibility filtering after every consumer has cut over.

**Phase completion condition:**  
There is one canonical Card domain and one canonical runtime Character domain; no live code path relies on `status IS NULL` to mean Card or on `chat_sessions.character_id` to mean source Card.

## Task 4.1 — Runtime-Only Character API and Legacy Card Tool Removal

### Objective

Strip Card semantics out of the Characters plugin and make runtime Character APIs unambiguous before final schema cleanup.

### Architectural Intent

This delivers AR AC-21/22/28 and prevents the old compatibility layer from becoming permanent architecture.

### Scope

**Modify:**
- `plugins/characters/src/index.ts`
- `plugins/characters/src/getCharactersTool.ts`
- `plugins/characters/src/getCharacterTool.ts`
- `plugins/characters/src/updateCharacterTool.ts`
- `plugins/characters/src/deleteCharacterTool.ts` if retained as a runtime-only operation
- `plugins/characters/scripts/verify-characters.mjs`
- runtime callers affected by narrowed Character wire types

**Delete:**
- Card-owned legacy modules from `plugins/characters/src/`, including old Card codec/import/export/Chub/media/apply-to-chat implementations once pre-contract inspection confirms all consumers have moved
- migrated Card-specific verification files from Characters package

**Create:**
- None expected

**Expected but unchanged dependencies:**
- `orchestrator/src/orchestrator/locationAndPresenceScraper.ts`
- `character_chat_links`
- Cast/runtime visual/canon systems

### Required Logical Changes

- `get_characters` lists runtime Characters only;
- remove `status IS NULL` Card-library eligibility and hidden `castOnly` workaround if no longer needed;
- runtime Character detail/update exposes only runtime-owned fields needed by Cast/runtime systems;
- remove all Card CRUD/import/export/Chub/start-RP registration from Characters plugin;
- runtime Character delete must not delete chats because of source-Card semantics;
- comments/descriptions no longer define Cards as a Character subtype;
- Cast and runtime scene/canon/visual callers continue to function against runtime-only Character IDs.

### Acceptance Criteria

- **T4.1-AC01:** No Card-facing operation is registered by the Characters plugin.
- **T4.1-AC02:** `get_characters` no longer needs Card-exclusion compatibility logic.
- **T4.1-AC03:** Runtime Character detail/update remains sufficient for Cast persona/appearance editing.
- **T4.1-AC04:** Runtime Character deletion has no source-Card chat-deletion behaviour.
- **T4.1-AC05:** Presence, Cast, scenes/canon, settlement, and visual-state regression verification remains green.

### Verification

**Automated:**
- updated `plugins/characters/scripts/verify-characters.mjs`;
- location/presence verification;
- settle-transient verification;
- scenes/canon verification as affected;
- Character sprite/visual-state verification;
- frontend build/typecheck.

**Runtime/manual:**
- verify Cast loads/edits a runtime Character in an RP whose source Card is independently editable.

### Constraints & Anti-Patterns

- do not reintroduce Card lookup in runtime Character APIs;
- no rename churn unrelated to the split;
- do not delete schema columns until Task 4.2.

### API Delta

Retire legacy Card-as-Character tools; `get_characters`/`get_character`/`update_character` become runtime-only contracts.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** high-fan-out public tool semantics and runtime domain contract cleanup.

### Task Completion Boundary

All application consumers compile and run with runtime-only Character APIs; the remaining legacy Card data/schema representation is unused and safe to remove.

---

## Task 4.2 — Destructive Schema Cutover and Final Data Cleanup

### Objective

Remove the now-unused legacy Card representation from `characters` and the ambiguous source-Card `chat_sessions.character_id` relationship, leaving the deployed schema aligned with the Architectural Report.

### Architectural Intent

This is the final persistence cutover that makes Cards and runtime Characters physically and semantically distinct rather than merely dual-written.

### Scope

**Create:**
- next `db/migrations/` destructive cleanup migration
- deterministic cleanup migration verification if separate from Task 1.1 verifier

**Modify:**
- `db/migrations/README.md`
- any final DB-facing runtime row types exposed by schema cleanup

**Delete:**
- None outside schema elements removed by migration

**Expected but unchanged dependencies:**
- canonical Cards migration from Task 1.1
- Cards/plugin/frontend cutover from prior phases
- `character_chat_links` orphan cleanup trigger

### Required Logical Changes

- verify every legacy Card/library row has canonical Card counterpart before deletion;
- remove legacy Card/library rows from `characters`;
- remove `chat_sessions.character_id` once no live consumer uses it as source Card;
- remove Card-only columns from runtime `characters` where Blueprint discovery confirms no legitimate runtime owner remains, including imported source/spec/avatar/card prompt-package fields as appropriate;
- tighten runtime Character lifecycle constraints if safe now that `status IS NULL` is no longer a Card discriminator;
- remove obsolete Card-lorebook Character associations after verifying Card associations exist;
- preserve all runtime `character_chat_links`, Character IDs, visual references/state, scenes, canon, and fork memberships;
- fail safely/abort migration when preconditions reveal incomplete cutover rather than silently dropping unmigrated Card data.

### Acceptance Criteria

- **T4.2-AC01:** No reusable Card row remains in `characters`.
- **T4.2-AC02:** No live source-Card relationship remains in `chat_sessions.character_id`.
- **T4.2-AC03:** `characters` contains only runtime Character-owned schema/state.
- **T4.2-AC04:** Existing Cards, Card media references, chats, forks, and Card lorebooks remain correctly associated after cleanup.
- **T4.2-AC05:** Existing runtime Characters retain IDs, memberships, persona/appearance, and visual references/state.
- **T4.2-AC06:** Schema no longer requires nullability/status conventions to distinguish Cards from Characters.

### Verification

**Automated:**
- destructive migration verifier with pre/post count and relationship assertions;
- full DB/integration verification;
- Cards plugin verification;
- runtime Characters verification;
- chat/fork verification;
- lorebook verification;
- prompt/context-stack verification;
- frontend build/typecheck.

**Runtime/manual:**
- inspect representative Card, independent RP roots, a fork lineage, runtime Characters, and Card-owned lorebook/media after migration.

### Constraints & Anti-Patterns

- do not edit historical migrations;
- no heuristic name matching;
- do not delete runtime Characters as part of Card-row cleanup;
- do not drop a legacy field until repository search confirms no live consumer remains;
- stop with a Planning Deviation if pre-contract inspection finds a legitimate runtime owner for a Card-shaped column the Blueprint assumed removable.

### API Delta

Final removal of persistence compatibility:

- legacy source `chat_sessions.character_id` Card meaning removed;
- `characters` Card-subtype representation removed.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** destructive migration of canonical persistence and high fan-out domain schema.

### Task Completion Boundary

The deployed schema and all live code contain one canonical Cards domain and one runtime-only Characters domain, with chat lineage and Character membership semantics preserved.

---

# Phase 5 — Whole-System Architectural Verification and Release

**Phase objective:**  
Prove the completed split across the full integration surface and release it using the repository's established workflow.

**Phase completion condition:**  
All task reviews have passed, the final integration review returns PASS, production deployment is healthy, smoke checks confirm the critical end-to-end behaviour, and the implementation is committed and pushed.

## Task 5.1 — Final Cross-Domain Regression and Acceptance Scenario

### Objective

Run the complete deterministic and runtime acceptance matrix against the final architecture before the harness's mandatory Final Integration Review.

### Architectural Intent

Task-local correctness is not enough for this change; the defining behaviour spans Card storage, live prompt reads, chat lineage, runtime Character membership, deletion, lorebooks, media, frontend, and visuals.

### Scope

**Create:**
- only missing integration verification fixtures/scripts required to cover Blueprint/AR acceptance criteria

**Modify:**
- verification scripts only where necessary for final cross-domain assertions

**Delete:**
- obsolete compatibility-only verification fixtures if all canonical replacements exist

**Expected but unchanged dependencies:**
- entire implemented Cards/runtime Character split

### Required Logical Changes

The final acceptance scenario must cover at minimum:

1. import Card X with image, prompt fields, greetings, and embedded lorebook;
2. start RP A from Card X;
3. confirm no runtime Character exists solely from RP start;
4. introduce `Present: Sydney` and capture Sydney A's Character ID;
5. fork RP A to A2 and verify eligible Sydney identity is shared;
6. start independent RP B from Card X;
7. introduce `Present: Sydney` and verify Sydney B has a different Character ID;
8. edit Card X and verify subsequent prompt assembly in A/A2/B reads the updated Card fields while neither Sydney runtime row is directly mutated;
9. verify Card-owned embedded lorebook is reachable where enabled;
10. verify runtime Character visual references/state remain Character-scoped and no Card avatar becomes Character ownership;
11. delete one fork and verify the shared Character survives in another branch;
12. delete Card X and verify all A/A2/B chats are deleted, Card media/supporting content is cleaned according to ownership, chat links disappear, and all now-orphaned runtime Characters are cleaned through normal lifecycle;
13. verify an unrelated Card/lineage remains untouched.

### Acceptance Criteria

- **T5.1-AC01:** Every AR AC-01 through AC-28 is mapped to and satisfied by deterministic or explicit runtime verification.
- **T5.1-AC02:** The critical end-to-end scenario above passes.
- **T5.1-AC03:** Full relevant test suites, typecheck/build, and static checks pass.
- **T5.1-AC04:** Repository search finds no live Card-as-Character source relationship or Card-library null-status compatibility path.
- **T5.1-AC05:** Full branch diff contains no unrelated implementation changes.

### Verification

**Automated:**
- Cards plugin suite;
- Characters plugin suite;
- migration verification;
- chat sessions/fork suite;
- prompt/server/context-stack suites;
- lorebook suite;
- location/presence/settlement/scenes/canon/visual-state regression suites;
- frontend typecheck/build;
- production Docker/build verification;
- any repository-wide lint/static checks required by current project convention.

**Runtime/manual:**
- execute the critical end-to-end scenario against the deployed/local integration environment before final release.

### Constraints & Anti-Patterns

- verification-only repairs must remain within the architecture; architectural mismatch requires Planning Deviation, not test weakening;
- do not waive an AR criterion because task-local tests passed;
- do not convert expected failures into ignored/skipped tests without a concrete environmental reason.

### API Delta

No new API delta. Verify the complete Blueprint API Delta Ledger is the final live contract.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** full architectural integration gate across persistence and high-fan-out interfaces.

### Task Completion Boundary

All deterministic and runtime verification required for Final Integration Review is green and captured as reviewer input.

---

## 4. Cross-Task Dependency Ledger

| Task | Depends on | Dependency |
| --- | --- | --- |
| `1.2` | `1.1` | Canonical Card storage/chat Card reference exist |
| `2.1` | `1.1`, `1.2` | Cards persistence and Card CRUD/plugin foundation exist |
| `2.2` | `1.1`, `2.1` | Card-lorebook association and canonical Card import path exist |
| `2.3` | `1.1`, `1.2` | Explicit Card reference and Cards plugin exist |
| `3.1` | `2.1` | Canonical Card HTTP/import/export/media contracts exist |
| `3.2` | `2.2`, `2.3`, `3.1` | Card backend, RP start/live reads, and frontend Card API contracts are ready |
| `4.1` | `2.3`, `3.2` | No backend/frontend Card consumer needs Character-named Card compatibility |
| `4.2` | `4.1` | Legacy Card rows/schema are unused by live code |
| `5.1` | `4.2` | Final canonical schema/code state exists |

Tasks without a listed dependency must still satisfy the harness pre-contract repository check before execution.

## 5. Final Integration Verification

After Task 5.1 passes its independent task review, the coding harness must run the canonical final integration gate:

`/config/workspace/BigImagine/docs/coding-loop/FINAL_INTEGRATION_REVIEW.md`

Follow that document exactly.

### Required checks

- full relevant test suite;
- project typecheck/build;
- lint/static checks as applicable;
- production plugin/container build;
- full branch diff review for unrelated changes;
- confirm every Architectural Report acceptance criterion AC-01 through AC-28 is satisfied;
- confirm every Blueprint core/collateral file is accounted for;
- confirm every API Delta matches the finalized Blueprint;
- confirm live Card reads remain intentional and working;
- confirm independent-start versus fork Character identity semantics;
- confirm Card deletion removes all Card-linked chats and Characters disappear only through membership/orphan lifecycle;
- confirm imported Card media ownership and cleanup;
- confirm runtime Character visual references/state remain Character-scoped and external generated assets are not treated as locally owned bytes;
- confirm embedded Card lorebooks do not establish Card↔runtime-Character identity;
- confirm no task-level compatibility shim survived as a second canonical architecture.

### Final Review Inputs

The integration reviewer must receive:

1. `docs/plans/cards-runtime-characters/1_ARCHITECTURAL_REPORT.md`
2. `docs/plans/cards-runtime-characters/2_BLUEPRINT.md`
3. `docs/plans/cards-runtime-characters/3_IMPLEMENTATION_PLAN.md`
4. full implementation diff
5. deterministic verification results

The final question is:

**Did the completed implementation faithfully deliver the original architectural intent across the whole Cards / chat-lineage / runtime-Character split?**

If the review returns FINDINGS, repair only genuine failures against the governing artifacts, rerun relevant deterministic verification, and rerun the Final Integration Review until PASS.

## 6. Deploy, Smoke Check, Commit, and Push

After Final Integration Review returns PASS and the diff is clear:

1. apply any required final migration using the established BigImagine database procedure;
2. rebuild/deploy affected BigImagine services/plugins using the repository's established container/deployment workflow;
3. confirm database, orchestrator, frontend, and affected containers are healthy;
4. smoke-test the critical Card → independent RP → fork → runtime Character → live Card edit → Card delete lifecycle in the deployed environment;
5. inspect logs for new Card/Character/lorebook/prompt/fork errors;
6. review the final diff for temporary files, debug changes, generated junk, or unrelated modifications;
7. commit the completed architectural change with a concise descriptive message;
8. push the current branch/remotes using the established repository workflow.

Do not stop for routine approval between these steps when verification and review are clean. Stop only for a genuine Planning Deviation, unsafe/unexpected repository state, unresolved migration ambiguity, deployment failure that cannot be safely repaired within scope, or review finding that requires an architectural decision outside the governing artifacts.
