/**
 * @file orchestrator/src/server/httpServer.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — the orchestrator's HTTP surface
 * @description
 * Thin bootstrap + route table only. As of the 2026-08-12 breakdown
 * (docs/plans/completed/httpserver-breakdown-plan.md), every request handler this module wires lives in its
 * own server/handle*.ts module (handleChats.ts, handleChatCompletions.ts, handleAdmin*.ts,
 * promptAssembly.ts/promptPreview.ts/locationImages.ts/turnExecution.ts, ...); this file keeps
 * HttpServerDeps, the [method, path, handler] route table below (with the withUser/withAdmin auth
 * wrappers), and startHttpServer. The paragraphs that follow document the HTTP surface those
 * handlers implement — each stays with its endpoint rather than moving into the handler files.
 *
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
  handleChatMemoryResizePost,
  handleChatMemoryResizeStatusGet,
  handleChatMemorySyncStatusGet,
  handleImageSettingsGet,
  handleImageSettingsSet,
  handleLocationRenderStatusGet,
  handleLocationsGet,
  handleLocationSettingsGet,
  handleLocationSettingsSet,
  handleCharacterSettingsGet,
  handleCharacterSettingsSet,
  handlePortraitBackgroundPromptsSettingsGet,
  handlePortraitBackgroundPromptsSettingsSet,
  handlePortraitSubjectDescriberSettingsGet,
  handlePortraitSubjectDescriberSettingsSet,
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
import { handleTurnDisplayMetrics } from './handleTurnDisplayMetrics.js';
import { handleLlmStatsGet, handleTurnDisplayStatsGet } from './handleAdminStats.js';
import { buildModelsList } from './openai.js';
import { handleLocationImageBroken } from './locationImages.js';
import {
  handlePortraitCandidateRetry,
  handlePortraitEntities,
  handlePortraitEntityFromCastCharacter,
  handlePortraitEpisodeReflect,
  handlePortraitFeedback,
  handlePortraitGenerate,
  handlePortraitPreview,
  handlePortraitHistory,
  handlePortraitLayersGet,
  handlePortraitLayersSet,
  handlePortraitLessons,
  handlePortraitLlmConnectionGet,
  handlePortraitLlmConnectionSet,
  handlePortraitsEnabledGet,
  handlePortraitsEnabledSet,
  handlePortraitWiki,
} from './portraitRoutes.js';
import { handlePortraitRoundTelemetry } from './portraitTelemetryRoutes.js';

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
  /** Injectable DeepSeek pricing-page fetcher for POST /v1/admin/connections/pricing-sync
   *  (io/deepseekPricingSync.ts) — omitted in production (the real fetch hits DeepSeek's own
   *  domain), present in verify-server.mjs so the route can be exercised without a network call. */
  fetchHtml?: (url: string) => Promise<string>;
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

  // rp-cast-infrastructure-plan.md Part B: the caller may scope the invocation to a chat via
  // ?chat_id=… (the Cast sidebar passes the active RP chat's id so chat-scoped tools like
  // get_characters/get_scenes surface that chat's auto-registered rows). Absent = undefined,
  // exactly the stateless behavior every existing call site has today.
  const chatId = new URL(req.url!, 'http://placeholder').searchParams.get('chat_id') ?? undefined;

  const { status, body } = await invokeTool(deps.db, deps.tools, deps.embeddings, userId, toolName, args, chatId);
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



type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
) => Promise<void>;

interface Route {
  /** HTTP method this route answers; '*' matches any method (the CRUD family routes). */
  method: 'GET' | 'POST' | '*';
  /** Exact path, prefix (prefix: true), or path family — see the matchers below. */
  path?: string;
  prefix?: boolean;
  /** Match path, path/, and path?... — the prefix-with-query pattern the CRUD families use. */
  family?: string | string[];
  run: RouteHandler;
}

/** Route-table matcher — preserves the original if-chain's exact conditions. */
function routeMatches(req: IncomingMessage, route: Route): boolean {
  if (route.method !== '*' && req.method !== route.method) return false;
  const url = req.url ?? '';
  if (route.family !== undefined) {
    const families = Array.isArray(route.family) ? route.family : [route.family];
    return families.some((f) => url === f || url.startsWith(`${f}/`) || url.startsWith(`${f}?`));
  }
  if (route.prefix) return url.startsWith(route.path!);
  return url === route.path;
}

/** Authenticate to a user_id — the value authenticate() resolves, never anything the body says. */
async function withUser(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  fn: (userId: string) => Promise<void>,
): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  await fn(userId);
}

/** Admin gate: any Cloudflare Access identity that cleared the hostname, else the static admin key. */
async function withAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  fn: () => Promise<void>,
): Promise<void> {
  if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
    sendJson(res, 401, { error: 'missing or incorrect admin key' });
    return;
  }
  await fn();
}

/** Serve one FRONTEND_DIST_DIR file, rejecting path traversal (the old if-chain's `..` guard).
 *  distPrefix keeps the subdirectory (e.g. 'assets/') — the URL's path prefix was already sliced
 *  off by the caller, and the file lives at dist/<distPrefix><relativePath>. */
async function serveDistFile(res: ServerResponse, distPrefix: string, distRelativePath: string): Promise<void> {
  const relativePath = decodeURIComponent(distRelativePath);
  if (relativePath.includes('..')) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  await serveStaticFile(res, `${FRONTEND_DIST_DIR}/${distPrefix}${relativePath}`);
}

// The route table. Registration order IS the precedence: prefix routes match in the order they
// appear, so the two /v1/characters/ sub-routes sit before the generic /v1/characters/ prefix
// (same as the old if-chain), and everything else mirrors the if-chain's order exactly.
const routes: Route[] = [
  // ---- SPA + PWA static (served unauthenticated; Cloudflare Access gates the whole hostname) ----
  { method: 'GET', path: '/', run: async (_req, res, _deps) => { await serveStaticFile(res, `${FRONTEND_DIST_DIR}/index.html`); } },
  { method: 'GET', prefix: true, path: '/assets/', run: async (req, res, _deps) => { await serveDistFile(res, 'assets/', (req.url ?? '').slice('/assets/'.length)); } },
  // PWA installability: web app manifest + its icons (frontend/public/*, copied to dist/ root
  // verbatim by Vite — unlike /assets/, these keep their source filenames, so each needs its own
  // route rather than a single prefix match).
  { method: 'GET', path: '/manifest.json', run: async (_req, res, _deps) => { await serveStaticFile(res, `${FRONTEND_DIST_DIR}/manifest.json`); } },
  { method: 'GET', path: '/apple-touch-icon.png', run: async (_req, res, _deps) => { await serveStaticFile(res, `${FRONTEND_DIST_DIR}/apple-touch-icon.png`); } },
  { method: 'GET', prefix: true, path: '/icons/', run: async (req, res, _deps) => { await serveDistFile(res, 'icons/', (req.url ?? '').slice('/icons/'.length)); } },
  { method: 'GET', path: '/healthz', run: async (_req, res, _deps) => { sendJson(res, 200, { status: 'ok' }); } },

  // ---- Household-key/Access-gated reads (no admin key) ----
  { method: 'POST', path: '/v1/client-logs', run: async (req, res, deps) => { await handleClientLogs(req, res, deps); } },
  { method: 'GET', path: '/v1/whoami', run: async (req, res, deps) => { await handleWhoAmI(req, res, deps); } },
  { method: 'GET', path: '/v1/models', run: async (_req, res, deps) => { await handleModels(res, deps); } },
  { method: 'GET', path: '/v1/timezone', run: async (req, res, deps) => { await handleHouseholdTimezoneGet(req, res, deps); } },
  { method: 'GET', path: '/v1/chat-background-settings', run: async (req, res, deps) => { await handleChatBackgroundSettingsGet(req, res, deps); } },
  { method: 'GET', path: '/v1/chat-legibility-settings', run: async (req, res, deps) => { await handleChatLegibilitySettingsGet(req, res, deps); } },
  { method: 'GET', path: '/v1/screen-lock-settings', run: async (req, res, deps) => { await handleScreenLockSettingsGet(req, res, deps); } },

  // ---- Chat turns, cleanup, attachments (user-authenticated) ----
  { method: 'GET', prefix: true, path: '/v1/chat/status', run: async (req, res, deps) => { await handleChatTurnStatus(req, res, deps); } },
  { method: 'GET', prefix: true, path: '/v1/cleanup/status', run: async (req, res, deps) => { await handleCleanupStatus(req, res, deps); } },
  { method: 'GET', prefix: true, path: '/v1/cleanup/jobs', run: async (req, res, deps) => { await handleCleanupJobs(req, res, deps); } },
  { method: 'POST', path: '/v1/cleanup/run', run: async (req, res, deps) => { await handleCleanupRunNow(req, res, deps); } },
  { method: 'POST', path: '/v1/chat/completions', run: async (req, res, deps) => { await handleChatCompletions(req, res, deps); } },
  { method: 'POST', path: '/v1/chat/abort', run: async (req, res, deps) => { await handleChatAbort(req, res, deps); } },
  // Client-reported RP turn display timing (llm-stats-page-plan.md Timing section) — written by
  // every regular chat turn, so regular chat auth, not admin (the same gate /v1/chat/completions
  // uses). Fire-and-forget from the client; a failed write never fails the turn.
  { method: 'POST', path: '/v1/turn-display-metrics', run: async (req, res, deps) => { await handleTurnDisplayMetrics(req, res, deps); } },
  { method: 'POST', path: '/v1/attachments/extract', run: async (req, res, deps) => { await handleUploadAttachment(req, res, deps); } },

  // ---- Characters ----
  { method: 'POST', path: '/v1/characters/import', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => {
      const result = await importCharacterCard(req, deps, userId);
      sendJson(res, result.status, result.body);
    }) },
  // Must sit before the generic GET /v1/characters/ prefix below, which would otherwise swallow
  // it — same registration order as the chub-avatar route. Backs BrowseChubView.tsx's card modal.
  { method: 'GET', prefix: true, path: '/v1/characters/chub-detail', run: async (req, res, deps) => withUser(req, res, deps, async () => {
      const result = await handleChubCardDetail(req, { settings: deps.settings });
      sendJson(res, result.status, result.body);
    }) },
  { method: 'GET', prefix: true, path: '/v1/characters/chub-avatar', run: async (req, res, deps) => withUser(req, res, deps, async () => {
      await handleChubAvatarProxy(req, res, deps);
    }) },
  { method: 'GET', prefix: true, path: '/v1/characters/', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => {
      await handleCharacterExportRoutes(req, res, deps, userId, new URL(req.url!, 'http://placeholder'));
    }) },

  // ---- Chats / folders / location image notify (any method — the CRUD handlers dispatch on it) ----
  { method: '*', family: '/v1/chats', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => {
      await handleChatRoutes(req, res, deps, userId, new URL(req.url!, 'http://placeholder'));
    }) },
  { method: '*', family: '/v1/folders', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => {
      await handleFolderRoutes(req, res, deps, userId, new URL(req.url!, 'http://placeholder'));
    }) },
  { method: 'POST', prefix: true, path: '/v1/locations/', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => {
      // endpoint.md §5.2: the Chat View's broken-background-image notify — user-scoped, clears the
      // stale URL so the next visit re-renders.
      await handleLocationImageBroken(req, res, deps, userId, new URL(req.url!, 'http://placeholder'));
    }) },

  // ---- Tools (handleToolInvoke authenticates itself, same as the old chain) ----
  { method: 'GET', path: '/v1/tools', run: async (req, res, deps) => withUser(req, res, deps, async () => {
      sendJson(res, 200, { names: deps.tools.definitions().map((def) => def.name) });
    }) },
  { method: 'POST', prefix: true, path: '/v1/tools/', run: async (req, res, deps) => {
      const toolName = decodeURIComponent(new URL(req.url!, 'http://placeholder').pathname.slice('/v1/tools/'.length));
      await handleToolInvoke(req, res, deps, toolName);
    } },

  // ---- Admin: credentials + connections ----
  { method: 'GET', path: '/v1/admin/credentials', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleAdminCredentialsList(res, deps); }) },
  { method: 'POST', path: '/v1/admin/credentials', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleAdminCredentialsSet(req, res, deps); }) },
  { method: '*', family: '/v1/admin/connections', run: async (req, res, deps) => withAdmin(req, res, deps, async () => {
      await handleAdminConnectionRoutes(req, res, deps, new URL(req.url!, 'http://placeholder'));
    }) },
  { method: '*', family: '/v1/admin/image-connections', run: async (req, res, deps) => withAdmin(req, res, deps, async () => {
      await handleAdminImageConnectionRoutes(req, res, deps, new URL(req.url!, 'http://placeholder'));
    }) },

  // ---- Admin: settings GET/POST pairs ----
  { method: 'GET', path: '/v1/admin/image-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleImageSettingsGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/image-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleImageSettingsSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/location-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleLocationSettingsGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/location-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleLocationSettingsSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/character-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleCharacterSettingsGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/character-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleCharacterSettingsSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/portrait-subject-describer-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handlePortraitSubjectDescriberSettingsGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/portrait-subject-describer-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handlePortraitSubjectDescriberSettingsSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/portrait-background-prompts', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handlePortraitBackgroundPromptsSettingsGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/portrait-background-prompts', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handlePortraitBackgroundPromptsSettingsSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/locations', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleLocationsGet(res, deps); }) },
  { method: 'GET', path: '/v1/admin/timezone', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleTimezoneGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/timezone', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleTimezoneSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/chat-background-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleChatBackgroundSettingsGet(req, res, deps); }) },
  { method: 'POST', path: '/v1/admin/chat-background-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleChatBackgroundSettingsSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/chat-legibility-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleChatLegibilitySettingsGet(req, res, deps); }) },
  { method: 'POST', path: '/v1/admin/chat-legibility-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleChatLegibilitySettingsSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/notification-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleNotificationSettingsGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/notification-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleNotificationSettingsSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/screen-lock-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleAdminScreenLockSettingsGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/screen-lock-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleAdminScreenLockSettingsSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/pia-proxy-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handlePiaProxyUrlGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/pia-proxy-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handlePiaProxyUrlSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/persona-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handlePersonaSettingsGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/persona-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handlePersonaSettingsSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/chat-memory-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleChatMemorySettingsGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/chat-memory-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleChatMemorySettingsSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/chat-memory-sync-status', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleChatMemorySyncStatusGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/chat-memory-resize', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleChatMemoryResizePost(res, deps); }) },
  { method: 'GET', path: '/v1/admin/chat-memory-resize-status', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleChatMemoryResizeStatusGet(res, deps); }) },
  { method: 'GET', path: '/v1/admin/location-render-status', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleLocationRenderStatusGet(res, deps); }) },
  { method: 'GET', path: '/v1/admin/canon-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleCanonSettingsGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/canon-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleCanonSettingsSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/cleanup-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleCleanupSettingsGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/cleanup-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleCleanupSettingsSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/lorebook-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleLorebookSettingsGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/lorebook-settings', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleLorebookSettingsSet(req, res, deps); }) },
  { method: '*', family: ['/v1/admin/lorebooks', '/v1/admin/lorebook-entries'], run: async (req, res, deps) => withAdmin(req, res, deps, async () => {
      await handleAdminLorebookRoutes(req, res, deps, new URL(req.url!, 'http://placeholder'));
    }) },
  // Stats page reads (llm-stats-page-plan.md): Usage & Cost over llm_calls and Timing over
  // turn_display_metrics. Both read across every user via db.withSystemScope, admin-gated like
  // every other /v1/admin/* route; `days` (default 30, clamped to 365) bounds the lookback.
  // Family (not exact-path) entries, the same convention as the lorebooks routes below: the
  // route matcher compares the raw req.url against an exact path, so a `?days=` query string
  // would 404 an exact-path entry — the family matcher's explicit `url.startsWith(f + '?')`
  // case is how every query-param endpoint in this table stays reachable.
  { method: 'GET', family: ['/v1/admin/llm-stats'], run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleLlmStatsGet(req, res, deps); }) },
  { method: 'GET', family: ['/v1/admin/turn-display-stats'], run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handleTurnDisplayStatsGet(req, res, deps); }) },

  // ---- Portrait Studio (docs/plans/completed/portrait-studio-plan.md) ----
  // User-scoped surfaces (visual_* tables are user_scoped RLS, migration 0105): entity CRUD,
  // wiki browse/edit, the generate/feedback actions. The layers write is the one admin-gated
  // route — visual_layer_stack is an orchestrator_settings write, and every settings write on
  // this server is admin-gated; the layers read stays user-gated so the tab renders for anyone.
  // The portrait-studio-standalone-subjects-plan.md from-cast-character route must be registered
  // BEFORE the '*' family route below (first-match-wins): the exact path would otherwise be
  // swallowed by the family entry's startsWith match. The family entry also owns any other
  // unexpected POST under /v1/portraits/entities (e.g. /v1/portraits/entities/<uuid>) — its
  // handler 404s those, the same outcome as before. The old /from-character path and the
  // set-as-avatar route are gone (the plan renames the former and deletes the latter).
  { method: 'POST', path: '/v1/portraits/entities/from-cast-character', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => {
      await handlePortraitEntityFromCastCharacter(req, res, deps, userId);
    }) },
  { method: '*', family: '/v1/portraits/entities', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => {
      await handlePortraitEntities(req, res, deps, userId, new URL(req.url!, 'http://placeholder'));
    }) },
  { method: '*', family: '/v1/portraits/wiki', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => {
      await handlePortraitWiki(req, res, deps, userId, new URL(req.url!, 'http://placeholder'));
    }) },
  { method: 'GET', path: '/v1/portraits/layers', run: async (req, res, deps) => withUser(req, res, deps, async () => { await handlePortraitLayersGet(res, deps); }) },
  { method: 'POST', path: '/v1/portraits/layers', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handlePortraitLayersSet(req, res, deps); }) },
  { method: 'POST', path: '/v1/portraits/generate', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => { await handlePortraitGenerate(req, res, deps, userId); }) },
  { method: 'POST', path: '/v1/portraits/preview', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => { await handlePortraitPreview(req, res, deps, userId); }) },
  { method: 'POST', path: '/v1/portraits/feedback', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => { await handlePortraitFeedback(req, res, deps, userId); }) },
  // portrait-studio-telemetry-plan.md — the durable per-round receipt. GET only, user-gated; the
  // handler parses /v1/portraits/rounds/:roundId/telemetry and runs its own ownership check
  // (visual_rounds is user-scoped) before touching the RLS-exempt llm_calls table.
  { method: 'GET', family: '/v1/portraits/rounds', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => {
      await handlePortraitRoundTelemetry(req, res, deps, userId, new URL(req.url!, 'http://placeholder'));
    }) },
  { method: 'POST', family: '/v1/portraits/episodes', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => {
      await handlePortraitEpisodeReflect(req, res, deps, userId, new URL(req.url!, 'http://placeholder'));
    }) },
  { method: 'GET', path: '/v1/portraits/history', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => { await handlePortraitHistory(res, deps, userId); }) },
  { method: 'GET', path: '/v1/portraits/lessons', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => { await handlePortraitLessons(res, deps, userId); }) },
  { method: 'POST', family: '/v1/portraits/candidates', run: async (req, res, deps) => withUser(req, res, deps, async (userId) => {
      await handlePortraitCandidateRetry(req, res, deps, userId, new URL(req.url!, 'http://placeholder'));
    }) },
  // portrait-chain-hardening-plan.md's kill switch — the read is registered at both a
  // household-gated public path (the frontend fetches it as a regular authenticated user right
  // after auth resolves, before anyone would have entered the separate admin key) and an
  // admin-gated path, with the admin write alongside, the same three-route shape as the
  // chat-background settings trio. Deliberately NOT gated by the flag itself: the Settings toggle
  // that flips it must stay reachable regardless of current value.
  { method: 'GET', path: '/v1/portraits-enabled', run: async (req, res, deps) => withUser(req, res, deps, async () => { await handlePortraitsEnabledGet(res, deps); }) },
  { method: 'GET', path: '/v1/admin/portraits-enabled', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handlePortraitsEnabledGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/portraits-enabled', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handlePortraitsEnabledSet(req, res, deps); }) },
  { method: 'GET', path: '/v1/admin/portrait-llm-connection', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handlePortraitLlmConnectionGet(res, deps); }) },
  { method: 'POST', path: '/v1/admin/portrait-llm-connection', run: async (req, res, deps) => withAdmin(req, res, deps, async () => { await handlePortraitLlmConnectionSet(req, res, deps); }) },
];

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  for (const route of routes) {
    if (routeMatches(req, route)) {
      await route.run(req, res, deps);
      return;
    }
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
