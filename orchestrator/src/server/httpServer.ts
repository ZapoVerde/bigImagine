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

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { generateChatTitle } from '../io/llm/generateChatTitle.js';
import { runWithCallContext } from '../io/llm/callContext.js';
import type { LlmConnectionStore } from '../io/llmConnections.js';
import type { ImageConnectionStore } from '../io/imageConnections.js';
import { log } from '../io/logger.js';
import { recordPromptTrace, type PromptTraceEntry } from '../io/promptTrace.js';
import { runTurn } from '../orchestrator/loop.js';
import { runStreamingRpTurn } from '../orchestrator/streamingTurn.js';
import { abortTurn, isAbortError } from '../orchestrator/turnAbort.js';
import { writeLorebookActivationLog } from '../io/lorebook/writeLorebookActivationLog.js';
import { parseStoryHeader, scrapeTurnPresence } from '../orchestrator/locationAndPresenceScraper.js';
import { ensureFirstTurnHeader } from '../orchestrator/ensureFirstTurnHeader.js';
import { appendAttachmentsToLatestUserMessage, attachImagesToLatestUserMessage } from '../util/attachmentContext.js';
import { formatCurrentDateContext } from '../util/dateContext.js';
import { importCharacterCard } from './handleCharacterImport.js';
import { handleCharacterExportRoutes } from './handleCharacterExport.js';
import { extractAttachmentUpload } from './handleUploadAttachment.js';
import { handleChubCardDetail } from './handleChubCardDetail.js';
import type { AccessIdentityResolver } from '../io/accessIdentity.js';
import type { ChatParams, ChatSessionStore } from '../io/chatSessions.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import type { LlmMessage, LlmProvider } from '../io/llm/types.js';
import type { PostgresClient } from '../io/postgres.js';
import type { ProviderCredentialStore } from '../io/providerCredentials.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { createToolRegistry, filterToolRegistry, type ToolRegistry } from '../orchestrator/toolRegistry.js';
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
  JsonBodyTooLargeError,
  readJsonBody,
  sendJson,
  serveStaticFile,
  writeStreamErrorTerminalFrame,
  writeStreamHeaders,
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
import {
  buildChatCompletion,
  buildChatCompletionChunk,
  buildModelsList,
  isChatCompletionRequestBody,
} from './openai.js';
import { assembleSessionTurnContext } from './promptAssembly.js';
import { toPreviewItem, type PromptPreviewItem } from './promptPreview.js';
import { fireLocationImageGeneration, handleLocationImageBroken } from './locationImages.js';
import { resolveTurnLlm } from './turnExecution.js';

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

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

// Uncapped until Stage 5 (images/vision) — a chat-completions body carrying several base64-encoded
// images is the first realistic way this could balloon; everything else here is chat text, which
// never approached a size worth guarding against. Generous enough for MAX_IMAGES_PER_TURN images
// at openai.ts's own MAX_IMAGE_BYTES ceiling, plus normal chat text/attachments Markdown.


async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  const { db, settings, tools, apiKeys, accessIdentity, chats } = deps;

  const userId = await authenticate(req, apiKeys, accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof JsonBodyTooLargeError) {
      sendJson(res, 413, { error: `request body exceeds the ${Math.floor(err.maxBytes / (1024 * 1024))}MB limit` });
      return;
    }
    throw err;
  }
  if (!isChatCompletionRequestBody(body)) {
    sendJson(res, 400, { error: 'expected { messages: [{role, content}, ...] }' });
    return;
  }

  // The location resolved by Stage 2's scraper (segway.md §4.2) — captured here so endpoint.md
  // §5's decoupled image-generation trigger can fire after the reply is sent (see the SSE and
  // sendJson tails of this handler).
  let scrapedLocationId: string | undefined;

  const messages: LlmMessage[] = body.messages
    .filter((m) => ALLOWED_ROLES.has(m.role))
    .map((m) => ({ role: m.role as LlmMessage['role'], content: m.content }));

  // Attached files (already turned into Markdown by POST /v1/attachments/extract) are appended
  // only to the copy of history sent to the model this one turn — never persisted. Everything
  // below that reads from `messages` (chat storage, the auto-generated title) deliberately keeps
  // using the original, un-spliced array; only the runTurn call below gets messagesForLlm. Images
  // (if any) are spliced in further down, only after confirming the resolved connection actually
  // supports vision — see the explicit-failure gate below.
  let messagesForLlm = body.attachments?.length
    ? appendAttachmentsToLatestUserMessage(messages, body.attachments)
    : messages;

  // Persisted-session path (bigBrain's own frontend): chat_id ties this turn to a chat_sessions
  // row — its params/tool allow-list apply and the exchange is stored after the turn resolves.
  // No chat_id (Open WebUI's traffic) keeps the original fully stateless behavior.
  let sessionParams: ChatParams = {};
  let sessionTools = tools;
  let sessionWasEmpty = false;
  let sessionTitle: string | undefined;
  let priorMessageCount = 0;
  let sessionKind: 'chat' | 'rp' = 'chat';
  // Which character (if any) this chat is linked to (applyCharacterToChatTool.ts) — only read
  // here for docs/plans/prompt-macros.md's {{char}} macro (see the interpolateMacros call below);
  // everything else about the turn is indifferent to it.
  let sessionCharacterId: string | null = null;
  // Which context_stack_presets row (if any) drives this turn's per-turn narrator assembly
  // (docs/plans/turn-loop-plan.md §3.2). The legacy post-runTurn cleanup pass is gone — cleanup is now
  // the async heuristic subloop (cleanupLoop.ts), opted in per chat via cleanup_enabled_at.
  let sessionPromptStackPresetId: string | null = null;
  // The already-persisted latest user message's id (rerun/edit-resend case, where there's no new
  // user turn to insert) — carried forward so point-in-time canon recall still has an anchor to
  // use even when this turn doesn't add a fresh chat_messages row of its own.
  let existingLatestUserMessageId: string | undefined;
  if (body.chat_id) {
    const detail = await chats.getChat(userId, body.chat_id);
    if (!detail) {
      sendJson(res, 404, { error: 'unknown chat_id' });
      return;
    }
    sessionParams = detail.session.params;
    sessionWasEmpty = detail.messages.length === 0;
    sessionTitle = detail.session.title;
    priorMessageCount = detail.messages.length;
    sessionKind = detail.session.kind;
    sessionCharacterId = detail.session.characterId;
    sessionPromptStackPresetId = detail.session.promptStackPresetId;
    existingLatestUserMessageId = [...detail.messages].reverse().find((m) => m.role === 'user')?.messageId;
    if (detail.session.toolNames !== null) {
      sessionTools = filterToolRegistry(tools, detail.session.toolNames);
    }
  }
  // The RP lane runs with NO tools at all (2026-08-10 user direction) — the model just executes
  // its prompt stack (the Comfy 2 preset) and can never emit a tool call, character creation
  // included. Overrides any stored tool_names value (the legacy recall pair, or null = all).
  // Auto-recall still injects into the stack server-side; it never needed a model tool call.
  if (sessionKind === 'rp') sessionTools = createToolRegistry([]);

  const { turnLlm, turnDefaultModel, turnPrice } = await resolveTurnLlm(deps, sessionParams, body.chat_id);

  // The one deterministic gate bb_principles.md §2/§11 requires for images: fail the whole turn
  // visibly, before runTurn/llm.complete is ever called, rather than silently dropping the image
  // or letting a non-vision model claim to have seen it. Checked against whichever connection this
  // turn actually resolved to (a per-chat override or the household-wide active one), not just the
  // active one — supportsVision travels with the profile (io/llm/profiles.ts), not the pick.
  if (body.images?.length) {
    if (!turnLlm.supportsVision) {
      const connectionLabel = sessionParams.profile ? `the "${sessionParams.profile}" connection` : 'the active connection';
      sendJson(res, 422, {
        error: `${connectionLabel} doesn't support image input — enable vision support for it in Settings, or switch connections`,
      });
      return;
    }
    messagesForLlm = attachImagesToLatestUserMessage(messagesForLlm, body.images);
  }

  // A client's own model picker (Open WebUI's dropdown, populated from GET /v1/models) sends
  // its selection here — that's what actually takes effect, not the fixed modelName below.
  // turnDefaultModel only remains as the label echoed back when the request didn't specify one.
  const model = body.model ?? sessionParams.model;
  // Unconditional, on every turn — a model has no reliable sense of "today" on its own, and
  // date-taking tools (add_meal_plan_entry, get_meal_plan, ...) need it regardless of whether
  // this chat has its own custom system prompt, or even a chat_id at all (Open WebUI's stateless
  // traffic gets it too). household_timezone is read live, not cached at boot, so changing it in
  // Settings takes effect on the very next turn, no restart.
  const timezone = await getHouseholdTimezone(deps.settings);

  // docs/plans/prompt-macros.md's Stage 1: resolved fresh every turn (not baked at apply_prompt_stack_
  // to_chat time) specifically so a persona/character-card edit takes effect on the very next
  // message with no re-apply needed — bi_principles.md §13's live-read, no-restart guarantee
  // applied to {{user}}/{{char}}/{{persona}} the same way it already applies to every other
  // Settings-backed value. Gated to 'rp' chats (a household 'chat'-kind session could legitimately
  // contain literal `{{...}}`-looking text, e.g. discussing templating syntax, that has no
  // business being rewritten) and to a cheap .includes('{{') check, so the common case — an RP
  // chat whose system prompt has no macros in it — pays for none of the extra reads below.
  // docs/chat-memory.md: only the persisted-session path (bigBrain's own frontend, which the
  // rolling-sync pipeline actually maintains derived state for) gets server-side history trimming
  // and memory injection — a stateless caller (Open WebUI) gets exactly what it sent, unchanged,
  // same as before this feature existed.
  let systemPrompt: string;
  // The assistant message this turn will persist is pre-generated before prompt assembly so
  // the lorebook gate can seed its deterministic per-turn probability roll from the message
  // being generated (docs/lorebook-plan.md §4) — never Math.random, so a retry or re-assembly
  // reproduces the same bytes and the byte-prefix cache survives. Only set for persisted turns
  // (body.chat_id); threaded to appendMessages below so the activation-log row's message_id
  // matches the seed exactly.
  let assistantMessageId: string | undefined;
  let lorebookActivatedEntryIds: string[] = [];
  if (body.chat_id) {
    assistantMessageId = randomUUID();
    const assembled = await assembleSessionTurnContext(
      db,
      deps.settings,
      deps.embeddings,
      userId,
      body.chat_id,
      sessionKind,
      sessionCharacterId,
      sessionPromptStackPresetId,
      sessionParams,
      messagesForLlm,
      timezone,
      assistantMessageId,
    );
    systemPrompt = assembled.systemPrompt;
    messagesForLlm = assembled.messagesForLlm;
    lorebookActivatedEntryIds = assembled.lorebookActivatedEntryIds;
  } else {
    systemPrompt = [formatCurrentDateContext(timezone), sessionParams.system].filter(Boolean).join('\n\n');
  }

  // Point-in-time canon recall's anchor (db/migrations/0053_canon_facts_chat_anchor.sql) needs the
  // triggering user message's id available to mid-turn tool calls, not just to the post-turn
  // appendMessages below — so a genuinely new turn's user message is persisted here, before
  // runTurn runs, rather than only after. A rerun/edit-resend has no new user message to insert
  // (see isNewTurn's own comment below); it anchors to the existing one instead.
  const latestUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  const isNewTurn = messages.length > priorMessageCount;
  let anchorMessageId: string | undefined = existingLatestUserMessageId;
  if (body.chat_id && latestUserMessage && isNewTurn) {
    const [inserted] = await chats.appendMessages(userId, body.chat_id, [{ role: 'user', content: latestUserMessage.content }]);
    anchorMessageId = inserted?.messageId;
  }

  // The Prompt Inspector's "Main Prompt" is the exact text this turn sends, captured at send time
  // (io/promptTrace.ts) — record-before-the-call, same rule the cleanup subloop's repair prompts
  // follow (cleanupLoop.ts's dispatchStep). runTurn prepends systemPrompt to messagesForLlm; that
  // final array is what the model sees, so that's what the trace records. This is what lets the
  // inspector show "the last turn that was sent" (bi_principles.md §18) instead of a live
  // reconstruction of the next one.
  // Persisted chats only — no chat_id is stateless Open WebUI traffic with nothing to trace
  // against. Images ride on LlmMessage.images (util/attachmentContext.ts), never in content, so
  // this never embeds base64 blobs into the trace.
  // The entry stays live after recordPromptTrace so usage/price can be attached once the turn
  // resolves — the same "absent until the call returns, absent forever if it failed" contract
  // as reply. Undefined while stateless (no chat_id): nothing to trace, nothing to attach.
  let mainTraceEntry: PromptTraceEntry | undefined;
  if (body.chat_id) {
    mainTraceEntry = {
      kind: 'main',
      title: 'Main Prompt',
      items: [
        ...(systemPrompt ? [toPreviewItem('system', systemPrompt)] : []),
        ...messagesForLlm.map((m) => toPreviewItem(m.role as PromptPreviewItem['role'], m.content)),
      ],
      capturedAt: Date.now(),
    };
    recordPromptTrace(body.chat_id, mainTraceEntry);
  }

  let reply: string;
  let focusedNoteId: string | null | undefined;
  // Real token-level streaming for the RP lane (docs/plans/rp-streaming-plan.md): when an RP chat
  // asks for stream: true, the turn runs through runStreamingRpTurn instead of runTurn and every
  // delta is relayed to the client as it arrives. The chat-kind lane (tool-calling turns, Open
  // WebUI) is untouched and keeps the buffered runTurn path byte-for-byte.
  const streamingRp = sessionKind === 'rp' && body.stream === true;
  // Echoed back in every SSE chunk's model field (the OpenAI-compatible framing). Declared here,
  // before the streaming branch, because its onDelta closure reads it during the turn.
  const echoedModel = model ?? turnDefaultModel;
  // First LLM turn of a new RP chat (≤1 pre-turn message: empty chat, a seeded greeting only, or
  // a user message left by a failed first attempt): the reply's scene header may be repaired by
  // ensureFirstTurnHeader (below) after the LLM resolves but before persistence. Declared here,
  // before the streaming branch, because its onDelta closure reads it during the turn — turn 1 is
  // deliberately NOT streamed live (rp-streaming-plan.md Edge Cases), so the client never sees
  // raw pre-repair text that wouldn't match what actually gets saved.
  const firstLlmTurn = sessionKind === 'rp' && priorMessageCount <= 1;
  // SSE headers are deliberately deferred until the first delta (plan Contracts: "no headers sent
  // yet, respond with 499/500 as today") — so a zero-delta failure still surfaces as a normal
  // HTTP status instead of a committed-200 terminal frame.
  let streamHeadersSent = false;
  const sseId = `chatcmpl-${randomUUID()}`;
  const taskId = body.chat_id ?? randomUUID();
  // A dropped client connection cancels the in-flight LLM call (plan Edge Cases) instead of
  // burning tokens on a stream nobody is reading — fires the same abort path as the explicit
  // Stop button. Detached when the streaming branch ends (every outcome) so a close event that
  // fires after this turn finished can't abort the next turn registered under the same chat_id.
  const onClientClose = () => {
    if (streamingRp) abortTurn(taskId);
  };
  req.on('close', onClientClose);

  if (streamingRp) {
    try {
      const turnResult = await runStreamingRpTurn({
        userId,
        taskId,
        messages: messagesForLlm,
        systemPrompt,
        model,
        sampling: {
          temperature: sessionParams.temperature,
          topP: sessionParams.top_p,
          maxTokens: sessionParams.max_tokens,
        },
        llm: turnLlm,
        db,
        onDelta: (delta) => {
          // Turn 1 is deliberately NOT streamed live (plan Edge Cases): ensureFirstTurnHeader may
          // rewrite the reply after the stream resolves, so relaying raw pre-repair text would show
          // the client something that doesn't match what gets saved. The core still accumulates
          // it; the header-repaired text is sent as a single chunk once persistence completes.
          if (firstLlmTurn) return;
          if (!streamHeadersSent) {
            writeStreamHeaders(res);
            streamHeadersSent = true;
          }
          res.write(`data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, sseId, { role: 'assistant', content: delta }, null))}\n\n`);
        },
      });
      reply = turnResult.content;
      if (mainTraceEntry) {
        mainTraceEntry.usage = turnResult.usage;
        mainTraceEntry.price = turnPrice;
      }
    } catch (err) {
      if (!streamHeadersSent) {
        // Nothing has been streamed yet — today's exact behavior, no SSE at all (plan Contracts).
        if (isAbortError(err)) {
          log.info(`runStreamingRpTurn aborted for user ${userId}`, { chatId: body.chat_id ?? 'stateless' });
          req.off('close', onClientClose);
          sendJson(res, 499, { error: 'turn aborted' });
          return;
        }
        log.error(`runStreamingRpTurn failed for user ${userId}`, err);
        req.off('close', onClientClose);
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      // Streaming had already begun: headers are committed, so the failure/abort surfaces as the
      // terminal frame before [DONE] instead of an HTTP status change (plan Contracts). Nothing
      // is persisted — the client that sees this frame knows the turn didn't complete.
      log.error(`runStreamingRpTurn failed for user ${userId} after streaming began`, err);
      writeStreamErrorTerminalFrame(res, isAbortError(err), err instanceof Error ? err.message : String(err));
      req.off('close', onClientClose);
      return;
    }
  } else {
    try {
      const turnResult = await runTurn({
        userId,
        // A stateless request (no chat_id — Open WebUI's traffic, or any caller not using bigBrain's
        // own persisted-session frontend) still needs a task id for bb_principles.md §14: a fresh
        // one per turn is fine there, since kind stays 'chat' (never capped, only metered) and
        // nothing needs it to be stable across calls the way an agent_routine's job_id must be.
        taskId,
        messages: messagesForLlm,
        systemPrompt,
        model,
        sampling: {
          temperature: sessionParams.temperature,
          topP: sessionParams.top_p,
          maxTokens: sessionParams.max_tokens,
        },
        llm: turnLlm,
        db,
        tools: sessionTools,
        anchorMessageId,
        embeddings: deps.embeddings,
      });
      reply = turnResult.content;
      focusedNoteId = turnResult.focusedNoteId;
      if (mainTraceEntry) {
        mainTraceEntry.usage = turnResult.usage;
        mainTraceEntry.price = turnPrice;
      }
    } catch (err) {
      // Surfaced to the client rather than falling through to startHttpServer's generic top-level
      // catch (bare "internal error") — a provider quirk (truncated tool-call JSON, a malformed
      // upstream response) should be diagnosable from the chat itself, not just the server log.
      if (isAbortError(err)) {
        // The user hit Stop (POST /v1/chat/abort). Not an error: the upstream call was cancelled,
        // nothing was appended, and the frontend treats 499 as the expected "turn stopped" outcome.
        log.info(`runTurn aborted for user ${userId}`, { chatId: body.chat_id ?? 'stateless' });
        sendJson(res, 499, { error: 'turn aborted' });
        return;
      }
      log.error(`runTurn failed for user ${userId}`, err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  if (body.chat_id) {    // Repair the scene header synchronously when the raw reply lacks one, so the scrape below has
    // a header to resolve a location from and the bg pass fires on turn 1 — the async cleanup
    // subloop would otherwise add the header only after this reply was already persisted and
    // scraped, and nothing re-scrapes (see orchestrator/ensureFirstTurnHeader.ts). One small LLM
    // call, first turn only, fail-open: a failed repair stores and sends the raw reply,
    // byte-identical to before.
    if (firstLlmTurn && reply) {
      reply = await ensureFirstTurnHeader(
        { settings: deps.settings },
        turnLlm,
        userId,
        body.chat_id,
        reply,
        messagesForLlm,
      );
    }
    // The user message (if this was a genuinely new turn) is already persisted above, before
    // runTurn ran — only the assistant reply is appended here now. Stage 2 (segway.md §4) then
    // scrapes the turn's header block into trusted scene state, anchored to the new message's
    // active swipe — fail-open inside the scraper, so it can never block or degrade the turn.
    const [assistantMessage] = await chats.appendMessages(userId, body.chat_id, [{ role: 'assistant', content: reply, messageId: assistantMessageId }]);
    // docs/lorebook-plan.md §3e/§4 — the activation log is written after the turn completes
    // ("write after, not during"): one row per entry this turn injected, the source sticky/
    // cooldown resolve from next turn. writeLorebookActivationLog fails open inside itself, so a
    // log hiccup can never fail a turn that already succeeded. Deliberately NOT wired into the
    // swipe-regenerate path — regenerating a message re-rolls the gate with the same message id
    // (same seed), and the message's original rows stay the audit trail for that message.
    if (lorebookActivatedEntryIds.length > 0 && assistantMessageId) {
      await deps.db.withUserScope(userId, (session) =>
        writeLorebookActivationLog(session, userId, body.chat_id!, assistantMessageId, lorebookActivatedEntryIds),
      );
    }
    if (assistantMessage) {
      // 'extend': a genuinely new turn — a location change advances previous_scene_id
      // (endpoint.md §5.1.8's last-turn location state), so the background can revert to the
      // location that was showing before this turn while the new render is pending.
      // location.md §4.2's header-good gate: only scrape when the reply's header parses — a bad
      // header is left to the cleanup subloop, which repairs it and then fires the deferred
      // scrape on the repaired text (cleanupLoop.ts's onLocationScraped hook). This is the same
      // race ensureFirstTurnHeader.ts already closes for turn 1, generalized to every turn.
      scrapedLocationId = parseStoryHeader(reply)
        ? await scrapeTurnPresence(
            { db, settings, ensureActiveSwipe: (u, c, m) => chats.ensureActiveSwipe(u, c, m) },
            userId,
            body.chat_id,
            assistantMessage.messageId,
            reply,
            'extend',
          )
        : undefined;
    }
    // First exchange in a still-untitled session names it, once — bigBrain never retitles a
    // chat again after this. Reuses the same llm/provider the turn itself just used (this is a
    // single tiny forced-schema call, not worth a separate cheap-model concept); a truncated
    // fallback keeps a naming hiccup from being visible as a broken turn.
    // Deliberately *not* awaited: naming the chat is background polish, and the reply the user
    // is waiting on has no business sitting behind a second LLM round-trip. The call runs
    // decoupled — the same shape as fireLocationImageGeneration and chatMemorySync.ts's tick —
    // and the title lands in the DB whenever it lands; the client picks it up on its next chat
    // refresh (ChatView's refreshActiveMessages re-reads the session). A naming failure still
    // falls back to the truncated title, and a failed persist is logged, never surfaced.
    if (sessionWasEmpty && sessionTitle === 'New chat' && latestUserMessage) {
      // Const captures for the background task — TypeScript doesn't preserve let/narrowed
      // variable types inside closures, and these are read after this function has returned.
      const chatId = body.chat_id;
      const userMessageText = latestUserMessage.content;
      void (async () => {
        let title: string;
        try {
          title = await runWithCallContext({ taskId: chatId, kind: 'system', userId }, () =>
            generateChatTitle(turnLlm, userMessageText, reply),
          );
        } catch (err) {
          log.error('generateChatTitle failed, falling back to a truncated title', err);
          title = userMessageText.slice(0, 60);
        }
        await chats.updateChat(userId, chatId, { title }).catch((err) =>
          log.error(`failed to persist chat title for ${chatId}`, err),
        );
      })();
    }
    // Canvas: only when this turn actually touched a note (a tool's own focusHint said so) —
    // omitted entirely otherwise, so an unrelated turn never clears/overwrites the chat's
    // existing canvas focus (updateChat's dynamic patch treats "not present" as "leave alone").
    if (focusedNoteId !== undefined) {
      await chats.updateChat(userId, body.chat_id, { canvasNoteId: focusedNoteId });
    }
  }

  if (streamingRp) {
    // The stream has resolved and persistence above completed. The final SSE frames are written
    // only now, after persistence succeeds — so a client that sees [DONE] can trust the message is
    // already saved, the same guarantee the non-streaming path gives via its single response
    // (rp-streaming-plan.md Logic). Turn 1 (buffered by onDelta above) gets its one whole-reply
    // chunk here, post header-repair.
    if (!streamHeadersSent) writeStreamHeaders(res);
    if (firstLlmTurn) {
      res.write(
        `data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, sseId, { role: 'assistant', content: reply }, null))}\n\n`,
      );
    }
    res.write(`data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, sseId, {}, 'stop'))}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    req.off('close', onClientClose);
    if (scrapedLocationId) {
      // endpoint.md §5: fire the location-image generation pass only once the reply is actually
      // sent — never awaited inline (a provider round-trip has no place blocking the reply).
      // turnLlm is the connection this very turn ran on — the describer uses it too (the same
      // "the room's description is written by the story's own voice" default VLZ uses).
      res.once('finish', () => fireLocationImageGeneration(deps, userId, body.chat_id, scrapedLocationId!, turnLlm));
    }
    return;
  }

  if (body.stream) {
    const id = `chatcmpl-${randomUUID()}`;
    writeStreamHeaders(res);
    res.write(
      `data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, id, { role: 'assistant', content: reply }, null))}\n\n`,
    );
    res.write(`data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, id, {}, 'stop'))}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    if (scrapedLocationId) {
      // endpoint.md §5: fire the location-image generation pass only once the reply is actually
      // sent — never awaited inline (a provider round-trip has no place blocking the reply).
      // turnLlm is the connection this very turn ran on — the describer uses it too (the same
      // "the room's description is written by the story's own voice" default VLZ uses).
      res.once('finish', () => fireLocationImageGeneration(deps, userId, body.chat_id, scrapedLocationId!, turnLlm));
    }
    return;
  }

  sendJson(res, 200, buildChatCompletion(echoedModel, reply));
  if (scrapedLocationId) {
    // endpoint.md §5: same decoupled trigger as the streaming branch — the reply is sent, the
    // image pass starts in the background like chatMemorySync.ts's tick. Same turnLlm threading
    // as the streaming branch above.
    res.once('finish', () => fireLocationImageGeneration(deps, userId, body.chat_id, scrapedLocationId!, turnLlm));
  }
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
