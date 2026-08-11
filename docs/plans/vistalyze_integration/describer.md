# The Room Describer (Step 1.5: scrape → describe → render)

**Status**: Built, verified 2026-08-11 — cited by `orchestratorSettings.ts` (the room-description
pass's two settings keys).

The missing major step in BigImagine's background generation: **a room-description LLM call**.
BigImagine's post-turn scraper (segway.md §4) is deliberately zero-token (bi_principles.md §2) —
it can only seed a freshly-minted location's `visual_description` from the extracted name itself
("Bostaff's Apartment — Living Room"). Until this pass existed, that name-string was exactly what
the image pipeline expanded into the bg prompt: a room *name*, not a room *description*. VLZ's
pipeline runs three LLM steps (Boolean gate → Classifier → **Describer**); this is BigImagine's
analogue of the Describer, slotted between the scraper and the render.

## 1. Pipeline position

```
cleanup subloop (writes the two-line header)
  → scraper (segway.md §4, zero tokens — mints the location, visual_description = name)
  → DESCRIBER (this doc, one LLM call, only for a never-described row)
  → generateLocationImage (endpoint.md §5 — the prompt hash now covers the real description)
```

Both passes run decoupled, fired together from the response 'finish' event
(`httpServer.ts`'s `fireLocationImageGeneration`) and from the restart triggers
(`ensureActiveLocationImage`). The chain **awaits the describer before the render**: the render
hash (endpoint.md §5.1.2) is computed over the synthesized prompt, which expands
`visual_description`, so a description that landed *after* a render would flip the hash and waste
a generation. Sequencing describe-then-render inside the same decoupled fire gives one clean
render per new room.

## 2. The skip rule (never-described sentinel)

A row is "never described" iff its `visual_description` is empty **or still equals its `name`**
(the mint seed). The pass is a no-op otherwise:

* a row the describer already enriched (visual_description ≠ name) is skipped — re-visits and the
  restart triggers cost nothing;
* a user-authored description (`create_location`'s optional `visual_description`, or the
  `create_location` tool writing `status = 'permanent'`) is explicit canon and is **never
  overwritten** (bi_principles.md §3 — an explicit signal outranks an inferred one);
* `create_location` with no description writes `visual_description = ''` — still never-described,
  so the describer fires for it, exactly as for a scraped row.

The same sentinel is what segway.md §4.2 step 3's same-place carry relies on: a mint that finds a
*described* prior row carries its `visual_description`/`definition` forward (so the carried render
hash still matches — §5.1.2 cache hit), and the describer sees the carried description as
already-described (no second LLM call for the same room). A *name-seeded* prior carries nothing
beyond the fingerprint, exactly as before.

## 3. The LLM call

One call, shaped like `ensureFirstTurnHeader.ts`'s single-call pattern:

* **Context**: the chat's last `location_describer_history_pairs` turn-pairs plus the turn that
  just landed (VLZ `buildDescriberContext`'s shape — the trigger message is the final entry), read
  from `chat_messages` in the same ordering every other read uses. Default 1 turn-pair.
* **Prompt**: the `location_describer_prompt` orchestrator setting (migration 0078), expanded with
  `{{location_name}}` and `{{context}}`. Empty setting = the built-in default
  (`DEFAULT_LOCATION_DESCRIBER_PROMPT`), the same "empty override means built-in" fallback as
  every other prompt key (bi_principles.md §18).
* **Gate**: `runWithCallContext({ taskId: chatId, kind: 'system', userId })` (bi_principles.md §14)
  — the LLM provider is the turn's own gated provider where the caller has one (the post-turn
  fire passes `turnLlm`, the same connection the story ran on — VLZ's "describer defaults to the
  main chat LLM"), else the boot-time `deps.llm` (restart triggers).
* **Trace**: `recordPromptTrace` entry kind `'describer'` recorded before the call, reply attached
  after (the Prompt Inspector's source, same as 'cleanup'/'title').

### The built-in prompt

```
[SYSTEM: TASK — LOCATION VISUAL ARCHIVIST]
The scene is: {{location_name}}

NARRATIVE CONTEXT:
{{context}}

Write the location's Definition (a brief conceptual statement of what this place is) and its
Visuals (2–3 sentences of concrete visual detail for an image generator — lighting, materials,
layout, color).

### OUTPUT FORMAT:
Definition: [Logical Definition]
Visuals: [Image Generation Prompt]

Exclude mention of humans, animals, and any other living creatures from the Visuals.
```

Note what is deliberately absent: **time of day, weather, mood**. The physical description is the
room alone — same stance as endpoint.md §4.2's default template — so the describer's output is
stable across turns, and time-conditioned imagery stays a user template override (which changes
the hash when the template does).

## 4. Output mapping

The reply is parsed with VLZ `extractMarkerData`'s tolerant label scan (markdown-wrapped labels
tolerated; capture stops at the next marker). Two fields are written back, each **independently** —
a reply missing one half leaves that column as-is:

| Marker  | Column                       | Used by                                        |
|---------|------------------------------|------------------------------------------------|
| `Definition:` | `locations.definition` (new, nullable, migration 0078) | model-facing getters (`get_locations`, `create_location`) — the conceptual identity, for future search/library |
| `Visuals:`    | `locations.visual_description` | image prompt synthesis (`{{visual_description}}`, endpoint.md §4.2) |

`Name:` is deliberately ignored — the header location is the authoritative name and is never
overridden.

## 5. Settings surface (bi_principles.md §18)

| Key | Default | Meaning |
|-----|---------|---------|
| `location_describer_prompt` | built-in prompt above | the full describer prompt; empty = default |
| `location_describer_history_pairs` | `'1'` | trailing turn-pairs of narrative context; unset/corrupt = 1 |

Both are `orchestrator_settings` keys added by `db/migrations/0078_location_describer.sql`
(alongside `locations.definition`), read live on every pass, editable in the Settings tab's
"Image Generation" fieldset (adminServer `getImageSettings`/`setImageSettings`, `ImageSettings`
shape). No restart.

## 6. Fail-open contract

The pass never throws (segway.md §1): a config read, a message read, an LLM error, an empty
reply, a reply with no markers, or a DB write failure all log and return, leaving the row
untouched. A missing description is never worth a broken pass — the render still runs with the
name-seed description, byte-identical to the pre-feature behavior. An in-flight guard (one
describe per location, same shape as `generateLocationImage.ts`'s render guard) keeps overlapping
triggers from double-spending a text LLM round-trip.

## 7. Files

* **`orchestrator/src/orchestrator/describeLocation.ts`** *(new)* — the pass itself.
* **`db/migrations/0078_location_describer.sql`** *(new)* — `locations.definition` + the two
  settings keys (CHECK constraint widened wholesale).
* **`orchestrator/src/server/httpServer.ts`** — `fireLocationImageGeneration` chains
  describe-then-render; post-turn fires pass `turnLlm`; the restart triggers use `deps.llm`.
* **`orchestrator/src/orchestrator/locationAndPresenceScraper.ts`** — §4.2 step 3's carry also
  clones a described prior's `visual_description`/`definition` (hash-match keeps the §5.1.2 cache
  hit); a never-described mint seeds `visual_description = name`, `definition = null`.
* **`orchestrator/src/io/chatSessions.ts`** — `forkChat`'s location-resurrection clone carries
  `definition` alongside `visual_description`.
* **`plugins/locations/src/createLocationTool.ts`** — accepts an optional `definition`.
* **`plugins/locations/src/getLocationsTool.ts`** — surfaces `definition` (id/name/definition).
* **`orchestrator/scripts/verify-location-describer.mjs`** *(new)* — the fake-pool/stub-LLM suite.
