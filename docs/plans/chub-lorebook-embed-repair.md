# Repair: embed chub-imported lorebook entries at import time

*A follow-up to `chub-lorebook-import-plan.md` §A, filed after reviewing the landed implementation
(`insertCharacterFromCard.ts`, commit `89f8162`). Per `docs/roles.md`'s fix-loop, this is a
structural fix — it changes `ToolHandlerContext`, a shape every registered tool handler depends on
— so it's a repair doc for Reasonix rather than a Claude Code direct patch.*

## Goal

A card imported from chub.ai (or uploaded locally) whose `character_book` gets turned into
`lorebook_entries` rows today never has those rows embedded. Because `recallLorebookEntries.ts`
excludes any non-constant entry with a NULL `vector_embed` from discovery by design, this means
every imported entry that isn't marked `constant` is permanently unrecallable the moment Lorebook
mode is turned on — silently, with no signal anywhere in the UI — unless a user manually opens and
re-saves each entry one at a time in `LorebooksView.tsx` (which happens to re-embed on save). That
directly undercuts the point of `chub-lorebook-import-plan.md` §A: "a pathway to handle that, fairly
easy." This repair makes the import path embed entries the same way every other lorebook write path
already does.

## Files

- `orchestrator/src/orchestrator/toolRegistry.ts` — modified — `ToolHandlerContext` gains
  `embeddings: EmbeddingProvider`, alongside the existing `userId`/`db`/`chatId`/`anchorMessageId`.
- `orchestrator/src/orchestrator/loop.ts` — modified — the one place a `ToolHandlerContext` object
  is constructed (~line 234, `tool.handler(call.arguments, { userId, db: session, chatId,
  anchorMessageId: opts.anchorMessageId })`) gains `embeddings`. `RunTurnOptions` (or wherever
  `loop.ts`'s run function takes its options) needs an `embeddings: EmbeddingProvider` field to have
  something to pass — check whether `runTurn`'s caller already has one in scope (httpServer.ts does,
  it's already a `PluginDeps` member) versus threading a new parameter down.
- Every caller of `loop.ts`'s run function (`httpServer.ts`, `agentRoutineDispatch.ts`, and any
  other task-kind dispatcher) — modified — pass their existing `embeddings` provider through. These
  are additive changes (one more field on an options object each already builds), not new plumbing
  from scratch, since `embeddings: EmbeddingProvider` already exists on `PluginDeps`
  (`pluginLoader.ts`) and every one of these callers already has it available.
- `plugins/characters/src/insertCharacterFromCard.ts` — modified — takes a new `embeddings:
  EmbeddingProvider` parameter; `insertLorebookEntries` embeds each draft as
  `` `${bookName}\n${content}` `` (the exact convention `panelData.ts`'s `quickAddLorebookEntry` and
  `adminServer.ts`'s create route already use — grep both for the literal template before writing
  this, it should match verbatim) and adds `vector_embed` to the insert's column list.
- `plugins/characters/src/importCharacterCardTool.ts` — modified — passes `ctx.embeddings` through
  to `insertCharacterFromCard`.
- `plugins/characters/src/importCharacterCardFromUrlTool.ts` — modified — same.

## Logic

`insertLorebookEntries` currently builds one INSERT with a fixed column list that explicitly omits
`vector_embed` (its own comment: "this plan only writes rows, it doesn't embed or recall them"). The
fix batches an embed call over all drafts before that insert — `embeddings.embed(drafts.map(d =>
\`${bookName}\n${d.content}\`))`, one call for the whole book rather than one per entry, mirroring
`adminServer.ts`'s ST-importer batch-embed call (`embeddings.embed(entries.map(...))`, already in
the codebase at the ST-import route) rather than the single-entry shape `quickAddLorebookEntry` uses
(that one only ever handles one entry at a time, so it's not the pattern to copy here — the batch
importer route is the closer sibling).

Each draft's resulting vector (or `null` if the batch call throws or returns short) is added to that
row's insert values, `vector_embed` appended to the column list `insertLorebookEntries` already
builds.

Fail-open, matching every other embed call in this codebase (`quickAddLorebookEntry`,
`recallLorebookEntries`): if the embed call throws, log a warning and insert every draft with
`vector_embed = null` rather than failing the whole card import. A card with an unreachable
embeddings provider should still import — the character, the lorebook rows, and the character
link — same as it does today; it just stays undiscoverable until someone re-saves it or a later
retry succeeds. This is strictly better than today's permanent-null with no retry path, but the
import itself must never hard-fail over an embedding hiccup (same contract every sibling wrapper
already holds).

## Contracts

`insertCharacterFromCard`'s signature grows one parameter:

```
insertCharacterFromCard(db, userId, parsed, cardJson, embeddings, avatarBytes?)
```

(`embeddings` slotted before the existing optional `avatarBytes` so callers that don't pass an
avatar don't need to pass `undefined` in two places — check whichever ordering keeps both call
sites in `importCharacterCardTool.ts`/`importCharacterCardFromUrlTool.ts` cleanest; the exact
position isn't load-bearing, only that both call sites get updated together.)

`ToolHandlerContext` gains one required field:

```
interface ToolHandlerContext {
  userId: string;
  db: DbSession;
  chatId?: string;
  anchorMessageId?: string;
  embeddings: EmbeddingProvider;
}
```

Required, not optional — every tool handler already runs inside a request that has an
`EmbeddingProvider` available somewhere in scope (it's a `PluginDeps` member everywhere plugins get
constructed), so there's no legitimate call site that can't supply one. Making it optional would
just relocate today's silent gap into every other tool instead of closing it.

## Edge Cases

- A card with no `character_book` (the common case): `parseCharacterBookEntries` returns `null`
  before any embedding happens — this path is a strict no-op, same as today.
- Embeddings provider throws or times out: import still succeeds, all entries land with
  `vector_embed = null`, a warning is logged. Same fail-open shape as every other embed call in this
  codebase — do not let this become a reason the whole character import fails.
- A card with a very large `character_book` (dozens/hundreds of entries): one batched `embed()` call
  over all of them, not N sequential calls — check the embeddings provider's own batch-size ceiling
  (if any) and chunk if it has one; if it doesn't, a single call is fine, this isn't a hot path.
- `entry.content` empty string: still gets embedded (embedding an empty string is either a no-op or
  a defined provider behavior already handled elsewhere in this codebase — don't special-case it
  here, follow whatever `quickAddLorebookEntry` does today for an all-whitespace entry, since that
  function already guards its own top-level empty-content case the same way).

## Tests

- `insertCharacterFromCard`, given a card with a two-entry `character_book`, produces two
  `lorebook_entries` rows with non-null `vector_embed`.
- Given an embeddings provider stubbed to throw, the same import still succeeds (character +
  lorebook rows + character link all present), all entries have `vector_embed = null`, no thrown
  error propagates to the caller.
- `importCharacterCardTool.ts` and `importCharacterCardFromUrlTool.ts` both still pass their
  existing test/verify scripts (`verify-characters.mjs`, `verify-chub-tools.mjs`) once `ctx.embeddings`
  is threaded through — these scripts construct a `ToolHandlerContext` by hand somewhere; check they
  don't need a stub `embeddings` added to keep compiling.
- `verify-lorebook-io.mjs` or a new script: a `recallLorebookEntries` call finds a chub-imported
  entry now that it has a vector, using the exact same fixture card `verify-character-book-parse.mjs`
  already builds (don't invent a second fixture).

## Out of Scope

- Backfilling `vector_embed` for any `lorebook_entries` rows already imported before this fix lands
  (there's no production data yet per the repo's current state, but if that assumption changes,
  a one-off backfill script is a separate, smaller follow-up, not part of this repair).
- Any UI signal for "this entry has no vector yet" in `LorebooksView.tsx` / `LorebookPanel.tsx` — the
  fix above makes the gap not exist for the import path going forward, which is a more complete fix
  than surfacing a warning about a gap that no longer opens.
- Re-embedding on `character_book` re-import (re-importing the same card twice creates a second
  book today, per `chub-lorebook-import-plan.md`'s own open question — unchanged by this repair).

## Principles / Conventions in Play

- `bi_principles.md` §8 (Four Kinds of Code) — `insertLorebookEntries`'s embed step keeps
  `insertCharacterFromCard` an IO Wrapper, not a new role; it's already impure Postgres IO, adding
  one more external call (the embeddings provider) doesn't change its classification.
- Fail-open is the established convention for every embedding call in this codebase
  (`recallLorebookEntries`, `quickAddLorebookEntry`, the ST-importer route) — this repair extends
  the same contract to the chub-import path rather than introducing a new failure posture.
