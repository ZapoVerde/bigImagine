# Chub Import: Embedded Lorebooks + a Real Import Button on the Card Modal

Two gaps, both in the chub.ai import path, bundled here because the second is a small UI fix that
piggybacks on infrastructure the first one touches anyway.

Depends on `docs/lorebook-plan.md` §3a (`lorebooks`/`lorebook_entries`, already live via `0051`) and
§3b's `lorebook_character_links` table landing first. Nothing here needs §3c's gating columns, §3d's
settings, or §4/§5's recall engine — this plan only ever *writes* lorebook rows, it doesn't discover
or inject them.

## A. A downloaded/imported card's embedded lorebook currently goes nowhere

### Current state

The Character Card V2/V3 spec allows an embedded lorebook at `data.character_book` — `{ name?,
description?, scan_depth?, token_budget?, recursive_scanning?, entries: CharacterBookEntry[] }`,
each entry shaped close to (not identical to) an ST world-info entry: `keys`, `secondary_keys`,
`content`, `comment`/`name`, `constant`, `selective`, `enabled`, `insertion_order`, `position`
(`'before_char' | 'after_char'`), `case_sensitive`.

`cardCodec.ts`'s `parseCardJson` (`plugins/characters/src/cardCodec.ts:68`) never reads
`data.character_book` — only `name`/`description`/`personality`/`scenario`/`system_prompt`/
`mes_example`/`first_mes`/`alternate_greetings`. The full raw JSON is still kept verbatim as
`characters.source_json` (`insertCharacterFromCard.ts`), so nothing is *lost* — but a card's
lorebook today just sits inert in a JSONB column, unreachable by anything, for both import routes
(`importCharacterCardTool.ts`'s local-upload path and `importCharacterCardFromUrlTool.ts`'s chub-URL
path — both call the same `insertCharacterFromCard`).

### Fix

**New pure function**, `parseCharacterBookEntries(cardJson: unknown): LorebookEntryDraft[] | null` —
placed in `orchestrator/src/util/` (core), not inside `plugins/characters`, because
`docs/lorebook-plan.md` §8a's ST-world-info-JSON importer needs the identical target shape
(`LorebookEntryDraft`) for its own, differently-sourced parse — same reasoning
`assemblePromptStack.ts`'s own preamble gives for why it lives in core: a pure function with no
plugin-specific state, needed by more than one caller, belongs in core the same way
`interpolateMacros.ts` does. Returns `null` when the card has no `character_book` or an empty
`entries` array — the common case, and it must be a fast, obvious no-op.

Field mapping (`character_book` entry → `LorebookEntryDraft` → `lorebook_entries` column):

| `character_book` entry field | `LorebookEntryDraft` / `lorebook_entries` |
|---|---|
| `id` (number, often absent) | `uid` — synthesized sequentially (0, 1, 2, …) when absent, same as ST's `getFreeWorldEntryUid` does for a book with no existing uids |
| `keys` | `key` |
| `secondary_keys` | `keysecondary` |
| `comment` or `name` | `comment` |
| `content` | `content` |
| `constant` | `constant` |
| `selective` | `selective` |
| `!enabled` | `disable` |
| `insertion_order` | `order_value` |
| `position` (`'before_char'`/`'after_char'`) | `position` (0/1, same mapping `0051`'s `position smallint` already expects) |
| `case_sensitive` | kept in `source_json` only (§3c of `lorebook-plan.md` dropped `case_sensitive` as an evaluated column — this plan doesn't reopen that) |
| whole entry, verbatim | `source_json` |

**New IO Wrapper**, added to `insertCharacterFromCard.ts` (the one write path both import tools
already share, per that file's own preamble — this is exactly the kind of change that file was
factored out to make safe): after the `characters` row insert, if `parseCharacterBookEntries`
returns entries, in the same flow:

1. Insert one `lorebooks` row — `name = character_book.name || "${character.name}'s Lorebook"`,
   `global_scope = false` (§3b of `lorebook-plan.md`: this book belongs to this character, it isn't
   platform-wide).
2. Bulk-insert the mapped `lorebook_entries` rows under it.
3. Insert one `lorebook_character_links` row (`lorebook-plan.md` §3b) linking the new book to the
   new `character_id` — this is what makes "loading this character brings its lore into scope" real,
   the same promise the very first draft of `lorebook-plan.md` opened with.

Not a separate transaction/step the caller has to remember to invoke — folded into
`insertCharacterFromCard` itself, so both `importCharacterCardTool.ts` and
`importCharacterCardFromUrlTool.ts` (and the modal's new Import button in §B) get it automatically,
with no second write path to drift out of sync.

`InsertedCharacter`'s return shape gains `lorebookEntriesImported: number` (0 when there was no
`character_book`) so callers can surface "Imported 14 lorebook entries from this card" without a
second round-trip.

### Whether it's actually *used* stays gated separately

Creating the link is not the same as it firing in a turn — `lorebook-plan.md` §2's `lorebook_mode`
default-off gate still applies. A card with an embedded lorebook imports its entries and its
character-link unconditionally (that's just data, same tier as importing `description`), but whether
they're ever recalled into a prompt still depends on Lorebook being turned on, same as any other
book. No conflict — attachment and activation are already orthogonal per `lorebook-plan.md` §3b/§2.

## B. Chub card modal: Download-only, no Import

### Current state

`ChubResultCard.tsx` (the Browse Chub grid cell) already has a real, working Import button —
`onClick` calls `BrowseChubView.tsx`'s `importCharacter(fullPath)`, which does
`callTool('import_character_card_from_url', { url: fullPath }, apiKey)` (a direct tool-invocation
call, not routed through the LLM/chat) and tracks per-card `ImportState` (`idle` / `importing` /
`imported` / `error`) in `BrowseChubView`'s `importStates` map.

`ChubCardModal.tsx` (opened by clicking a grid card) only has `onDownload` — fetches the card PNG
through the chub-avatar proxy and triggers a browser file download. There's no way to import from
inside the modal; a user who opens it to read the description has to close it and use the grid
card's button instead.

### Fix

Thread the same props `ChubResultCard` already receives into `ChubCardModal`:

```
interface ChubCardModalProps {
  card: ChubCharacterSummary;
  apiKey: string | null;
  importState: ImportState;   // new
  onImport: () => void;       // new
  onClose: () => void;
}
```

`BrowseChubView.tsx` passes `importStates[card.fullPath] ?? { status: 'idle' }` and
`() => void importCharacter(card.fullPath)` into the modal exactly the way it already does for the
grid cell — no new state, no second `ImportState` machine to keep in sync with the grid's.

Add an Import button to the modal's footer, next to (not replacing) the existing Download button —
downloading the raw PNG is still a legitimate, separate thing to want. Button label/disabled logic
mirrors `ChubResultCard.tsx`'s existing block verbatim (`Importing…` / `Imported ✓` / `Import` /
error message beneath) so the two surfaces read as the same action, not two different features.

Once §A lands, a successful import's toast/status line also reports
`lorebookEntriesImported` when nonzero — "Imported ✓ (12 lorebook entries)" — visible from both the
grid card and the modal, since both funnel through the same `ImportedChubCharacter` response shape
(`frontend/src/api/types.ts`).

## Build order

1. `parseCharacterBookEntries` (core, pure, unit-testable in isolation against a hand-built V2 JSON
   fixture with a `character_book` block).
2. `lorebook_character_links` table — if `lorebook-plan.md`'s migration hasn't landed yet, this plan
   needs at minimum that one table (plus the already-live `lorebooks`/`lorebook_entries`) pulled
   forward; it does not need the rest of that migration.
3. Wire `parseCharacterBookEntries` + the three-insert sequence into `insertCharacterFromCard.ts`;
   extend `InsertedCharacter`/`ImportedChubCharacter` with `lorebookEntriesImported`.
4. Modal props + button (§B) — independent of 1–3, can land first or in parallel; only the "N
   entries imported" detail in the success state depends on §A being done.

## Open questions

- `character_book.scan_depth` / `token_budget` / `recursive_scanning` are book-level settings in the
  spec, distinct from `lorebook_settings`'s *global* versions (`lorebook-plan.md` §3d). Do they get
  read into anything, or stay `source_json`-only like `case_sensitive` did? Nothing in the current
  `lorebooks` table has a per-book override of the global settings, so the honest default is
  `source_json`-only until per-book overrides are an actual feature, not silently half-wired.
- Should importing a card whose `character_book.name` collides with an existing lorebook's name
  create a second book (current default — `lorebooks` has no unique constraint on `name`) or offer
  to merge? Collision is probably rare enough (book names aren't a shared namespace across
  characters) that a second book is the right default; flagging in case that's wrong.
- Does the Import button in the modal close the modal on success, or leave it open showing
  `Imported ✓` the way the grid card does? Leaving it open (no `onClose()` call after import) matches
  the grid card's existing behavior and needs no new decision — named here only so it isn't
  accidentally "fixed" into inconsistency later.
