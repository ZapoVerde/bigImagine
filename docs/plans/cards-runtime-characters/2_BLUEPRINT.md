# Blueprint — Cards, Chat Lineages, and Runtime Characters

## 0. Source and Intent

This Blueprint implements `docs/plans/cards-runtime-characters/1_ARCHITECTURAL_REPORT.md`.

The repository discovery was performed in two deliberate passes:

1. **Core definition:** identify the ownership and runtime seams that must change for the Architectural Report to become true.
2. **Blast-radius discovery:** trace consumers, persistence, APIs, prompt paths, imports/exports, lorebooks, frontend state, fork behaviour, media lifecycle, build wiring, and verification affected by those core changes.

The implementation must preserve these governing outcomes:

- Cards are reusable source material, not runtime Characters.
- Every independently started RP creates a new Character identity scope.
- Forks of that RP may share the same runtime Characters.
- Independently started RPs from the same Card do not share runtime Characters.
- Card fields remain live source material for linked chats where they are live-read today.
- Deleting a Card deletes all chats derived from that Card, including forks.
- Character cleanup follows chat-membership lifecycle; Cards never directly own runtime Characters.
- Runtime Character visual state owns references/metadata, not externally hosted image assets.

---

## 1. Current Architecture

### 1.1 Cards and runtime Characters share one table

`characters` currently represents two different domains:

- Card/library rows, distinguished primarily by `status IS NULL`;
- runtime Characters, which carry lifecycle status and participate in `character_chat_links`.

Card-owned fields such as scenario, system prompt, example dialogue, greetings, source JSON, Card-spec metadata, and imported avatar path therefore coexist with runtime Character state.

This null-status discriminator is the central legacy coupling to remove.

### 1.2 Chat source Card is represented as `chat_sessions.character_id`

The `character_id` on an RP chat currently points at the Card/library row used to start the RP. It is not the runtime Character membership relationship.

Runtime Character membership is separately represented by `character_chat_links`.

The schema therefore already contains two conceptually different relationships that happen to use the word Character:

- `chat_sessions.character_id` = source Card;
- `character_chat_links.character_id` = runtime Character.

### 1.3 Runtime Character discovery is already chat-scoped

The Present/presence path resolves Characters only among Characters linked to the current chat. A same-named Character from another independently started chat is not eligible and a new runtime Character is minted instead.

This behaviour already provides the required isolation between independent RP starts.

### 1.4 Forking already supplies lineage sharing

Forked chats retain their parent relationship and receive links to eligible existing runtime Character rows rather than cloning those Characters.

The existing `parent_chat_id` tree plus `character_chat_links` therefore already encode the required lineage semantics. No new lineage table is required.

### 1.5 Card APIs are currently hosted by the Characters plugin

The Characters plugin currently owns both Card/library and runtime Character behaviour, including Card CRUD, import/export, Chub ingestion, imported avatar handling, applying a Card to a chat, and actual runtime Character tools.

The frontend Cards screen already presents the domain as Cards to the user, but internally calls Character-named APIs and uses Character-named types.

---

## 2. Target Architecture

### 2.1 Persistence domains

Create a first-class `cards` persistence domain containing Card-owned reusable source material and Card-owned imported media references.

The `characters` domain becomes runtime-only. Card-only fields and the `status IS NULL` library convention no longer belong there.

### 2.2 Explicit Card-to-chat relationship

Replace the semantic use of `chat_sessions.character_id` as source Card with an explicit Card relationship, preferably `card_id`.

The relationship remains live: prompt-building paths that intentionally read current Card fields continue reading the current Card row.

A fork inherits the same `card_id` as its parent because it remains derived from the same Card.

### 2.3 Runtime Character identity remains membership-based

Keep `character_chat_links` as the canonical runtime Character membership relation.

Do not add Card identity to runtime Character resolution.

Independent RP creation creates a new root chat with no inherited runtime Character memberships. Runtime Characters are minted as people become present.

Fork creation may copy eligible runtime Character memberships from the source branch into the fork, preserving shared identity inside that lineage.

### 2.4 Card deletion owns chat deletion

Deleting a Card must:

1. identify every chat linked to the Card, including roots and forks carrying that Card reference;
2. delete those chats;
3. allow chat deletion to cascade membership removal;
4. allow existing orphan-Character lifecycle rules to remove Characters with no remaining chat memberships;
5. remove Card-owned local/imported media according to the existing Card-media cleanup convention;
6. return deleted chat IDs where required so open frontend tabs/history state can be reconciled.

The Card delete path must never query runtime Characters by Card identity in order to delete them.

### 2.5 Runtime visual ownership

Runtime Character visual records remain keyed to runtime Character identity.

Character deletion removes Character-owned references, visual combinations/state, prompt/provenance metadata, and other derived records according to existing cascades/lifecycle.

Externally hosted image bytes are not treated as Character-owned assets and do not become part of Card deletion.

---

## 3. Core Change Set

### 3.1 Database migration

Add the Card domain and migrate existing Card/library rows out of `characters`.

The migration must preserve Card IDs where practical so existing chat/Card relationships and Card-owned supporting records can be deterministically remapped without heuristic matching.

Change the RP source relationship on `chat_sessions` from the legacy Character-named reference to the Card reference.

After migration:

- `characters` contains runtime Characters only;
- `cards` contains reusable Card records only;
- no runtime query needs `status IS NULL` to exclude Cards;
- no Card query reads from `characters`;
- every existing RP that previously referenced a Card/library row references the migrated Card;
- forked chats retain the same Card reference as their source lineage.

The migration must account for foreign keys, triggers, indexes, and dependent records before the legacy Card rows are removed from `characters`.

### 3.2 Cards plugin/domain

Introduce a Cards plugin/domain and move Card-specific responsibilities out of the Characters plugin:

- list/get Card;
- create/update/delete Card;
- Card PNG/JSON import;
- Card PNG/JSON export;
- Chub search/import integration where it produces Cards;
- Card codec/source-format handling;
- imported Card image storage/reference lifecycle;
- embedded Card lorebook creation/association;
- apply/start-RP Card linkage currently represented by `apply_character_to_chat`.

The existing Characters plugin remains responsible for runtime Characters and their runtime lifecycle.

### 3.3 RP start

Starting RP from a Card must:

- create a fresh RP root chat;
- link that chat to the selected Card;
- seed the opening greeting according to current zero-message behaviour;
- apply Card-owned prompt material through the established prompt-stack behaviour;
- not create or attach a runtime Character merely because the Card has a name/persona;
- leave runtime Character discovery to the Present/runtime path.

### 3.4 Forking

Fork creation must preserve two independent relationships:

- copy/inherit the source Card reference into the fork;
- link eligible existing runtime Characters into the fork using existing fork membership semantics.

These must not be collapsed into a Card→Character relationship.

### 3.5 Runtime Character APIs

Make Character APIs semantically runtime-only.

`get_characters`, `get_character`, runtime Character update/delete operations, Cast/presence consumers, and visual-state consumers must no longer contain compatibility behaviour for Card/library rows.

Where `castOnly`, `status IS NULL`, or equivalent filtering exists solely because Cards currently occupy `characters`, remove it once callers are migrated.

---

## 4. Live Card Consumption

### 4.1 Prompt assembly

Every prompt path that currently treats `chat_sessions.character_id` as the source Card must instead resolve the chat's Card reference and read Card-owned fields from `cards`.

Preserve intentional live-read semantics. Do not introduce a chat-owned frozen Card snapshot as the authoritative prompt source.

### 4.2 Prompt-stack application/reapplication

`apply_prompt_stack_to_chat` independently reads the source row and maps Card fields into prompt-stack markers. It must move to the Card relationship/domain as part of the same change.

This path must continue to use current Card values when the prompt stack is reapplied.

### 4.3 Card editing

Card update APIs must update the Card row only.

They must not mutate runtime Characters in any linked chat lineage. The effect on linked RPs occurs because future Card reads see the updated Card data.

---

## 5. Embedded Lorebooks

Embedded Card lorebooks are the principal non-mechanical ownership seam.

Today Card import may create lorebook records and associate them through a Character-named link to the Card/library row. After the split, that association must become explicitly Card-owned rather than being redirected to a runtime Character.

Required outcome:

- imported embedded lorebooks remain associated with their source Card;
- deleting the Card cleans up/detaches Card-owned lorebook association according to existing lorebook ownership semantics;
- prompt/lorebook recall for an RP can reach the Card's embedded lorebook through the chat's Card relationship where current behaviour expects it;
- no embedded Card lorebook association creates a runtime Character or establishes Card↔runtime-Character identity;
- runtime Character lorebook/canon behaviour, where genuinely Character-scoped, remains runtime Character-scoped.

The implementation should use explicit Card linkage rather than overloading a Character link with a Card ID.

---

## 6. Card Media and Runtime Character Visuals

### 6.1 Card media

Imported Card images are Card-owned media references/resources.

The existing local imported-image storage strategy may remain if desired by the current Card import/export contract, but ownership must move to Cards and deletion must follow Card lifecycle.

No Card image becomes a runtime Character portrait by identity implication.

### 6.2 Runtime Character visual state

Keep current runtime visual state, sprite state, combinations, image URL references, visual descriptions, and related metadata keyed to runtime Character IDs.

Do not copy Card avatar ownership into runtime Character storage during the domain split.

The actual externally hosted generated image assets remain external; database cleanup removes references/state, not provider-hosted bytes unless a separate provider cleanup capability explicitly exists.

---

## 7. Frontend Migration

### 7.1 Cards screen

Convert the existing Cards-facing `CharactersView` implementation to consume Card types and Card APIs.

The user-facing concept remains **Cards**. Internal naming should stop presenting the reusable library as Characters.

The screen must preserve:

- list/sort;
- create/edit;
- PNG/JSON import;
- PNG/JSON export;
- delete confirmation;
- Start RP;
- deleted-chat reconciliation after Card deletion;
- Chub-import refresh behaviour.

### 7.2 API types/client

Introduce Card summary/detail/import/export types and client helpers where the frontend currently exposes Card data as `CharacterSummary`/`CharacterDetail` or Character-card helpers.

Runtime Character types remain separate and should contain only runtime Character concerns.

### 7.3 Persisted navigation state

If the internal tab/route identifier changes from `characters` to `cards`, migrate persisted frontend tab state such as `bb_tabs` once at load/normalization time.

Do not maintain two indefinitely supported canonical names for the same tab.

### 7.4 Chub

Chub remains a Card acquisition surface even when Chub itself calls many entries character cards.

Importing from Chub must create a Card and refresh the Cards UI. It must not create a runtime Character.

---

## 8. Build and Plugin Wiring

If Cards becomes a separate workspace plugin/package, update all explicit production build/install/plugin-registration surfaces.

This includes any Dockerfile/package build sequence that enumerates plugin packages rather than relying solely on workspace globs, plus runtime tool registration/bootstrap as required.

The Characters plugin must remain loadable with its reduced runtime-only responsibilities.

---

## 9. Dependency Manifest

### Primary ownership surfaces

- DB migrations defining `characters`, runtime status, `character_chat_links`, chat source relationship, lorebook links, and relevant cascades/triggers.
- `plugins/characters/*` Card and runtime Character tools.
- new Cards domain/plugin.
- `orchestrator/src/io/chatSessions.ts` fork/chat persistence.
- RP start/apply path.

### Direct consumers requiring modification

- prompt assembly and Card macro/source resolution;
- context-stack preset application/reapplication;
- Cards frontend view;
- frontend API types/client helpers;
- Chub browse/import path;
- Card PNG/JSON import/export;
- embedded lorebook association and recall;
- Card deletion/tab reconciliation;
- imported Card media cleanup;
- plugin/bootstrap/build wiring.

### Consumers expected to remain semantically unchanged but requiring regression verification

- Present/location-and-presence scraper;
- Cast/runtime Character listing;
- Character settlement;
- Character visual state;
- sprite state/refresh;
- scenes that consume runtime Characters;
- canon/runtime Character records;
- fork Character membership propagation;
- orphan Character cleanup.

### Documentation/comments requiring semantic cleanup

Update code comments, tool descriptions, API declarations, and verification fixture terminology that currently calls the source Card a linked Character or treats Card/library rows as a Character subtype.

Do not perform unrelated terminology churn outside affected seams.

---

## 10. API Delta Ledger

| Current surface | Target surface/meaning | Compatibility expectation |
|---|---|---|
| `get_characters` used by Cards library | Card list API (for example `get_cards`) | Frontend migrates; `get_characters` becomes runtime-only |
| `get_character` used for Card editor | Card detail API | Frontend migrates |
| `create_character` used to author Cards | Card create API | Remove Card use from Character API |
| `update_character` used to edit Cards | Card update API | Remove Card use from Character API |
| `delete_character` used to delete Card + chats | Card delete API | Card delete preserves deleted-chat reporting; runtime Character delete remains separate |
| `apply_character_to_chat` used to attach source Card | Card-to-chat/start-RP API with Card semantics | Rename/redefine; no runtime Character implication |
| `chat_sessions.character_id` meaning source Card | explicit Card reference (`card_id`) | DB and all callers migrate atomically |
| Character Card import helpers | Card import helpers | Rename domain; wire Chub/file import to Cards |
| Character Card export helpers | Card export helpers | Rename domain |
| Character-shaped frontend Card types | Card summary/detail types | Separate from runtime Character types |
| Character-linked embedded Card lorebook association | explicit Card-lorebook association | Migrate existing associations |
| `get_characters(... castOnly ...)` compatibility filtering | runtime-only Character query | Remove Card-exclusion compatibility once split is complete |

Exact public tool names should be chosen consistently during implementation planning; the critical contract is semantic separation, not preservation of misleading Character names for Card operations.

---

## 11. Migration Requirements

The data migration must be deterministic and reversible through normal database backup/rollback practice.

It must distinguish existing Card/library rows from runtime Characters using the current canonical discriminator before that discriminator is removed.

For every migrated Card:

- preserve authored/imported Card fields;
- preserve source-format/source-JSON data;
- preserve imported media reference/path;
- preserve timestamps/IDs where practical;
- remap all `chat_sessions` source references;
- remap embedded lorebook associations;
- leave runtime Character memberships untouched.

After remapping, remove migrated Card rows from `characters` and remove Card-only schema/logic from the runtime Character domain as appropriate.

The migration must explicitly verify that no chat loses its source Card and no runtime Character is accidentally promoted into Cards.

---

## 12. Verification Assessment

### 12.1 Database/invariant verification

Add deterministic verification for:

- existing Card/library rows migrate to Cards;
- runtime Character rows remain runtime Characters;
- existing RP chats point to the correct migrated Card;
- forks retain the same Card reference;
- independent chats from one Card remain independent Character populations;
- embedded Card lorebook associations migrate correctly;
- Card deletion removes all chats carrying that Card reference;
- membership cascades/orphan cleanup remove runtime Characters after the last chat in their lineage is gone;
- deleting one fork does not delete a Character still linked to another fork;
- no Card row remains in `characters` after migration.

### 12.2 Card plugin verification

Split/move existing Card verification coverage to the Card domain and test:

- CRUD;
- PNG import/export;
- JSON import/export;
- Chub import result;
- imported Card image lifecycle;
- embedded lorebook handling;
- Start RP/Card attachment;
- Card deletion and returned deleted chat IDs.

### 12.3 Runtime Character verification

Update Character verification to assert runtime-only semantics:

- Present creates a runtime Character in the current chat;
- same name in an independent RP creates another Character;
- fork links the existing Character where eligible;
- `get_characters` no longer needs Card filtering;
- settlement and visual-state behaviour remain intact.

### 12.4 Prompt verification

Update/add tests for both prompt consumers:

- normal RP prompt assembly reads Card fields through `card_id`;
- prompt-stack apply/reapply reads Card fields through `card_id`;
- editing a Card changes subsequent live reads;
- Card edits do not mutate runtime Character persona/visual state;
- greeting seeding remains zero-message guarded.

### 12.5 Lorebook verification

Verify:

- imported Card lorebooks remain reachable for the linked RP;
- Card deletion cleans the Card association appropriately;
- runtime Character lorebook/canon paths do not accidentally read Card links;
- same-named runtime Characters in separate lineages do not share Character-scoped lorebook state.

### 12.6 Frontend verification

Build/typecheck plus targeted behaviour verification for:

- Cards list/editor;
- create/edit/delete;
- import/export;
- Chub import refresh;
- Start RP;
- Card deletion closes/removes deleted RP tabs;
- persisted `characters` tab state migrates to `cards` if the identifier is renamed;
- runtime Cast continues to display runtime Characters only.

### 12.7 Fork/regression verification

Existing chat-session/fork verification must remain green and gain explicit coverage that fork creation copies Card reference and Character memberships independently.

### 12.8 Build/deployment verification

Run repository-standard deterministic verification, including affected plugin verification scripts, orchestrator/server/chat-session verification, frontend build/typecheck, and production container/plugin build where the Cards package changes explicit build wiring.

Before completion, run the repository's coding-loop Final Integration Review against the complete diff and deterministic verification results.

---

## 13. Risks and Controls

### Risk: accidental snapshot semantics

**Control:** every current live Card consumer is explicitly migrated to `cards`; do not replace Card reads with copied runtime Character/chat fields.

### Risk: cross-lineage Character reuse

**Control:** preserve exact-chat runtime resolution and permit sharing only through explicit fork membership propagation. Add independent-start/fork tests.

### Risk: migration deletes or misclassifies runtime Characters

**Control:** classify legacy Card rows before destructive schema cleanup; verify counts/relationships and chat references before removing legacy rows.

### Risk: embedded lorebooks retain a hidden Card-as-Character dependency

**Control:** create explicit Card association and migrate recall/admin consumers deliberately.

### Risk: Card delete leaves live RP tabs pointing at deleted chats

**Control:** preserve deleted-chat ID reporting and frontend reconciliation.

### Risk: production image/plugin build omits new Cards package

**Control:** inspect and update explicit Docker/plugin build enumeration and verify production build.

### Risk: broad renaming creates unrelated churn

**Control:** rename semantics only where they represent the Card/runtime-Character split; leave unrelated historical/card-format vocabulary alone when it is externally defined.

---

## 14. Acceptance-Criteria Coverage

The implementation plan derived from this Blueprint must explicitly cover every Architectural Report acceptance criterion.

Key mappings:

- AR AC-01/02/28 → separate Cards persistence/domain; remove null-status Card subtype.
- AR AC-03/04/14/16/17 → explicit live Card→chat relationship and Card-owned chat deletion.
- AR AC-05/06/07/08/09/10/11/13/21/27 → existing root/fork topology plus runtime `character_chat_links`, with independent-start/fork regression tests.
- AR AC-12/15/18 → no Card identity in runtime Character resolution/mutation/deletion.
- AR AC-19/20 → membership cascade and orphan Character lifecycle.
- AR AC-22 → Cast/runtime Character APIs become runtime-only.
- AR AC-23/25 → Card-owned imported media.
- AR AC-24 → Character-owned visual references/derived state; external assets remain external.
- AR AC-26 → explicit Card-owned embedded/supporting content without Card↔runtime-Character identity.

---

## 15. Blueprint Completion Gate

This Blueprint is ready to hand to implementation planning when:

- the Card/runtime Character persistence split is explicit;
- the live Card→chat relationship is explicit;
- independent-start versus fork Character identity semantics are explicit;
- Card deletion lifecycle is explicit;
- embedded lorebook ownership is resolved at the architectural seam level;
- frontend/API/plugin/build consumers are enumerated;
- migration requirements are explicit;
- the API Delta Ledger contains every known misleading Card-as-Character boundary;
- deterministic verification requirements cover migration, live reads, independent lineages, forks, deletion, lorebooks, visuals, frontend, and production build.

No unresolved architectural question remains. The next artifact is `3_IMPLEMENTATION_PLAN.md`, which should divide this Blueprint into dependency-ordered, reviewable implementation phases without weakening these invariants.