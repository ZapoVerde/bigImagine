# RP-side Cast infrastructure — character parity + Cast sidebar

*For Reasonix to implement per `docs/roles.md`.*

## Context

Locations and characters are both auto-registered synchronously, in-request, by the same
`scrapeTurnPresence` call in `locationAndPresenceScraper.ts` — but only locations get real
treatment. `resolveOrCreateLocationRow` mints a new `locations` row with a real starting
`visual_description` (carried from a same-named prior row, or the location's own name as a
placeholder), and a **second, decoupled pass** — `describeLocationIfNeeded`
(`orchestrator/src/orchestrator/describeLocation.ts`), fired fire-and-forget off the response
`'finish'` event via `fireLocationImageGeneration` — makes one LLM call afterward to turn that
placeholder into a real description, before the background ever renders.

`resolvePresentCharacters` mints a new `characters` row on an unmatched `Present:` name too, but
writes only `(user_id, name, status: 'transient')` — no description field at all, and nothing
equivalent to the describer pass ever runs. Separately, `curatePeople` (invoked periodically out of
`chatMemorySync.ts`, RP chats only) produces genuinely rich person profiles — but writes them into
`canon_facts` (`category = 'person'`, keyed by a slugified name string), never touching the
`characters` table or `character_id`. Today there are two disconnected character records: a bare
roster row created instantly, and a rich profile that (if it ever gets produced) lands in a
different table nothing joins against.

The goal: give characters the same two-phase treatment locations already have (synchronous stub +
fire-and-forget real description), and surface a chat-scoped "Cast" list in the RP sidebar showing
who's known to this chat with a live presence indicator — sourced from data that already exists
(`character_chat_links`, `scene_presence`) but isn't reachable from the frontend today. This is
scoped to the RP chat side only — no image-gen, no Portrait/Visual Studio, no `visual_entities`
linkage; `curatePeople`'s reconciliation into `characters` is a related but separate follow-on,
deliberately deferred (see Out of Scope).

## Part A — Character creation reaches parity with locations

### A1. Synchronous carry-forward (mirrors `resolveOrCreateLocationRow`'s prior-row lookup)

In `resolvePresentCharacters` (`orchestrator/src/orchestrator/locationAndPresenceScraper.ts:446-486`),
before the bare insert at line 474, look up the most recent prior `characters` row for this
`user_id` with the same `name` and a non-empty `persona` (any `status`, not chat-scoped — a
character who appeared before, anywhere, should get their real persona back instead of a blank
stub). If found, carry `persona` (and, if useful, `avatar_path`) into the new row instead of leaving
it at the column default. If not found, insert exactly as today — `persona` stays empty. This is a
same-shape change to one insert statement, no schema change.

### A2. New describer pass — `describeCharacterIfNeeded`

New file `orchestrator/src/orchestrator/describeCharacter.ts`, structured identically to
`describeLocation.ts`: same `describeInFlight` in-flight guard, same fail-open contract (logs and
returns on any failure, never throws), same settings-driven prompt/history-pairs config
(`character_describer_prompt` / `character_describer_history_pairs`, empty override = built-in
default per Principle 17), same skip rule shape — a row is "never described" iff `persona` is empty
(the mint/carry-forward seed from A1), and already-described or user-authored rows (non-empty
`persona`) are always skipped, so a manual edit or a real import is never clobbered.

Prompt asks for a short persona/appearance blurb from the narrative context (last N turn-pairs, same
`ContextMessage` shape `describeLocation.ts` already reads), parsed for a single `Persona:` marker
(simpler than locations' two-marker Definition/Visuals split — characters only have one field to
fill) and written to `characters.persona`.

### A3. Fire-and-forget trigger

**Correction: `scrapeTurnPresence` does not currently return `characterIds` — this must change as
part of A3, not be assumed as existing plumbing.** Today it returns `Promise<string | undefined>`
(`locationAndPresenceScraper.ts:157`) — the location id only; `extractFromHeader` (line 208) computes
`characterIds` at line 219 to feed `replaceScenePresence`, then discards them, returning just
`locationId`. Both functions' return type must widen to `{ locationId: string; characterIds: string[] } | undefined`
(the `undefined` case — header parse skipped/failed — is unaffected).

That widened return then has to ripple through every consumer, mirroring exactly how `locationId`
already flows through each of them today:

- **`turnExecution.ts:383`** (direct in-request call) and **`turnExecution.ts:395`**'s
  `regenerateSwipe` return — currently `{ ok: true, message: swipeResult!, locationId }` — gains
  `characterIds` alongside `locationId`.
- **`handleChats.ts:608` and `:617`** — currently read `result.locationId` to fire
  `res.once('finish', () => fireLocationImageGeneration(...))`; add the equivalent
  `res.once('finish', () => characterIds.forEach(id => fireCharacterDescription(deps, userId, chatId, id, ...)))`
  reading `result.characterIds`.
- **`handleChatCompletions.ts:660`** (direct in-request call) feeds the finish-event fires at
  **lines 758, 777, 787** — each needs the same per-character fan-out alongside its existing
  `fireLocationImageGeneration(deps, userId, body.chat_id, scrapedLocationId!, turnLlm)` call.
- **The `onLocationScraped` hook itself** (`(userId, chatId, locationId) => void`, defined at
  `cleanupLoop.ts:153`) needs a sibling — `onCharactersScraped?: (userId, chatId, characterIds: string[]) => void` —
  since the deferred post-repair scrape path (`cleanupLoop.ts:617-625`) also calls
  `scrapeTurnPresence` and fires the hook, but never rides a `res.once('finish', ...)` (there's no
  response in flight for a background cleanup tick — the hook call *is* the fire point). Wire this
  new hook at all three places `onLocationScraped` is wired: **`index.ts:240`** (composition root,
  `startCleanupLoop({ ..., onLocationScraped: ... })`), **`handleChatCompletions.ts:362`**, and
  **`turnExecution.ts:229`** — note **229 is a hook-wiring site, not a finish-event site**; it's
  distinct from the three finish-event fires above.

New `fireCharacterDescription(deps, userId, chatId, characterId, llm)` in
`orchestrator/src/server/characterDescription.ts` (sibling to `locationImages.ts`, same shape as
`fireLocationImageGeneration`: `void (async () => { await describeCharacterIfNeeded(...) })()`),
called once per id in `characterIds` at each fire point above — not just newly-created ones; the
describer's own skip check (A2, non-empty `persona`) makes repeat calls free, same as locations.

### A4. Settings + Principle 17

Add `character_describer_prompt` and `character_describer_history_pairs` to the
`orchestrator_settings_key_check` widening (same wholesale-rebuild migration pattern used for
`location_describer_*`).

**Correction: the location describer's controls do not live on the image-settings panel.** They
moved entirely to the Locations page — `LocationsView.tsx:85-100`'s unified settings surface,
backed by `getLocationSettings` / `parseSetLocationSettingsBody` / `setLocationSettings`
(`adminServer.ts:813-893`) and their `handleLocationSettingsGet`/`handleLocationSettingsSet`
handlers. `adminServer.ts`'s `parseSetImageSettingsBody` still *accepts* `describer_*` keys, but only
for back-compat (`handleAdminDisplaySettings.ts:97-98`'s comment says so explicitly) — extending
that pair would put the new controls on the wrong page. Mirror the location-settings trio instead:
new `getCharacterSettings`/`parseSetCharacterSettingsBody`/`setCharacterSettings` functions in
`adminServer.ts` plus matching HTTP handlers, surfaced on `CharactersView.tsx` alongside the roster
(the natural parity location, mirroring `LocationsView.tsx`'s own describer fieldset).

Note on the CharactersView surface: unlike LocationsView (which already mounts
`useAdminUnlock`), `CharactersView.tsx` has no admin plumbing today — the new fieldset must add
`useAdminUnlock` (same mount-time no-key-then-stored-key probe, `LocationsView.tsx:63-80` as the
model) and two new client functions `adminGetCharacterSettings`/`adminSetCharacterSettings` in
`frontend/src/api/client.ts` (mirroring `adminGetLocationSettings`/`adminSetLocationSettings`,
client.ts:883-906), since the settings endpoints are admin-gated like every Settings-tab pair.

## Part B — Thread `chatId` through the direct tool-invoke path

`getCharactersTool.ts`'s `get_characters` and `getScenesTool.ts`'s `get_scenes` already have the
correct chat-scoped queries (`ctx.chatId` gates which auto-registered rows are eligible) — they're
just unreachable from the frontend because `toolInvoke.ts`'s `invokeTool()` builds
`ToolHandlerContext` as `{ userId, db, embeddings }` with no `chatId`, and the `POST /v1/tools/:name`
route (`httpServer.ts`) never parses any query string at all today.

- `httpServer.ts`'s `handleToolInvoke`: parse `chat_id` off `new URL(req.url!, ...).searchParams`,
  pass it through to `invokeTool(...)`.
- `toolInvoke.ts`'s `invokeTool(db, tools, embeddings, userId, name, args, chatId?)`: include
  `chatId` in the `ToolHandlerContext` literal it builds.
- `frontend/src/api/client.ts`'s `callTool<T>(name, args, apiKey, chatId?)`: append
  `?chat_id=...` to the fetch URL when provided; every existing call site (`CharactersView.tsx`,
  `PortraitStudioView.tsx`) is unaffected since the new param is optional and appended, not a body
  shape change.

This makes `get_characters` chat-scope-capable from the frontend with no plugin change — but
**`get_scenes` needs one** (see Part C below); "no plugin code changes needed" does not hold for it.

## Part C — Cast sidebar section

**Correction: "the active scene's `characterIds`" is not resolvable from what Part B alone provides
— two real gaps, both need a fix stated here, not left implicit:**

1. **`get_scenes` isn't scene-chat-scoped.** Its query (`plugins/scenes/src/getScenesTool.ts`)
   filters `where s.user_id = $1` only — `ctx.chatId`/`$2` is used solely inside the eligibility
   subqueries for *characters and locations*, never to filter *which scenes* come back, even though
   `scenes.chat_id` exists (migration 0067). Threading `chatId` through Part B scopes rows within a
   scene, not which scenes are returned — calling `get_scenes` today still returns every scene the
   user has, across every chat. **Fix: add `and (s.chat_id = $2 or s.chat_id is null)` to the
   query's main `where` clause** — the `or s.chat_id is null` branch keeps user-authored scenes
   (`create_scene` mints rows with no chat_id — `createSceneTool.ts:53`) visible to chat-scoped
   calls, the same "user-authored rows always eligible" posture the file's eligibility clauses
   already use. A stateless call (`ctx.chatId` unset, `$2` null) now returns only user-authored
   scenes rather than every scene the user has. This is a small, contained change to
   `getScenesTool.ts` itself.
2. **The frontend has no way to identify the active scene even once `get_scenes` is chat-scoped.**
   The backend already computes and sends this — `chatSessions.ts:494`'s `toSessionRow` includes
   `sceneId: row.scene_id` in every `ChatSessionRow` — but the **frontend type is missing the
   field**: `frontend/src/api/types.ts`'s `ChatSessionRow` interface (lines 398+) has no `sceneId`.
   Add it there (zero backend change — the data is already on the wire), then `CastSection` matches
   `get_scenes`' now-single returned row (post-fix-1, chat-scoped `get_scenes` returns at most the
   chat's own scenes) — or, if a chat can accumulate more than one historical scene row, matches on
   `session.sceneId` explicitly rather than assuming array length 1.

New `frontend/src/components/sidebar/CastSection.tsx` (+ `.css`), structured like
`TurnDrawerSection.tsx`: own `useState` collapse state, own header/toggle/chevron button, own
`useEffect` fetch(es) gated on not-collapsed, cancelled-flag guarded, chat-id-tagged results so a
stale fetch from a previous chat is never shown after a chat switch. Props: `{ apiKey, chatId, sceneId }` —
`chatId` is already available at the `Sidebar` level via `App.tsx`'s `activeChatId`; `sceneId` needs
threading from the active chat's session (fix 2 above) down through `App.tsx` → `Sidebar` → `CastSection`,
the one piece of genuinely new plumbing in this plan.

Data: call `get_characters` (roster: id, name, chat-scoped per Part B) and the now-chat-scoped
`get_scenes` (presence: the matching scene's `characterIds`) via `callTool`. Cross-reference: any
roster character whose id is in that scene's `characterIds` gets the presence indicator (green
dot/tick); everyone else renders without it. Row rendering reuses `CharactersView.tsx`'s existing
list-row shape (avatar thumb + name, `CharacterAvatarThumb`) rather than inventing a new one.

Plug into `Sidebar.tsx`'s `case 'rp':` block (lines 57-72) as a third sibling inside
`sidebar-rp-sections`, alongside `PromptInspectorPanel` and `TurnDrawerSection`.

Default **expanded**, not collapsed like `TurnDrawerSection` — Timing is a secondary debug panel;
Cast is the actual feature being asked for and should be glanceable without a click. Still fully
collapsible per the ask.

## Files

**New:**
- `orchestrator/src/orchestrator/describeCharacter.ts`
- `orchestrator/src/server/characterDescription.ts`
- `frontend/src/components/sidebar/CastSection.tsx` + `.css`

**Modified:**
- `orchestrator/src/orchestrator/locationAndPresenceScraper.ts` — `resolvePresentCharacters`
  carry-forward (A1); `scrapeTurnPresence`/`extractFromHeader` return `characterIds` alongside
  `locationId` (A3)
- `orchestrator/src/orchestrator/cleanupLoop.ts` — new `onCharactersScraped` hook, fired from the
  deferred post-repair scrape path (A3)
- `orchestrator/src/index.ts` — wire `onCharactersScraped` at the composition root (A3)
- `orchestrator/src/server/handleChatCompletions.ts` — wire `onCharactersScraped` (line 362) *and*
  fan out `fireCharacterDescription` at each finish-event site (758, 777, 787) (A3)
- `orchestrator/src/server/turnExecution.ts` — wire `onCharactersScraped` (line 229, hook-wiring, not
  a finish-event site); `regenerateSwipe`'s return gains `characterIds` (line 395) (A3)
- `orchestrator/src/server/handleChats.ts` — fan out `fireCharacterDescription` from
  `result.characterIds` at both finish-event sites (608, 617) (A3)
- `orchestrator/src/io/orchestratorSettings.ts` — new settings keys
- `orchestrator/src/server/adminServer.ts` — new `getCharacterSettings`/
  `parseSetCharacterSettingsBody`/`setCharacterSettings` trio, mirroring the location-settings one
  (not the image-settings one) (A4)
- `orchestrator/src/server/handleAdminDisplaySettings.ts` — new
  `handleCharacterSettingsGet`/`handleCharacterSettingsSet` handlers (A4)
- `frontend/src/views/CharactersView.tsx` — new describer-settings fieldset + `useAdminUnlock`
  mount, mirroring `LocationsView.tsx`'s (A4)
- `db/migrations/` — new migration widening `orchestrator_settings_key_check`
- `orchestrator/src/server/httpServer.ts`, `orchestrator/src/server/toolInvoke.ts` — chatId query-param threading (Part B)
- `plugins/scenes/src/getScenesTool.ts` — filter by `(s.chat_id = $2 or s.chat_id is null)` (Part C fix 1)
- `frontend/src/api/types.ts` — add `sceneId` to `ChatSessionRow` (Part C fix 2)
- `frontend/src/api/client.ts` — `callTool` optional `chatId` param (Part B);
  `adminGetCharacterSettings`/`adminSetCharacterSettings` (A4)
- `frontend/src/App.tsx` — hold the active chat's `sceneId` (up-reported by ChatView via a new
  `onSceneIdChange` callback, same shape as the existing `onTurnSnapshot` at App.tsx:278) and
  thread it down to `Sidebar`
- `frontend/src/views/ChatView.tsx` — up-report the loaded session's `sceneId` via the new
  `onSceneIdChange` callback (the source of Part C fix 2's plumbing — App holds no session state)
- `frontend/src/components/sidebar/Sidebar.tsx` — mount `CastSection`, passing `sceneId` through

## Edge Cases

- A character with an already non-empty `persona` (user-authored, imported, or previously
  described) — describer always skips, never overwrites.
- Two overlapping turns describing the same character — `describeInFlight` guard (same as
  locations), cleared in `finally`.
- Describer LLM call fails or returns no `Persona:` marker — logged, row left untouched, exactly
  `describeLocation.ts`'s fail-open posture.
- `chat_id` query param absent on `/v1/tools/:name` — behaves exactly as today for `get_characters`
  (`ctx.chatId` undefined, only user-authored characters visible); for the now-chat-scoped
  `get_scenes` (Part C fix 1), an absent `chatId` returns only user-authored scenes rather than
  every scene the user has — a deliberate posture change. Note the one other consumer: the
  agent_routine dispatch path (`agentRoutineDispatch.ts` runs `runTurn` with `taskKind:
  'agent_routine'`, which `loop.ts:212` maps to `chatId = undefined`) calls tools without a
  chatId — any routine that calls `get_scenes` sees only user-authored scenes from now on. No
  such routine exists today (verified: no non-frontend `get_scenes` caller), so this is accepted
  as a posture change, not a regression.
- A character first minted via the **deferred cleanup-tick scrape** (`cleanupLoop.ts`'s post-repair
  path, not the live turn path) must still get its describer fire — covered by the new
  `onCharactersScraped` hook (A3), not the finish-event fires (there's no HTTP response in flight on
  that path).
- Cast section fetch races a chat switch — same cancelled-flag + chatId-tag pattern
  `TurnDrawerSection.tsx` already uses.
- A chat with no `sceneId` yet (no turn has landed a header) — `CastSection` shows the roster with
  no presence indicators, not an error.

## Out of Scope

- Reconciling `curatePeople`'s richer async `canon_facts` profile back into `characters.persona` —
  a real, related question (should the eventual rich profile ever supersede the describer's initial
  blurb?) but a separate decision from closing today's up-front-creation gap; write up as its own
  follow-on once this lands.
- Any outfit-stub / genre-fitting wardrobe suggestion at creation time — that's Portrait/Visual
  Studio linkage (image-gen), explicitly out of scope per "agnostic to image gen."
- Any change to `visual_entities`, Subject archetypes, or Portrait/Visual Studio.
- Renaming the `portraits` tab/`TabType` to "Studio" — unrelated, label-only change, not touched here.
- The `ensureActiveLocationImage` restart triggers (`handleChats.ts:174/456/494` →
  `locationImages.ts:178`) are **not** given a character analogue — those exist to restart a stalled
  *image* render on chat reopen, and characters have no image-gen leg in this plan. Deliberate
  carve-out, not an oversight: characters only ever fire on the turn/scrape path (A3), never on
  chat-reopen.

## Verification

- `npx tsc --noEmit` across `orchestrator` and `frontend` workspaces.
- Apply the new migration by hand against the live DB (standing process, per `0044_characters.sql`'s
  header), confirm `orchestrator_settings_key_check` accepts the two new keys.
- Manual end-to-end in an RP chat: have a new named character enter the scene's `Present:` line;
  confirm a `characters` row is created immediately (`status: 'transient'`, `persona` empty or
  carried-forward); confirm the reply is sent without waiting on the describer; confirm `persona`
  gets filled in shortly after via the fire-and-forget pass; confirm re-mentioning an
  already-described character never overwrites its `persona`.
- Manual: open the Cast section in the RP sidebar, confirm it lists chat-linked characters, confirm
  the present character shows the live indicator and it updates turn-to-turn as presence changes.
- Manual: confirm `CharactersView.tsx` (no `chatId` in play) is completely unaffected — same global
  roster as today.
- Manual: trigger a deferred cleanup-tick scrape (a turn whose raw header fails parsing, repaired
  later by cleanup) and confirm a character introduced only on that path still gets described.
- Manual: call `get_scenes` via `/v1/tools/get_scenes` with no `chat_id` and confirm it now returns
  only user-authored scenes (posture change from Part C fix 1 — no chat context means no
  auto-registered rows), and with a `chat_id` confirm it returns only that chat's own scene(s)
  plus user-authored ones.
