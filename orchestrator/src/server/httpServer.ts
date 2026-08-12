/**
 * @file orchestrator/src/server/httpServer.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — the orchestrator's HTTP surface
 * @description
 * The only "server" bigBrain exposes. Speaks just enough of the OpenAI Chat Completions shape
 * for the native frontend SPA to drive a turn (the shape was already OpenAI-compatible from
 * bigBrain's own history; nothing forces keeping it, but there's no reason to change it either).
 * Every request is authenticated to a user_id via authenticate() — that resolved value, never
 * anything the request body says, is what gets passed to runTurn's userId, per bb_principles.md
 * §4. authenticate() tries two paths: a Cloudflare Access identity (io/accessIdentity.ts) first,
 * since it's only ever present when a request actually transited the Cloudflare-Access-gated
 * hostname; then falls back to a BIGBRAIN_API_KEYS bearer token (apiKeyStore.ts). GET /v1/whoami
 * exposes this same resolution unauthenticated-by-default (no key required) so the frontend SPA
 * can silently probe whether Access already covers it.
 *
 * Streaming responses are not real token-level streaming: runTurn resolves the full reply
 * before this module has anything to send, so a stream:true request gets its answer as one SSE
 * chunk followed immediately by the terminator, not a token at a time. Good enough for a chat UI
 * to render correctly; true streaming would need runTurn itself to support it.
 *
 * Also serves a second, additive surface (toolInvoke.ts): POST /v1/tools/:name lets the
 * native frontend invoke one registered tool directly, bypassing runTurn — used for UI actions
 * that call a tool without going through a conversational turn. Same Bearer-key auth as
 * /v1/chat/completions; same RLS scoping regardless of which front door a call came through.
 *
 * GET / and GET /assets/* serve the built frontend/ SPA (Vite + React). Static
 * files are read from FRONTEND_DIST_DIR (frontend/dist, produced at Docker build time) and served
 * unauthenticated at the app layer, same as before (Cloudflare Access gates the whole hostname;
 * the SPA's own JS is what calls the authenticated JSON endpoints below). This replaced the old
 * standalone landingPage.ts/adminPage.ts server-rendered pages — Settings is now a tab inside the
 * SPA itself rather than a separate page, so switching to it never loses another tab's state.
 *
 * A persisted-chat surface (io/chatSessions.ts): /v1/chats and /v1/folders CRUD back the
 * frontend Chat tab's history sidebar, and an optional chat_id on POST /v1/chat/completions ties
 * a turn to a stored session — its params (system prompt, sampling, default model) and tool
 * allow-list apply, and the exchange is appended after the turn resolves. Requests without
 * chat_id (Open WebUI's) keep the original stateless behavior bit-for-bit.
 *
 * DELETE /v1/chats/:id/messages/:messageId removes one message standalone (the Chat tab's delete
 * action); POST /v1/chats/:id/messages/:messageId/truncate removes that message and everything
 * chronologically after it — "edit"'s primitive (truncate the edited user message, then POST
 * /v1/chat/completions again with new content, ending up one message longer than what's now
 * persisted).
 *
 * POST /v1/chats/:id/messages/:messageId/edit (body: { content: non-empty string }) rewrites an
 * already-persisted message's text in place — the Chat tab's "edit an LLM reply" action. Unlike
 * the truncate+resend user-edit above, the message keeps its message_id and everything
 * chronologically after it is untouched; the pre-edit text is preserved as a swipe via the same
 * recordSwipe write path regeneration uses, so the original reply stays one ‹ away.
 *
 * POST /v1/chats/:id/messages/:messageId/swipe (body: { direction: 'prev' | 'next' }) — swipe
 * capability on the last LLM response (docs/bi_principles.md), only ever valid for messageId ==
 * this chat's current last message. cycleSwipe (io/chatSessions.ts) is a pure content swap between
 * already-stored variants for most calls; 'next' past the newest stored variant is what "Rerun"
 * actually is now (regenerateSwipe below, in place via recordSwipe, no truncate/resend) — the two
 * are the same action from the store's point of view, so the frontend's Rerun button just sends
 * 'next' — except when messageId is the chat's sole message (the character-card greeting
 * applyCharacterToChatTool.ts seeded, never an LLM turn): 'next' past its last stored
 * alternate_greeting returns { status: 'no_further_swipe' } instead of regenerating, since there's
 * no prior user turn to regenerate a reply to. Deleting the current last turn naturally re-exposes
 * whatever's now last with its own, never-pruned swipe history still intact — no restore logic
 * needed for that (see migration 0059's own comment for why).
 *
 * handleChatCompletions also always prepends a current-date/time system message
 * (util/dateContext.ts, using the household_timezone admin setting) ahead of a chat's own custom
 * system prompt, for every turn regardless of chat_id — an LLM has no reliable sense of "today"
 * on its own, and date-taking tools need it.
 *
 * docs/plans/prompt-macros.md's Stage 1: an 'rp' chat's system prompt is scanned for `{{char}}`/
 * `{{user}}`/`{{persona}}`/`{{description}}`/`{{scenario}}`/etc. (util/interpolateMacros.ts) fresh
 * on every turn, right here, before it's folded into systemPrompt — never baked once at
 * apply_prompt_stack_to_chat time, so a persona or character-card edit takes effect on the very
 * next message with no re-apply needed (bi_principles.md §13). This is deliberately the one and
 * only per-turn resolution pass Stage 2/3 will extend, not a stopgap.
 *
 * A third, admin-only surface (adminServer.ts): GET/POST /v1/admin/credentials read/write
 * provider_credentials (io/providerCredentials.ts), called by the SPA's Settings tab. Gated by
 * isAdminAuthorized: any Cloudflare Access identity that already cleared the hostname (same
 * accessIdentity resolver authenticate() uses) is trusted, falling back to the static
 * BIGBRAIN_ADMIN_API_KEY only when Access isn't configured or the caller isn't a browser — with
 * Access in front of the whole app, a second manually-typed secret was redundant friction rather
 * than real defense in depth for a single-household deployment. A successful POST writes the new
 * value then exits the process (triggerRestart) so restart: unless-stopped picks up the new
 * credential at boot — see index.ts's provider-resolution sequence. triggerRestart is injectable
 * specifically so tests can exercise this route without killing the test process.
 *
 * A screen-lock idle-timeout overlay (ported from SillyTavern-Playground's driver/ui/
 * lockScreen.js) gets two GET surfaces for the same orchestrator_settings pair
 * (screen_lock_password/screen_lock_timeout_minutes, io/orchestratorSettings.ts): GET
 * /v1/screen-lock-settings, household-key/Access gated like /v1/timezone, is what
 * ScreenLockOverlay.tsx itself polls, since it must work for a regular authenticated user, not
 * just an admin; GET/POST /v1/admin/screen-lock-settings, admin-gated like every other Settings-
 * tab field, is where the password is actually set. No restart needed either way — both routes
 * read/write the same live value.
 *
 * Same admin gate, for the Connections tab's CRUD (io/llmConnections.ts, replacing the old
 * single-fieldset Settings "Connection" picker): GET/POST /v1/admin/connections list/create rows;
 * PATCH/DELETE /v1/admin/connections/:id update/remove one (DELETE 409s on the active row —
 * activate a different connection first); POST /v1/admin/connections/:id/activate flips is_active
 * and restarts (same restart-required contract the old picker had — deps.llm is a boot-time
 * singleton, bi_principles.md §14). GET /v1/admin/connections/:id/models lists that connection's
 * model catalog by building a throwaway provider for it (adminServer.ts's listModelsForConnection).
 * GET /v1/admin/connections/:id/providers?model=ID lists the upstream inference providers
 * OpenRouter can route that model to (adminServer.ts's listProvidersForConnection) — 404 when the
 * connection kind has no such catalog (i.e. isn't OpenRouter), since there's nothing to pin
 * routing to either way. POST /v1/admin/connections/:id/test (adminServer.ts's testConnection)
 * fires one cheap, capped-tokens real call through the saved connection and reports success/
 * failure — always 200 with { ok, latencyMs, reply? | error? }, never a thrown error for a bad
 * key/model, since that's exactly the failure mode this exists to surface; only the id-not-found
 * case is a 404. POST .../create and PATCH .../:id both take apiKey OR copyApiKeyFrom (a source
 * connection id whose key to reuse verbatim, io/llmConnections.ts's copyCiphertext) — several named
 * connections sharing one underlying provider no longer means re-pasting the same key into each.
 *
 * Same admin gate, but no restart, for GET/POST /v1/admin/timezone — the household_timezone
 * setting behind the date-context line above. It's read fresh per chat turn rather than baked
 * into anything at boot, so a POST here just writes the value and responds 200 immediately.
 *
 * Same admin gate and no-restart shape again for GET/POST /v1/admin/pia-proxy-settings —
 * pia_proxy_url, the internal address of the standalone pia-proxy container (stacks/pia-proxy)
 * plugins/characters' chub.ai import/search tools fetch through. Admin-only with no household-key
 * counterpart (unlike timezone/screen-lock): the frontend never reads this value itself, only
 * io/piaProxyFetch.ts does, server-side. GET /v1/characters/chub-avatar?url= (registered before
 * the generic /v1/characters/ prefix below) is the one place a chub CDN URL crosses straight from
 * the browser rather than through a tool call — gated by an explicit host allowlist
 * (CHUB_AVATAR_ALLOWED_HOSTS) before ever reaching fetchThroughPiaProxy, since an unguarded proxy
 * of an arbitrary `url` param would be an open SSRF relay.
 *
 * POST /v1/attachments/extract (handleUploadAttachment.ts's extractAttachmentUpload) turns a
 * staged file into Markdown ahead of a chat turn — same Bearer/Access auth as chat completions,
 * no persistence of its own. handleChatCompletions then splices any `attachments` in the request
 * body onto the copy of `messages` sent to the model this one turn only
 * (util/attachmentContext.ts) — the chat's stored history and auto-generated title still derive
 * from the original, un-spliced messages, so an attached file never bloats a chat's history.
 *
 * `images` on the request body never goes through an extraction endpoint at all — the frontend
 * base64-encodes them client-side (openai.ts's own preamble). handleChatCompletions gates on the
 * resolved connection's LlmProvider.supportsVision before splicing them in: an image sent to a
 * non-vision-capable connection fails the whole turn with a 422 before runTurn/llm.complete is
 * ever called, never a silent drop (bb_principles.md §2/§11).
 *
 * @api-declaration
 * startHttpServer(deps) — binds and listens on deps.port, returns the underlying http.Server
 *
 * The legacy inline cleanup LLM pass (runCleanupPass) is gone — the reply lands raw and the async
 * heuristic subloop (orchestrator/cleanupLoop.ts, migration 0072) rewrites it after the fact:
 * GET /v1/cleanup/status is the pill's read surface and POST /v1/cleanup/run is the page's
 * run-now trigger. See cleanupLoop.ts for the loop itself.
 *
 * @contract
 *   assertions:
 *     purity:          impure (opens a listening socket)
 *     state_ownership: [the http.Server instance it creates]
 *     external_io:     [inbound HTTP]
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { LlmConnectionStore } from '../io/llmConnections.js';
import type { ImageConnectionStore } from '../io/imageConnections.js';
import { log } from '../io/logger.js';
import { importCharacterCard } from './handleCharacterImport.js';
import { handleCharacterExportRoutes } from './handleCharacterExport.js';
import { extractAttachmentUpload } from './handleUploadAttachment.js';
import { handleChubCardDetail } from './handleChubCardDetail.js';
import type { AccessIdentityResolver } from '../io/accessIdentity.js';
import type { ChatSessionStore } from '../io/chatSessions.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import type { LlmProvider } from '../io/llm/types.js';
import type { PostgresClient } from '../io/postgres.js';
import type { ProviderCredentialStore } from '../io/providerCredentials.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import type { ToolRegistry } from '../orchestrator/toolRegistry.js';
import type { ApiKeyStore } from './apiKeyStore.js';
import {
  getChatBackgroundSettings,
  getChatLegibilitySettings,
  getHouseholdTimezone,
  getScreenLockSettings,
} from './adminServer.js';
import { invokeTool } from './toolInvoke.js';
import {
  authenticate,
  FRONTEND_DIST_DIR,
  isAdminAuthorized,
  readJsonBody,
  sendJson,
  serveStaticFile,
} from './httpUtils.js';
import {
  handleCanonSettingsGet,
  handleCanonSettingsSet,
  handleChatBackgroundSettingsSet,
  handleChatLegibilitySettingsSet,
  handleChatMemorySettingsGet,
  handleChatMemorySettingsSet,
  handleChatMemorySyncStatusGet,
  handleImageSettingsGet,
  handleImageSettingsSet,
  handleLocationRenderStatusGet,
  handleLocationsGet,
  handleLocationSettingsGet,
  handleLocationSettingsSet,
  handleLorebookSettingsGet,
  handleLorebookSettingsSet,
  handleTimezoneGet,
  handleTimezoneSet,
} from './handleAdminDisplaySettings.js';
import {
  handleAdminScreenLockSettingsGet,
  handleAdminScreenLockSettingsSet,
  handleChubAvatarProxy,
  handleNotificationSettingsGet,
  handleNotificationSettingsSet,
  handlePersonaSettingsGet,
  handlePersonaSettingsSet,
  handlePiaProxyUrlGet,
  handlePiaProxyUrlSet,
} from './handleAdminMisc.js';
import { handleAdminLorebookRoutes } from './handleAdminLorebooks.js';
import { handleClientLogs } from './handleClientLogs.js';
import { handleFolderRoutes } from './handleFolders.js';
import {
  handleChatAbort,
  handleChatTurnStatus,
} from './handleTurnControl.js';
import {
  handleCleanupJobs,
  handleCleanupRunNow,
  handleCleanupSettingsGet,
  handleCleanupSettingsSet,
  handleCleanupStatus,
} from './handleCleanup.js';
import { handleChatRoutes } from './handleChats.js';
import {
  handleAdminConnectionRoutes,
  handleAdminCredentialsList,
  handleAdminCredentialsSet,
  handleAdminImageConnectionRoutes,
} from './handleAdminConnections.js';
import { handleChatCompletions } from './handleChatCompletions.js';
import { buildModelsList } from './openai.js';
import { handleLocationImageBroken } from './locationImages.js';

export interface HttpServerDeps {
  llm: LlmProvider;
  db: PostgresClient;
  /** Only used by the archive_chat route (chatMemorySync.ts's archiveChatMemory) — the end-of-chat
   *  long-term-memory extraction needs to embed nothing itself, but chatMemorySync's shared
   *  ChatMemorySyncDeps shape expects it, same reasoning as its own module preamble. */
  embeddings: EmbeddingProvider;
  tools: ToolRegistry;
  apiKeys: ApiKeyStore;
  accessIdentity: AccessIdentityResolver;
  chats: ChatSessionStore;
  adminApiKey: string;
  credentials: ProviderCredentialStore;
  settings: OrchestratorSettingsStore;
  /** The admin-managed connection registry (db/migrations/0062_llm_connections.sql,
   *  io/llmConnections.ts) — backs the Connections tab's CRUD (GET/POST/PATCH/DELETE
   *  /v1/admin/connections) and its per-connection model/provider catalog preview routes. */
  llmConnections: LlmConnectionStore;
  /** The admin-managed image-generation connection registry (db/migrations/0068_image_connections.sql,
   *  io/imageConnections.ts) — backs the Connections tab's image section CRUD and the
   *  generateLocationImage pass's active-connection resolution (endpoint.md §3/§5). */
  imageConnections: ImageConnectionStore;
  modelName: string;
  port: number;
  /** Defaults to a real process.exit(0) — restart: unless-stopped relaunches the container, which
   *  reads the newly-saved credential at boot. Overridable so tests can prove a POST reached this
   *  point without actually killing the test process. */
  triggerRestart?: () => void;
  /** Whether backup/'s R2 credentials are real (docker-compose.yml's BIGBRAIN_BACKUP_CONFIGURED)
   *  — surfaced on /v1/whoami so the frontend can warn when offsite backup isn't actually running
   *  rather than failing silently. Not a secret itself (bb_principles.md §12). */
  backupConfigured: boolean;
}


async function handleToolInvoke(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  toolName: string,
): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  if (!toolName) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  let args: unknown;
  try {
    args = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const { status, body } = await invokeTool(deps.db, deps.tools, deps.embeddings, userId, toolName, args);
  sendJson(res, status, body);
}

async function handleUploadAttachment(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  const { status, body } = await extractAttachmentUpload(req);
  sendJson(res, status, body);
}




async function handleModels(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  if (deps.llm.listModels) {
    try {
      const models = await deps.llm.listModels();
      sendJson(res, 200, buildModelsList(models.map((m) => m.id)));
      return;
    } catch (err) {
      log.error('failed to fetch live model catalog, falling back to the static entry', err);
    }
  }
  sendJson(res, 200, buildModelsList([deps.modelName]));
}


async function handleWhoAmI(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'not authenticated' });
    return;
  }
  sendJson(res, 200, { userId, backupConfigured: deps.backupConfigured });
}

// household_timezone isn't a secret (bb_principles.md §12) and every household member already
// receives it indirectly on every chat turn via formatCurrentDateContext's system message — this
// just gives the frontend itself (computing "today" client-side) the same value directly, gated
// the same way as /v1/chats rather than requiring the admin key.
async function handleHouseholdTimezoneGet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  sendJson(res, 200, { timezone: await getHouseholdTimezone(deps.settings) });
}

// parallax_fade_teststep.md §2.2: the ChatView location-background parallax toggle, read live by
// the frontend at chat load. Same household-key/Access gate as /v1/timezone above (the chat view
// needs it as a regular authenticated user, before anyone would have entered the separate admin
// key just to open Settings) and the same no-restart shape — the value is fetched fresh, never
// baked in at boot.
async function handleChatBackgroundSettingsGet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  sendJson(res, 200, await getChatBackgroundSettings(deps.settings));
}

// migration 0074's read side for ChatView's "Text legibility" menu — same household-key/Access
// gate as the chat-background pair above: any authenticated user reads the current toggle set
// (nothing secret here), only the admin-gated POST below writes it.
async function handleChatLegibilitySettingsGet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  sendJson(res, 200, await getChatLegibilitySettings(deps.settings));
}

// screen_lock_password isn't a secret (bi_principles.md §12 — see adminServer.ts's own note), and
// ScreenLockOverlay.tsx needs it as a regular authenticated user, not an admin: it has to poll
// this the moment the app itself is authenticated, before anyone would have entered the separate
// admin key just to open Settings. Same household-key/Access gate as /v1/timezone above.
async function handleScreenLockSettingsGet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  sendJson(res, 200, await getScreenLockSettings(deps.settings));
}



async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/') {
    await serveStaticFile(res, `${FRONTEND_DIST_DIR}/index.html`);
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/assets/')) {
    const relativePath = decodeURIComponent(req.url.slice('/assets/'.length));
    if (relativePath.includes('..')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    await serveStaticFile(res, `${FRONTEND_DIST_DIR}/assets/${relativePath}`);
    return;
  }
  // PWA installability: web app manifest + its icons (frontend/public/*, copied to dist/ root
  // verbatim by Vite — unlike /assets/, these keep their source filenames, so each needs its own
  // route rather than a single prefix match).
  if (req.method === 'GET' && req.url === '/manifest.json') {
    await serveStaticFile(res, `${FRONTEND_DIST_DIR}/manifest.json`);
    return;
  }
  if (req.method === 'GET' && req.url === '/apple-touch-icon.png') {
    await serveStaticFile(res, `${FRONTEND_DIST_DIR}/apple-touch-icon.png`);
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/icons/')) {
    const relativePath = decodeURIComponent(req.url.slice('/icons/'.length));
    if (relativePath.includes('..')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    await serveStaticFile(res, `${FRONTEND_DIST_DIR}/icons/${relativePath}`);
    return;
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/client-logs') {
    await handleClientLogs(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/whoami') {
    await handleWhoAmI(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    await handleModels(res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/timezone') {
    await handleHouseholdTimezoneGet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/chat-background-settings') {
    await handleChatBackgroundSettingsGet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/chat-legibility-settings') {
    await handleChatLegibilitySettingsGet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/screen-lock-settings') {
    await handleScreenLockSettingsGet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/v1/chat/status')) {
    await handleChatTurnStatus(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/v1/cleanup/status')) {
    await handleCleanupStatus(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/v1/cleanup/jobs')) {
    await handleCleanupJobs(req, res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/cleanup/run') {
    await handleCleanupRunNow(req, res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    await handleChatCompletions(req, res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/abort') {
    await handleChatAbort(req, res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/attachments/extract') {
    await handleUploadAttachment(req, res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/characters/import') {
    const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
    if (!userId) {
      sendJson(res, 401, { error: 'missing or unrecognized API key' });
      return;
    }
    const result = await importCharacterCard(req, deps, userId);
    sendJson(res, result.status, result.body);
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/v1/characters/chub-avatar')) {
    const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
    if (!userId) {
      sendJson(res, 401, { error: 'missing or unrecognized API key' });
      return;
    }
    await handleChubAvatarProxy(req, res, deps);
    return;
  }
  // Must sit before the generic GET /v1/characters/ prefix below, which would otherwise swallow
  // it — same registration order as the chub-avatar route. Backs BrowseChubView.tsx's card modal.
  if (req.method === 'GET' && req.url?.startsWith('/v1/characters/chub-detail')) {
    const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
    if (!userId) {
      sendJson(res, 401, { error: 'missing or unrecognized API key' });
      return;
    }
    const result = await handleChubCardDetail(req, { settings: deps.settings });
    sendJson(res, result.status, result.body);
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/v1/characters/')) {
    const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
    if (!userId) {
      sendJson(res, 401, { error: 'missing or unrecognized API key' });
      return;
    }
    await handleCharacterExportRoutes(req, res, deps, userId, new URL(req.url, 'http://placeholder'));
    return;
  }
  if (req.url === '/v1/chats' || req.url?.startsWith('/v1/chats/') || req.url?.startsWith('/v1/chats?')) {
    const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
    if (!userId) {
      sendJson(res, 401, { error: 'missing or unrecognized API key' });
      return;
    }
    await handleChatRoutes(req, res, deps, userId, new URL(req.url, 'http://placeholder'));
    return;
  }
  if (req.url === '/v1/folders' || req.url?.startsWith('/v1/folders/')) {
    const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
    if (!userId) {
      sendJson(res, 401, { error: 'missing or unrecognized API key' });
      return;
    }
    await handleFolderRoutes(req, res, deps, userId, new URL(req.url, 'http://placeholder'));
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/v1/locations/')) {
    const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
    if (!userId) {
      sendJson(res, 401, { error: 'missing or unrecognized API key' });
      return;
    }
    // endpoint.md §5.2: the Chat View's broken-background-image notify — user-scoped, clears the
    // stale URL so the next visit re-renders.
    await handleLocationImageBroken(req, res, deps, userId, new URL(req.url, 'http://placeholder'));
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/tools') {
    const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
    if (!userId) {
      sendJson(res, 401, { error: 'missing or unrecognized API key' });
      return;
    }
    sendJson(res, 200, { names: deps.tools.definitions().map((def) => def.name) });
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/v1/tools/')) {
    const toolName = decodeURIComponent(new URL(req.url, 'http://placeholder').pathname.slice('/v1/tools/'.length));
    await handleToolInvoke(req, res, deps, toolName);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/credentials') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleAdminCredentialsList(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/credentials') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleAdminCredentialsSet(req, res, deps);
    return;
  }
  if (req.url === '/v1/admin/connections' || req.url?.startsWith('/v1/admin/connections/') || req.url?.startsWith('/v1/admin/connections?')) {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleAdminConnectionRoutes(req, res, deps, new URL(req.url, 'http://placeholder'));
    return;
  }
  if (
    req.url === '/v1/admin/image-connections' ||
    req.url?.startsWith('/v1/admin/image-connections/') ||
    req.url?.startsWith('/v1/admin/image-connections?')
  ) {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleAdminImageConnectionRoutes(req, res, deps, new URL(req.url, 'http://placeholder'));
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/image-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleImageSettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/image-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleImageSettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/location-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleLocationSettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/location-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleLocationSettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/locations') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleLocationsGet(res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/timezone') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleTimezoneGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/timezone') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleTimezoneSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/chat-background-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleChatBackgroundSettingsGet(req, res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/chat-background-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleChatBackgroundSettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/chat-legibility-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleChatLegibilitySettingsGet(req, res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/chat-legibility-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleChatLegibilitySettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/notification-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleNotificationSettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/notification-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleNotificationSettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/screen-lock-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleAdminScreenLockSettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/screen-lock-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleAdminScreenLockSettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/pia-proxy-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handlePiaProxyUrlGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/pia-proxy-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handlePiaProxyUrlSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/persona-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handlePersonaSettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/persona-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handlePersonaSettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/chat-memory-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleChatMemorySettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/chat-memory-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleChatMemorySettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/chat-memory-sync-status') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleChatMemorySyncStatusGet(res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/location-render-status') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleLocationRenderStatusGet(res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/canon-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleCanonSettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/canon-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleCanonSettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/cleanup-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleCleanupSettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/cleanup-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleCleanupSettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/lorebook-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleLorebookSettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/lorebook-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleLorebookSettingsSet(req, res, deps);
    return;
  }
  if (
    req.url === '/v1/admin/lorebooks' ||
    req.url?.startsWith('/v1/admin/lorebooks/') ||
    req.url?.startsWith('/v1/admin/lorebooks?') ||
    req.url === '/v1/admin/lorebook-entries' ||
    req.url?.startsWith('/v1/admin/lorebook-entries/') ||
    req.url?.startsWith('/v1/admin/lorebook-entries?')
  ) {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleAdminLorebookRoutes(req, res, deps, new URL(req.url, 'http://placeholder'));
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

export function startHttpServer(deps: HttpServerDeps): Server {
  const server = createServer((req, res) => {
    handleRequest(req, res, deps).catch((err) => {
      log.error('unhandled error in HTTP handler', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });

  server.listen(deps.port, () => {
    log.info(`orchestrator HTTP server listening on :${deps.port}`);
  });

  return server;
}
