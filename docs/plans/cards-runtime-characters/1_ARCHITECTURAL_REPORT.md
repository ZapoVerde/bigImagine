# Architectural Report — Cards, Chat Lineages, and Runtime Characters

> Purpose: define the target behaviour and architectural boundaries between reusable Cards, RP chat lineages, and runtime Characters.
>
> This report describes the required end state. It deliberately does not prescribe storage structures, APIs, migrations, files, implementation phases, or implementation order.

## 1. High-Level Goal & Rationale

BigImagine must treat **Cards** and **Characters** as distinct domain concepts, with **RP chat lineage** as the boundary that gives runtime Characters their identity context.

A **Card** is reusable source material used to start one or more independent roleplays.

A **Character** is a runtime narrative person who comes into existence inside a particular roleplay lineage.

The same Card may start multiple independent roleplays. Those roleplays do not share runtime Character identity merely because they came from the same Card.

A roleplay may also be forked. Forks belong to the same narrative lineage and may intentionally share runtime Character identity.

The governing conceptual rules are:

> **Cards start roleplays. Characters inhabit chat lineages.**

> **Independent roleplays started from the same Card have independent Characters.**

> **Forks of the same roleplay may share Characters.**

A Card may remain a live source of RP configuration and content for every chat derived from it. Editing the Card may therefore improve those linked roleplays immediately.

A Card does not, however, own or identify runtime Characters directly.

---

## 1.1 Detailed Description

### Cards

A Card is reusable authored or imported content.

A Card may contain:

- title or name
- persona-like source material
- visual or appearance source material
- scenario
- system instructions
- example dialogue
- greetings
- imported source-format information
- original Card source data
- an imported Card image
- supporting material supplied as part of the Card package

A Card may be character-centric, scenario-centric, or some mixture of both.

The system must not assume that a Card itself represents exactly one runtime person.

Cards belong to the reusable library.

A single Card may start multiple independent roleplays.

### Roleplays

An RP chat is created from a Card.

The Card remains the live source of Card-owned configuration for that RP.

Where current behaviour intentionally reads Card fields dynamically, edits to the Card must continue to affect linked roleplays without requiring the RP to be recreated.

Examples include Card-owned prompt material, scenario, description, example dialogue, greetings or other supported Card fields.

Each independently started RP establishes a new **chat lineage**.

### Chat lineage

A chat lineage consists of:

- one original RP chat
- any forks descended from that RP

Forking creates a new chat branch inside the same lineage.

Starting a new RP from the same Card creates a separate lineage.

This distinction defines runtime Character identity boundaries.

For example:

    Card X

    Lineage A
    ├─ Chat A
    └─ Chat A2 (fork of A)
       └─ Sydney #1

    Lineage B
    └─ Chat B
       └─ Sydney #2

Sydney #1 and Sydney #2 are different runtime Characters even if:

- they have the same name
- they originated from the same Card
- their narrative starting conditions were identical

Sydney #1 may be shared between Chat A and Chat A2 because those chats belong to the same lineage.

### Characters

A Character is a runtime narrative person.

Characters only come into existence from runtime roleplay activity.

A Character owns runtime state such as:

- identity
- name
- persona
- visual appearance
- lifecycle state
- scene presence
- narrative/canon state
- visual references and derived visual state

A Character does not exist simply because a Card contains similarly named source material.

A Character belongs conceptually to one chat lineage.

Within that lineage, the Character may participate in multiple forked chats.

A Character must never be shared across independent lineages, even when those lineages were created from the same Card.

### Character discovery

Runtime Character discovery operates within the current chat lineage.

When the narrative identifies a person:

1. the system determines whether that person already exists as a runtime Character in the current lineage
2. if an appropriate Character exists, it may be reused
3. otherwise a new Character is created for that lineage

The Card library is not searched as a source of Character identity.

Characters from another independent lineage are not candidates.

Name matching alone never crosses lineage boundaries.

### Cards and Characters

There is no direct persistent Card↔Character identity relationship.

The architecture must not express:

> this Character belongs to this Card

or:

> this Card's Sydney is this runtime Sydney

The relationship is instead:

    Card
      ↓
    RP chats
      ↓
    chat lineage
      ↓
    runtime Characters

This relationship is indirect and contextual.

The Card determines which chats depend on it.

The chat lineage determines which runtime Characters may be shared.

### Card editing

Card editing is intentionally live.

If a linked RP currently reads a Card-owned field dynamically, editing that Card must affect those linked chats according to existing live-read semantics.

This is desired behaviour.

Editing a Card must not directly mutate runtime Character state.

For example:

- changing Card scenario may alter future prompt assembly
- changing Card instructions may improve future RP responses
- changing a runtime Character's persona affects that Character only

These are separate domains.

### Card deletion

Deleting a Card destroys all RP chats that depend on that Card.

This is intentional.

Deletion therefore removes every independent chat lineage started from that Card.

Once those chats are removed:

- chat membership relationships disappear
- runtime Character lifecycle cleanup runs
- Characters that no longer belong to any surviving chat are deleted
- runtime state owned exclusively by those deleted chats/Characters is cleaned up according to its normal lifecycle

The Card does not directly delete Characters.

Characters disappear because the chat lineages in which they exist have been destroyed.

### Character deletion and chat deletion

Deleting one chat within a fork lineage does not necessarily delete its Characters.

For example:

    Chat A  ─┐
             ├─ Sydney #1
    Chat A2 ─┘

Deleting Chat A leaves Sydney #1 alive because Chat A2 still belongs to the same lineage and still references her.

Deleting the last chat carrying Sydney #1 removes her remaining membership, after which normal orphan cleanup may delete her.

Independent Chat B and Sydney #2 are unaffected.

### Card media

Imported Card images belong to Cards.

Their lifecycle follows the Card.

When a Card is deleted:

- its Card-owned imported media is cleaned up
- its dependent chats are deleted
- runtime Character visual state is cleaned up independently through runtime lifecycle

A Card image is not automatically a runtime Character portrait.

### Runtime Character visual state

Character visual references and derived visual state are Character-owned.

Generated image assets themselves remain externally hosted. The Character domain owns only the references, metadata, subject state, combinations, hashes, prompts, provenance, or other derived state required to use those assets.

Deleting a Character removes its Character-owned visual references and derived visual state according to normal runtime lifecycle.

It does not imply ownership or deletion of the externally hosted image asset itself unless a separate provider-specific cleanup mechanism explicitly exists.

Two independent Sydneys created from two separate RPs under the same Card may therefore have different:

- appearance
- image references
- subject visual state
- outfit state
- expression state
- VN visual combinations

Those differences are correct.

### Cast

Cast represents runtime Characters in the current RP lineage.

Cast must not:

- enumerate Cards
- resolve Characters from Cards
- reuse Characters from another independent lineage merely because the Card is the same
- infer identity from matching names outside the current lineage

Forked chats may intentionally see the same Characters where runtime membership says they share them.

### Same-name isolation

The architecture must safely support:

- Card X containing a character named Sydney
- Sydney #1 in Lineage A
- Sydney #2 in Lineage B
- another unrelated Card Y containing a Sydney
- Sydney #3 in a lineage started from Card Y

None of those runtime Characters share identity unless they are explicitly part of the same chat lineage.

### Supporting content

Supporting content imported with a Card belongs to the Card domain until used by its linked RP chats.

It may remain live Card-owned configuration where that matches existing behaviour.

Its existence must not establish direct runtime Character identity.

If supporting content is scoped to runtime Characters, that scoping must use the actual runtime Character within the relevant lineage rather than the Card's identity or name.

---

## 2. Core Principles & Constraints

### 2.1 Governing Project Principles

#### Cards are reusable source material

A Card may start more than one independent RP.

Those RPs must remain runtime-isolated from each other.

#### Runtime identity is contextual

Runtime Character identity is defined within narrative context, not by reusable source material.

#### Forks preserve lineage

Forking an RP creates a related branch, not a brand-new independent runtime world.

#### Names are not identity

Names may be used for resolution within an eligible runtime scope but never establish identity across independent lineages.

#### Ownership determines lifecycle

Cards own dependent chats and Card media.

Chats and runtime membership govern Character lifecycle.

Characters own Character runtime state, visual references, and derived visual state, but not externally hosted image assets merely because they reference them.

---

### 2.2 Change-Specific Principles

#### P-01 — Cards and Characters are separate domains

Cards and runtime Characters have distinct identity, ownership and lifecycle.

#### P-02 — Every RP chat belongs to one Card

An RP chat has one Card source.

A Card may own many RP chats.

#### P-03 — Each independently started RP creates a new lineage

Starting RP twice from the same Card creates two independent runtime worlds.

#### P-04 — Forks remain in the same lineage

Forking an RP creates another chat within that RP's existing lineage.

#### P-05 — Character identity is lineage-scoped

A runtime Character may participate in multiple chats only when those chats belong to the same lineage.

#### P-06 — Characters never cross independent lineages

A Character from one independently started RP must never be reused in another independently started RP, even if both use the same Card.

#### P-07 — No direct Card↔Character identity

No persistent relationship may mean that a runtime Character is “the Character belonging to” a Card.

#### P-08 — Card reads remain live

Where existing RP behaviour intentionally consumes Card-owned fields dynamically, edits to the Card continue to affect linked chats.

#### P-09 — Card deletion destroys dependent RPs

Deleting a Card deletes all RP chats started from it, including all fork branches.

#### P-10 — Character cleanup follows chat deletion

Characters are removed through loss of their chat memberships and normal runtime lifecycle cleanup, not through direct Card ownership.

#### P-11 — Card media is Card-owned

Imported Card imagery follows Card lifecycle.

#### P-12 — Character visual references and derived visual state are Character-owned

Runtime Characters own the references and derived state needed to use generated imagery. Externally hosted image assets are not treated as Character-owned physical assets merely because a Character references them.

#### P-13 — Same Card does not imply shared Characters

Two independent RPs started from the same Card have distinct runtime Character populations.

---

### 2.3 Explicit Non-Goals

This architectural change does not define:

- automatic generated Character portraits
- per-turn portrait reconciliation
- visual-description prompt changes
- Cast image-regeneration controls
- Studio redesign
- Portraits settings redesign
- VN sprite-generation redesign
- BGRM changes
- Card UI visual redesign
- provider-specific deletion of externally hosted generated images
- changes to the semantic meaning of Persona or Appearance

Those systems may rely on the resulting clean Character identity model later.

---

## 3. Architectural Flows

### 3.1 User Flow

#### Create or import a Card

1. User creates or imports a Card.
2. Card appears in the reusable library.
3. No runtime Character is created.

#### Start first RP

1. User selects Card X.
2. User starts RP.
3. Chat A is created.
4. Chat A begins a new lineage.
5. Runtime Characters are created only as the RP identifies them.

#### Fork RP

1. User forks Chat A.
2. Chat A2 is created in the same lineage.
3. Runtime Characters may be shared between A and A2.

#### Start another RP from the same Card

1. User selects Card X again.
2. User starts another RP.
3. Chat B is created.
4. Chat B starts a new independent lineage.
5. Characters in Lineage A are not candidates for Chat B.
6. Chat B creates its own runtime Characters as needed.

#### Edit Card

1. User edits Card X.
2. Linked chats continue reading Card-owned content live according to existing behaviour.
3. Future RP turns reflect the updated Card.
4. Runtime Character state is not directly rewritten.

#### Delete Card

1. User deletes Card X.
2. Every RP chat linked to Card X is deleted.
3. All forks of those chats are deleted.
4. Their Character memberships disappear.
5. Characters with no remaining memberships are cleaned up.
6. Card-owned media is cleaned up.

---

### 3.2 Data Flow

#### Card creation/import

Card source  
→ Card domain  
→ reusable Card persistence  
→ optional Card-owned media

No Character creation occurs.

#### RP creation

Card  
→ RP chat  
→ new chat lineage

No runtime Character identity is created merely by starting RP.

#### Character discovery

RP narrative activity  
→ person detected  
→ lineage-scoped Character resolution  
→ existing Character in same lineage reused OR new Character created  
→ Character linked to relevant chat

#### Fork

Existing chat  
→ fork chat  
→ same lineage  
→ eligible runtime Character memberships shared into fork according to existing fork semantics

#### Independent RP from same Card

Same Card  
→ new chat  
→ new lineage  
→ independent Character namespace

#### Card deletion

Card deleted  
→ all dependent RP chats deleted  
→ all their chat memberships removed  
→ orphan Character cleanup  
→ runtime-state cleanup  
→ Card-owned media cleanup

---

### 3.3 Logic Flow

#### Resolve Card

Card resolution occurs only in the Card domain.

Runtime Characters are never candidate Cards.

#### Resolve runtime Character

When a name/person appears:

1. determine current chat lineage
2. search only eligible runtime Characters within that lineage
3. reuse an existing Character when runtime resolution rules permit
4. otherwise create a new Character
5. never search another independent lineage
6. never search the Card library as Character identity

#### Start RP

Starting RP from Card X:

- creates a new root chat
- establishes a new lineage
- links the chat to Card X
- uses Card X as live RP source material
- does not create a Character

#### Fork RP

Forking a chat:

- keeps Card association
- keeps lineage identity
- preserves intended shared Character identity across the fork

#### Start another RP

Starting another RP from the same Card:

- creates another root chat
- creates another lineage
- does not reuse Characters from previous lineages

#### Delete one chat

Deleting a chat:

- removes that chat
- removes its Character memberships
- leaves shared lineage Characters alive if another chat still references them

#### Delete Card

Deleting the Card:

- deletes all root and forked chats dependent on it
- removes all related memberships
- allows normal lifecycle cleanup to remove all now-orphaned runtime Characters
- removes Card-owned media

---

### 3.4 Failure Flow

#### Card import failure

A failed Card import does not create runtime Characters.

Partial Card-owned resources are cleaned up according to existing best-effort behaviour.

#### RP start failure

A failed RP creation must not leave a partially created runtime Character population or establish cross-lineage identity.

#### Character discovery failure

Failure to resolve or create a Character remains scoped to the current chat lineage.

It must not fall back to Characters from another RP or to Card identity.

#### Fork failure

A failed fork must not mutate the source lineage's existing Character memberships.

#### Card deletion failure

Deletion must not leave a state where the Card is logically absent but some chats still claim to depend on it without an explicit recoverable failure condition.

Deletion of Card-owned media may remain best-effort after logical domain deletion if that matches established storage conventions.

---

## 4. Overall Acceptance Criteria

- **AC-01:** Cards and runtime Characters have separate canonical identities and domain ownership.

- **AC-02:** Creating or importing a Card does not create a runtime Character.

- **AC-03:** Every RP chat belongs to exactly one Card.

- **AC-04:** A Card may have multiple independently started RP chats.

- **AC-05:** Each independently started RP creates a distinct chat lineage.

- **AC-06:** Forks of an RP remain members of the source RP's lineage.

- **AC-07:** Runtime Character identity is scoped to one chat lineage.

- **AC-08:** A Character may be shared across multiple chats in the same lineage.

- **AC-09:** A Character may not be shared across independent lineages.

- **AC-10:** Two independent RPs started from the same Card may each contain a same-named Character without sharing identity or state.

- **AC-11:** Runtime Character discovery searches only the current lineage's eligible Character population.

- **AC-12:** Runtime Character discovery never uses a Card as a Character identity source.

- **AC-13:** Matching names do not establish Character identity across independent lineages.

- **AC-14:** Editing a Card continues to affect linked RP chats wherever Card fields are intentionally live-read today.

- **AC-15:** Editing a Card does not directly mutate runtime Character state.

- **AC-16:** Deleting a Card deletes all RP chats linked to that Card.

- **AC-17:** Deleting a Card deletes all forked chats descended from its linked RP chats.

- **AC-18:** Card deletion does not directly target runtime Characters by Card identity.

- **AC-19:** After Card-owned chats are deleted, Characters with no surviving chat memberships are cleaned up through runtime lifecycle rules.

- **AC-20:** Deleting one chat in a lineage does not delete a Character still referenced by another chat in that lineage.

- **AC-21:** Starting a new RP from the same Card never reuses Characters from an older independent RP lineage.

- **AC-22:** Cast contains runtime Characters from the current RP lineage and never Cards.

- **AC-23:** Imported Card media is Card-owned and cleaned up when the Card is deleted.

- **AC-24:** Runtime Character visual references and derived visual state are scoped to the Character and are cleaned up with that Character; externally hosted image assets are not treated as locally owned resources.

- **AC-25:** Card-owned imported imagery is not treated as runtime Character identity or ownership.

- **AC-26:** Card-provided supporting content does not create a direct Card↔runtime-Character identity relationship.

- **AC-27:** Forking preserves intended runtime Character sharing without making those Characters available to unrelated RP lineages from the same Card.

- **AC-28:** The completed architecture requires no lifecycle-status/nullability convention to distinguish Cards from Characters.

---

## 5. Open Architectural Questions

None.

### Resolved architectural decisions

- The reusable source concept is **Card**.
- A Card may be character-centric or scenario-centric.
- Cards and runtime Characters are separate domains.
- Every RP chat is linked to one Card.
- A Card may start many independent RPs.
- Each independently started RP creates its own chat lineage.
- Forks remain inside the lineage of the RP they forked from.
- Runtime Character identity belongs to one lineage.
- Characters may be shared across forks within that lineage.
- Characters may never cross independent lineages.
- Same Card does not imply shared runtime Characters.
- Card reads remain live where current RP behaviour intentionally uses them.
- Editing a Card may improve all linked RPs immediately.
- Card deletion deletes all chats and forks dependent on that Card.
- Characters are cleaned up indirectly through loss of chat membership.
- There is no direct persistent Card↔Character identity relationship.
- Imported Card media belongs to Cards.
- Runtime Characters own visual references and derived visual state, not externally hosted image assets themselves.
