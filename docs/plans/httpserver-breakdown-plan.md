# httpServer.ts Breakdown Plan

*Status: planned, not started — 2026-08-11.*

## 1. Purpose

`orchestrator/src/server/httpServer.ts` is 4,247 lines. `bi_principles.md` §10 sets a 300-line
budget per file ("every file does exactly one thing... when you reach 300 lines, split the file
along the nearest fault line and continue"). This file is ~14x over budget and has been for a
while — every new admin settings panel added a GET/SET pair here and two more branches to the
dispatcher, rather than landing in its own module. This plan lays out the fault lines and an
extraction order so the split can happen incrementally without a single large risky rewrite.

Related, out of scope here: `orchestrator/src/server/adminServer.ts` (2,363 lines) has the same
problem and is called into by several of the admin routes below. Worth its own pass later, not
folded into this plan.

## 2. Why It Got This Big

Not one bloated feature — five unrelated concerns stacked in one file, each grown by the same
"add two functions + two `if` branches" pattern:

1. **Generic HTTP plumbing** — `readJsonBody`, `authenticate`, `isAdminAuthorized`, `sendJson`,
   `serveStaticFile` (~120 lines). Legitimately small and cohesive on its own.
2. **Prompt assembly & Prompt Inspector logic** (~950 lines) — narrator stack building, macro
   resolution, live-window trimming, prompt preview construction. This is business logic, not
   I/O — it only lives here because `handleChatCompletions` calls it.
3. **Location-image resolution/triggering** (~165 lines) — `fireLocationImageGeneration`,
   `resolveChatLocationImage`, etc., sandwiched inside the prompt-assembly block.
4. **~25 individual admin/settings route handlers** (~1,300 lines) — credentials, connections,
   image connections, image settings, location settings, timezone, chat background, chat
   legibility, chat memory, canon, lorebook CRUD, notifications, screen lock, PIA proxy, persona.
   The lorebook admin block alone is 314 lines — bigger than the entire budget by itself.
5. **Chat/folder CRUD, turn control, cleanup routes** (~700 lines).
6. **The dispatcher itself** — `handleRequest`, a ~470-line `if (method && url === ...)` chain.

Nothing here is hard to split — it's accretion, not genuine cohesion.

## 3. Current State (line ranges as of 2026-08-11)

| Lines | Contents |
|---|---|
| 1–337 | header doc, imports, `HttpServerDeps` |
| 338–421 | `readJsonBody`, `authenticate`, `isAdminAuthorized`, `sendJson` |
| 422–1379 | prompt preview/assembly, narrator stack, macro resolution (location-image code interleaved at 875–1040) |
| 1380–1568 | `TurnPrice`, `toTurnPrice`, `resolveTurnLlm`, `regenerateSwipe` |
| 1570–1580 | `serveStaticFile` |
| 1581–1955 | `handleChatCompletions` |
| 1956–2026 | `handleToolInvoke`, `handleUploadAttachment`, `handleClientLogs` |
| 2027–2881 | admin credentials/connections/image-connections/settings routes, incl. `handleAdminLorebookRoutes` (2567–2881, 314 lines) |
| 2881–3033 | notifications, screen lock, chub avatar proxy, PIA proxy, persona settings |
| 3034–3092 | `handleModels`, `isChatPatchBody`, `pairsSetting` |
| 3093–3502 | `handleChatRoutes` (chat CRUD, edit/truncate/swipe) |
| 3503–3555 | `handleFolderRoutes` |
| 3556–3766 | whoami, household timezone get, chat display settings gets, turn status, chat abort, cleanup status/run/jobs/settings |
| 3767–4233 | `handleRequest` dispatch chain |
| 4234–4247 | `startHttpServer` |

## 4. Proposed Breakdown

Following the existing `server/handleXxx.ts` convention (`handleCharacterExport.ts`,
`handleCharacterImport.ts`, `handleChubCardDetail.ts`, `handleUploadAttachment.ts`,
`toolInvoke.ts`):

**Stays in `httpServer.ts`** (thin bootstrap): `HttpServerDeps`, `startHttpServer`,
`handleRequest`. Even alone, `handleRequest` is ~500 lines as a flat if-chain — it likely needs to
become a route table (`[method, pattern, handler]` array) or be split into per-domain
sub-dispatchers (settings / chat / admin) rather than staying one function.

| New file | Contents | Est. lines |
|---|---|---|
| `httpUtils.ts` | `readJsonBody`, `authenticate`, `isAdminAuthorized`, `sendJson`, `serveStaticFile` | ~120 |
| `promptAssembly.ts` | macro resolution, narrator stack, live-window trim, `assembleSessionTurnContext` | ~500 |
| `promptPreview.ts` | `PromptPreview*` types, `buildPromptPreview` | ~230 |
| `locationImages.ts` | `fireLocationImageGeneration`, `resolveChatLocationImage`, `ensureActiveLocationImage`, `handleLocationImageBroken` | ~165 |
| `turnExecution.ts` | `TurnPrice`, `resolveTurnLlm`, `regenerateSwipe` | ~190 |
| `handleChatCompletions.ts` | `/v1/chat/completions` handler | ~375 (still over — needs a second split) |
| `handleAdminConnections.ts` | credentials + connection + image-connection admin routes | ~300 |
| `handleAdminDisplaySettings.ts` | image/location/timezone/background/legibility/memory settings | ~230 |
| `handleAdminLorebooks.ts` | lorebook CRUD block, already self-contained | ~314 |
| `handleAdminMisc.ts` | notifications, screen lock, PIA proxy, persona, chub avatar proxy | ~150 |
| `handleChats.ts` | `handleChatRoutes` | ~410 (still over — split CRUD vs message-mutation) |
| `handleFolders.ts` | `handleFolderRoutes` | ~53 |
| `handleCleanup.ts` | cleanup status/run/jobs/settings | ~210 |
| `handleTurnControl.ts` | chat turn status + abort | ~50 |
| `handleMisc.ts` | whoami, models, household timezone get | ~90 |

~19 files instead of 1. This first cut removes ~3,800 of the 4,247 lines from `httpServer.ts`.
Three files (`handleChatCompletions.ts`, `handleChats.ts`, `promptAssembly.ts`) still land over
300 lines and need a second pass once the initial extraction lands — not blocking the first cut.

## 5. Extraction Order

Lowest risk / most self-contained first, most entangled last:

1. Standalone admin settings GET/SET pairs (`handleAdminDisplaySettings.ts`, `handleAdminMisc.ts`) — pure, no shared state with the rest of the file.
2. `handleAdminLorebooks.ts` — already a contiguous, self-contained block.
3. `handleCleanup.ts`, `handleTurnControl.ts`, `handleFolders.ts` — small, low fan-in.
4. `handleAdminConnections.ts` — larger but still self-contained.
5. `handleChats.ts` — bigger and more central; touch after the smaller ones are proven out.
6. `promptAssembly.ts`, `locationImages.ts`, `turnExecution.ts` — shared between
   `handleChatCompletions` and `regenerateSwipe`; extract together since they're entangled, and
   double check both call sites still compile against the new imports.
7. `handleChatCompletions.ts` — depends on everything extracted in step 6.
8. `handleRequest`/dispatcher rework — last, since it wires everything together; only safe once
   every handler it calls already lives in its own file.

## 6. Open Questions

- Does prompt assembly (`promptAssembly.ts`, `promptPreview.ts`) belong under `server/` at all,
  or should it move to `io/` or a new `prompts/` directory? It's business logic reachable from
  HTTP, not HTTP plumbing itself. Deferred — decide when step 6 is reached.
- `handleChats.ts` and `handleChatCompletions.ts` will still need a second split to clear 300
  lines; exact fault line (e.g. CRUD vs. message-mutation for chats; request validation vs. turn
  execution for completions) to be decided at extraction time, not speculatively now.
