# httpServer.ts Breakdown Plan

*Status: planned, not started — refreshed 2026-08-12 (post rp-streaming; file now 4,470 lines).*

## 1. Purpose

`orchestrator/src/server/httpServer.ts` is 4,470 lines. `bi_principles.md` §10 sets a 300-line
budget per file ("every file does exactly one thing... when you reach 300 lines, split the file
along the nearest fault line and continue"). This file is ~15x over budget and has been for a
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
   `serveStaticFile`, plus the SSE helpers `writeStreamHeaders` and `writeStreamErrorTerminalFrame`
   (~145 lines). Legitimately small and cohesive on its own.
2. **Prompt assembly & Prompt Inspector logic** (~780 lines) — narrator stack building, macro
   resolution, live-window trimming, prompt preview construction. This is business logic, not
   I/O — it only lives here because `handleChatCompletions` calls it.
3. **Location-image resolution/triggering** (~165 lines) — `fireLocationImageGeneration`,
   `resolveChatLocationImage`, etc., sandwiched inside the prompt-assembly block.
4. **~30 individual admin/settings route handlers** (~1,400 lines) — credentials, connections,
   image connections, image settings, location settings, timezone, chat background, chat
   legibility, chat memory, canon, lorebook CRUD, notifications, screen lock, PIA proxy, persona.
   The lorebook admin block alone is 314 lines — bigger than the entire budget by itself.
5. **Chat/folder CRUD, turn control, cleanup routes** (~700 lines).
6. **The dispatcher itself** — `handleRequest`, a ~470-line `if (method && url === ...)` chain.

Nothing here is hard to split — it's accretion, not genuine cohesion.

## 3. Current State (line ranges as of 2026-08-12)

| Lines | Contents |
|---|---|
| 1–337 | header doc, imports, `HttpServerDeps` |
| 338–462 | `readJsonBody`, `authenticate`, `isAdminAuthorized`, `sendJson`, `writeStreamHeaders`, `writeStreamErrorTerminalFrame` |
| 463–1404 | prompt preview/assembly, narrator stack, macro resolution (location-image code interleaved at 900–1064) |
| 1405–1636 | `TurnPrice`, `toTurnPrice`, `resolveTurnLlm`, `regenerateSwipe` (SSE streaming branch added 2026-08-12) |
| 1637–1647 | `serveStaticFile` |
| 1648–2127 | `handleChatCompletions` (480 lines — includes the RP SSE streaming branch) |
| 2128–2198 | `handleToolInvoke`, `handleUploadAttachment` (thin wrappers over `toolInvoke.ts`/`handleUploadAttachment.ts`), `handleClientLogs` |
| 2199–3052 | admin credentials/connections/image-connections/settings routes, incl. `handleAdminLorebookRoutes` (2739–3052, 314 lines) |
| 3053–3205 | notifications, screen lock, chub avatar proxy, PIA proxy, persona settings |
| 3206–3264 | `handleModels`, `isChatPatchBody`, `pairsSetting` |
| 3265–3725 | `handleChatRoutes` (chat CRUD, edit/truncate/swipe) |
| 3726–3778 | `handleFolderRoutes` |
| 3779–3989 | whoami, household timezone get, chat display settings gets, turn status, chat abort, cleanup status/run/jobs/settings |
| 3990–4456 | `handleRequest` dispatch chain |
| 4457–4470 | `startHttpServer` |

## 4. Proposed Breakdown

Following the existing `server/handleXxx.ts` convention (`handleCharacterExport.ts`,
`handleCharacterImport.ts`, `handleChubCardDetail.ts`, `handleUploadAttachment.ts`,
`toolInvoke.ts`):

**Stays in `httpServer.ts`** (thin bootstrap): `HttpServerDeps`, `startHttpServer`,
`handleRequest`. Even alone, `handleRequest` is ~470 lines as a flat if-chain — it likely needs to
become a route table (`[method, pattern, handler]` array) or be split into per-domain
sub-dispatchers (settings / chat / admin) rather than staying one function.

| New file | Contents | Est. lines |
|---|---|---|
| `httpUtils.ts` | `readJsonBody`, `authenticate`, `isAdminAuthorized`, `sendJson`, `serveStaticFile`, `writeStreamHeaders`, `writeStreamErrorTerminalFrame` | ~145 |
| `promptAssembly.ts` | macro resolution, narrator stack, live-window trim, `assembleSessionTurnContext` + helpers | ~600 |
| `promptPreview.ts` | `PromptPreview*` types, `buildPromptPreview` | ~260 |
| `locationImages.ts` | `fireLocationImageGeneration`, `resolveChatLocationImage`, `ensureActiveLocationImage`, `handleLocationImageBroken` | ~165 |
| `turnExecution.ts` | `TurnPrice`, `toTurnPrice`, `resolveTurnLlm`, `regenerateSwipe` (incl. its SSE streaming path) | ~260 |
| `handleChatCompletions.ts` | `/v1/chat/completions` handler (incl. RP SSE streaming) | ~480 (still over — needs a second split) |
| `handleAdminConnections.ts` | credentials + connection + image-connection admin routes | ~300 |
| `handleAdminDisplaySettings.ts` | image/location/timezone/background/legibility/memory/canon/lorebook-settings + memory-sync/render-status gets | ~330 |
| `handleAdminLorebooks.ts` | lorebook CRUD block, already self-contained | ~314 |
| `handleAdminMisc.ts` | notifications, screen lock, PIA proxy, persona, chub avatar proxy | ~150 |
| `handleClientLogs.ts` | `handleClientLogs` (unauthenticated-by-design; owns its fileLogBuffer) | ~50 |
| `handleChats.ts` | `handleChatRoutes` | ~460 (still over — split CRUD vs message-mutation) |
| `handleFolders.ts` | `handleFolderRoutes` | ~53 |
| `handleCleanup.ts` | cleanup status/run/jobs/settings | ~210 |
| `handleTurnControl.ts` | chat turn status + abort | ~50 |
| `handleMisc.ts` | whoami, models, household timezone get, chat background/legibility gets, screen lock get | ~110 |

17 files instead of 1 (16 new + `httpServer.ts`). This first cut removes ~3,900 of the 4,470 lines
from `httpServer.ts`. Three files (`handleChatCompletions.ts`, `handleChats.ts`,
`promptAssembly.ts`) still land over 300 lines and need a second pass once the initial extraction
lands — not blocking the first cut.

## 5. Extraction Order

Lowest risk / most self-contained first, most entangled last. **After every step: STOP** — run
`npm run check` and `npm run verify` (both must exit 0), commit, then compact context before
starting the next step. (`npm run verify` covers `verify-server.mjs`, `verify-streaming-turn.mjs`,
`verify-tool-invoke.mjs`, `verify-attachments.mjs`, `verify-client-logs.mjs`, etc.)

1. Standalone admin settings GET/SET pairs (`handleAdminDisplaySettings.ts`, `handleAdminMisc.ts`) — pure, no shared state with the rest of the file.
   **STOP** — check + verify green, commit, compact.
2. `handleAdminLorebooks.ts` — already a contiguous, self-contained block.
   **STOP** — check + verify green, commit, compact.
3. `handleClientLogs.ts`, `handleCleanup.ts`, `handleTurnControl.ts`, `handleFolders.ts` — small, low fan-in.
   **STOP** — check + verify green, commit, compact.
4. `handleAdminConnections.ts` — larger but still self-contained.
   **STOP** — check + verify green, commit, compact.
5. `handleChats.ts` — bigger and more central; touch after the smaller ones are proven out.
   **STOP** — check + verify green, commit, compact.
6. `promptAssembly.ts`, `locationImages.ts`, `turnExecution.ts` — shared between
   `handleChatCompletions` and `regenerateSwipe`; extract together since they're entangled, and
   double check both call sites still compile against the new imports.
   **STOP** — check + verify green, commit, compact.
7. `handleChatCompletions.ts` — depends on everything extracted in step 6.
   **STOP** — check + verify green, commit, compact.
8. `handleRequest`/dispatcher rework — last, since it wires everything together; only safe once
   every handler it calls already lives in its own file.
   **STOP** — check + verify green, commit, compact.

## 6. Checklist & Risks (things the extraction must not forget)

- **External import surface**: `orchestrator/src/index.ts` imports
  `{ fireLocationImageGeneration, startHttpServer }` from `./server/httpServer.js`.
  `fireLocationImageGeneration` moves to `locationImages.ts` → update that import in step 6.
  `HttpServerDeps` must stay exported from `httpServer.ts` (index.ts reaches it via
  `Parameters<typeof startHttpServer>[0]`).
- **`loadPromptStackSlots` sync risk**: it is the narrator-path slot loader and must stay in sync
  with `plugins/context-stack-presets/src/applyPromptStackToChatTool.ts` (both map `group_name`
  from `context_stack_presets` — a past bug fixed one side only). Keep that coupling in mind when
  moving it into `promptAssembly.ts` (step 6).
- **`handleToolInvoke` / `handleUploadAttachment` wrappers**: already thin delegators to
  `toolInvoke.ts` / `handleUploadAttachment.ts`. Decide at extraction time whether they stay in
  `httpServer.ts` or move with their logic; do not copy logic.
- **SSE helpers** (`writeStreamHeaders`, `writeStreamErrorTerminalFrame`) move with
  `handleChatCompletions.ts`/`turnExecution.ts` — both streaming routes share them.
- **Per-helper bucketing** in the prompt block (463–1404): `toPreviewItem`,
  `buildChatMemorySystemPrompt`, `buildMacroSnapshot`, `resolveMacrosInSystemPrompt`,
  `loadPromptStackSlots`, `buildNarratorStackItems`, `assembleNarratorSystemText`,
  `trimToLiveWindow`, `resolveMacrosInMessages`, `decorateMessageForDisplay` — assign each to
  `promptAssembly.ts` or `promptPreview.ts` at extraction time, not speculatively now.
- **PWA static routes** (`/manifest.json`, `/apple-touch-icon.png`, `/icons/`) live in the
  dispatcher (step 8) — keep them when converting to a route table.

## 7. Open Questions

- Does prompt assembly (`promptAssembly.ts`, `promptPreview.ts`) belong under `server/` at all,
  or should it move to `io/` or a new `prompts/` directory? It's business logic reachable from
  HTTP, not HTTP plumbing itself. Deferred — decide when step 6 is reached.
- `handleChats.ts` and `handleChatCompletions.ts` will still need a second split to clear 300
  lines; exact fault line (e.g. CRUD vs. message-mutation for chats; request validation vs. turn
  execution for completions) to be decided at extraction time, not speculatively now.
