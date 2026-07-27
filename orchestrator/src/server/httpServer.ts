/**
 * @file orchestrator/src/server/httpServer.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — the orchestrator's HTTP surface
 * @description
 * The only "server" bigBrain exposes. Speaks just enough of the OpenAI Chat Completions shape
 * for a client like Open WebUI's "OpenAI API" connection type to treat bigBrain as a model
 * (Phase 4 decision: bigBrain drives, the chat UI only displays). Every request is authenticated
 * to a user_id via authenticate() — that resolved value, never anything the request body says, is
 * what gets passed to runTurn's userId, per bb_principles.md §4. authenticate() tries two paths:
 * a Cloudflare Access identity (io/accessIdentity.ts) first, since it's only ever present when a
 * request actually transited the Cloudflare-Access-gated bigbrain.your-domain.example hostname; then falls
 * back to a BIGBRAIN_API_KEYS bearer token (apiKeyStore.ts) — the only path Open WebUI's traffic
 * ever uses, since it reaches this container directly over traefik-net, never through that
 * hostname. GET /v1/whoami exposes this same resolution unauthenticated-by-default (no key
 * required) so the frontend SPA can silently probe whether Access already covers it.
 *
 * Streaming responses are not real token-level streaming: runTurn resolves the full reply
 * before this module has anything to send, so a stream:true request gets its answer as one SSE
 * chunk followed immediately by the terminator, not a token at a time. Good enough for a chat UI
 * to render correctly; true streaming would need runTurn itself to support it.
 *
 * Also serves a second, additive surface (openApiToolServer.ts): GET /v1/tools/openapi.json and
 * POST /v1/tools/:name let an external OpenAPI-aware caller (Open WebUI's "OpenAPI tool server"
 * connection type) invoke one registered tool directly, bypassing runTurn — the caller's own
 * model already decided which tool and with what arguments, so there's no reasoning left for
 * bigBrain to do. Same Bearer-key auth as /v1/chat/completions; same RLS scoping regardless of
 * which front door a call came through.
 *
 * GET / and GET /assets/* serve the built frontend/ SPA (Vite + React) — the tab bar (Chat /
 * Lists / Recipes / Meal Plans / Settings) that is bigbrain.your-domain.example's whole UI now. Static
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
 * chronologically after it — the shared primitive behind both "edit" (truncate the edited user
 * message, then POST /v1/chat/completions again with new content, ending up one message longer
 * than what's now persisted) and "rerun" (truncate the assistant reply being regenerated, then
 * resend the exact same, now-shorter history). handleChatCompletions tells those two resends
 * apart from a genuinely new turn purely by length — messages.length > priorMessageCount means a
 * new user message needs inserting; equal length means it's already accounted for, so only the
 * new assistant reply gets appended (otherwise a rerun would duplicate the user's message).
 *
 * handleChatCompletions also always prepends a current-date/time system message
 * (util/dateContext.ts, using the household_timezone admin setting) ahead of a chat's own custom
 * system prompt, for every turn regardless of chat_id — an LLM has no reliable sense of "today"
 * on its own, and date-taking tools (recipes plugin's add_meal_plan_entry/get_meal_plan) need it.
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
 * Same admin gate, same restart-on-save shape, for GET/POST /v1/admin/settings — the Settings
 * tab's connection picker, backing orchestrator_settings (io/orchestratorSettings.ts). Unlike
 * credentials, the GET response includes the actual current value (a profile/model name isn't a
 * secret) alongside every selectable profile name from BIGBRAIN_LLM_PROFILES, so the picker can
 * render a dropdown with the active one pre-selected. GET /v1/admin/settings/models?profile=NAME
 * (same gate) lists the model catalog for any one configured profile — even one that isn't
 * currently active — by building a throwaway provider for it (adminServer.ts's
 * listModelsForProfile), so the model dropdown can be populated before an admin commits to a
 * switch.
 *
 * Same admin gate, but no restart, for GET/POST /v1/admin/timezone — the household_timezone
 * setting behind the date-context line above. It's read fresh per chat turn rather than baked
 * into anything at boot, so a POST here just writes the value and responds 200 immediately.
 *
 * Same admin gate, same no-restart shape, for GET/POST /v1/admin/recipe-settings — the household's
 * default recipe scale (plugins/recipes/src/scaleRecipeTool.ts reads it live on every scale_recipe
 * call that omits an explicit target_servings).
 *
 * Same admin gate, same restart-on-save shape as credentials/settings, for GET/POST
 * /v1/admin/calendar-settings and GET/POST /v1/admin/notion-settings (docs/bb_principles.md
 * §13 — non-secret runtime config belongs in the database, not .env). Each is read once at boot
 * (plugins/calendar's ICS poll; io/notion.ts's client construction), so a live update with no
 * restart would silently do nothing until the next one anyway — unlike timezone.
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
 * @contract
 *   assertions:
 *     purity:          impure (opens a listening socket)
 *     state_ownership: [the http.Server instance it creates]
 *     external_io:     [inbound HTTP]
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { generateChatTitle } from '../io/llm/generateChatTitle.js';
import { createLlmProviderForProfile, type LlmProfile } from '../io/llm/index.js';
import { log } from '../io/logger.js';
import { runTurn } from '../orchestrator/loop.js';
import { appendAttachmentsToLatestUserMessage, attachImagesToLatestUserMessage } from '../util/attachmentContext.js';
import { formatCurrentDateContext } from '../util/dateContext.js';
import { extractAttachmentUpload } from './handleUploadAttachment.js';
import type { AccessIdentityResolver } from '../io/accessIdentity.js';
import type { ChatParams, ChatSessionStore } from '../io/chatSessions.js';
import type { LlmMessage, LlmProvider } from '../io/llm/types.js';
import type { PostgresClient } from '../io/postgres.js';
import type { ProviderCredentialStore } from '../io/providerCredentials.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { filterToolRegistry, type ToolRegistry } from '../orchestrator/toolRegistry.js';
import type { ApiKeyStore } from './apiKeyStore.js';
import {
  buildGoogleAuthUrl,
  completeGoogleCalendarOauth,
  consumeGoogleOauthState,
  getActiveProfileSetting,
  getCalendarSettings,
  getDefaultRecipeServings,
  getGoogleCalendarSettings,
  getHouseholdTimezone,
  getNotionSettings,
  listCredentials,
  listModelsForProfile,
  mintGoogleOauthState,
  parseSetActiveProfileBody,
  parseSetCalendarSettingsBody,
  parseSetCredentialBody,
  parseSetDefaultRecipeServingsBody,
  parseSetGoogleCalendarSettingsBody,
  parseSetNotionSettingsBody,
  parseSetTimezoneBody,
  setActiveProfile,
  setCalendarSettings,
  setCredential,
  setDefaultRecipeServings,
  setGoogleCalendarSettings,
  setHouseholdTimezone,
  setNotionSettings,
} from './adminServer.js';
import { buildOpenApiSpec, invokeTool } from './openApiToolServer.js';
import {
  buildChatCompletion,
  buildChatCompletionChunk,
  buildModelsList,
  isChatCompletionRequestBody,
} from './openai.js';

export interface HttpServerDeps {
  llm: LlmProvider;
  db: PostgresClient;
  tools: ToolRegistry;
  apiKeys: ApiKeyStore;
  accessIdentity: AccessIdentityResolver;
  chats: ChatSessionStore;
  adminApiKey: string;
  credentials: ProviderCredentialStore;
  settings: OrchestratorSettingsStore;
  /** Every profile defined in BIGBRAIN_LLM_PROFILES, apiKey-resolved — the selectable set for the
   *  Settings tab's connection picker (GET/POST /v1/admin/settings) and the source of each
   *  connection's model catalog (GET /v1/admin/settings/models). */
  llmProfiles: Record<string, LlmProfile>;
  modelName: string;
  port: number;
  /** Where this server is externally reachable from — used only to fill in the OpenAPI spec's
   *  `servers` entry (openApiToolServer.ts). Defaults to http://localhost:<port> when unset,
   *  which is fine for local verification but wrong for a real deployment behind Docker/Traefik —
   *  set this to the real reachable URL there (see .env.example). */
  publicBaseUrl?: string;
  /** Defaults to a real process.exit(0) — restart: unless-stopped relaunches the container, which
   *  reads the newly-saved credential at boot. Overridable so tests can prove a POST reached this
   *  point without actually killing the test process. */
  triggerRestart?: () => void;
}

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

// Uncapped until Stage 5 (images/vision) — a chat-completions body carrying several base64-encoded
// images is the first realistic way this could balloon; everything else here is chat text, which
// never approached a size worth guarding against. Generous enough for MAX_IMAGES_PER_TURN images
// at openai.ts's own MAX_IMAGE_BYTES ceiling, plus normal chat text/attachments Markdown.
const MAX_JSON_BODY_BYTES = 40 * 1024 * 1024;

class JsonBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`request body exceeded ${maxBytes} bytes`);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += (chunk as Buffer).length;
    if (totalBytes > MAX_JSON_BODY_BYTES) throw new JsonBodyTooLargeError(MAX_JSON_BODY_BYTES);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function authenticate(
  req: IncomingMessage,
  apiKeys: ApiKeyStore,
  accessIdentity: AccessIdentityResolver,
): Promise<string | undefined> {
  const accessJwt = req.headers['cf-access-jwt-assertion'];
  if (typeof accessJwt === 'string') {
    const userId = await accessIdentity.userIdForAccessJwt(accessJwt);
    if (userId) return userId;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return apiKeys.userIdForKey(header.slice('Bearer '.length));
}

// Any household member who already cleared Cloudflare Access to reach this hostname at all is
// trusted for admin actions too — Access is the real gate; a second static secret behind it was
// redundant friction for a single-household deployment. The static BIGBRAIN_ADMIN_API_KEY check
// remains as the only path in for deployments with no Access configured (accessIdentity is then a
// no-op resolver, see io/accessIdentity.ts) and for any non-browser/API automation.
//
// A plain === on the key would leak timing information about how many leading bytes of the
// presented key matched the real one — this key alone can rotate every other credential in the
// system, worth the extra care even though apiKeyStore.ts's per-household-member check doesn't
// bother.
async function isAdminAuthorized(
  req: IncomingMessage,
  adminApiKey: string,
  accessIdentity: AccessIdentityResolver,
): Promise<boolean> {
  const accessJwt = req.headers['cf-access-jwt-assertion'];
  if (typeof accessJwt === 'string') {
    const userId = await accessIdentity.userIdForAccessJwt(accessJwt);
    if (userId) return true;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(adminApiKey);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Where the built frontend/ SPA lands at Docker build time (Dockerfile: npm run build
// --workspace=@bigbrain/frontend), resolved the same way index.ts resolves pluginsDir.
const FRONTEND_DIST_DIR = new URL('../../../frontend/dist', import.meta.url).pathname;

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStaticFile(res: ServerResponse, filePath: string): Promise<void> {
  try {
    const content = await readFile(filePath);
    const contentType = STATIC_CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': contentType, 'content-length': content.length });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  const { llm, db, tools, apiKeys, accessIdentity, chats, modelName } = deps;

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
    if (detail.session.toolNames !== null) {
      sessionTools = filterToolRegistry(tools, detail.session.toolNames);
    }
  }

  // A chat's own profile override (a per-chat connection picker, distinct from the household-wide
  // one in Settings) swaps in a throwaway provider for that one named connection, built fresh per
  // turn the same way the Settings tab's model-catalog preview already does (server/adminServer.ts's
  // listModelsForProfile) — cheap, since every provider here is a stateless fetch wrapper
  // (io/llm/anthropic.ts, io/llm/openaiCompatible.ts). Unlike the household setting, this needs no
  // restart to take effect. An unknown profile name (stale override, a profile since removed from
  // BIGBRAIN_LLM_PROFILES) falls back to the household's active connection rather than failing the
  // whole turn, logging why per bb_principles.md §11.
  let turnLlm = llm;
  let turnDefaultModel = modelName;
  if (sessionParams.profile) {
    const profile = deps.llmProfiles[sessionParams.profile];
    if (profile) {
      turnLlm = createLlmProviderForProfile(profile);
      turnDefaultModel = profile.model;
    } else {
      log.error(
        `chat_id ${body.chat_id} names unknown profile "${sessionParams.profile}" (not in BIGBRAIN_LLM_PROFILES) — falling back to the active connection`,
      );
    }
  }

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
  const systemPrompt = [formatCurrentDateContext(timezone), sessionParams.system].filter(Boolean).join('\n\n');
  let reply: string;
  let focusedNoteId: string | null | undefined;
  try {
    ({ content: reply, focusedNoteId } = await runTurn({
      userId,
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
    }));
  } catch (err) {
    // Surfaced to the client rather than falling through to startHttpServer's generic top-level
    // catch (bare "internal error") — a provider quirk (truncated tool-call JSON, a malformed
    // upstream response) should be diagnosable from the chat itself, not just the server log.
    log.error(`runTurn failed for user ${userId}`, err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const echoedModel = model ?? turnDefaultModel;

  if (body.chat_id) {
    const latestUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    // A "rerun"/"edit" resend first truncates the chat back to some earlier point (DELETE/POST
    // .../truncate below), then resends a messages array that's already fully accounted for in
    // what's persisted (rerun: identical to what's left after truncating; edit: the truncated
    // history plus one new user message). Only a genuinely new turn's client array is longer than
    // what was already stored — that's the one case needing a new user-message row here; a
    // same-length resend means the "latest user message" already exists, and inserting it again
    // would duplicate it.
    const isNewTurn = messages.length > priorMessageCount;
    await chats.appendMessages(userId, body.chat_id, [
      ...(latestUserMessage && isNewTurn ? [{ role: 'user' as const, content: latestUserMessage.content }] : []),
      { role: 'assistant' as const, content: reply },
    ]);
    // First exchange in a still-untitled session names it, once — bigBrain never retitles a
    // chat again after this. Reuses the same llm/provider the turn itself just used (this is a
    // single tiny forced-schema call, not worth a separate cheap-model concept); a truncated
    // fallback keeps a naming hiccup from being visible as a broken turn.
    if (sessionWasEmpty && sessionTitle === 'New chat' && latestUserMessage) {
      let title: string;
      try {
        title = await generateChatTitle(turnLlm, latestUserMessage.content, reply);
      } catch (err) {
        log.error('generateChatTitle failed, falling back to a truncated title', err);
        title = latestUserMessage.content.slice(0, 60);
      }
      await chats.updateChat(userId, body.chat_id, { title });
    }
    // Canvas: only when this turn actually touched a note (a tool's own focusHint said so) —
    // omitted entirely otherwise, so an unrelated turn never clears/overwrites the chat's
    // existing canvas focus (updateChat's dynamic patch treats "not present" as "leave alone").
    if (focusedNoteId !== undefined) {
      await chats.updateChat(userId, body.chat_id, { canvasNoteId: focusedNoteId });
    }
  }

  if (body.stream) {
    const id = `chatcmpl-${randomUUID()}`;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(
      `data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, id, { role: 'assistant', content: reply }, null))}\n\n`,
    );
    res.write(`data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, id, {}, 'stop'))}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  sendJson(res, 200, buildChatCompletion(echoedModel, reply));
}

async function handleOpenApiSpec(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const baseUrl = `${deps.publicBaseUrl ?? `http://localhost:${deps.port}`}/v1/tools`;
  sendJson(res, 200, buildOpenApiSpec(deps.tools.definitions(), baseUrl));
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

  const { status, body } = await invokeTool(deps.db, deps.tools, userId, toolName, args);
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

async function handleAdminCredentialsList(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const credentials = await listCredentials(deps.credentials);
  sendJson(res, 200, { credentials });
}

async function handleAdminCredentialsSet(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetCredentialBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { name: one of the known credential names, value: non-empty string }' });
    return;
  }

  await setCredential(deps.credentials, parsed.name, parsed.value);

  const payload = JSON.stringify({ status: 'restarting' });
  res.writeHead(202, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload, () => {
    const restart = deps.triggerRestart ?? (() => process.exit(0));
    setTimeout(restart, 100);
  });
}

async function handleAdminSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const setting = await getActiveProfileSetting(
    deps.settings,
    deps.llmProfiles,
    process.env.BIGBRAIN_LLM_ACTIVE_PROFILE ?? '',
  );
  sendJson(res, 200, setting);
}

async function handleAdminSettingsModels(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  const profileName = new URL(req.url ?? '', 'http://placeholder').searchParams.get('profile');
  if (!profileName) {
    sendJson(res, 400, { error: 'expected a ?profile=<name> query parameter' });
    return;
  }

  let result;
  try {
    result = await listModelsForProfile(deps.llmProfiles, profileName);
  } catch (err) {
    log.error(`failed to list models for connection "${profileName}"`, err);
    sendJson(res, 502, { error: 'failed to reach this connection to list its models' });
    return;
  }
  if (!result) {
    sendJson(res, 404, { error: `unknown profile "${profileName}"` });
    return;
  }

  sendJson(res, 200, result);
}

async function handleAdminSettingsSet(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const profileNames = Object.keys(deps.llmProfiles);
  const parsed = parseSetActiveProfileBody(raw, profileNames);
  if (!parsed) {
    sendJson(res, 400, { error: `expected { value: one of ${profileNames.join(', ')}, model?: string }` });
    return;
  }

  await setActiveProfile(deps.settings, parsed);

  const payload = JSON.stringify({ status: 'restarting' });
  res.writeHead(202, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload, () => {
    const restart = deps.triggerRestart ?? (() => process.exit(0));
    setTimeout(restart, 100);
  });
}

async function handleTimezoneGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const timezone = await getHouseholdTimezone(deps.settings);
  sendJson(res, 200, { timezone });
}

async function handleTimezoneSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const value = parseSetTimezoneBody(raw);
  if (!value) {
    sendJson(res, 400, { error: 'expected { value: a valid IANA timezone name, e.g. "America/New_York" }' });
    return;
  }

  await setHouseholdTimezone(deps.settings, value);
  // No restart needed — the very next chat turn reads it live (handleChatCompletions).
  sendJson(res, 200, { timezone: value });
}

async function handleRecipeSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const defaultServings = await getDefaultRecipeServings(deps.settings);
  sendJson(res, 200, { defaultServings });
}

async function handleRecipeSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const value = parseSetDefaultRecipeServingsBody(raw);
  if (value === undefined) {
    sendJson(res, 400, { error: 'expected { value: a positive number }' });
    return;
  }

  await setDefaultRecipeServings(deps.settings, value);
  // No restart needed — the next scale_recipe call reads it live.
  sendJson(res, 200, { defaultServings: value });
}

async function handleCalendarSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getCalendarSettings(deps.settings));
}

async function handleCalendarSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetCalendarSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { owner_user_id?: non-empty string, mask_work_calendar?: boolean }, at least one' });
    return;
  }

  await setCalendarSettings(deps.settings, parsed);

  const payload = JSON.stringify({ status: 'restarting' });
  res.writeHead(202, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload, () => {
    const restart = deps.triggerRestart ?? (() => process.exit(0));
    setTimeout(restart, 100);
  });
}

async function handleNotionSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getNotionSettings(deps.settings));
}

async function handleNotionSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetNotionSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { owner_user_id?: non-empty string, lists_data_source_id?: non-empty string }, at least one' });
    return;
  }

  await setNotionSettings(deps.settings, parsed);

  const payload = JSON.stringify({ status: 'restarting' });
  res.writeHead(202, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload, () => {
    const restart = deps.triggerRestart ?? (() => process.exit(0));
    setTimeout(restart, 100);
  });
}

async function handleGoogleCalendarSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getGoogleCalendarSettings(deps.settings));
}

async function handleGoogleCalendarSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetGoogleCalendarSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, {
      error: 'expected { client_id?: non-empty string, owner_user_id?: non-empty string, calendar_id?: non-empty string }, at least one',
    });
    return;
  }

  await setGoogleCalendarSettings(deps.settings, parsed);

  const payload = JSON.stringify({ status: 'restarting' });
  res.writeHead(202, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload, () => {
    const restart = deps.triggerRestart ?? (() => process.exit(0));
    setTimeout(restart, 100);
  });
}

function googleCalendarRedirectUri(deps: HttpServerDeps): string {
  return `${deps.publicBaseUrl ?? `http://localhost:${deps.port}`}/v1/admin/google-calendar/callback`;
}

async function handleGoogleCalendarAuthUrl(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const { clientId } = await getGoogleCalendarSettings(deps.settings);
  if (!clientId) {
    sendJson(res, 400, { error: 'google_calendar_client_id is not configured yet — set it in Settings first' });
    return;
  }
  const state = mintGoogleOauthState();
  sendJson(res, 200, { url: buildGoogleAuthUrl(clientId, googleCalendarRedirectUri(deps), state) });
}

// Deliberately not gated by isAdminAuthorized, unlike every other /v1/admin/* route — see the
// preamble and the call site in handleRequest for why this is still safe.
async function handleGoogleCalendarCallback(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const url = new URL(req.url ?? '', 'http://placeholder');
  const code = url.searchParams.get('code') ?? undefined;
  const state = url.searchParams.get('state') ?? undefined;

  if (!consumeGoogleOauthState(state)) {
    sendJson(res, 400, { error: 'missing or expired oauth state — restart the connection flow from Settings' });
    return;
  }
  if (!code) {
    res.writeHead(302, { location: '/?google_calendar=denied' });
    res.end();
    return;
  }

  try {
    await completeGoogleCalendarOauth(deps.credentials, deps.settings, code, googleCalendarRedirectUri(deps));
  } catch (err) {
    log.error('Google Calendar OAuth exchange failed', err);
    res.writeHead(302, { location: '/?google_calendar=error' });
    res.end();
    return;
  }

  res.writeHead(302, { location: '/?google_calendar=connected' });
  // The refresh token was just written to provider_credentials — same restart-on-save shape as
  // any other credential rotation (index.ts only ever reads it at boot).
  res.end(() => {
    const restart = deps.triggerRestart ?? (() => process.exit(0));
    setTimeout(restart, 100);
  });
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

function isChatPatchBody(value: unknown): value is {
  title?: string;
  folder_id?: string | null;
  params?: ChatParams;
  tool_names?: string[] | null;
  canvas_note_id?: string | null;
} {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.title !== undefined && typeof v.title !== 'string') return false;
  if (v.folder_id !== undefined && v.folder_id !== null && typeof v.folder_id !== 'string') return false;
  if (v.params !== undefined && (typeof v.params !== 'object' || v.params === null)) return false;
  if (
    v.tool_names !== undefined &&
    v.tool_names !== null &&
    !(Array.isArray(v.tool_names) && v.tool_names.every((t) => typeof t === 'string'))
  ) {
    return false;
  }
  if (v.canvas_note_id !== undefined && v.canvas_note_id !== null && typeof v.canvas_note_id !== 'string') {
    return false;
  }
  return true;
}

async function handleChatRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  userId: string,
  url: URL,
): Promise<void> {
  // '' -> [] (list/create); '/<id>' -> ['<id>']; '/<id>/messages/<msgId>[/truncate]' -> [...].
  // Split-on-'/' rather than the old naive rest.slice(1) (which took everything past the first
  // slash verbatim, so a nested message path would've been misread as one giant, never-matching
  // chatId) — needed once routes could nest below a chat id at all.
  const segments = url.pathname.slice('/v1/chats'.length).split('/').filter(Boolean);

  if (segments.length === 0) {
    if (req.method === 'GET') {
      const search = url.searchParams.get('search') ?? undefined;
      const folderId = url.searchParams.get('folder_id') ?? undefined;
      sendJson(res, 200, { chats: await deps.chats.listChats(userId, { search, folderId }) });
      return;
    }
    if (req.method === 'POST') {
      const body = (await readJsonBody(req)) as { title?: string; folder_id?: string };
      const session = await deps.chats.createChat(userId, {
        title: typeof body.title === 'string' ? body.title : undefined,
        folderId: typeof body.folder_id === 'string' ? body.folder_id : undefined,
      });
      sendJson(res, 201, session);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const chatId = decodeURIComponent(segments[0]!);

  if (segments.length === 1) {
    if (req.method === 'GET') {
      const detail = await deps.chats.getChat(userId, chatId);
      if (!detail) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!isChatPatchBody(body)) {
        sendJson(res, 400, { error: 'expected { title?, folder_id?, params?, tool_names?, canvas_note_id? }' });
        return;
      }
      const updated = await deps.chats.updateChat(userId, chatId, {
        title: body.title,
        folderId: body.folder_id,
        params: body.params,
        toolNames: body.tool_names,
        canvasNoteId: body.canvas_note_id,
      });
      if (!updated) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, updated);
      return;
    }
    if (req.method === 'DELETE') {
      const deleted = await deps.chats.deleteChat(userId, chatId);
      sendJson(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: 'not found' });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (segments[1] === 'messages' && segments.length >= 3) {
    const messageId = decodeURIComponent(segments[2]!);

    if (segments.length === 3 && req.method === 'DELETE') {
      const deleted = await deps.chats.deleteMessage(userId, chatId, messageId);
      sendJson(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: 'not found' });
      return;
    }
    if (segments.length === 4 && segments[3] === 'truncate' && req.method === 'POST') {
      const truncated = await deps.chats.truncateMessagesFrom(userId, chatId, messageId);
      sendJson(res, truncated ? 200 : 404, truncated ? { truncated: true } : { error: 'not found' });
      return;
    }
  }

  sendJson(res, 404, { error: 'not found' });
}

async function handleFolderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  userId: string,
  url: URL,
): Promise<void> {
  const rest = url.pathname.slice('/v1/folders'.length); // '' | '/<id>'

  if (rest === '' || rest === '/') {
    if (req.method === 'GET') {
      sendJson(res, 200, { folders: await deps.chats.listFolders(userId) });
      return;
    }
    if (req.method === 'POST') {
      const body = (await readJsonBody(req)) as { name?: string; parent_id?: string };
      if (typeof body.name !== 'string' || !body.name.trim()) {
        sendJson(res, 400, { error: 'expected { name: non-empty string, parent_id? }' });
        return;
      }
      const folder = await deps.chats.createFolder(userId, {
        name: body.name.trim(),
        parentId: typeof body.parent_id === 'string' ? body.parent_id : undefined,
      });
      sendJson(res, 201, folder);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const folderId = decodeURIComponent(rest.slice(1));
  if (req.method === 'POST') {
    const body = (await readJsonBody(req)) as { name?: string; parent_id?: string | null };
    const updated = await deps.chats.updateFolder(userId, folderId, {
      name: typeof body.name === 'string' ? body.name : undefined,
      parentId: body.parent_id !== undefined ? body.parent_id : undefined,
    });
    if (!updated) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, updated);
    return;
  }
  if (req.method === 'DELETE') {
    const deleted = await deps.chats.deleteFolder(userId, folderId);
    sendJson(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: 'not found' });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

async function handleWhoAmI(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'not authenticated' });
    return;
  }
  sendJson(res, 200, { userId });
}

// household_timezone isn't a secret (bb_principles.md §12) and every household member already
// receives it indirectly on every chat turn via formatCurrentDateContext's system message — this
// just gives the frontend itself (CalendarView/TodayAgenda, computing "today" client-side) the
// same value directly, gated the same way as /v1/chats rather than requiring the admin key.
async function handleHouseholdTimezoneGet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  sendJson(res, 200, { timezone: await getHouseholdTimezone(deps.settings) });
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
  if (req.method === 'GET' && req.url === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
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
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    await handleChatCompletions(req, res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/attachments/extract') {
    await handleUploadAttachment(req, res, deps);
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
  if (req.method === 'GET' && req.url === '/v1/tools/openapi.json') {
    await handleOpenApiSpec(res, deps);
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
  if (req.method === 'GET' && req.url === '/v1/admin/settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleAdminSettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleAdminSettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/v1/admin/settings/models')) {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleAdminSettingsModels(req, res, deps);
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
  if (req.method === 'GET' && req.url === '/v1/admin/recipe-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleRecipeSettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/recipe-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleRecipeSettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/calendar-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleCalendarSettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/calendar-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleCalendarSettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/notion-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleNotionSettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/notion-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleNotionSettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/google-calendar-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleGoogleCalendarSettingsGet(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/google-calendar-settings') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleGoogleCalendarSettingsSet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/google-calendar/auth-url') {
    if (!(await isAdminAuthorized(req, deps.adminApiKey, deps.accessIdentity))) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleGoogleCalendarAuthUrl(res, deps);
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/v1/admin/google-calendar/callback')) {
    // Deliberately not gated by isAdminAuthorized (docs/spec.md §6.7): Google's redirect is a
    // plain browser GET with no way to attach a bearer token or Access header of its own. Instead
    // it's protected by the single-use `state` nonce minted only for an already-admin-authorized
    // auth-url request above — this route can only ever complete a flow this server itself
    // started, it can't accept an arbitrary inbound payload the way a real webhook would.
    await handleGoogleCalendarCallback(req, res, deps);
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
