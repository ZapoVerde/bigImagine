# Cards and in-chat characters keep crossing paths — repair

*For Reasonix to implement per `docs/roles.md`.*

A card (manually-authored/imported, `status is null`) is a reusable scenario template. A
"character" (`status is not null`) is a chat-scoped instance born from activating one — via Start
RP or the presence-scraper naming someone in a `Present:` line. These are different things and keep
ending up on the same surfaces. This doc covers two independent fixes found in the same review pass,
each landable as its own commit:

- **Part A** — the RP sidebar's Cast section (which should show only this chat's actual characters)
  was pulling in the user's entire card library instead, because `get_characters`' chat-scoped query
  only ever chat-scoped the auto-registered branch.
- **Part B** — the "Characters" page (which only ever lists/edits cards — auto-registered rows are
  structurally excluded from it) is mislabeled, and hosts a settings fieldset that configures
  in-chat-character behavior it has no business owning. Renames the page to "Cards" and moves that
  fieldset to the global Settings tab.

## Part A — Cast section shows the whole card library, not the chat's cast

### Goal

`CastSection.tsx` (RP sidebar) calls `get_characters` chat-scoped and displays the result as "who's
known to this chat." But `getCharactersTool.ts`'s query only chat-scopes the auto-registered branch
(`status is not null`) — every manually-authored character card (`status is null`) is unconditionally
eligible regardless of `chatId`, so Cast actually shows the user's entire card library in every RP
chat, indistinguishable from characters that have actually appeared in that story. Fix Cast to show
only characters actually linked to the calling chat, without changing `get_characters`' existing
whole-library behavior for its other two callers (`CharactersView.tsx`'s unscoped Roster, and the
LLM's own mid-chat `get_characters` tool call, which needs the full card library to pick one for
`add_character_to_scene`).

### Files

- `plugins/characters/src/getCharactersTool.ts` — modified: read an optional `castOnly: boolean` off
  the handler's `args`. When true, drop the `status is null` unconditional-eligibility branch from
  the query so it returns only rows satisfying the existing `character_chat_links` link check.
  Default (`castOnly` absent/false) is byte-for-byte today's behavior.
- `frontend/src/components/sidebar/CastSection.tsx` — modified: its `get_characters` call passes
  `{ castOnly: true }` instead of `{}`.
- `plugins/characters/scripts/verify-characters.mjs` — modified: new cases for `castOnly` (see
  Tests).

No other file changes. In particular, `getCharactersTool.ts`'s `definition.parameters` JSON schema
(the LLM-facing manifest) is **not** touched — see Contracts.

### Logic

`getCharactersTool.ts`'s handler currently ignores its `args` entirely (`_args`). Read
`args.castOnly` (treat anything other than a literal `true` as false, including a missing/malformed
body — never throw on this).

- `castOnly` false/absent: keep today's WHERE clause exactly —
  `status is null or (status <> 'inactive' and exists(select 1 from character_chat_links where
  character_id = characters.character_id and chat_id = $2))`.
- `castOnly` true: use `status is not null and status <> 'inactive' and exists(select 1 from
  character_chat_links where character_id = characters.character_id and chat_id = $2)` — i.e. the
  same link-exists check, minus the `status is null` carve-out. Per `db/migrations/0096`'s own
  invariant, a manually-authored card (`status is null`) never has a `character_chat_links` row by
  design, so this clause naturally excludes the whole card library without needing a separate
  `status is null` exclusion to be spelled out redundantly.

`CastSection.tsx`'s existing `callTool<CharacterSummary[]>('get_characters', {}, apiKey, chatId)`
becomes `callTool<CharacterSummary[]>('get_characters', { castOnly: true }, apiKey, chatId)`. Nothing
else in the component changes — its scene-presence cross-reference, its "No characters known to this
chat yet." empty state, and its Send-to-Studio row action all already assume "this chat's actual
roster"; they were just being fed the wrong data.

`CharactersView.tsx`'s unscoped roster fetch and the LLM's own in-conversation `get_characters` tool
call both omit `castOnly`, so both keep exactly today's whole-library behavior.

### Contracts

`get_characters` request body gains one new optional field:

```
{ castOnly?: boolean }   // default false
```

- `false`/absent: response unchanged from today — `{ characterId, name }[]` covering every
  manually-authored card plus this chat's linked auto-registered characters.
- `true`: same response shape, restricted to characters linked to the calling chat via
  `character_chat_links` (auto-registered characters that have actually appeared in this chat),
  excluding `status = 'inactive'` rows.

This field is deliberately **not** added to `definition.parameters` (stays `{ type: 'object',
properties: {}, additionalProperties: false }`). The direct-invoke path the frontend uses
(`toolInvoke.ts`'s `invokeTool` → `tool.handler(args, ctx)`) passes the request body straight through
with no schema validation against `definition.parameters` — that schema only governs the LLM's own
tool-calling manifest. So `castOnly` is purely an internal frontend↔handler contract, invisible to
and unusable by the model.

### Edge Cases

- Fresh RP chat, right after Start RP applies a character card, before any turn has landed a
  `Present:` header: `castOnly=true` returns zero rows — the just-applied card is never itself
  chat-linked (manually-authored rows are structurally exempt from `character_chat_links`, per
  `db/migrations/0096`'s comment: "remain the deliberate, reusable, cross-chat library"). This is not
  a new gap to handle — `CastSection`'s existing "No characters known to this chat yet." empty state
  already covers it. Once the scene's `Present:` line names that character, `resolvePresentCharacters`'
  carry-forward (`rp-cast-infrastructure-plan.md` Part A1) mints the linked, persona-carrying row and
  it appears from then on.
- `castOnly=true` with no `chatId` at all (`ctx.chatId` undefined): `exists(... chat_id = null)`
  matches nothing, so the result is an empty list — consistent with how the rest of this file (and
  `get_scenes`) already treats a stateless call.
- A `status = 'inactive'` row (demoted alternate timeline) must stay excluded under `castOnly=true`,
  same as it's excluded today — keep the `status <> 'inactive'` clause.
- Malformed/non-boolean `castOnly` in the request body — treat as false, never throw.

### Tests

Extend `plugins/characters/scripts/verify-characters.mjs`'s fake-pool coverage of `get_characters`
with:
- `castOnly` omitted/false still returns both a `status is null` (user-authored) row and a linked
  `status is not null` row — unchanged from the existing test's expectation.
- `castOnly: true` with a `chatId` excludes the user-authored row and returns only the row linked to
  that chat via `character_chat_links`.
- `castOnly: true` excludes a linked row whose `status = 'inactive'`.
- `castOnly: true` with no `chatId` returns `[]`.

Manual: open Cast on a brand-new RP chat right after Start RP, before any turn — confirm the empty
state, not the whole card library. Play a turn whose narration names an existing card by name in a
`Present:` line; confirm that character (with persona carried forward from the card) now appears in
Cast. Separately confirm `CharactersView.tsx`'s Roster still lists every card, unaffected by this
change.

### Out of Scope

- Any change to `character_chat_links`, `db/migrations/0096`, or `applyCharacterToChatTool.ts`.
  Manually-authored cards staying structurally exempt from chat-links is existing, deliberate
  architecture, not something this repair should fight.
- `getCharacterTool.ts` (singular) and `getScenesTool.ts`'s `eligibleFor` character filtering — both
  already gate on a separate, correct primary scoping mechanism (a caller-supplied `characterId`
  already known to be in scope; `scene_presence` rows that are already scene-scoped), so neither has
  this bug.
- Any UI/copy change to `CastSection.tsx` beyond the one-line `castOnly: true` args change — its
  existing empty-state text and presence-dot logic already describe the corrected behavior correctly.

### Principles / Conventions in Play

- `docs/plans/vistalyze_integration/segway.md` §2.6's eligibility filter — `castOnly` reuses, not
  replaces, the existing `exists()`-against-`character_chat_links` clause; it only removes the
  `status is null` unconditional-eligibility carve-out for this one caller.
- `db/migrations/0096`'s stated invariant that manually-authored characters are "structurally exempt"
  from `character_chat_links` and remain a reusable cross-chat library — this repair leans on that
  invariant rather than working around it.

## Part B — Cards and characters are different things; stop treating "Characters" as their shared home

### Goal

A card (manually-authored or imported) is a reusable scenario/template — `status is null`, never
tied to any one chat. A "character" in the auto-generated sense (`status is not null` —
`transient`/`permanent`/`inactive`) is an instance that only exists because a card was activated
into a specific story: either via Start RP (`applyCharacterToChatTool`) or via the presence-scraper
naming someone in a `Present:` line, at which point `resolvePresentCharacters`' carry-forward (A1)
seeds it from a same-named card if one exists. These are two different things — a template and an
instance of playing it — and they should stop sharing one page and one label. Part A already stopped
them from sharing *query results* (Cast no longer shows the whole card library); this part stops
them from sharing *UI surface*:

1. The page currently called "Characters" only ever lists and edits cards (confirmed:
   `getCharactersTool.ts`'s unscoped branch structurally cannot return an auto-registered row — see
   Part A's Goal). It should be labeled "Cards," not "Characters," so its name matches what it
   actually manages.
2. The Character-describer settings fieldset currently embedded in that page (A4 of
   `rp-cast-infrastructure-plan.md`) configures a describer pass that only ever touches auto-registered,
   in-chat characters (`describeCharacterIfNeeded`'s skip rule: only a blank-persona row, which per A1
   is never a card) — a characters concern, stranded on what's now explicitly the cards-only page. It
   moves to the global Settings tab instead, alongside this app's other admin-gated, chat-independent
   LLM/prompt config (persona settings, screen-lock, notifications, etc. — see `SettingsView.tsx`'s own
   preamble: "this view is household settings only now").

### Files

- `frontend/src/hooks/useTabs.ts` — modified: the `TabType` display-name map's `characters:
  'Characters'` entry becomes `characters: 'Cards'`. The `TabType` union member itself stays
  `'characters'` — renaming the type/tab-id has no user-visible effect and would ripple into
  `App.tsx`'s `SIDEBAR_CONTENT_TABS` set and every `tab.type === 'characters'` check for no benefit.
- `frontend/src/views/CharactersView.tsx` — modified: every *user-visible* string that says
  "character(s)" in a way that means "card(s)" changes to "card(s)" — the list header ("Characters" →
  "Cards"), the empty states ("No characters yet — create one or import a card." →
  "No cards yet — create one or import a card.", "Pick a character, create a new one, or import a
  card." → "Pick a card, create a new one, or import one."), the delete confirmation, the mobile
  back-button label ("← Characters" → "← Cards"), and the drag-drop overlay text where it says
  "character card" redundantly (already says "card," leave as-is). Also removes the entire
  Character-describer settings block (state, handlers, `useAdminUnlock` mount, and the `<details>`
  JSX) — see the Logic section below for what moves where.
- `frontend/src/views/CharactersView.css` — modified: removes the now-unused
  `.characters-describer-settings`/`.characters-describer-fields`/`.characters-describer-unlock`
  rules (moved to `SettingsView.css`). This incidentally removes the layout bug that would otherwise
  need fixing here: `.characters-view` is `display: flex` with no `flex-direction`, so today the
  describer-settings `<details>` (no `width`/`flex-basis` of its own) sits as a stray extra column
  wedged in front of the `.characters-list`/`.characters-editor` split instead of the full-width band
  above it that both this file's and `CharactersView.tsx`'s comments claim it is. Deleting the block
  removes the bug along with the feature — no separate CSS layout fix is needed once it's gone.
- `frontend/src/views/SettingsView.tsx` — modified: gains the Character-describer prompt/history-pairs
  fieldset, following this file's existing multi-section pattern exactly (its own `applyCharacterSettings`
  function; its own `describerPrompt`/`describerHistoryPairs` state pair; `adminGetCharacterSettings`
  folded into the `Promise.all` inside the existing `attemptLoad`; its own save handler and JSX
  section) — the same shape as its `applyPersonaSettings`/`applyScreenLockSettings` neighbors, reusing
  the tab's single existing `useAdminUnlock` instance rather than mounting a second one.
- `frontend/src/views/SettingsView.css` — modified: gains the moved describer-settings rules
  (renamed from `.characters-describer-*` to match this file's own naming, e.g. `.settings-describer-*`
  or whatever convention the surrounding fieldsets already use — match neighbors, don't invent a new one).
- `frontend/src/api/client.ts` — unmodified. `adminGetCharacterSettings`/`adminSetCharacterSettings`
  already exist as standalone exported functions (A4); they just get a new caller.

### Logic

`CharactersView.tsx` currently does three things under one roof: edits cards, imports/exports cards,
and (via the describer-settings `<details>`) configures a setting that affects characters it never
even lists. After this change it does exactly the first two — a page that only ever touches
`status is null` rows now only ever talks about "cards."

The describer-settings fieldset's actual behavior (its admin-key gate, its two fields, its save call
against `adminSetCharacterSettings`) doesn't change — only its host component does. Port the
`characterSettings`/`selectedDescriberPrompt`/`selectedDescriberHistoryPairs`/`settingsStatus` state,
`applyCharacterSettings`, and `saveCharacterSettings` from `CharactersView.tsx` into `SettingsView.tsx`
essentially unchanged; fold `adminGetCharacterSettings(key)` into `SettingsView.tsx`'s existing
`attemptLoad`'s `Promise.all` (alongside `adminGetPersonaSettings` etc.) instead of giving it a
second, separate `useAdminUnlock`/`attemptLoad` pair the way `CharactersView.tsx` had to (that page
had no admin plumbing of its own before A4 added it just for this fieldset — `SettingsView.tsx`
already has one, unifying is a net simplification, not just a move).

### Contracts

No backend or tool contract changes — `adminGetCharacterSettings`/`adminSetCharacterSettings` and
their underlying `GET`/`POST` admin endpoints are unchanged; only the frontend component that calls
them moves.

### Edge Cases

- `CharactersView.tsx` loses its only `useAdminUnlock` mount and its only reason to import
  `adminGetCharacterSettings`/`adminSetCharacterSettings` — remove those imports too, don't leave them
  unused.
- `SettingsView.tsx`'s `attemptLoad` currently fetches six settings groups in one `Promise.all`; adding
  a seventh (`adminGetCharacterSettings`) follows the same all-or-nothing load semantics — if it fails,
  the whole tab's `attemptLoad` reports failure, same as today for any of the other six. This matches
  existing behavior for this tab and is not a regression specific to this change.
- Nothing in `CastSection.tsx` or the Cast/RP-chat side references the describer-settings fieldset —
  it was only ever reachable from `CharactersView.tsx`, so moving it has no ripple into the RP sidebar.
- Renaming only the display label (not the `TabType` value, component name, file name, or the
  `get_characters`/`create_character`/`update_character`/`delete_character` tool names, or the
  `characters` table) is a deliberate scope boundary — see Out of Scope.

### Tests

- `npx tsc --noEmit` across `frontend`.
- Manual: open the sidebar — the tab reads "Cards," not "Characters." Open it — list header, empty
  states, and the back button all say "Cards"/"card" language; no leftover "Characters" copy. The
  Describer settings `<details>` is gone from this page.
- Manual: open Settings — a new "Character-describer" (or equivalently named) fieldset appears there,
  admin-gated the same way the rest of the tab is, loads the same saved prompt/history-pairs values
  the old fieldset showed, and Save round-trips correctly (verify against `GET`/`POST`
  `/v1/admin/character-settings` directly if easier than exercising the admin-key UI end to end).
- Manual end-to-end: with the new Settings fieldset showing a non-default describer prompt, have a
  new named character enter an RP chat's `Present:` line and confirm the description pass still uses
  it — proving the relocation didn't silently disconnect the setting from the pass that reads it.

### Out of Scope

- Renaming `TabType`'s `'characters'` value, the `CharactersView` component/file name, the
  `characters` Postgres table, or the `get_characters`/`create_character`/`update_character`/
  `delete_character`/`get_character` tool names. All of that is internal plumbing invisible to the
  user; renaming it is a much larger, purely-cosmetic diff across backend, frontend, and the LLM's own
  tool manifest for zero user-facing benefit. If a full internal rename is wanted later, it's its own
  follow-on plan, not folded into this one.
- `LocationsView.tsx`'s own Room-describer settings fieldset, which has the same
  "auto-registered-in-chat concern living on the manually-authored library's page" shape this part
  fixes for characters, and currently cites this file's A4 section as its own precedent. Left as-is
  here — flagging it as a real, symmetric follow-up candidate if the same "cards vs. instances" split
  turns out to matter for locations too, but that's the user's call, not assumed by this doc.
- Any change to `CastSection.tsx` or the RP sidebar — Part A already made Cast correctly scoped to
  in-chat characters; this part only touches the cards-only page and Settings.
