# Add remove-from-chat to the RP Cast

*For Reasonix to implement per `docs/roles.md`.*

## Goal

`CastSection.tsx` lists every character linked to the active RP chat with a live presence dot, but
has no way to drop one from the chat. This plan adds a delete affordance to each cast row so a
character can be removed from the chat, and pins down the cascade: removing a character from the
cast deletes its `character_chat_links` row for that chat, lets the existing orphan-characters
trigger (`db/migrations/0096`) remove the `characters` row whenever that was its last link, and
clears the character's leftover `scene_presence` rows for hygiene (the presence dot itself already
stops lighting up the instant the link is gone — see Cascade decision).

It draws on three prior things for its shape: `applyCharacterToChatTool.ts`'s args-guard/handler
style is the coding convention we mirror (note it is *not* what creates `character_chat_links` rows
— that's `resolvePresentCharacters` in `locationAndPresenceScraper.ts`, the `Present:` auto-
registration path; `apply_character_to_chat` only stamps `chat_sessions.character_id`/`params.system`
for a manually-applied protagonist and is otherwise unrelated to the cast/link mechanism this plan
touches); the orphan/cleanup semantics are exactly what `db/migrations/0096` already set up and this
plan deliberately leans on rather than re-implements; and the cast row's existing per-row action
(Send to Studio) is the UI pattern a row-level remove button follows
(`portrait-studio-standalone-subjects-plan.md` Part C).

## Cascade decision (the "or both" from `docs/todo.md` item 2)

Todo item 2 asks to "decide what that cascades to: the `character_chat_link`, the `characters`
row, or both." The data model answers it for us and the answer is: **the link row, with the
`characters` row going away via the existing trigger only when it loses its last link.**

- A character present in **more than one chat** (its `character_chat_links` has rows for other
  chats too) must survive the remove — removing it from this chat's cast must not delete the
  persona a different story is still using. Deleting only the link expresses this exactly.
- A character present in **only this chat** should have its `characters` row cleaned up. Migration
  `0096` already ships `cleanup_orphaned_character()` (`after delete on character_chat_links`,
  `delete from characters where character_id = old.character_id and not exists (select 1 from
  character_chat_links where character_id = old.character_id)`). Deleting the link lets this
  trigger do the row cleanup as designed — we do not add a second, parallel delete path.
- **`scene_presence`**: cleared too, though this is hygiene rather than a correctness fix.
  `getScenesTool.ts`'s `character_ids` aggregate already re-checks `exists(select 1 from
  character_chat_links where character_id = ... and chat_id = $2)` live on every read (segway.md
  §2.6's eligibility filter) — so the moment this chat's `character_chat_links` row is gone, the
  cast's presence dot already stops lighting up on the very next `get_scenes` call, with or without
  touching `scene_presence` at all. There is no "still renders as present until the next re-scrape"
  bug to fix here. We still delete the character's `scene_presence` rows for this chat's scenes so a
  chat that never gets another `Present:` scrape doesn't carry a permanently-orphaned junction row
  (it would otherwise sit invisible-but-inert until, if ever, `replaceScenePresence` next touches
  that scene). We scope by scene, not globally — the character may still be present in a *different*
  chat's scene with its own link, and presence is its own record.

So: `delete character_chat_links` (this chat) + `delete scene_presence` (this chat's scenes);
the orphan trigger decides the `characters` row. No FK, RLS, or trigger change is needed — nothing
here is new schema.

## Files

**New:**
- `plugins/characters/src/removeCharacterFromChatTool.ts` — the `remove_character_from_chat` tool
  (IO Wrapper, structure parallels `applyCharacterToChatTool.ts`/`deleteCharacterTool.ts`).

**Modified:**
- `plugins/characters/src/index.ts` — register the new tool.
- `plugins/characters/scripts/verify-characters.mjs` — new fake-pool test cases for the tool.
- `plugins/characters/dist/` — rebuild the plugin output (see Verification).
- `frontend/src/components/sidebar/CastSection.tsx` — delegate the row's remove action to the new
  tool; add per-row busy/status/confirm handling; refresh the roster after success.
- `frontend/src/components/sidebar/CastSection.css` — remove-button styles mirroring the existing
  studio-button styles.

No backend HTTP route, no migration, no `adminServer.ts`, no `get_characters`/`get_scenes`
contract change.

## Logic

### Backend — new tool `remove_character_from_chat`

In `removeCharacterFromChatTool.ts`, following the established plugin style (file preamble,
`registeredTool`, args guard, same `ctx.db` sqlite-like session helpers every tool here uses):

- Guard args: `{ characterId: string; chatId: string }`, both non-empty. Reject otherwise with a
  clear message mirroring `applyCharacterToChatTool.ts`'s `isApplyCharacterToChatArgs` shape.
- Delete the link row (guarding the character belongs to `ctx.userId` so a stale/foreign id can
  never touch another user's data — same scoping discipline as `deleteCharacterTool.ts`):
  `delete from character_chat_links where character_id = $1 and chat_id = $2` joined to a
  `characters.user_id = ctx.userId` check. The clean way is a single parameterized statement via
  the `where character_id = $1 and chat_id = $2 and exists (select 1 from characters where
  character_id = character_chat_links.character_id and user_id = $3)` guard, or a delete against
  the link table then a count check — the actual shape is Reasonix's call as long as a foreign or
  user-scoped-invalid id is a safe, scoped no-op (return `{ removed: false, reason: 'not-found' }`)
  and never modifies data outside this user.
- Clear presence for the removed character in this chat's scenes, scoped to this user's rows:
  `delete from scene_presence sp using scenes s where sp.character_id = $1 and sp.scene_id =
  s.scene_id and s.user_id = ctx.userId and s.chat_id = $2` (only this chat's scenes).
- The two deletes need no special transaction handling: `postgres.ts`'s `withUserScope` already
  wraps the *entire* tool invocation in one `BEGIN`/`COMMIT`, the same way every other multi-statement
  tool here (e.g. `deleteCharacterTool.ts`'s two deletes) already relies on implicitly — just issue
  both `ctx.db.query` calls in sequence, nothing more. (Not that atomicity is load-bearing for
  presence correctness anyway — see the Cascade decision section on why `get_scenes`'s own
  eligibility filter already makes the link delete alone sufficient; the same-commit delete is
  simply the natural, zero-extra-effort way to also drop the now-irrelevant `scene_presence` rows.)
- Do **not** delete the `characters` row in code. The `cleanup_orphaned_character()` trigger
  handles it, and only when appropriate (last link gone). This keeps the plan aligned with
  migration `0096`'s "deletion is self-healing via FK/trigger, not app code."
- Do **not** touch the avatar file, `visual_entities`, canon facts, etc. Removing from the cast is
  not a card deletion — the persona row (if it survives because another chat uses it) and its
  avatar must be left intact.
- Also do **not** purge `chat_sessions.character_id`'d chats the way `delete_character` does —
  that tool deletes whole chats only because it is *destroying the persona outright*. Here the
  narrator/history is untouched; we're only unlinking from the cast.
- Return `{ removed: true }` on success, `{ removed: false, reason: 'not-found' }` when the link
  (or the user-scoped link) didn't exist. This lets the frontend treat a double-click/re-remove
  idempotently without an error.

Register it in `plugins/characters/src/index.ts`'s `registerTools` array alongside
`apply_character_to_chat`; add `info` description mention and the api-declaration
(`createRemoveCharacterFromChatTool()` returns the `remove_character_from_chat` RegisteredTool).

Contracts (precise, since a caller depends on it):

```
POST /v1/tools/remove_character_from_chat?chat_id=<chatId>
{ characterId: string }
→ { removed: boolean; reason?: 'not-found' }
```

The tool is registered normally like `apply_character_to_chat`, so it appears in the LLM tool
manifest with `definition.parameters` (`characterId` required, `chatId` required,
`additionalProperties: false`). `apply_character_to_chat` is already model-visible; a symmetric
remove is the least surprising registration and needs no castOnly-style internal-only trick.
The chat-scoped `?chat_id=` query string (rp-cast-infrastructure-plan.md Part B) already arrives
on `ctx.chatId`; the tool uses it and/or the body's `chatId` — since `callTool` already appends
`?chat_id=`, prefer `ctx.chatId` when present and fall back to a body `chatId` arg, or simply
require the body `chatId` and validate it against `ctx.chatId`. Reasonix decides at implementation
time based on how adjacent tools already thread this — the key requirement is a foreign chat can
never be asserted against.

### Frontend — `CastSection.tsx`

Add to each cast row, alongside the existing Send-to-Studio button, a compact remove affordance
(a ✕ / "Remove" button, matching the row-button style already present so both stack cleanly at
phone width per bi_principles.md §18). New local state mirrors the existing studio state pattern:

- `removingId: string | null` — which character's remove is in flight (a row shows a busy state).
- `removeMessage: { id, text, ok }` — most recent per-row remove result/error, the same transient
  auto-clearing pattern `studioMessage` uses (timeout clears 4s).
- A `pendingRemoveId: string | null` confirm gate so no `window.confirm` is needed mid-list (the
  Cards page uses `window.confirm` for a full card delete; a cast remove is lighter-weight, so a
  two-step in-row confirm — click ✕ once to arm, a second click to confirm — is mobile-friendlier
  and avoids a native dialog). Reasonix may use either, but a row should not delete on a single
  unfocused tap.

Behavior of `removeFromCast(characterId)`:
1. Call `callTool<{ removed: boolean }>('remove_character_from_chat', { characterId }, apiKey,
   chatId)` — note `chatId` is passed so the query-string scoping applies, matching how the same
   component calls `get_characters`/`get_scenes`.
2. On success (`removed: true`): optimistically / then deterministically remove that row from
   `roster` (set `roster = roster.filter(...)`) so the cast updates immediately, show a transient
   success `removeMessage`, and rely on the roster change (which also drops any linked scene
   presence read) to clear the dot. If the row was the only linked character, the list falls
   through to the existing "No characters known to this chat yet." empty state for free.
3. On failure: set `removeMessage { text, ok: false }` and leave the roster untouched.
4. Guard with the same `loadChatId === chatId` discipline already used so a removal fired just
   before a chat switch never updates the wrong chat's roster. Re-run is not required — the row
   deletion is self-contained.

Mobile-friendliness: the row already flexes (avatar + name flex:1 + studio button + presence dot).
Adding a remove button alongside the studio button keeps both at a comfortable tap target
(principles §18). If space becomes tight on very narrow rows, let the two buttons align right and
the row wrap rather than squeeze — the existing layout already reflows; keep it that way, don't
force a fixed width that breaks the phone layout.

### Frontend — `CastSection.css`

Add remove-button styles mirroring the existing `.cast-row-studio-btn` block (same compact ghost
ghost-button look), a `.cast-row-remove-btn` hover/disabled state, and a `.cast-row-remove-status`
(+ `.err`) message style beside the name like `.cast-row-studio-status`. Reuse existing CSS custom
properties (`--color-danger`, `--color-hover-surface`, etc.) so the danger remove saturates on
hover but stays subtle at rest.

## Edge Cases

- **Removing a character present in other chats too** — only this chat's link is deleted; the
  `characters` row and its avatar/persona are untouched (survive) because the orphan trigger
  requires *zero* remaining links. Its `scene_presence` rows in *other* chats' scenes are untouched
  (we scope the presence delete to `s.chat_id = $2`). Verify this explicitly.
- **Removing the last-linked character** — trigger removes the `characters` row; the cast now shows
  the empty state. The next `Present:` scrape that names it again mints a fresh transient row
  (A1 carry-forward brings the persona back) — that's existing behavior, not something to
  suppress; removing someone from the cast is exactly the way to make them fresh again.
- **Character currently present in the active scene** (`sceneId` matches, dot lit) — the point of
  the presence cleanup: after removal it no longer renders as present, and if tapped again it
  reappears per the above rule.
- **Character never linked / already removed / foreign user's character** — the delete matches
  nothing under the user-scope guard; return `removed:false, reason:'not-found'`. Frontend treats
  that as an idempotent success (just drop the row), not an error.
- **Remove fired then a chat switch happens** — the `loadChatId`/cancelled guard prevents the
  stale update from writing into the new chat's roster.
- **Character only ever player-authored card (`status is null`)** — cannot appear in the cast at
  all (`castOnly` excludes the card library), so a remove button is never shown for one. Verify the
  tool nonetheless can't be tricked into unlinking a card's (nonexistent) link.
- **`character_chat_links`/`scene_presence` RLS** — both tables enforce `user_scoped` policies
  (migration 0096 for links; scene_presence has its own equivalent). The app pool already has
  `grant select, insert, update, delete`, so the deletes work for the calling user. Keep the query
  under the user's own scope and do not run as the table owner.

## Tests

Extend `plugins/characters/scripts/verify-characters.mjs`'s fake-pool coverage with cases for
`remove_character_from_chat`:
- removes the link row for `(characterId, chatId)` when the character belongs to the calling user;
- a character linked to two chats: removing one chat's link leaves the `characters` row and the
  other chat's link intact (the fake pool must model the trigger's effect — i.e. the "no delete of
  the characters row" branch — or assert the query does not touch `characters`);
- a character with only this chat's link: the tool issues the link delete and the scenario models
  the trigger cleaning the row (assert the tool itself does not DELETE `characters`);
- clears `scene_presence` for that character **only** within this chat's scenes;
- foreign/missing `characterId` (or a `characterId` belonging to another user) → `removed:false`,
  `reason:'not-found'`, no data deleted;
- malformed args (missing/empty `characterId` or `chatId`) → throws, no query run.

## Verification

- `npx tsc --noEmit` across the `characters` plugin, and `frontend` workspace.
- Rebuild `plugins/characters/dist` (the deployed plugin loads from `dist` — check how the plugin
  build/index resolves and rebuild accordingly; `dist` artifacts for the other tools are present,
  so the new tool must be compiled and present there too or the running server won't see it).
- Run `node plugins/characters/scripts/verify-characters.mjs`.
- Manual in an RP chat: open Cast, confirm a remove control on each row. Remove a character present
  in another chat → row disappears from this cast, the other chat's cast still lists it, its
  persona/avatar row is intact (verify the `characters` row still exists and still has the other
  chat's link). Remove a character only in this chat → row disappears, cast shows empty state, and
  the `characters` row is gone (orphan trigger). Remove a character currently present → the green
  dot disappears immediately. Re-mention it in a `Present:` line on the next turn → it reappears in
  the cast (fresh transient row, persona carried forward).

## Out of Scope

- Deleting the `characters` row directly in code — the trigger owns that (see Cascade decision).
- Any change to `character_chat_links`, `scene_presence`, migration `0096`, or RLS — the data model
  already expresses this removal.
- Broadening the tool into the LLM agent's mid-chat repertoire — it's registered (so the model can
  use it like `apply_character_to_chat`), but this plan does not wire any new agent-routine/director
  logic around it.
- Adding a symmetric remove to `LocationsView`/the Locations sidebar — locations are a separate
  surface; the todo scopes this to the RP cast. Flagged, not touched.
- Replacing Send to Studio or any other existing cast affordance.
- Any change to `apply_character_to_chat`, `delete_character`, or the card page.

## Principles / Conventions in Play

- bi_principles.md §1 (canonical record): removing from the cast operates on the single canonical
  source of truth (`character_chat_links`), and downstream presence is derivable working state we
  can (and do) clean in the same commit.
- bi_principles.md §11 (observability): the presence-vs-removed contradiction would be a silent
  correctness failure; logging the removal (characterId, chatId, whether the trigger will reap the
  row — i.e. whether other links remain) at the IO seam is part of the change.
- bi_principles.md §18 (mobile-first): the two in-row buttons must stack/reflow at phone width, not
  squeeze.
- `docs/roles.md` plan template: this is a `-plan.md` (an architectural decision is being recorded —
  the cascade) worth keeping after implementation, not a disposable `-repair.md`.
- Migration-append-only: no migration, so nothing to bump.
