/**
 * @file orchestrator/src/server/httpServer.ts
 * @stamp 2026-08-10
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

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { generateChatTitle } from '../io/llm/generateChatTitle.js';
import { createLlmProviderForProfile } from '../io/llm/index.js';
import { runWithCallContext } from '../io/llm/callContext.js';
import type { LlmConnectionStore } from '../io/llmConnections.js';
import type { ImageConnectionStore } from '../io/imageConnections.js';
import { generateLocationImage } from '../orchestrator/generateLocationImage.js';
import { describeLocationIfNeeded } from '../orchestrator/describeLocation.js';
import { createGatedLlmProvider } from '../io/llm/llmGate.js';
import { log } from '../io/logger.js';
import { getPromptTrace, clearPromptTrace, recordPromptTrace, type PromptTraceEntry } from '../io/promptTrace.js';
import { longestCommonPrefixLength } from '../util/commonPrefix.js';
import { computeSectionStability, type SectionStabilityResult } from '../util/sectionStability.js';
import { recordClientLogBatch, type ClientLogEntry } from '../io/clientLogSink.js';
import { runTurn } from '../orchestrator/loop.js';
import { runStreamingRpTurn } from '../orchestrator/streamingTurn.js';
import { getTurnStatus } from '../orchestrator/turnStatus.js';
import { abortTurn, isAbortError } from '../orchestrator/turnAbort.js';
import { getCleanupJobs, getCleanupStatus, runCleanupNow } from '../orchestrator/cleanupLoop.js';
import { archiveChatMemory, DEFAULT_LIVE_WINDOW_PAIRS, DEFAULT_SYNC_EVERY_PAIRS } from '../orchestrator/chatMemorySync.js';
import { buildAutoRecallParts, formatAutoRecallBlock, buildAutoRecallQuery, AUTO_RECALL_PAIRS } from '../io/chatMemory/recallForPrompt.js';
import { resolveLorebook } from '../orchestrator/resolveLorebook.js';
import { writeLorebookActivationLog } from '../io/lorebook/writeLorebookActivationLog.js';
import {
  getLorebookPanelData,
  quickAddLorebookEntry,
  setLorebookChatOverride,
  setLorebookEntryOverride,
} from '../io/lorebook/panelData.js';
import {
  renderBridge,
  renderPlotThreads,
  renderAutoRecall,
  renderFusedMemoryBlock,
  formatRecentHistoryTurns,
  renderRecentHistory,
  type RpMemoryContext,
} from '../io/chatMemory/memoryInjection.js';
import { loadLocationBlock, parseStoryHeader, scrapeTurnPresence } from '../orchestrator/locationAndPresenceScraper.js';
import { ensureFirstTurnHeader } from '../orchestrator/ensureFirstTurnHeader.js';
import { appendAttachmentsToLatestUserMessage, attachImagesToLatestUserMessage } from '../util/attachmentContext.js';
import { formatCurrentDateContext } from '../util/dateContext.js';
import { interpolateMacros, type MacroSnapshot } from '../util/interpolateMacros.js';
import { groupTagsForRendered, wrapSlotContent, type MarkerKey, type PromptStackFields, type PromptStackSlot } from '../util/assemblePromptStack.js';
import { importCharacterCard } from './handleCharacterImport.js';
import { handleCharacterExportRoutes } from './handleCharacterExport.js';
import { extractAttachmentUpload } from './handleUploadAttachment.js';
import { handleChubCardDetail } from './handleChubCardDetail.js';
import { fetchThroughPiaProxy } from '../io/piaProxyFetch.js';
import type { AccessIdentityResolver } from '../io/accessIdentity.js';
import type { ChatDetail, ChatParams, ChatSessionRow, ChatSessionStore, StoredChatMessage } from '../io/chatSessions.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import type { LlmMessage, LlmProvider, LlmUsage } from '../io/llm/types.js';
import type { PostgresClient } from '../io/postgres.js';
import type { ProviderCredentialStore } from '../io/providerCredentials.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { createToolRegistry, filterToolRegistry, type ToolRegistry } from '../orchestrator/toolRegistry.js';
import type { ApiKeyStore } from './apiKeyStore.js';
import {
  createLorebookAdmin,
  createLorebookEntryAdmin,
  deleteLorebookAdmin,
  exportLorebookWorldInfo,
  importLorebookWorldInfo,
  deleteLorebookEntryAdmin,
  getCanonSettings,
  getChatMemorySettings,
  getChatMemorySyncStatus,
  getChatBackgroundSettings,
  getChatLegibilitySettings,
  getCleanupSettings,
  getHouseholdTimezone,
  getImageSettings,
  getLocationRenderStatus,
  getLocationsAdmin,
  getLocationSettings,
  getLorebookSettings,
  getLorebooksAdmin,
  getNotificationSettings,
  getPersonaSettings,
  getPiaProxyUrl,
  getScreenLockSettings,
  listCredentials,
  listModelsForConnection,
  listProvidersForConnection,
  parseCreateConnectionBody,
  parseCreateImageConnectionBody,
  parseSetCanonSettingsBody,
  parseSetChatMemorySettingsBody,
  parseSetChatBackgroundSettingsBody,
  parseSetChatLegibilitySettingsBody,
  parseSetCleanupSettingsBody,
  parseSetCredentialBody,
  parseSetImageSettingsBody,
  parseSetLocationSettingsBody,
  parseSetLorebookSettingsBody,
  parseSetNotificationSettingsBody,
  parseSetPersonaSettingsBody,
  parseSetPiaProxyUrlBody,
  parseSetScreenLockSettingsBody,
  parseSetTimezoneBody,
  parseUpdateConnectionBody,
  parseUpdateImageConnectionBody,
  setCanonSettings,
  setChatMemorySettings,
  setChatBackgroundSettings,
  setChatLegibilitySettings,
  setCleanupSettings,
  setCredential,
  setHouseholdTimezone,
  setImageSettings,
  setLocationSettings,
  setLorebookSettings,
  setNotificationSettings,
  setPersonaSettings,
  setPiaProxyUrl,
  setScreenLockSettings,
  testConnection,
  testImageConnection,
  updateLorebookAdmin,
  updateLorebookEntryAdmin,
} from './adminServer.js';
import type { LorebookEntryInput, LorebookEntryPatch } from './adminServer.js';
import { invokeTool } from './toolInvoke.js';
import {
  buildChatCompletion,
  buildChatCompletionChunk,
  buildModelsList,
  isChatCompletionRequestBody,
} from './openai.js';

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

// The SSE response headers both streaming routes (handleChatCompletions's RP branch and the
// swipe route's needs_regenerate stream) write — same framing the existing non-RP fake-stream
// branch has always used, so any OpenAI-compatible client parses both identically.
function writeStreamHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

// The SSE abort/error terminal frame (docs/plans/rp-streaming-plan.md Contracts) — one extra
// data: line before [DONE], usable only once streaming has begun (headers committed, so an HTTP
// status code is no longer an option). Emitted identically by both streaming routes. A success
// completion never emits this: it keeps today's stop-finish chunk + [DONE], so an OpenAI-
// compatible client that has never heard of bigimagine_error simply never sees it.
function writeStreamErrorTerminalFrame(res: ServerResponse, aborted: boolean, message: string): void {
  res.write(
    `data: ${JSON.stringify({ bigimagine_error: true, aborted, message })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
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
  '.png': 'image/png',
};

// GET /v1/chats/:id/prompt-preview (buildPromptPreview, below the turn-context assembly this
// mirrors): one labeled, ordered item per piece of the exact prompt an 'rp' chat's next turn would
// send — bi_principles.md §11/§18, letting a household member audit or hand-tune what the model
// actually sees instead of only ever seeing the reply it produced from it.
export interface PromptPreviewItem {
  /** Raw marker vocabulary key (assemblePromptStack.ts's MarkerKey) when this item came from a
   *  preset's marker slot — undefined for a custom slot, a date-context line, or a conversation
   *  message. The frontend maps this to a friendly name; the orchestrator has no business owning
   *  display copy. */
  markerKey?: string;
  /** A custom slot's own cosmetic label (migration 0060), when set. */
  label?: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  chars: number;
  /** ~4 chars/token, the same provider-agnostic heuristic truncateForContext.ts already documents
   *  and uses — bi_principles.md §6 rules out a real per-provider tokenizer at this seam. */
  estimatedTokens: number;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

// One captured group per prompt kind, the most recent capture of each (the trace keeps several
// turns' worth; the inspector shows the latest per kind — cleanup re-fires every turn, and only
// the last one is the useful one to audit). Map keeps first-seen order with last value winning,
// which is exactly "first-seen order, latest content".
function latestPerKind<T extends { kind: string }>(entries: T[]): T[] {
  const byKind = new Map<string, T>();
  for (const entry of entries) byKind.set(entry.kind, entry);
  return [...byKind.values()];
}

function toPreviewItem(
  role: PromptPreviewItem['role'],
  content: string,
  extra?: { markerKey?: string; label?: string },
): PromptPreviewItem {
  return {
    markerKey: extra?.markerKey,
    label: extra?.label,
    role,
    content,
    chars: content.length,
    estimatedTokens: estimateTokens(content.length),
  };
}

// docs/chat-memory.md: the always-injected half of chat memory (small, unconditional — see
// recallChatHistoryTool.ts's own doc for why full-turn recall stays an explicit tool call instead,
// and recallForPrompt.ts for the CNZ-shaped auto-recall this module now also runs — the user
// chose CNZ parity for the RP read path: silent per-turn retrieval on top of the still-enabled
// tools). The two chat kinds diverge completely here, mirroring chatMemorySync.ts's own kind branch:
//
// A 'chat' (household) chat gets household_memory (every user's own row — RLS already scopes it)
// plus chat_memory_entries' flat key-ideas digest, byte-for-byte the original behavior, returned
// as a plain string.
//
// An 'rp' chat gets no household_memory at all (docs/bi_principles.md §4/§16,
// db/migrations/0049_chat_kind.sql — in-fiction details have no business leaking into unrelated
// chats, or vice versa) and instead gets the hookseeker-parity bridge's own output: the evolving
// SCENE and EVENTS chat_memory_entries rows (topic_key 'scene'/'events', written by
// bridgeChatMemory.ts) plus the latest-approved-per-arc_tag 'plot' canon_facts — the same
// dedup-to-most-recent-per-arc query recallCanonFactsTool.ts uses, just unranked (this is the
// unconditional "what's the state of every open thread" injection, not a semantic top-k search) —
// plus buildAutoRecallParts's CNZ-style auto-recall: the last AUTO_RECALL_PAIRS turn-pairs
// embedded as the query, returning this chat's archived full turns and approved canon facts,
// injected unconditionally (fail-open — empty parts on error or no match).
//
// The rp branch returns the *structured* RpMemoryContext (scene/events/plotThreads/chunks/facts
// plus the fused legacy string), not a formatted block — the narrator stack renders each
// component through its own user-editable template (io/chatMemory/memoryInjection.ts, the
// 2026-08-13 user direction), so bridge/plot_threads/auto_recall can be ordered independently in
// a preset, while `fused` keeps the deprecated memory_recall alias and the no-preset fallback
// byte-identical to the pre-split output.
async function buildChatMemorySystemPrompt(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  embeddings: EmbeddingProvider,
  userId: string,
  chatId: string,
  kind: 'chat' | 'rp',
  messages: LlmMessage[],
): Promise<string | RpMemoryContext> {
  return db.withUserScope(userId, async (session) => {
    if (kind === 'rp') {
      // docs/chat-memory.md: the always-injected half (scene/events/plot threads) plus the
      // CNZ-shaped auto-recall (io/chatMemory/recallForPrompt.ts) — the last AUTO_RECALL_PAIRS
      // turn-pairs become the query, and both the chat's archived full turns and its approved
      // canon facts are retrieved unconditionally. Fail-open: empty parts when nothing matched or
      // retrieval errored, so memory can never break a turn. Returned as raw parts — the narrator
      // stack renders them through the per-component templates (io/chatMemory/memoryInjection.ts).
      const [bridgeRows, plotRows, autoRecall] = await Promise.all([
        session.query<{ topic_key: string; content: string }>(
          `select topic_key, content from chat_memory_entries where chat_id = $1 and topic_key in ('scene', 'events')`,
          [chatId],
        ),
        session.query<{ arc_tag: string; summary: string; detail: string }>(
          `select distinct on (arc_tag) arc_tag, summary, detail
           from canon_facts
           where chat_id = $1 and category = 'plot' and status = 'approved'
           order by arc_tag, proposed_at desc`,
          [chatId],
        ),
        buildAutoRecallParts(session, settings, embeddings, userId, chatId, messages),
      ]);
      const scene = bridgeRows.find((r) => r.topic_key === 'scene')?.content;
      const events = bridgeRows.find((r) => r.topic_key === 'events')?.content;
      const plotThreads = plotRows.map((r) => ({ arc_tag: r.arc_tag, summary: r.summary, detail: r.detail }));
      const fused = renderFusedMemoryBlock(scene, events, plotThreads, formatAutoRecallBlock(autoRecall.chunks, autoRecall.facts));
      return { scene, events, plotThreads, chunks: autoRecall.chunks, facts: autoRecall.facts, fused };
    }

    const [household, entries] = await Promise.all([
      session.query<{ content: string }>(
        'select content from household_memory where user_id = $1 order by updated_at desc',
        [userId],
      ),
      session.query<{ content: string }>(
        'select content from chat_memory_entries where chat_id = $1 order by updated_at',
        [chatId],
      ),
    ]);
    const parts: string[] = [];
    if (household.length) {
      parts.push(`What you remember about this household:\n${household.map((r) => `- ${r.content}`).join('\n')}`);
    }
    if (entries.length) {
      parts.push(
        `Key ideas from earlier in this conversation (no longer in view — call recall_chat_history for exact wording):\n${entries
          .map((r) => `- ${r.content}`)
          .join('\n')}`,
      );
    }
    return parts.join('\n\n');
  });
}

// docs/plans/prompt-macros.md's Stage 1 — the turn-scoped snapshot (docs §2) both the system-prompt and
// the message-history resolution passes share, built fresh per turn so a persona/card edit takes
// effect on the very next turn with no re-apply (bi_principles.md §13's live-read guarantee).
// Character fields (name/persona/scenario) are read live rather than trusted from whatever
// apply_prompt_stack_to_chat baked in at Apply time, same reasoning as household persona settings
// below. Callers gate on their text actually containing '{{' so this never runs for a macro-free
// turn — a wasted round-trip here is a real one (two reads per turn).
async function buildMacroSnapshot(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  userId: string,
  characterId: string | null,
): Promise<MacroSnapshot> {
  const [character, persona] = await Promise.all([
    characterId
      ? db.withUserScope(userId, (session) =>
          session.query<{ name: string; persona: string; scenario: string }>(
            'select name, persona, scenario from characters where character_id = $1 and user_id = $2',
            [characterId, userId],
          ),
        )
      : Promise.resolve([]),
    getPersonaSettings(settings),
  ]);
  const characterRow = character[0];
  return {
    charName: characterRow?.name,
    userName: persona.name || undefined,
    persona: persona.description ? (persona.name ? `${persona.name}: ${persona.description}` : persona.description) : persona.name || undefined,
    description: characterRow?.persona || undefined,
    scenario: characterRow?.scenario || undefined,
  };
}

// docs/plans/prompt-macros.md's Stage 1 — only called when the caller already knows systemText contains
// at least one `{{`, so it always substitutes for real, never a wasted pass. The snapshot is
// built by the caller (buildMacroSnapshot) so a turn that also resolves message history reuses
// one frozen snapshot for both (docs §2's "resolved once, at the top of the turn").
async function resolveMacrosInSystemPrompt(systemText: string, snapshot: MacroSnapshot): Promise<string> {
  return interpolateMacros(systemText, snapshot);
}

interface SlotDbRow {
  slot_type: string;
  marker_key: string | null;
  enabled: boolean;
  custom_role: string | null;
  custom_content: string | null;
  label: string | null;
  tag_enabled: boolean;
  group_name: string | null;
}

// PromptStackSlot already carries the cosmetic label column (migration 0060) and the tag toggle
// (migration 0085) — assembly needs both, so there is no separate "with label" type anymore; the
// prompt inspector below (buildNarratorStackItems) uses the same fields to label a slot the way
// PromptStacksView's own slotLabel() does.

interface NarratorCharacterFieldsRow {
  name: string;
  system_prompt: string;
  persona: string;
  scenario: string;
  example_dialogue: string;
}

// Shared by both per-turn narrator assembly and the cleanup pass below — the same
// context_stack_slots read applyPromptStackToChatTool.ts does, just usable from core without
// crossing the plugin/core dependency line (assemblePromptStack itself already lives in core,
// util/assemblePromptStack.ts, moved here 2026-08-06 for exactly this reason).
async function loadPromptStackSlots(db: PostgresClient, userId: string, presetId: string): Promise<PromptStackSlot[]> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<SlotDbRow>(
      `select slot_type, marker_key, enabled, custom_role, custom_content, label, tag_enabled, group_name
       from context_stack_slots where preset_id = $1 order by position`,
      [presetId],
    ),
  );
  return rows.map((row) => ({
    slotType: row.slot_type as 'marker' | 'custom',
    markerKey: row.marker_key ?? undefined,
    enabled: row.enabled,
    customRole: (row.custom_role as 'system' | 'user' | 'assistant' | null) ?? undefined,
    customContent: row.custom_content ?? undefined,
    label: row.label ?? undefined,
    tagEnabled: row.tag_enabled,
    groupName: row.group_name ?? undefined,
  }));
}

// docs/plans/turn-loop-plan.md §3.2: the per-turn replacement for apply_prompt_stack_to_chat's
// bake-once-at-Apply behavior. Same two-phase pattern that tool already uses (assemblePromptStack
// then interpolateMacros) — re-run fresh every turn instead of frozen into params.system. The RP
// memory split (2026-08-13 user direction): buildChatMemorySystemPrompt now returns structured
// parts (scene/events/plotThreads/chunks/facts) and each of the three component markers is
// rendered from its own user-editable template (io/chatMemory/memoryInjection.ts, CNZ-style
// {{var}}/{{#if}} interpolation) into a field the preset's own slot ordering places — so a preset
// can order `bridge`, `plot_threads` and `auto_recall` independently. The deprecated `memory_recall`
// alias still emits the fused legacy block (context.fused) for presets that haven't migrated,
// byte-identical to the pre-split behavior.
//
// canon_facts is deliberately left unset here even when a preset enables that slot:
// recall_canon_facts (plugins/canonize/src/recallCanonFactsTool.ts) scopes by scene_id via
// scene_presence/scenes.active_location_id. chat_sessions.scene_id now exists (migration 0067)
// and is kept stamped by the post-cleanup scraper (orchestrator/locationAndPresenceScraper.ts),
// so the cheap "this chat's current scene" read segway.md §2.2 promised is available here — and
// the location-tracker (docs/plans/vistalyze_integration/location.md §5.4) now uses it: the
// 'location' marker slot is populated every turn via loadLocationBlock (the known-locations
// <locations> block, eligibility-filtered + current-parent scoped), so a preset carrying that
// marker emits it verbatim in its own slot order. The tool stays live for the model to call
// mid-turn when it does have a scene_id.
// docs/bi_principles.md §18 ("every prompt is surfaced for manual tuning"): one labeled item per
// enabled, non-empty slot, in preset order — the same population assemblePromptStack itself would
// emit, just not yet collapsed into one joined string. Both assembleNarratorSystemText (the real
// per-turn call) and buildPromptPreview (the read-only inspector below) call this, so a preview
// can never drift from what a turn actually sends — there is exactly one place this assembly runs.
//
// recentHistoryMessages (the turn's trimmed live-window messages, or undefined for callers that
// don't have them) feeds the recent_history marker when that slot is enabled — the 2026-08-10 user
// direction: the active context (last sent turn + active turns) renders INSIDE the stack, wrapped
// by the preset's own HTML tags, and is NOT also appended as messages. The rendering is
// deterministic (formatRecentHistoryTurns, bi_principles §17) so an unchanged window produces
// identical bytes and the byte-prefix cache survives; the volatile block sits wherever the preset
// placed the slot, which is the author's cache-management control.
async function buildNarratorStackItems(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  embeddings: EmbeddingProvider,
  userId: string,
  chatId: string,
  characterId: string | null,
  presetId: string,
  memoryContext: RpMemoryContext,
  recentHistoryMessages?: LlmMessage[],
  lorebookSeedMessageId?: string,
): Promise<{ items: PromptPreviewItem[]; lorebookActivatedEntryIds: string[] }> {
  const [slots, characterRows, persona, bridgeTemplate, plotTemplate, autoRecallTemplate, chunkTemplate, recentHistoryTemplate, locationBlock, lorebookBlock] = await Promise.all([
    loadPromptStackSlots(db, userId, presetId),
    characterId
      ? db.withUserScope(userId, (session) =>
          session.query<NarratorCharacterFieldsRow>(
            'select name, system_prompt, persona, scenario, example_dialogue from characters where character_id = $1 and user_id = $2',
            [characterId, userId],
          ),
        )
      : Promise.resolve([]),
    getPersonaSettings(settings),
    settings.get('chat_memory_inject_bridge_prompt'),
    settings.get('chat_memory_inject_plot_prompt'),
    settings.get('chat_memory_inject_auto_recall_prompt'),
    settings.get('chat_memory_auto_recall_chunk_prompt'),
    settings.get('chat_memory_inject_recent_history_prompt'),
    // location.md §5.4 — the known-locations block for the 'location' marker slot. Fail-open:
    // '' when disabled/empty, so an enabled slot with nothing to say emits nothing (the
    // assembler's non-empty filter drops it) — never an empty <locations> block in the prompt.
    loadLocationBlock({ db, settings }, userId, chatId),
    // docs/lorebook-plan.md §4/§7 — the lorebook slot text, resolved per-turn (recall → timed
    // state → gate → format, all fail-open inside resolveLorebook). Seeded deterministically by
    // the assistant message_id being generated, which only exists when the caller is actually
    // producing a turn — the inspector (no message being generated) passes the last assistant
    // message's id, or nothing for a chat that has never had one (slot simply omitted).
    lorebookSeedMessageId && recentHistoryMessages
      ? resolveLorebook({
          db,
          settings,
          embeddings,
          userId,
          chatId,
          characterId,
          queryText: buildAutoRecallQuery(recentHistoryMessages, AUTO_RECALL_PAIRS),
          assistantMessageId: lorebookSeedMessageId,
        })
      : Promise.resolve(undefined),
  ]);
  // The preset was deleted, or has no slots, since Apply — nothing to assemble against. Caller
  // falls back to formatCurrentDateContext alone rather than crashing the turn over stale config.
  if (slots.length === 0) return { items: [], lorebookActivatedEntryIds: [] };

  const character = characterRows[0];
  const personaText = persona.description
    ? persona.name
      ? `${persona.name}: ${persona.description}`
      : persona.description
    : persona.name || undefined;

  const fields: PromptStackFields = {
    system: character?.system_prompt || undefined,
    description: character?.persona || undefined,
    scenario: character?.scenario || undefined,
    mes_example: character?.example_dialogue || undefined,
    persona: personaText,
    // The three component markers — each rendered from its own template (CNZ-style {{var}}/{{#if}}),
    // empty when its component has no content so an enabled slot with nothing to say emits nothing.
    // Template settings follow the platform's "empty string = built-in default" contract (same as
    // the digest prompts: an empty override clears back to DEFAULT_*), so `|| undefined` — not
    // `?? undefined`, which would render an empty template and silently drop the marker.
    bridge: renderBridge(memoryContext.scene, memoryContext.events, bridgeTemplate || undefined) || undefined,
    plot_threads: renderPlotThreads(memoryContext.plotThreads, plotTemplate || undefined) || undefined,
    auto_recall:
      renderAutoRecall(memoryContext.chunks, memoryContext.facts, autoRecallTemplate || undefined, chunkTemplate || undefined, character?.name) ||
      undefined,
    // The active context (2026-08-10 user direction): the live-window turns, last sent turn
    // included, rendered deterministically and placed wherever the preset ordered this slot —
    // inside the preset's own HTML wrapper tags when it authored them (e.g. Comfy 2's
    // <narrative_execution>). Empty window => undefined => the slot's non-empty filter drops it,
    // and the caller then keeps sending the window as plain messages (unchanged behavior).
    recent_history:
      recentHistoryMessages?.length
        ? renderRecentHistory(
            formatRecentHistoryTurns(recentHistoryMessages, character?.name ?? '', persona.name ?? ''),
            character?.name ?? '',
            persona.name ?? '',
            recentHistoryTemplate || undefined,
          ) || undefined
        : undefined,
    // location.md §5.4 — the known-locations block (known parents + the current parent's subs +
    // the TRG rules text), rendered by loadLocationBlock above. undefined when disabled/empty so
    // an enabled 'location' slot with nothing to say emits nothing.
    location: locationBlock.block || undefined,
    // Deprecated fused alias — presets that still carry a memory_recall slot get the legacy block.
    memory_recall: memoryContext.fused || undefined,
    // docs/lorebook-plan.md §7 — the dedicated lorebook slot, filled by resolveLorebook above.
    // undefined when mode is off, nothing activated, or the resolution failed (fail-open) — the
    // assembler's non-empty filter then drops the slot exactly as if it weren't in the preset.
    lorebook: lorebookBlock?.text || undefined,
  };

  const snapshot: MacroSnapshot = {
    charName: character?.name,
    userName: persona.name || undefined,
    persona: personaText,
    description: character?.persona || undefined,
    scenario: character?.scenario || undefined,
  };

  // Walks the same slots assemblePromptStack(fields, slots) would, in the same order, with the
  // same enabled/non-empty filter — kept as its own loop (rather than calling that pure function
  // and losing slot identity) purely so each emitted item can still carry the markerKey/label that
  // produced it. assemblePromptStack itself has no reason to know that; a display concern doesn't
  // belong in the platform's canonical prompt-assembly pure function.
  const items: PromptPreviewItem[] = [];
  const renderedIndices: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    if (!slot.enabled) continue;
    if (slot.slotType === 'custom') {
      if (!slot.customContent) continue;
      renderedIndices.push(i);
      items.push(toPreviewItem(slot.customRole ?? 'system', wrapSlotContent(interpolateMacros(slot.customContent, snapshot), slot), { label: slot.label }));
      continue;
    }
    const value = slot.markerKey ? fields[slot.markerKey as MarkerKey] : undefined;
    if (!value) continue;
    renderedIndices.push(i);
    items.push(toPreviewItem('system', wrapSlotContent(interpolateMacros(value, snapshot), slot), { markerKey: slot.markerKey, label: slot.label }));
  }
  // Migration 0086: same group-tag wrapping assemblePromptStack applies, so the real prompt and
  // the inspector can never drift — <Name> around the run's first rendered member, </Name> around
  // the last (groupTagsForRendered), outside the slot's own 0085 tags.
  const groupTags = groupTagsForRendered(slots, renderedIndices);
  for (let m = 0; m < items.length; m++) {
    const tags = groupTags.get(renderedIndices[m]!);
    if (!tags) continue;
    const { open, close } = tags;
    items[m] = {
      ...items[m]!,
      content: `${open ? `${open}\n` : ''}${items[m]!.content}${close ? `\n${close}` : ''}`,
    };
  }
  return { items, lorebookActivatedEntryIds: lorebookBlock?.activatedEntryIds ?? [] };
}

// Returns the joined system text plus whether the recent_history slot actually rendered this turn
// — when it did, the caller must NOT also append the live-window messages (they now live inside
// the stack; duplicating them would double the window's tokens and put a changed byte in the
// system block, defeating the cache prefix the user is managing).
async function assembleNarratorSystemText(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  embeddings: EmbeddingProvider,
  userId: string,
  chatId: string,
  characterId: string | null,
  presetId: string,
  memoryContext: RpMemoryContext,
  recentHistoryMessages?: LlmMessage[],
  lorebookSeedMessageId?: string,
): Promise<{ text: string; recentHistoryRendered: boolean; lorebookActivatedEntryIds: string[] }> {
  const { items, lorebookActivatedEntryIds } = await buildNarratorStackItems(db, settings, embeddings, userId, chatId, characterId, presetId, memoryContext, recentHistoryMessages, lorebookSeedMessageId);
  return {
    text: items.map((i) => i.content).join('\n\n'),
    recentHistoryRendered: items.some((i) => i.markerKey === 'recent_history'),
    lorebookActivatedEntryIds,
  };
}

// The other half: raw history older than the live window is never sent at all — only reachable via
// recall_chat_history. Same knob (chat_memory_live_window_pairs) orchestrator/src/orchestrator/
// chatMemorySync.ts's own sync pipeline uses for where the live window ends, read live so the two
// stay in agreement without coordinating a restart.
async function trimToLiveWindow(messages: LlmMessage[], settings: OrchestratorSettingsStore): Promise<LlmMessage[]> {
  const raw = await settings.get('chat_memory_live_window_pairs');
  const pairs = raw ? Number(raw) : NaN;
  const liveMessages = (Number.isInteger(pairs) && pairs > 0 ? pairs : 8) * 2;
  return messages.length > liveMessages ? messages.slice(-liveMessages) : messages;
}

// endpoint.md §5's decoupled image-generation trigger: fires describe-then-render without
// awaiting either, invoked from the response 'finish' event so the reply the user is waiting on is
// already sent before a provider round-trip starts. The describer (describeLocation.ts — the
// room-description LLM call, VLZ Step 3) must run BEFORE the render: the render hash (endpoint.md
// §5.1.2) is over the synthesized prompt, which expands visual_description, so a description that
// landed after the render would flip the hash and waste a gen — the chain awaits the describer
// first (both fail-open inside themselves, so a failed describe falls through to a name-seed
// render, exactly today's behavior). The injected llm is the turn's gated provider where the
// caller has one (post-turn fire sites pass turnLlm — the same connection the story itself ran
// on, mirroring VLZ's describer defaulting to the main chat LLM); restart triggers
// (ensureActiveLocationImage, the swipe-route fire) pass none and fall back to deps.llm.
export function fireLocationImageGeneration(
  deps: HttpServerDeps,
  userId: string,
  chatId: string | undefined,
  locationId: string,
  llm: LlmProvider = deps.llm,
): void {
  void (async () => {
    await describeLocationIfNeeded(
      { db: deps.db, settings: deps.settings },
      llm,
      userId,
      chatId,
      locationId,
    );
    await generateLocationImage(
      { db: deps.db, settings: deps.settings, imageConnections: deps.imageConnections },
      userId,
      locationId,
      chatId,
    );
  })();
}

// endpoint.md §6.4's chat-background read: the eligible current location (via the scene_id cache
// pointer, segway.md §2.2, falling back to the active swipe's own anchored/associated location so
// a stale scene pointer on prev/next cycling can't blank the layer) plus the last settled
// location (chat_sessions.previous_scene_id — endpoint.md §5.1.8's last-turn location state, the
// revert target shown while the current render is pending or after a swipe). Scoped to the
// requesting user. The current location is returned even before its image has rendered
// (imageUrl null): the post-turn bg pass fires only after the reply is sent (endpoint.md §5), so
// a location change lands with no image for a beat, and the client keeps the previous background
// up until the pending render is ready to replace it (§5.1.8's "notify UI"). Null is reserved
// for "no eligible location at all". The previous location is eligibility-relaxed (a historical
// pointer, not model-facing — "some background is better than no background even if stale") and
// only returned when it actually has an image to show.
async function resolveChatLocationImage(
  db: PostgresClient,
  userId: string,
  chatId: string,
): Promise<{ current: { locationId: string; name: string; definition: string | null; imageUrl: string | null } | null; previous: { locationId: string; name: string; definition: string | null; imageUrl: string } | null }> {
  return db.withUserScope(userId, async (session) => {
    // The chat's scene pointers — current and last-turn/previous — which everything below
    // resolves through.
    const [chatState] = await session.query<{ scene_id: string | null; previous_scene_id: string | null }>(
      'select scene_id, previous_scene_id from chat_sessions where chat_id = $1',
      [chatId],
    );

    let current: { locationId: string; name: string; definition: string | null; imageUrl: string | null } | null = null;
    if (chatState?.scene_id) {
      // Primary path: the scene_id cache pointer (segway.md §2.2) -> scenes.active_location_id
      // -> locations.image_url, §2.6-filtered. The filter makes this read as absent on a stale
      // pointer — e.g. prev/next cycling flipped the active swipe but not the scene — which the
      // fallback below catches.
      const [sceneRow] = await session.query<{ location_id: string; name: string; definition: string | null; image_url: string | null }>(
        `select l.location_id, l.name, l.definition, l.image_url
         from scenes s
         join locations l on l.location_id = s.active_location_id and l.user_id = $1
         where s.scene_id = $2
           and (
             l.status = 'permanent' or l.status is null or
             (l.status = 'transient' and l.anchor_swipe_id in (
               select active_swipe_id from chat_messages where chat_id = $3 and active_swipe_id is not null
             ))
           )
         limit 1`,
        [userId, chatState.scene_id, chatId],
      );
      current = sceneRow
        ? { locationId: sceneRow.location_id, name: sceneRow.name, definition: sceneRow.definition, imageUrl: sceneRow.image_url }
        : null;
    }
    if (!current) {
      // Fallback: the active swipe's own location — its anchored transient row, or its recorded
      // location_swipe_images association (the cycle-back case: the location row was since
      // re-anchored to a newer swipe, but this swipe's image is still valid for it — endpoint.md
      // §5.1.8's "save the association, stays inactive, reuse on return").
      const [swipeRow] = await session.query<{ location_id: string; name: string; definition: string | null; image_url: string | null }>(
        `select l.location_id, l.name, l.definition, l.image_url
         from locations l
         where l.user_id = $1
           and (
             l.status = 'permanent' or l.status is null or
             (l.status = 'transient' and l.anchor_swipe_id in (
               select active_swipe_id from chat_messages where chat_id = $2 and active_swipe_id is not null
             )) or
             exists (select 1 from location_swipe_images a
                     where a.chat_id = $2 and a.location_id = l.location_id
                       and a.swipe_id in (
                         select active_swipe_id from chat_messages where chat_id = $2 and active_swipe_id is not null
                       ))
           )
         order by (l.status = 'transient') desc, l.updated_at desc
         limit 1`,
        [userId, chatId],
      );
      current = swipeRow
        ? { locationId: swipeRow.location_id, name: swipeRow.name, definition: swipeRow.definition, imageUrl: swipeRow.image_url }
        : null;
    }

    let previous: { locationId: string; name: string; definition: string | null; imageUrl: string } | null = null;
    if (chatState?.previous_scene_id) {
      // The last settled location — shown while the current render is pending or after a swipe.
      // definition rides along (describer.md's "Definition:" half) so the canvas caption stays
      // complete when the UI is showing the previous background, mirroring the current path.
      const [prevRow] = await session.query<{ location_id: string; name: string; definition: string | null; image_url: string }>(
        `select l.location_id, l.name, l.definition, l.image_url
         from scenes s
         join locations l on l.location_id = s.active_location_id and l.user_id = $1
         where s.scene_id = $2 and l.image_url is not null
         limit 1`,
        [userId, chatState.previous_scene_id],
      );
      previous = prevRow ? { locationId: prevRow.location_id, name: prevRow.name, definition: prevRow.definition, imageUrl: prevRow.image_url } : null;
    }

    return { current, previous };
  });
}

/** endpoint.md §5.1.8's "restart bg discovery on return": after a chat load or a swipe cycle
 *  that left the active location without a rendered image (a dropped or failed pass), fire the
 *  cache-first generation pass so discovery resumes. Cache-first + the renderInFlight guard make
 *  repeat triggers no-ops whenever the image already exists or a render is already running. */
async function ensureActiveLocationImage(deps: HttpServerDeps, userId: string, chatId: string): Promise<void> {
  try {
    const state = await resolveChatLocationImage(deps.db, userId, chatId);
    if (state.current && !state.current.imageUrl) {
      fireLocationImageGeneration(deps, userId, chatId, state.current.locationId);
    }
  } catch (err) {
    log.warn('ensureActiveLocationImage: resolution failed, skipping trigger', { chatId, err });
  }
}

// endpoint.md §5.2's broken-link expiry recovery: the browser's Chat View hit an HTTP error (404/
// expired CDN link) loading a location's background image and notifies the server, which clears
// image_url so the next visit's cache check sees a miss and re-renders a fresh URL. Only the URL
// is cleared — the location row, its description, and its environment are untouched, and
// image_generated_at is left alone (the cleared URL alone is what flips §5.1.2's cache check to
// a miss; the timestamp is stale-but-harmless and the re-render overwrites it).
async function handleLocationImageBroken(_req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps, userId: string, url: URL): Promise<void> {
  const rest = url.pathname.slice('/v1/locations/'.length); // '<id>/image-broken'
  const segments = rest.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[1] !== 'image-broken') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const locationId = decodeURIComponent(segments[0]!);
  await deps.db.withUserScope(userId, async (session) => {
    await session.query('update locations set image_url = null where location_id = $1 and user_id = $2', [locationId, userId]);
    // endpoint.md §5.1.8: a per-swipe association must not resurrect the expired link on a
    // cycle-back — clear its URL too. The association row stays (the location identity is still
    // real); the next pass re-renders and re-records it.
    await session.query('update location_swipe_images set image_url = null where location_id = $1', [locationId]);
  });
  log.info('location image cleared after a client-side load failure (endpoint.md §5.2)', { locationId });
  sendJson(res, 200, { cleared: true });
}

// Shared by handleChatCompletions and regenerateSwipe below — a persisted chat's system prompt
// assembly (memory digest + either per-turn narrator assembly or the legacy frozen params.system,
// macro-resolved for 'rp') is identical whichever of the two is producing the reply; only how the
// result gets persisted differs (append a new turn vs. recordSwipe in place).
async function assembleSessionTurnContext(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  embeddings: EmbeddingProvider,
  userId: string,
  chatId: string,
  sessionKind: 'chat' | 'rp',
  sessionCharacterId: string | null,
  sessionPromptStackPresetId: string | null,
  sessionParams: ChatParams,
  messagesForLlm: LlmMessage[],
  timezone: string,
  lorebookSeedMessageId?: string,
): Promise<{ systemPrompt: string; messagesForLlm: LlmMessage[]; lorebookActivatedEntryIds: string[] }> {
  const [memoryContext, trimmed] = await Promise.all([
    buildChatMemorySystemPrompt(db, settings, embeddings, userId, chatId, sessionKind, messagesForLlm),
    trimToLiveWindow(messagesForLlm, settings),
  ]);

  // docs/plans/prompt-macros.md's Stage 1, extended to message history: an RP chat's stored messages —
  // chiefly the character's seeded greeting, which apply_character_to_chat/apply_prompt_stack_to_chat
  // insert verbatim — can carry the same {{...}} tokens as its system text, and they'd otherwise
  // reach the LLM literally (and get echoed back into replies). Resolved here, at the same seam and
  // against the same frozen snapshot as the system text (docs §2: resolved once at the top of the
  // turn), never by rewriting the canonical message. Display-only resolution is a separate concern
  // served by GET /v1/chats/:id's resolvedContent (handleChatRoutes). Gated exactly like the
  // system pass below: 'rp' chats only (a 'chat'-kind session could legitimately discuss literal
  // `{{...}}`-looking text), and only when something actually contains '{{' — so a macro-free turn
  // pays for none of the reads.
  const systemNeedsMacros = sessionKind === 'rp' && !sessionPromptStackPresetId && !!sessionParams.system?.includes('{{');
  const historyNeedsMacros = sessionKind === 'rp' && trimmed.some((m) => m.content.includes('{{'));
  let macroSnapshot: MacroSnapshot | undefined;
  if (systemNeedsMacros || historyNeedsMacros) {
    macroSnapshot = await buildMacroSnapshot(db, settings, userId, sessionCharacterId);
  }

  if (sessionKind === 'rp' && sessionPromptStackPresetId) {
    // Per-turn narrator assembly (docs/plans/turn-loop-plan.md §3.2): re-run assemblePromptStack fresh
    // every turn instead of replaying the frozen string apply_prompt_stack_to_chat baked once into
    // params.system at Apply-click — a character-card/persona/memory-digest edit takes effect on
    // the very next message, no re-apply needed. memory_recall is folded in as a field the preset's
    // own slot ordering places, not appended after the fact.
    // No formatCurrentDateContext here — unlike a 'chat'-kind session, an in-character narrator
    // has no business knowing the real-world wall-clock time unless the prompt stack itself surfaces
    // it (e.g. a scenario slot), so it's omitted for 'rp' rather than unconditionally prepended.
    // buildNarratorStackItems reads the character/persona once more for its own slot snapshot —
    // near-simultaneous with the turn-level buildMacroSnapshot above, so Stage 1's deterministic
    // lookups make the two byte-identical; a Stage 2 clock/RNG would want them merged into one.
    // recentHistoryRendered: the live-window turns (last sent turn included) moved INTO the stack
    // inside the preset's own tags (2026-08-10 user direction: "I do not want the messages
    // appended at the end"). When the slot rendered, the messages array is emptied — the stack
    // alone carries the context; the LLM adapters emit a single empty user message so providers
    // don't reject the request shape (the user's "send it as it is").
    const narrator = await assembleNarratorSystemText(db, settings, embeddings, userId, chatId, sessionCharacterId, sessionPromptStackPresetId, memoryContext as RpMemoryContext, trimmed, lorebookSeedMessageId);
    return {
      systemPrompt: narrator.text,
      messagesForLlm: narrator.recentHistoryRendered ? [] : resolveMacrosInMessages(trimmed, historyNeedsMacros, macroSnapshot),
      // The activated entry ids ride up to the turn handler so it can append the
      // lorebook_activation_log rows after the turn completes (docs/lorebook-plan.md §3e/§4) —
      // the "write after, not during" shape that keeps sticky/cooldown resolvable next turn.
      lorebookActivatedEntryIds: narrator.lorebookActivatedEntryIds,
    };
  }

  // No applied preset — a 'chat'-kind chat, or an 'rp' chat that's never been through Apply:
  // unchanged legacy behavior, the frozen params.system, macro-resolved if 'rp'. Date context still
  // applies to 'chat'-kind sessions (household assistant use), just not 'rp' ones (see above).
  let system = sessionParams.system;
  if (sessionKind === 'rp' && system?.includes('{{') && macroSnapshot) {
    system = await resolveMacrosInSystemPrompt(system, macroSnapshot);
  }
  const dateContext = sessionKind === 'rp' ? undefined : formatCurrentDateContext(timezone);
  // The no-preset fallback gets the fused string either way: a 'chat' lane returns it directly,
  // an 'rp' lane returns the structured context whose .fused is the legacy block.
  const memoryText = typeof memoryContext === 'string' ? memoryContext : memoryContext.fused;
  return {
    systemPrompt: [dateContext, system, memoryText].filter(Boolean).join('\n\n'),
    messagesForLlm: resolveMacrosInMessages(trimmed, historyNeedsMacros, macroSnapshot),
    // No lorebook slot in the legacy path — resolveLorebook only runs through the preset branch.
    lorebookActivatedEntryIds: [],
  };
}

// The message-history half of the turn-scoped resolution pass above (and the Prompt Inspector's
// live fallback): substitute the turn's snapshot into every message whose text actually contains
// '{{', returning the original array untouched when nothing needs it. Per-message `includes('{{')`
// skips the regex for macro-free history; the array itself is never rewritten — new objects only
// for the messages that change, so callers holding the originals (chat persistence, the canon
// anchor) keep seeing verbatim content.
function resolveMacrosInMessages(messages: LlmMessage[], needsMacros: boolean, snapshot: MacroSnapshot | undefined): LlmMessage[] {
  if (!needsMacros || !snapshot) return messages;
  return messages.map((m) => (m.content.includes('{{') ? { ...m, content: interpolateMacros(m.content, snapshot) } : m));
}

// Display-only single-message twin of handleChatRoutes' GET /v1/chats/:id decoration: the swipe
// routes return one StoredChatMessage (a stored alternate greeting, or a regenerated reply) that
// the client swaps into view in place, so it carries the same derived resolvedContent contract —
// canonical content untouched, display copy resolved against the live persona.
async function decorateMessageForDisplay(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  userId: string,
  session: Pick<ChatSessionRow, 'kind' | 'characterId'>,
  message: StoredChatMessage,
): Promise<StoredChatMessage> {
  if (session.kind !== 'rp' || !message.content.includes('{{')) return message;
  const snapshot = await buildMacroSnapshot(db, settings, userId, session.characterId);
  return { ...message, resolvedContent: interpolateMacros(message.content, snapshot) };
}

export interface PromptPreviewGroup {
  /** Stable kind tag: 'main' (the last turn's main prompt, captured at send time — see below),
   *  or a captured background prompt's tag ('cleanup', 'title', …) from io/promptTrace.ts. */
  kind: string;
  /** Human heading shown in the inspector, e.g. 'Main Prompt' / 'Cleanup Prompt'. */
  title: string;
  /** True when this group is the actual text fired during a turn (captured at send time); false
   *  only for the main prompt's fallback — a live reconstruction of what the next turn would
   *  send, shown while no turn has been captured yet (fresh chat, or trace lost to a restart). */
  captured: boolean;
  /** The prompt's items in send order — system-stack/header items first, then conversation
   *  messages, each with a rough token estimate. */
  items: PromptPreviewItem[];
  /** Cache-coverage diff against the previous fired main (docs/plans/prompt-inspector-tag-tree.md
   *  §3.2, revised): stablePrefixChars = length of the longest common prefix (UTF-16 code units)
   *  of this group's joined items text and the previous 'main' trace entry's; previousCallAt =
   *  when that previous main fired. A section of this group's tag tree is cache-covered iff
   *  section.end <= stablePrefixChars. Both entries are recorded at send time, so the badge is
   *  deterministic — no live reconstruction involved. Absent when fewer than two 'main' entries
   *  are on record (fresh chat, or the in-memory trace was lost to a restart) — the frontend
   *  then omits the cache badges rather than showing an unknown state. */
  stablePrefixChars?: number;
  previousCallAt?: number;
  /** Per-subsection identity stability over the last x calls on record (docs/
   *  prompt-inspector-tag-tree.md §3.3): the trace's main entries, oldest first, are replayed as
   *  consecutive pairs — each section (keyed by canonical tag name + occurrence index) counts one
   *  observation per call it existed in, identical when its full span is byte-identical to the
   *  previous call's same section. The percentage shown per section is identical / seen. Absent
   *  when fewer than two 'main' entries are on record — same omission rule as
   *  stablePrefixChars (fresh chat, or the in-memory trace was lost to a restart). */
  stability?: SectionStabilityResult;
  /** The model's reply to this prompt, when the trace captured one (io/promptTrace.ts's `reply` —
   *  cleanup repairs record it; the cleaned text replaces the raw output in the message, so this
   *  is the only place it survives). Rendered as its own collapsible block; deliberately kept OUT
   *  of `items` so the group's totals stay prompt-side (the reply was never sent to the model). */
  reply?: PromptPreviewItem;
  /** The last turn's vendor-reported token accounting (io/promptTrace.ts's `usage`), copied from
   *  the captured 'main' entry — present only when a turn has fired and resolved successfully
   *  against a connection that reports usage, undefined on the live-reconstruction fallback (no
   *  real call to report) or a turn that failed. Powers the receipt row under the group title
   *  (docs/plans/prompt-inspector-usage-cost.md). */
  usage?: LlmUsage;
  /** The acting connection's USD-per-1M-token rates at that turn's send time — undefined end to
   *  end when no price was configured ("tokens only, never a fabricated $0.00"); a partially-set
   *  price keeps the $ figure off rather than pricing a tier at another tier's rate. */
  price?: { inputPerMillion?: number; outputPerMillion?: number; cacheHitPerMillion?: number };
}

export interface PromptPreview {
  /** One group per prompt this chat fires, in order: the last turn's main prompt (captured at
   *  send time, falling back to a live preview), then any captured background prompts from the
   *  last turns (cleanup pass, title generation, …). */
  groups: PromptPreviewGroup[];
  totalChars: number;
  totalEstimatedTokens: number;
}

// The read-only twin of assembleSessionTurnContext's 'rp' branch above. After a turn has fired,
// the 'main' entry handleChatCompletions/regenerateSwipe recorded in io/promptTrace.ts IS the
// exact text that turn sent — the inspector's primary path. The live assembly below (same
// memory/preset/legacy logic, same buildNarratorStackItems/resolveMacrosInSystemPrompt) is only
// the fallback for when no capture exists yet; it can never drift from what a real turn sends
// since both paths share that assembly. RP-only (docs/bi_principles.md's household-memory/canon
// scoping is what makes a 'chat'-kind session's system prompt uninteresting to audit this way —
// it's just the frozen params.system).
async function buildPromptPreview(  deps: HttpServerDeps,
  userId: string,
  chatId: string,
): Promise<{ ok: true; preview: PromptPreview } | { ok: false; status: number; error: string }> {
  const detail = await deps.chats.getChat(userId, chatId);
  if (!detail) return { ok: false, status: 404, error: 'not found' };
  const { session } = detail;
  if (session.kind !== 'rp') {
    return { ok: false, status: 422, error: 'prompt preview is only available for rp chats' };
  }

  // io/promptTrace.ts's contract, applied to the main prompt too: the trace now holds 'main'
  // entries — the exact text handleChatCompletions/regenerateSwipe record just before the llm
  // call — and those are "the last turn that was sent", which is what the inspector exists to
  // show. Prefer the latest one; the live assembly below is the fallback for a chat that hasn't
  // fired a turn yet, or a restart that wiped the in-memory trace (and it stays useful while
  // composing, before the first send — bi_principles.md §13's live-read applied to this surface).
  // Either way the group's items stay granular (one per system-stack slot and history message) so
  // the frontend can render them individually, or join them into one block, as it prefers.
  const trace = getPromptTrace(chatId);
  const mains = [...trace].reverse().filter((e) => e.kind === 'main');
  const capturedMain = mains[0];
  const previousMain = mains[1];

  let mainGroup: PromptPreviewGroup;
  if (capturedMain) {
    mainGroup = {
      kind: 'main',
      title: 'Main Prompt',
      captured: true,
      items: capturedMain.items.map((i) => ({
        role: i.role,
        content: i.content,
        chars: i.chars,
        estimatedTokens: i.estimatedTokens,
      })),
    };
    // The turn's usage/cost receipt: copied from the trace entry the way `reply` is — absent
    // while the entry hasn't resolved yet, absent forever on the live-reconstruction fallback
    // below (no real call happened to report). Both fields are 'main'-only (see the plan).
    mainGroup.usage = capturedMain.usage;
    mainGroup.price = capturedMain.price;
    // Cache-coverage badges (§3.2, revised): diff the last fired main against the one before it.
    // Both are recorded bytes, so the badge is deterministic — no live reconstruction, unlike the
    // original design. stablePrefixChars = the longest common prefix of the two joined texts, in
    // the same UTF-16 code units the frontend's tag-tree offsets use (the tree slices the same
    // joined text). Omitted when only one (or zero) main is on record — the frontend then shows
    // no cache badges at all.
    if (previousMain) {
      const joinedNow = capturedMain.items.map((i) => i.content).join('\n\n');
      const joinedPrev = previousMain.items.map((i) => i.content).join('\n\n');
      mainGroup.stablePrefixChars = longestCommonPrefixLength(joinedNow, joinedPrev);
      mainGroup.previousCallAt = previousMain.capturedAt;
    }
    // Per-subsection stability (§3.3): replay the mains the trace holds (oldest first) as
    // consecutive pairs — the fixed last-x-calls window, data the trace already keeps (no new
    // state, no reset bookkeeping). Only reachable with a capture; requires ≥2 mains on record,
    // same omission rule as the cache badges above.
    if (mains.length >= 2) {
      mainGroup.stability = computeSectionStability(
        [...mains].reverse().map((m) => m.items.map((i) => i.content).join('\n\n')),
      );
    }
  } else {
    const messagesForLlm: LlmMessage[] = detail.messages.map((m) => ({ role: m.role, content: m.content }));
    let [memoryContext, trimmed] = await Promise.all([
      buildChatMemorySystemPrompt(deps.db, deps.settings, deps.embeddings, userId, chatId, session.kind, messagesForLlm),
      trimToLiveWindow(messagesForLlm, deps.settings),
    ]);

    // No date-context item — 'rp' turns no longer get formatCurrentDateContext prepended (see
    // assembleSessionTurnContext's 'rp' branch above), and this preview must never show something
    // an actual turn wouldn't send.
    const systemStack: PromptPreviewItem[] = [];

    // Same shared-snapshot shape as assembleSessionTurnContext — one frozen snapshot for the
    // system text (legacy branch only) and the message history (both branches; a real turn's
    // narrator path resolves messages the same way), docs/plans/prompt-macros.md §2.
    const systemNeedsMacros = !session.promptStackPresetId && !!session.params.system?.includes('{{');
    const historyNeedsMacros = trimmed.some((m) => m.content.includes('{{'));
    const macroSnapshot = systemNeedsMacros || historyNeedsMacros
      ? await buildMacroSnapshot(deps.db, deps.settings, userId, session.characterId)
      : undefined;

    if (session.kind === 'rp' && session.promptStackPresetId) {
      // Lorebook preview seed: no assistant message is being generated here, so the gate uses
      // the last assistant message's id (stable per chat head — the preview shows what the last
      // resolved turn saw); a chat that has never had an assistant message omits the slot.
      const lastAssistantMessageId = [...detail.messages].reverse().find((m) => m.role === 'assistant')?.messageId;
      systemStack.push(
        ...(await buildNarratorStackItems(deps.db, deps.settings, deps.embeddings, userId, chatId, session.characterId, session.promptStackPresetId, memoryContext as RpMemoryContext, trimmed, lastAssistantMessageId)).items,
      );
    } else {
      let system = session.params.system;
      if (system?.includes('{{') && macroSnapshot) {
        system = await resolveMacrosInSystemPrompt(system, macroSnapshot);
      }
      if (system) systemStack.push(toPreviewItem('system', system, { markerKey: 'system' }));
      // No-preset fallback: 'chat' lane returns the string directly, 'rp' lane the structured
      // context whose .fused is the legacy block — either way it previews as the memory item.
      const memoryText = typeof memoryContext === 'string' ? memoryContext : memoryContext.fused;
      if (memoryText) systemStack.push(toPreviewItem('system', memoryText, { markerKey: 'memory_recall' }));
    }
    // When the recent_history slot rendered, the live-window turns are INSIDE the stack — the
    // preview must not also list them as message items (mirrors the real turn: messagesForLlm is
    // emptied in assembleSessionTurnContext). resolveMacrosInMessages stays gated on !rendered:
    // the rendered block's own Stage-1 pass (buildNarratorStackItems) already resolved its macros.
    const historyInStack = systemStack.some((i) => i.markerKey === 'recent_history');
    const messages = historyInStack
      ? []
      : resolveMacrosInMessages(trimmed, historyNeedsMacros, macroSnapshot).map((m) => toPreviewItem(m.role as PromptPreviewItem['role'], m.content));
    mainGroup = { kind: 'main', title: 'Main Prompt', captured: false, items: [...systemStack, ...messages] };
  }

  // One group per prompt this chat fires. Main first (the captured last turn, or the live preview),
  // then every captured background prompt — the cleanup pass, title generation, … — in fire order.
  // 'main' entries in the trace are already surfaced as the first group, so they're filtered out
  // here rather than shown a second time.
  const groups: PromptPreviewGroup[] = [
    mainGroup,
    ...latestPerKind(trace)
      .filter((e) => e.kind !== 'main')
      .map((entry): PromptPreviewGroup => ({
        kind: entry.kind,
        title: entry.title,
        captured: true,
        items: entry.items.map((i) => ({
          role: i.role,
          content: i.content,
          chars: i.chars,
          estimatedTokens: i.estimatedTokens,
        })),
        // A captured background prompt's reply (cleanup repair outputs — otherwise unrecoverable),
        // when the trace recorded one. Separate from items so prompt-side totals stay prompt-side.
        reply: entry.reply
          ? { role: 'assistant', content: entry.reply, chars: entry.reply.length, estimatedTokens: estimateTokens(entry.reply.length) }
          : undefined,
      })),
  ];

  const allChars = groups.reduce((sum, g) => sum + g.items.reduce((s, i) => s + i.chars, 0), 0);
  return {
    ok: true,
    preview: {
      groups,
      totalChars: allChars,
      totalEstimatedTokens: estimateTokens(allChars),
    },
  };
}

// A chat's own profile override (a per-chat connection picker, distinct from the household-wide
// active connection) swaps in a throwaway provider for that one named connection (io/llmConnections.ts),
// built fresh per turn — cheap, since every provider here is a stateless fetch wrapper
// (io/llm/anthropic.ts, io/llm/openaiCompatible.ts). Unlike the household setting, this needs no
// restart to take effect. An unknown connection name (stale override, a connection since renamed
// or deleted in the Connections tab) falls back to the household's active connection rather than
// failing the whole turn, logging why per bb_principles.md §11. Shared by handleChatCompletions and
// regenerateSwipe below — resolving which connection a chat's turn runs through doesn't depend on
// whether the reply is being appended as a new turn or swapped in as a swipe.
// The acting connection's per-token rates (USD per 1M tokens) for a turn — what the Prompt
// Inspector's receipt multiplies the vendor's usage by. Undefined end to end when the connection
// has no price configured; a tier is undefined when that tier has no rate (the receipt then omits
// the $ figure entirely rather than pricing it at another tier's rate).
export interface TurnPrice {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheHitPerMillion?: number;
}

// LlmProfile carries the same three price fields as the llm_connections row (io/llm/profiles.ts,
// relayed by io/llmConnections.ts's toProfile) — this is a pure shape conversion, not a second
// DB round-trip. All three undefined collapses to undefined: a connection with no price set must
// read as "no price" end to end, never as a fabricated $0.00.
function toTurnPrice(profile: {
  priceInputPerMillion?: number;
  priceOutputPerMillion?: number;
  priceCacheHitPerMillion?: number;
} | undefined): TurnPrice | undefined {
  if (!profile) return undefined;
  const { priceInputPerMillion, priceOutputPerMillion, priceCacheHitPerMillion } = profile;
  if (priceInputPerMillion === undefined && priceOutputPerMillion === undefined && priceCacheHitPerMillion === undefined) {
    return undefined;
  }
  return {
    inputPerMillion: priceInputPerMillion,
    outputPerMillion: priceOutputPerMillion,
    cacheHitPerMillion: priceCacheHitPerMillion,
  };
}

async function resolveTurnLlm(
  deps: HttpServerDeps,
  sessionParams: ChatParams,
  chatId: string | undefined,
): Promise<{ turnLlm: LlmProvider; turnDefaultModel: string; turnPrice: TurnPrice | undefined }> {
  let turnLlm = deps.llm;
  let turnDefaultModel = deps.modelName;
  let turnPrice: TurnPrice | undefined;
  if (sessionParams.profile) {
    const profile = await deps.llmConnections.resolveByName(sessionParams.profile);
    if (profile) {
      // A per-chat override builds its own throwaway provider (this function's own doc above) —
      // gated the same as deps.llm (index.ts wraps that one once, at boot), since a call through
      // an override is exactly as real a call as one through the household's active connection
      // (bb_principles.md §14 doesn't carve out an exception for "which connection").
      turnLlm = createGatedLlmProvider(createLlmProviderForProfile(profile), deps.db, deps.settings);
      turnDefaultModel = profile.model;
      // The override's own profile already carries the connection's prices — no second read.
      turnPrice = toTurnPrice(profile);
    } else {
      log.error(
        `chat_id ${chatId} names unknown connection "${sessionParams.profile}" — falling back to the active connection`,
      );
    }
  } else {
    // Default branch: reuse the boot-time deps.llm singleton unchanged — this resolveActive is
    // used ONLY to read the active connection's price fields, and must not replace turnLlm/
    // turnDefaultModel here (no second, redundant gated provider instance for a call that's
    // about to use the existing one). The returned profile is built from the same active row the
    // singleton was created from, so its prices are exactly the acting connection's.
    const active = await deps.llmConnections.resolveActive();
    turnPrice = toTurnPrice(active);
  }
  return { turnLlm, turnDefaultModel, turnPrice };
}

// Rerun's in-place regeneration path (docs/bi_principles.md: swipe capability on the last LLM
// response) — the exact same turn-running logic handleChatCompletions's chat_id path uses
// (connection resolution, memory/narrator system-prompt assembly, live-window trimming, runTurn,
// the optional cleanup pass), just persisted via chats.recordSwipe instead of appendMessages, and
// with no new user message to insert — messageId's own prior siblings in detail.messages are the
// entire prompt. Only ever called once the caller (handleChatRoutes below) has confirmed messageId
// is this chat's current last message; regenerating anything earlier would leave the turns after it
// stale, since nothing here touches them.
async function regenerateSwipe(
  deps: HttpServerDeps,
  userId: string,
  chatId: string,
  detail: ChatDetail,
  messageId: string,
  // Real token-level streaming for the RP lane (docs/plans/rp-streaming-plan.md) — same gate as
  // handleChatCompletions's streaming branch: only session.kind === 'rp' streams, and the swipe
  // route only passes stream: true when the client asked for it (body.stream, default false).
  // When streaming, the caller (the swipe route) is responsible for writing SSE frames from
  // onDelta; this function still owns the LLM call + persistence exactly as today, returning the
  // accumulated reply so the caller can finish its stream.
  stream = false,
  onDelta?: (textDelta: string) => void,
): Promise<{ ok: true; message: StoredChatMessage; locationId?: string } | { ok: false; aborted?: boolean; error: string }> {
  const { db, settings, chats } = deps;
  const { session } = detail;
  const priorMessages = detail.messages.slice(0, -1);
  const messagesForLlm: LlmMessage[] = priorMessages.map((m) => ({ role: m.role, content: m.content }));
  const anchorMessageId = [...priorMessages].reverse().find((m) => m.role === 'user')?.messageId;

  // The RP lane runs with NO tools at all (2026-08-10 user direction: "simply let it execute the
  // prompt stack, with no funny business") — whatever tool_names the session row carries (the old
  // recall pair, null = all, anything) never reaches the model. Auto-recall is unaffected: it's
  // server-side injection into the stack, not a model tool call.
  const sessionTools =
    session.kind === 'rp' ? createToolRegistry([]) : session.toolNames !== null ? filterToolRegistry(deps.tools, session.toolNames) : deps.tools;
  const { turnLlm, turnPrice } = await resolveTurnLlm(deps, session.params, chatId);
  const timezone = await getHouseholdTimezone(deps.settings);
  const { systemPrompt, messagesForLlm: trimmed } = await assembleSessionTurnContext(
    db,
    deps.settings,
    deps.embeddings,
    userId,
    chatId,
    session.kind,
    session.characterId,
    session.promptStackPresetId,
    session.params,
    messagesForLlm,
    timezone,
    // The assistant message being regenerated IS this message — its id is the deterministic
    // lorebook gate seed (docs/lorebook-plan.md §4), stable across re-swipes of the same message.
    messageId,
  );

  // Same Prompt Inspector capture as handleChatCompletions (io/promptTrace.ts, kind 'main') — a
  // swipe re-runs the last turn, so its regenerated prompt is the newest "Main Prompt" the
  // inspector should show. Recorded before the call, success or not, like the cleanup pass. The
  // entry stays live so usage/price can be attached once the turn resolves — the same "absent
  // until the call returns, absent forever if it failed" contract as reply.
  const traceEntry: PromptTraceEntry = {
    kind: 'main',
    title: 'Main Prompt',
    items: [
      ...(systemPrompt ? [toPreviewItem('system', systemPrompt)] : []),
      ...trimmed.map((m) => toPreviewItem(m.role as PromptPreviewItem['role'], m.content)),
    ],
    capturedAt: Date.now(),
  };
  recordPromptTrace(chatId, traceEntry);

  let reply: string;
  let focusedNoteId: string | undefined;
  // Streaming RP swipe (rp-streaming-plan.md): run through the shared core, relaying each delta to
  // the caller's onDelta for immediate SSE flush. The abort handling matches the buffered path
  // below exactly — the route decides what the client sees (499 vs terminal frame) based on
  // whether headers were already written. A non-RP or non-streaming swipe keeps runTurn.
  const streamingRp = session.kind === 'rp' && stream === true;
  if (streamingRp) {
    // stream=true implies the caller (the swipe route) passed onDelta — this is a programming
    // error if it didn't, not a runtime degradation path; fail loudly per conventions §11.
    if (!onDelta) throw new Error('regenerateSwipe: stream=true requires an onDelta callback');
    try {
      const turnResult = await runStreamingRpTurn({
        userId,
        taskId: chatId,
        messages: trimmed,
        systemPrompt,
        model: session.params.model,
        sampling: { temperature: session.params.temperature, topP: session.params.top_p, maxTokens: session.params.max_tokens },
        llm: turnLlm,
        db,
        onDelta,
      });
      reply = turnResult.content;
      traceEntry.usage = turnResult.usage;
      traceEntry.price = turnPrice;
    } catch (err) {
      if (isAbortError(err)) {
        log.info(`swipe regenerate aborted for chat ${chatId}`);
        return { ok: false, aborted: true, error: 'turn aborted' };
      }
      log.error(`swipe regenerate failed for chat ${chatId}`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    try {
      const turnResult = await runTurn({
        userId,
        taskId: chatId,
        messages: trimmed,
        systemPrompt,
        model: session.params.model,
        sampling: { temperature: session.params.temperature, topP: session.params.top_p, maxTokens: session.params.max_tokens },
        llm: turnLlm,
        db,
        tools: sessionTools,
        anchorMessageId,
        embeddings: deps.embeddings,
      });
      reply = turnResult.content;
      focusedNoteId = turnResult.focusedNoteId;
      // Attached only after a successful resolve — a thrown/aborted turn leaves the entry without
      // usage/price, matching reply's "absent if the call failed" contract exactly.
      traceEntry.usage = turnResult.usage;
      traceEntry.price = turnPrice;
    } catch (err) {
      if (isAbortError(err)) {
        // The user hit Stop — not a failure. Nothing is written (the persisted user message simply
        // has no reply yet, which the frontend already presents as the Resend recovery path), so
        // the client gets a 499 to swallow quietly instead of an alarming 500.
        log.info(`swipe regenerate aborted for chat ${chatId}`);
        return { ok: false, aborted: true, error: 'turn aborted' };
      }
      log.error(`swipe regenerate failed for chat ${chatId}`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const updated = await chats.recordSwipe(userId, chatId, messageId, reply);  if (!updated) {
    return { ok: false, error: 'message no longer exists' };
  }
  // Stage 2 (docs/plans/vistalyze_integration/segway.md §4, location.md §4.2): post-cleanup heuristic
  // extraction against the regenerated text — recordSwipe above just made its swipe active,
  // which is the anchor the scraper's transient rows attach to. Fail-open inside the scraper:
  // never blocks the turn. The returned locationId feeds endpoint.md §5's decoupled
  // image-generation trigger (fired by the caller after the response is sent — never awaited
  // inline here). 'replace' mode: the turn being regenerated is discarded, so previous_scene_id
  // (the last-turn location state) is left pointing at the last *settled* location — the revert
  // target must survive a chain of swipes.
  // location.md §4.2's header-good gate: only scrape when the reply's header parses — a bad
  // header is left to the cleanup subloop, which repairs it and then fires the deferred scrape
  // on the repaired text (cleanupLoop.ts's onLocationScraped hook), so nothing re-scrapes a
  // headerless text and no wasted ensureActiveSwipe row is minted for it.
  const locationId = parseStoryHeader(reply)
    ? await scrapeTurnPresence(
        { db, settings, ensureActiveSwipe: (u, c, m) => chats.ensureActiveSwipe(u, c, m) },
        userId,
        chatId,
        messageId,
        reply,
        'replace',
      )
    : undefined;
  if (focusedNoteId !== undefined) {
    await chats.updateChat(userId, chatId, { canvasNoteId: focusedNoteId });
  }
  return { ok: true, message: updated, locationId };
}

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

const MAX_CLIENT_LOG_ENTRIES = 200;

// Deliberately unauthenticated, same posture as GET /healthz — not /v1/whoami, which does 401
// without a valid key. The errors most worth capturing here are exactly the ones that happen
// before whoami() resolves (a broken unlock flow, a crash during initial mount). authenticate()
// still runs, best-effort, so a userId gets attached whenever one's already resolvable; abuse
// surface is bounded by readJsonBody's existing size cap, the entries-per-request cap below, and
// fileLogBuffer's own on-disk ring cap regardless of how much gets posted.
async function handleClientLogs(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err instanceof JsonBodyTooLargeError ? 413 : 400, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const entries = (body as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) {
    sendJson(res, 400, { error: 'expected { entries: [...] }' });
    return;
  }
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  const accepted = entries.slice(0, MAX_CLIENT_LOG_ENTRIES) as ClientLogEntry[];
  recordClientLogBatch(accepted, { userId });
  sendJson(res, 202, { accepted: accepted.length });
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

// The Connections tab's CRUD surface (io/llmConnections.ts) — same id-in-path shape as
// handleFolderRoutes above. GET/POST on the collection; GET/PATCH/DELETE plus two catalog-preview
// sub-routes on one connection by id.
async function handleAdminConnectionRoutes(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps, url: URL): Promise<void> {
  const rest = url.pathname.slice('/v1/admin/connections'.length); // '' | '/<id>' | '/<id>/activate' | '/<id>/models' | '/<id>/providers' | '/<id>/test'
  const segments = rest.split('/').filter(Boolean);

  if (segments.length === 0) {
    if (req.method === 'GET') {
      sendJson(res, 200, { connections: await deps.llmConnections.list() });
      return;
    }
    if (req.method === 'POST') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const parsed = parseCreateConnectionBody(raw);
      if (!parsed) {
        sendJson(res, 400, {
          error:
            'expected { name: non-empty string, kind: "anthropic" | "openai-compatible", model: non-empty string, ' +
            'apiKey OR copyApiKeyFrom (exactly one, both non-empty strings), baseUrl? (required for openai-compatible), ' +
            'supportsVision?, providerOrder?: string[], allowFallbacks?, quantizations?: string[] }',
        });
        return;
      }
      const created = await deps.llmConnections.create(parsed);
      sendJson(res, 201, created);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const id = decodeURIComponent(segments[0]!);

  if (segments.length === 1) {
    if (req.method === 'PATCH') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const parsed = parseUpdateConnectionBody(raw);
      if (!parsed) {
        sendJson(res, 400, { error: 'expected a partial connection patch — see POST /v1/admin/connections for field shapes' });
        return;
      }
      const updated = await deps.llmConnections.update(id, parsed);
      if (!updated) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, updated);
      return;
    }
    if (req.method === 'DELETE') {
      const result = await deps.llmConnections.remove(id);
      if (result === 'not_found') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      if (result === 'is_active') {
        sendJson(res, 409, { error: 'cannot delete the active connection — activate a different one first' });
        return;
      }
      sendJson(res, 200, { deleted: true });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (segments.length === 2 && segments[1] === 'activate' && req.method === 'POST') {
    const activated = await deps.llmConnections.activate(id);
    if (!activated) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const payload = JSON.stringify({ status: 'restarting' });
    res.writeHead(202, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload, () => {
      const restart = deps.triggerRestart ?? (() => process.exit(0));
      setTimeout(restart, 100);
    });
    return;
  }

  if (segments.length === 2 && segments[1] === 'models' && req.method === 'GET') {
    let result;
    try {
      result = await listModelsForConnection(deps.llmConnections, id);
    } catch (err) {
      log.error(`failed to list models for connection "${id}"`, err);
      sendJson(res, 502, { error: 'failed to reach this connection to list its models' });
      return;
    }
    if (!result) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (segments.length === 2 && segments[1] === 'test' && req.method === 'POST') {
    const result = await testConnection(deps.llmConnections, id);
    if (!result) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (segments.length === 2 && segments[1] === 'providers' && req.method === 'GET') {
    const modelId = url.searchParams.get('model');
    if (!modelId) {
      sendJson(res, 400, { error: 'expected a ?model=<id> query parameter' });
      return;
    }
    let result;
    try {
      result = await listProvidersForConnection(deps.llmConnections, id, modelId);
    } catch (err) {
      log.error(`failed to list providers for model "${modelId}" on connection "${id}"`, err);
      sendJson(res, 502, { error: 'failed to reach this connection to list its providers' });
      return;
    }
    if (!result) {
      sendJson(res, 404, { error: 'not found, or this connection has no provider catalog' });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

// The Connections tab's image-generation section CRUD (io/imageConnections.ts, endpoint.md §3) —
// same id-in-path shape as handleAdminConnectionRoutes above. GET/POST on the collection;
// GET/PATCH/DELETE plus Test on one connection by id. No /models or /providers preview routes:
// image connections have no model/provider catalogs to browse (a kind is a fixed adapter, a model
// is a free-text id the admin types). Activation is a plain 200, deliberately NOT the LLM
// connections' 202+restart: the active image connection is resolved live on every
// generateLocationImage call (bi_principles.md §13), so switching takes effect on the next render
// with no restart.
async function handleAdminImageConnectionRoutes(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps, url: URL): Promise<void> {
  const rest = url.pathname.slice('/v1/admin/image-connections'.length); // '' | '/<id>' | '/<id>/activate' | '/<id>/test'
  const segments = rest.split('/').filter(Boolean);

  if (segments.length === 0) {
    if (req.method === 'GET') {
      sendJson(res, 200, { connections: await deps.imageConnections.list() });
      return;
    }
    if (req.method === 'POST') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const parsed = parseCreateImageConnectionBody(raw);
      if (!parsed) {
        sendJson(res, 400, {
          error:
            'expected { name: non-empty string, kind: "runware" | "fal-ai" | "pollinations" | "comfyui" | "openai-images", ' +
            'model: non-empty string, apiKey?, baseUrl?, width? (64-8192), height? (64-8192), samplingSteps?, cfgScale?, samplerName?, ' +
            'masterPositiveStylePrefix?, masterNegativePrompt?, workflowParameters? }',
        });
        return;
      }
      const created = await deps.imageConnections.create(parsed);
      sendJson(res, 201, created);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const id = decodeURIComponent(segments[0]!);

  if (segments.length === 1) {
    if (req.method === 'PATCH') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const parsed = parseUpdateImageConnectionBody(raw);
      if (!parsed) {
        sendJson(res, 400, { error: 'expected a partial image-connection patch — see POST /v1/admin/image-connections for field shapes' });
        return;
      }
      const updated = await deps.imageConnections.update(id, parsed);
      if (!updated) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, updated);
      return;
    }
    if (req.method === 'DELETE') {
      const result = await deps.imageConnections.remove(id);
      if (result === 'not_found') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      if (result === 'is_active') {
        sendJson(res, 409, { error: 'cannot delete the active image connection — activate a different one first' });
        return;
      }
      sendJson(res, 200, { deleted: true });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (segments.length === 2 && segments[1] === 'activate' && req.method === 'POST') {
    let activated: boolean;
    try {
      activated = await deps.imageConnections.activate(id);
    } catch (err) {
      // activate() throws (rolling back) when the target vanished mid-transaction — from the
      // client's perspective the id is gone, so this is a 404, not a 500. Any other error here
      // (a genuine DB failure) also reads as not-found; the atomic rollback guarantees state was
      // never corrupted either way (bi_principles.md §11: log the seam).
      log.error(`image connection activation failed for "${id}"`, err);
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!activated) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    // 200, not the LLM connections' 202+restart — the active image connection is resolved live
    // on every generation call (see the handler's doc comment above).
    sendJson(res, 200, { activated: true });
    return;
  }

  if (segments.length === 2 && segments[1] === 'test' && req.method === 'POST') {
    const result = await testImageConnection(deps.imageConnections, deps.settings, id);
    if (!result) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

async function handleImageSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getImageSettings(deps.settings));
}

async function handleImageSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const parsed = parseSetImageSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { template?: string, describer_prompt?: string, describer_history_pairs?: string }' });
    return;
  }
  await setImageSettings(deps.settings, parsed);
  sendJson(res, 200, await getImageSettings(deps.settings));
}

// location.md §6.3 — the Locations page's unified settings surface: the tracker's three keys
// plus the room describer's two (moved entirely from the Backgrounds page; the image-settings
// endpoint above still accepts the describer_* keys for back-compat). Same admin gate + live
// no-restart shape as every other settings pair.
async function handleLocationSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getLocationSettings(deps.settings));
}

async function handleLocationSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const parsed = parseSetLocationSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, {
      error: 'expected { split_enabled?, injection_enabled?, injection_prompt?, describer_prompt?, describer_history_pairs? }',
    });
    return;
  }
  await setLocationSettings(deps.settings, parsed);
  sendJson(res, 200, await getLocationSettings(deps.settings));
}

// location.md §6.2.4 — the Locations page's read-only known-locations browser (parent/sub
// grouping, lifecycle status, image thumbnail). Cross-user admin roster, same as the render-
// status table; read-only, no POST counterpart.
async function handleLocationsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, { locations: await getLocationsAdmin(deps.db) });
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

// parallax_fade_teststep.md §2.2's admin write side — the SettingsView "Chat Background" toggle.
// Same admin gate and no-restart shape as /v1/admin/timezone: the value is read live by ChatView
// at chat load, so flipping it takes effect on the next visit without a restart.
async function handleChatBackgroundSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const value = parseSetChatBackgroundSettingsBody(raw);
  if (!value) {
    sendJson(res, 400, {
      error:
        'expected a partial { parallaxEnabled?, overlayOpacity?, overlayShade?, bubbleOpacity?, bubbleUserShade?, bubbleAssistantShade? } with at least one field',
    });
    return;
  }

  await setChatBackgroundSettings(deps.settings, value);
  sendJson(res, 200, await getChatBackgroundSettings(deps.settings));
}

// migration 0074's admin write side — the ChatView "Text legibility" collapsible menu in the
// chat settings rail (components/chat/LegibilityMenu.tsx). Same admin gate and no-restart shape
// as /v1/admin/timezone / the chat-background pair: each toggle POSTs its partial patch
// immediately (household-wide, applies to all chats), ChatView re-reads the set live at chat
// load, so there is no restart and no rebuild for a look change.
async function handleChatLegibilitySettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const value = parseSetChatLegibilitySettingsBody(raw);
  if (!value) {
    sendJson(res, 400, {
      error:
        'expected a partial { halo?, haloStrength?, outline?, solidCode?, weightBump?, hoverFocus? } with at least one field',
    });
    return;
  }

  await setChatLegibilitySettings(deps.settings, value);
  sendJson(res, 200, await getChatLegibilitySettings(deps.settings));
}

// docs/chat-memory.md — profileNames comes from deps.llmConnections.list() (the live, admin-managed
// set, io/llmConnections.ts), everything else is live-read via adminServer.ts.
async function handleChatMemorySettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const settings = await getChatMemorySettings(deps.settings);
  const profileNames = (await deps.llmConnections.list()).map((c) => c.name);
  sendJson(res, 200, { ...settings, profileNames });
}

async function handleChatMemorySettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetChatMemorySettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, {
      error:
        'expected at least one of { profile?, live_window_pairs?: positive number, sync_every_pairs?: positive number, ' +
        'digest_horizon_pairs?: positive number, chunk_summary_prompt?, distill_prompt?, household_memory_prompt? }',
    });
    return;
  }

  await setChatMemorySettings(deps.settings, parsed);
  // No restart needed — the next sync tick (orchestrator/src/orchestrator/chatMemorySync.ts) reads
  // every one of these live.
  const settings = await getChatMemorySettings(deps.settings);
  const profileNames = (await deps.llmConnections.list()).map((c) => c.name);
  sendJson(res, 200, { ...settings, profileNames });
}

// The review panel's actual data (bi_principles.md §11) — read-only, no POST counterpart, since
// this reports what the background sync loop (orchestrator/chatMemorySync.ts) already did rather
// than configuring anything.
async function handleChatMemorySyncStatusGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, { chats: await getChatMemorySyncStatus(deps.db) });
}

// The Backgrounds tab's proof-it-ran read: which render stages each recent location actually
// completed (describeLocation.ts's described/defined halves, generateLocationImage.ts's
// rendered/hash), cross-user like getChatMemorySyncStatus above — admin-gated, read-only.
async function handleLocationRenderStatusGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, { locations: await getLocationRenderStatus(deps.db) });
}

// docs/canonize-plan.md §6 — canon settings are live-read (recall_canon_facts reads
// canon_recall_top_k on every call), so a save here takes effect immediately, no restart, same
// shape as notification settings above.
async function handleCanonSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getCanonSettings(deps.settings));
}

async function handleCanonSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetCanonSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, {
      error: 'expected at least one of { recall_top_k?: positive integer, extraction_prompt?: string }',
    });
    return;
  }
  await setCanonSettings(deps.settings, parsed);
  // No restart needed — recall_canon_facts reads canon_recall_top_k live on every call.
  sendJson(res, 200, await getCanonSettings(deps.settings));
}

// docs/lorebook-plan.md §3d/§8a — the Lorebooks page's settings panel. Like canon settings,
// resolveLorebook reads the §3d keys live every turn, so a save here takes effect immediately.
async function handleLorebookSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getLorebookSettings(deps.settings));
}

async function handleLorebookSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetLorebookSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, {
      error:
        'expected at least one of { lorebook_mode?: "on" | "off", lorebook_token_budget?: positive number | null, ' +
        'lorebook_recall_top_k?: positive integer, lorebook_recursion_enabled?: boolean }',
    });
    return;
  }
  await setLorebookSettings(deps.settings, parsed);
  sendJson(res, 200, await getLorebookSettings(deps.settings));
}

// docs/lorebook-plan.md §8a — the Lorebooks page's library list + entry editor. Books/entries are
// user-scoped RLS tables, so every write body carries the owning user_id (from the list response);
// the admin key grants the cross-user read, and each write runs under that user's scope.
async function handleAdminLorebookRoutes(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps, url: URL): Promise<void> {
  const segments = url.pathname.split('/').filter(Boolean); // ['v1','admin','lorebooks', ...]
  const intField = (v: unknown, min = 0, max = Infinity) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;

  if (segments[2] === 'lorebooks') {
    const rest = segments.slice(3);
    if (rest.length === 0 && req.method === 'GET') {
      sendJson(res, 200, { lorebooks: await getLorebooksAdmin(deps.db) });
      return;
    }
    if (rest.length === 0 && req.method === 'POST') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const body = raw as Record<string, unknown> | null;
      if (!body || typeof body.user_id !== 'string' || !body.user_id || typeof body.name !== 'string' || !body.name.trim()) {
        sendJson(res, 400, { error: 'expected { user_id: string, name: non-empty string }' });
        return;
      }
      const created = await createLorebookAdmin(deps.db, body.user_id, body.name.trim());
      if (!created) {
        sendJson(res, 404, { error: 'user not found' });
        return;
      }
      sendJson(res, 201, created);
      return;
    }
    // Import (step 7): POST /v1/admin/lorebooks/import with an ST world-info export
    // `{ user_id, world_info: { name, entries: { [uid]: entryObject } } }` — parses into a new
    // book with source_json capturing each entryObject verbatim (0051's format).
    if (rest.length === 1 && rest[0] === 'import' && req.method === 'POST') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const body = raw as { user_id?: unknown; world_info?: unknown } | null;
      const wi = body?.world_info;
      if (!body || typeof body.user_id !== 'string' || !body.user_id || typeof wi !== 'object' || wi === null || Array.isArray(wi)) {
        sendJson(res, 400, { error: 'expected { user_id: string, world_info: { name, entries } }' });
        return;
      }
      const worldInfo = wi as { name?: unknown; entries?: unknown };
      if (typeof worldInfo.name !== 'string' || !worldInfo.name.trim() || worldInfo.entries === undefined) {
        sendJson(res, 400, { error: 'world_info must have a non-empty name and an entries object' });
        return;
      }
      const result = await importLorebookWorldInfo(deps.db, deps.embeddings, body.user_id, worldInfo.name, worldInfo.entries);
      if (!result) {
        sendJson(res, 400, { error: 'import failed — unknown user, blank name, or malformed entries (uid keys must be non-negative integers, values must be objects)' });
        return;
      }
      sendJson(res, 201, result);
      return;
    }
    if (rest.length === 1 && rest[0] !== 'import') {
      const lorebookId = decodeURIComponent(rest[0]!);
      if (req.method === 'PATCH') {
        let raw: unknown;
        try {
          raw = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: 'expected a JSON request body' });
          return;
        }
        const body = raw as Record<string, unknown> | null;
        if (!body || typeof body.user_id !== 'string' || !body.user_id) {
          sendJson(res, 400, { error: 'expected { user_id: string, ... }' });
          return;
        }
        const patch: { name?: string; globalScope?: boolean; characterIds?: string[] } = {};
        if (body.name !== undefined) {
          if (typeof body.name !== 'string' || !body.name.trim()) {
            sendJson(res, 400, { error: 'name must be a non-empty string' });
            return;
          }
          patch.name = body.name.trim();
        }
        if (body.global_scope !== undefined) {
          if (typeof body.global_scope !== 'boolean') {
            sendJson(res, 400, { error: 'global_scope must be a boolean' });
            return;
          }
          patch.globalScope = body.global_scope;
        }
        if (body.character_ids !== undefined) {
          if (!Array.isArray(body.character_ids) || body.character_ids.some((c) => typeof c !== 'string')) {
            sendJson(res, 400, { error: 'character_ids must be an array of strings' });
            return;
          }
          patch.characterIds = body.character_ids as string[];
        }
        const updated = await updateLorebookAdmin(deps.db, body.user_id, lorebookId, patch);
        if (!updated) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        sendJson(res, 200, { updated: true });
        return;
      }
      if (req.method === 'DELETE') {
        const userId = url.searchParams.get('userId');
        if (!userId) {
          sendJson(res, 400, { error: 'expected ?userId= query param' });
          return;
        }
        const deleted = await deleteLorebookAdmin(deps.db, userId, lorebookId);
        if (!deleted) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        sendJson(res, 200, { deleted: true });
        return;
      }
    }
    // Export (step 7): GET /v1/admin/lorebooks/:id/export?userId= — reverses the import
    // losslessly (§7): `{ name, entries: { [uid]: entryObject } }` with entryObject = the
    // verbatim source_json when the entry was imported, else an ST-shaped reconstruction.
    if (rest.length === 2 && rest[1] === 'export' && req.method === 'GET') {
      const lorebookId = decodeURIComponent(rest[0]!);
      const userId = url.searchParams.get('userId');
      if (!userId) {
        sendJson(res, 400, { error: 'expected ?userId= query param' });
        return;
      }
      const exported = await exportLorebookWorldInfo(deps.db, userId, lorebookId);
      if (!exported) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, exported);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (segments[2] === 'lorebook-entries') {
    const rest = segments.slice(3);
    if (rest.length === 0 && req.method === 'POST') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const body = raw as Record<string, unknown> | null;
      if (!body || typeof body.user_id !== 'string' || !body.user_id || typeof body.lorebook_id !== 'string' || typeof body.content !== 'string') {
        sendJson(res, 400, { error: 'expected { user_id: string, lorebook_id: string, content: string, ... }' });
        return;
      }
      const input: LorebookEntryInput = {
        lorebookId: body.lorebook_id,
        content: body.content,
      };
      if (body.key !== undefined) {
        if (!Array.isArray(body.key) || body.key.some((k) => typeof k !== 'string')) {
          sendJson(res, 400, { error: 'key must be an array of strings' });
          return;
        }
        input.key = body.key as string[];
      }
      if (body.comment !== undefined) {
        if (typeof body.comment !== 'string') {
          sendJson(res, 400, { error: 'comment must be a string' });
          return;
        }
        input.comment = body.comment;
      }
      for (const [name, target] of [
        ['constant', 'constant'],
        ['disable', 'disable'],
        ['use_probability', 'useProbability'],
        ['group_override', 'groupOverride'],
      ] as const) {
        if (body[name] !== undefined) {
          if (typeof body[name] !== 'boolean') {
            sendJson(res, 400, { error: `${name} must be a boolean` });
            return;
          }
          (input as unknown as Record<string, unknown>)[target] = body[name];
        }
      }
      for (const [name, target] of [
        ['order_value', 'orderValue'],
        ['probability', 'probability'],
        ['group_weight', 'groupWeight'],
        ['sticky', 'sticky'],
        ['cooldown', 'cooldown'],
        ['delay', 'delay'],
      ] as const) {
        if (body[name] !== undefined) {
          const v = intField(body[name]);
          if (v === undefined) {
            sendJson(res, 400, { error: `${name} must be a non-negative integer` });
            return;
          }
          (input as unknown as Record<string, unknown>)[target] = v;
        }
      }
      const created = await createLorebookEntryAdmin(deps.db, deps.embeddings, body.user_id, input);
      if (!created) {
        sendJson(res, 404, { error: 'book not found' });
        return;
      }
      sendJson(res, 201, created);
      return;
    }
    if (rest.length === 1) {
      const entryId = decodeURIComponent(rest[0]!);
      if (req.method === 'PATCH') {
        let raw: unknown;
        try {
          raw = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: 'expected a JSON request body' });
          return;
        }
        const body = raw as Record<string, unknown> | null;
        if (!body || typeof body.user_id !== 'string' || !body.user_id) {
          sendJson(res, 400, { error: 'expected { user_id: string, ... }' });
          return;
        }
        const patch: LorebookEntryPatch = {};
        if (body.key !== undefined) {
          if (!Array.isArray(body.key) || body.key.some((k) => typeof k !== 'string')) {
            sendJson(res, 400, { error: 'key must be an array of strings' });
            return;
          }
          patch.key = body.key as string[];
        }
        if (body.comment !== undefined) {
          if (typeof body.comment !== 'string') {
            sendJson(res, 400, { error: 'comment must be a string' });
            return;
          }
          patch.comment = body.comment;
        }
        if (body.content !== undefined) {
          if (typeof body.content !== 'string') {
            sendJson(res, 400, { error: 'content must be a string' });
            return;
          }
          patch.content = body.content;
        }
        for (const [name, target] of [
          ['constant', 'constant'],
          ['disable', 'disable'],
          ['use_probability', 'useProbability'],
          ['group_override', 'groupOverride'],
        ] as const) {
          if (body[name] !== undefined) {
            if (typeof body[name] !== 'boolean') {
              sendJson(res, 400, { error: `${name} must be a boolean` });
              return;
            }
            (patch as unknown as Record<string, unknown>)[target] = body[name];
          }
        }
        for (const [name, target] of [
          ['order_value', 'orderValue'],
          ['probability', 'probability'],
          ['group_weight', 'groupWeight'],
          ['sticky', 'sticky'],
          ['cooldown', 'cooldown'],
          ['delay', 'delay'],
        ] as const) {
          if (body[name] !== undefined) {
            const v = intField(body[name]);
            if (v === undefined) {
              sendJson(res, 400, { error: `${name} must be a non-negative integer` });
              return;
            }
            (patch as unknown as Record<string, unknown>)[target] = v;
          }
        }
        const updated = await updateLorebookEntryAdmin(deps.db, deps.embeddings, body.user_id, entryId, patch);
        if (!updated) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        sendJson(res, 200, { updated: true });
        return;
      }
      if (req.method === 'DELETE') {
        const userId = url.searchParams.get('userId');
        if (!userId) {
          sendJson(res, 400, { error: 'expected ?userId= query param' });
          return;
        }
        const deleted = await deleteLorebookEntryAdmin(deps.db, userId, entryId);
        if (!deleted) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        sendJson(res, 200, { deleted: true });
        return;
      }
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

async function handleNotificationSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getNotificationSettings(deps.settings));
}

async function handleNotificationSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetNotificationSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { server_url?: non-empty string, enabled?: boolean }, at least one' });
    return;
  }

  await setNotificationSettings(deps.settings, parsed);
  // No restart needed — the next send_push_notification call reads both fields live.
  sendJson(res, 200, await getNotificationSettings(deps.settings));
}

// Admin-gated counterpart to handleScreenLockSettingsGet above — same value, but this is the
// Settings tab's own read (and the only place the password gets written), so it's behind the
// admin key like every other Settings-tab field, not the lighter household gate the overlay uses.
async function handleAdminScreenLockSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getScreenLockSettings(deps.settings));
}

// GET /v1/characters/chub-avatar?url= — the one place a chub CDN URL crosses straight from the
// browser (BrowseChubView.tsx's search-result grid) rather than through a tool call, so it needs
// its own guard beyond fetchThroughPiaProxy: an unrestricted `url` param would make this an open
// image-fetch relay to anywhere on the internet (an SSRF hole reachable from any authenticated
// household member's browser, not just an LLM tool call). Restricted to chub's own avatar CDN
// host, confirmed live (2026-08-05) as the host every avatar_url/max_res_url in chub's search and
// character-detail responses actually uses.
const CHUB_AVATAR_ALLOWED_HOSTS = new Set(['avatars.charhub.io']);

async function handleChubAvatarProxy(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const target = new URL(req.url ?? '', 'http://placeholder').searchParams.get('url');
  if (!target) {
    sendJson(res, 400, { error: 'missing url query param' });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    sendJson(res, 400, { error: 'invalid url' });
    return;
  }
  if (!CHUB_AVATAR_ALLOWED_HOSTS.has(parsed.hostname)) {
    sendJson(res, 400, { error: `url must be hosted on one of: ${Array.from(CHUB_AVATAR_ALLOWED_HOSTS).join(', ')}` });
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetchThroughPiaProxy(deps.settings, target);
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : 'chub-avatar proxy fetch failed' });
    return;
  }
  if (!upstream.ok) {
    sendJson(res, upstream.status, { error: `chub.ai returned HTTP ${upstream.status}` });
    return;
  }

  const bytes = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'content-length': bytes.length,
  });
  res.end(bytes);
}

// GET/POST /v1/admin/pia-proxy-settings — admin-only, no household-authed counterpart (unlike
// timezone/screen-lock): pia_proxy_url is only ever read server-side, by io/piaProxyFetch.ts, never
// by the frontend directly.
async function handlePiaProxyUrlGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, { url: await getPiaProxyUrl(deps.settings) });
}

async function handlePiaProxyUrlSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const value = parseSetPiaProxyUrlBody(raw);
  if (!value) {
    sendJson(res, 400, { error: 'expected { value: a non-empty http(s) URL, e.g. "http://pia-proxy:8080" }' });
    return;
  }

  await setPiaProxyUrl(deps.settings, value);
  sendJson(res, 200, { url: await getPiaProxyUrl(deps.settings) });
}

// GET/POST /v1/admin/persona-settings — the household's own name/description
// (docs/plans/prompt-macros.md's Stage 1), read live by
// plugins/context-stack-presets' applyPromptStackToChatTool.ts. Same admin-authed,
// read-back-in-full shape as screen-lock/notification settings.
async function handlePersonaSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getPersonaSettings(deps.settings));
}

async function handlePersonaSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const body = parseSetPersonaSettingsBody(raw);
  if (!body) {
    sendJson(res, 400, { error: 'expected { name?: string, description?: string }, at least one present' });
    return;
  }

  await setPersonaSettings(deps.settings, body);
  // No restart needed — applyPromptStackToChatTool.ts reads both fields live on every apply.
  sendJson(res, 200, await getPersonaSettings(deps.settings));
}

async function handleAdminScreenLockSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetScreenLockSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { password?: string, timeout_minutes?: positive number }, at least one' });
    return;
  }

  await setScreenLockSettings(deps.settings, parsed);
  // No restart needed — ScreenLockOverlay.tsx polls /v1/screen-lock-settings live.
  sendJson(res, 200, await getScreenLockSettings(deps.settings));
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
  cleanup_preset_id?: string | null;
  cleanup_enabled_at?: string | null;
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
  if (v.cleanup_preset_id !== undefined && v.cleanup_preset_id !== null && typeof v.cleanup_preset_id !== 'string') {
    return false;
  }
  // '' is never a valid preset id — rejecting it here (instead of letting it reach Postgres's
  // uuid cast and 500) keeps a malformed patch a 400 like every other bad field.
  if (v.cleanup_preset_id === '') return false;
  if (v.cleanup_enabled_at !== undefined && v.cleanup_enabled_at !== null && typeof v.cleanup_enabled_at !== 'string') {
    return false;
  }
  if (v.cleanup_enabled_at === '') return false;
  return true;
}

// chat_memory_live_window_pairs / chat_memory_sync_every_pairs are stored as text and read live
// every sync tick by chatMemorySync.ts's resolveSyncSettings — this mirrors that parse (same
// positive-int-or-fallback shape) so the "when is the next sync due" math the UI shows never
// drifts from the loop's own.
function pairsSetting(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
      const kindParam = url.searchParams.get('kind');
      const kind = kindParam === 'chat' || kindParam === 'rp' ? kindParam : undefined;
      sendJson(res, 200, { chats: await deps.chats.listChats(userId, { search, folderId, kind }) });
      return;
    }
    if (req.method === 'POST') {
      const body = (await readJsonBody(req)) as { title?: string; folder_id?: string; kind?: string };
      const kind = body.kind === 'rp' ? 'rp' : undefined;
      const session = await deps.chats.createChat(userId, {
        title: typeof body.title === 'string' ? body.title : undefined,
        folderId: typeof body.folder_id === 'string' ? body.folder_id : undefined,
        kind,
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
      // Display-side macro resolution (docs/plans/prompt-macros.md's Stage 1, bi_principles.md §1): the
      // chat UI renders a message's resolvedContent — a per-read derived copy — so a character's
      // seeded greeting shows "Jeremy, …" instead of the literal {{user}} token, while the
      // canonical content stays verbatim and the client keeps re-sending it, so the per-turn
      // resolution pass (assembleSessionTurnContext) keeps re-resolving against the live persona —
      // a persona edit updates the greeting on the very next read with no re-apply. Gated like
      // every other macro pass: 'rp' chats only, and only when a message actually contains '{{'.
      if (detail.session.kind === 'rp' && detail.messages.some((m) => m.content.includes('{{'))) {
        const snapshot = await buildMacroSnapshot(deps.db, deps.settings, userId, detail.session.characterId);
        detail.messages = detail.messages.map((m) =>
          m.content.includes('{{') ? { ...m, resolvedContent: interpolateMacros(m.content, snapshot) } : m,
        );
      }
      sendJson(res, 200, detail);
      // endpoint.md §5.1.8's "restart bg discovery on return": a chat (re)open may find its
      // active location without a rendered image (a pass dropped by a swipe, or a failed
      // render) — fire the cache-first generation pass so discovery resumes. No-op whenever the
      // image already exists or a render is already in flight.
      void ensureActiveLocationImage(deps, userId, chatId);
      return;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!isChatPatchBody(body)) {
        sendJson(res, 400, { error: 'expected { title?, folder_id?, params?, tool_names?, canvas_note_id?, cleanup_preset_id?, cleanup_enabled_at? }' });
        return;
      }
      const updated = await deps.chats.updateChat(userId, chatId, {
        title: body.title,
        folderId: body.folder_id,
        params: body.params,
        toolNames: body.tool_names,
        canvasNoteId: body.canvas_note_id,
        cleanupPresetId: body.cleanup_preset_id,
        cleanupEnabledAt: body.cleanup_enabled_at,
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
      if (deleted) clearPromptTrace(chatId);
      sendJson(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: 'not found' });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (segments[1] === 'fork' && segments.length === 2 && req.method === 'POST') {
    const body = await readJsonBody(req);
    const fromMessageId = typeof (body as Record<string, unknown>)?.from_message_id === 'string'
      ? (body as { from_message_id: string }).from_message_id
      : undefined;
    const title = typeof (body as Record<string, unknown>)?.title === 'string' ? (body as { title: string }).title : undefined;
    if (!fromMessageId) {
      sendJson(res, 400, { error: 'expected { from_message_id: string, title?: string }' });
      return;
    }
    const forked = await deps.chats.forkChat(userId, chatId, fromMessageId, title);
    if (!forked) {
      sendJson(res, 404, { error: 'not found — chatId or from_message_id does not exist in this chat' });
      return;
    }
    sendJson(res, 201, forked);
    return;
  }

  if (segments[1] === 'archive' && segments.length === 2 && req.method === 'POST') {
    const archived = await deps.chats.archiveChat(userId, chatId);
    if (!archived) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    // Fire-and-forget: the end-of-chat memory judgment call can take a few seconds and the archive
    // action itself has already fully succeeded (archived_at is stamped) — a failure here is
    // logged, not surfaced as a failed archive (bb_principles.md §11: a discarded path is logged
    // with why, not silently swallowed, but it doesn't need to block the caller either). Skipped
    // entirely for an 'rp' chat — it never wrote to household_memory in its system prompt either
    // (buildChatMemorySystemPrompt above), so it shouldn't write inferred facts back into it now.
    if (archived.kind !== 'rp') {
      archiveChatMemory(
        { db: deps.db, llm: deps.llm, embeddings: deps.embeddings, settings: deps.settings, llmConnections: deps.llmConnections },
        userId,
        chatId,
        archived.title,
      ).catch((err) => log.error('archive_chat: long-term-memory extraction failed', { chatId, err }));
    }
    sendJson(res, 200, archived);
    return;
  }

  if (segments[1] === 'prompt-preview' && segments.length === 2 && req.method === 'GET') {
    const result = await buildPromptPreview(deps, userId, chatId);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return;
    }
    sendJson(res, 200, result.preview);
    return;
  }

  // Branch Map panel's data source — the whole fork family this chat belongs to, root first.
  if (segments[1] === 'lineage' && segments.length === 2 && req.method === 'GET') {
    const nodes = await deps.chats.getLineage(userId, chatId);
    if (!nodes) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, { nodes });
    return;
  }

  // Per-chat slice of the rolling sync loop's status record (io/chatSessions.ts's
  // getChatSyncStatus) — the RP chat header menu's "Sync status" panel. User-scoped like every
  // other chat route (a user's own chat's sync history is no more sensitive than the chat
  // itself), unlike the cross-user Review Panel endpoint /v1/admin/chat-memory-sync-status.
  // dueAfterMessages is computed from the same DB-backed settings the loop reads live every tick,
  // falling back to the loop's own defaults when unset.
  if (segments[1] === 'sync-status' && segments.length === 2 && req.method === 'GET') {
    const [livePairsRaw, syncEveryPairsRaw] = await Promise.all([
      deps.settings.get('chat_memory_live_window_pairs'),
      deps.settings.get('chat_memory_sync_every_pairs'),
    ]);
    const livePairs = pairsSetting(livePairsRaw, DEFAULT_LIVE_WINDOW_PAIRS);
    const syncEveryPairs = pairsSetting(syncEveryPairsRaw, DEFAULT_SYNC_EVERY_PAIRS);
    const sync = await deps.chats.getChatSyncStatus(userId, chatId, (livePairs + syncEveryPairs) * 2);
    if (!sync) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, { sync });
    return;
  }

  // One sync point's full inspection record (io/chatSessions.ts's getChatSyncInspection, 0079) —
  // what that pass actually produced: the memory entries it created/changed, the canon-fact
  // proposals it wrote, and the bridge prompt it sent the model. Fetched on demand when the Sync
  // Status panel expands a sync row, so the 30s status poll above never ships the heavy detail.
  if (segments[1] === 'syncs' && segments.length === 3 && req.method === 'GET') {
    const inspection = await deps.chats.getChatSyncInspection(userId, chatId, segments[2]);
    if (!inspection) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, { sync: inspection });
    return;
  }

  // Lorebook chat-sidebar panel (io/lorebook/panelData.ts, plan §8b) — user-scoped like every
  // other chat route: a user's own chat's lorebook state is no more sensitive than the chat
  // itself, so it rides the regular authenticated key, not the admin key. Returns the resolved
  // mode, the §3b in-scope books (with all entries, override state, and the §8b live-activation
  // badge from lorebook_activation_log's latest message), or an empty mode-correct panel on
  // failure — never an error the chat view has to survive.
  if (segments[1] === 'lorebook-panel' && segments.length === 2 && req.method === 'GET') {
    const detail = await deps.chats.getChat(userId, chatId);
    if (!detail) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const latestAssistantMessageId = [...detail.messages].reverse().find((m) => m.role === 'assistant')?.messageId ?? null;
    sendJson(
      res,
      200,
      await getLorebookPanelData(deps.db, deps.settings, {
        userId,
        chatId,
        characterId: detail.session.characterId,
        latestAssistantMessageId,
      }),
    );
    return;
  }

  if (segments[1] === 'lorebook-book-override' && segments.length === 2 && req.method === 'PUT') {
    const body = (await readJsonBody(req)) as { lorebook_id?: unknown; enabled?: unknown };
    if (typeof body.lorebook_id !== 'string' || typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { error: 'lorebook_id (string) and enabled (boolean) are required' });
      return;
    }
    const ok = await setLorebookChatOverride(deps.db, userId, chatId, body.lorebook_id, body.enabled);
    if (!ok) {
      sendJson(res, 404, { error: 'book not found' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (segments[1] === 'lorebook-entry-override' && segments.length === 2 && req.method === 'PUT') {
    const body = (await readJsonBody(req)) as { entry_id?: unknown; enabled?: unknown };
    if (typeof body.entry_id !== 'string' || typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { error: 'entry_id (string) and enabled (boolean) are required' });
      return;
    }
    const ok = await setLorebookEntryOverride(deps.db, userId, chatId, body.entry_id, body.enabled);
    if (!ok) {
      sendJson(res, 404, { error: 'entry not found' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (segments[1] === 'lorebook-quick-add' && segments.length === 2 && req.method === 'POST') {
    const body = (await readJsonBody(req)) as { content?: unknown };
    if (typeof body.content !== 'string') {
      sendJson(res, 400, { error: 'content (string) is required' });
      return;
    }
    const detail = await deps.chats.getChat(userId, chatId);
    if (!detail) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const result = await quickAddLorebookEntry(deps.db, deps.embeddings, userId, chatId, detail.session.title, body.content);
    if (!result) {
      sendJson(res, 400, { error: 'content must be non-empty' });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (segments[1] === 'location-image' && segments.length === 2 && req.method === 'GET') {
    // endpoint.md §6.4's chat background layer: resolve the chat's active location image — the
    // current eligible location (scene_id pointer, active-swipe fallback) plus the last settled
    // location (previous_scene_id). A current location whose image hasn't rendered yet comes
    // back with imageUrl: null — the post-turn bg pass (endpoint.md §5) fires after the reply
    // is sent, so the client keeps the previous background (or its current one) until the
    // pending render lands, never blanking the layer (§5.1.8).
    const image = await resolveChatLocationImage(deps.db, userId, chatId);
    sendJson(res, 200, {
      current: image.current ?? { locationId: null, name: null, definition: null, imageUrl: null },
      previous: image.previous ?? { locationId: null, name: null, definition: null, imageUrl: null },
    });
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
    if (segments.length === 4 && segments[3] === 'edit' && req.method === 'POST') {
      // In-place content rewrite (the Chat tab's "edit an LLM reply") — message keeps its id,
      // everything chronologically after it is untouched, and the pre-edit text is preserved as
      // a swipe (recordSwipeIfContent's stash-the-original path). Unlike the truncate+resend
      // user-edit, there is no "must be the last message" restriction: rewriting an earlier
      // reply's text is coherent mid-conversation, and swiping never touches earlier messages.
      const body = await readJsonBody(req);
      const content = (body as Record<string, unknown>)?.content;
      if (typeof content !== 'string' || !content.trim()) {
        sendJson(res, 400, { error: 'expected { content: non-empty string }' });
        return;
      }
      const detail = await deps.chats.getChat(userId, chatId);
      if (!detail) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      // No-op guard: identical text must not mint a junk swipe in the canonical record — the
      // frontend already skips the call, but a raw-API client shouldn't corrupt the swipe list
      // either (each edit otherwise appends a swipe, exactly like a regeneration would).
      const existing = detail.messages.find((m) => m.messageId === messageId);
      if (existing && existing.content === content) {
        sendJson(res, 200, { message: await decorateMessageForDisplay(deps.db, deps.settings, userId, detail.session, existing) });
        return;
      }
      const updated = await deps.chats.editMessageContent(userId, chatId, messageId, content);
      if (!updated) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, { message: await decorateMessageForDisplay(deps.db, deps.settings, userId, detail.session, updated) });
      // The edit made a new swipe active; if that swipe's location has no rendered image yet
      // (or the location changed under it), restart bg discovery — cache-first, so this is a
      // no-op whenever an image already exists or a render is in flight (see ensureActiveLocationImage).
      void ensureActiveLocationImage(deps, userId, chatId);
      return;
    }
    if (segments.length === 4 && segments[3] === 'swipe' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const direction = (body as Record<string, unknown>)?.direction;
      if (direction !== 'prev' && direction !== 'next') {
        sendJson(res, 400, { error: 'expected { direction: "prev" | "next" }' });
        return;
      }
      // rp-streaming-plan.md: the swipe route accepts the same optional stream flag the completions
      // route does (default false — omitted is identical to false, fully backward compatible).
      // Only an RP chat's needs_regenerate outcome streams; prev/next cycling (pure content swaps,
      // no LLM call) and non-RP swipes are unaffected and stay plain JSON.
      const stream = (body as Record<string, unknown>)?.stream === true;

      // Swiping only ever touches the chat's current last message (this module's own preamble) —
      // enforced here, not left to cycleSwipe/recordSwipe, since an id belonging to an earlier
      // turn is a client bug (a stale UI) rather than something the store should silently allow.
      const detail = await deps.chats.getChat(userId, chatId);
      const last = detail?.messages[detail.messages.length - 1];
      if (!detail || !last || last.messageId !== messageId || last.role !== 'assistant') {
        sendJson(res, 404, { error: "not found — messageId must be this chat's current last assistant reply" });
        return;
      }

      const cycled = await deps.chats.cycleSwipe(userId, chatId, messageId, direction);
      if (cycled.status === 'not_found') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      if (cycled.status === 'switched') {
        sendJson(res, 200, { message: await decorateMessageForDisplay(deps.db, deps.settings, userId, detail.session, cycled.message) });
        // endpoint.md §5.1.8's "restart bg discovery on return": cycling made a different swipe
        // active — if its location has no rendered image yet (a pass dropped by the earlier
        // swipe, or never run), fire the cache-first generation pass; if it has one, the
        // per-swipe association makes the read a reuse, no provider call. No-op when the image
        // exists or a render is already in flight.
        void ensureActiveLocationImage(deps, userId, chatId);
        return;
      }
      if (cycled.status === 'no_earlier_swipe') {
        sendJson(res, 200, { status: 'no_earlier_swipe' });
        return;
      }
      // needs_regenerate: 'next' past the newest stored variant — this is "Rerun" (this module's
      // own preamble on the swipe route). Except when this message is the chat's only message: that
      // means it's the seeded opening greeting (applyCharacterToChatTool.ts only ever seeds one when
      // the chat has zero prior messages) and its "variants" are a card's pre-written
      // alternate_greetings, not an earlier LLM turn — there is no prior user message to regenerate a
      // reply to, and regenerateSwipe would otherwise run the LLM with an empty message history to
      // fabricate one. Content the platform was handed, not content the LLM reasoned about, so it's
      // never a Rerun candidate — cycling stops at the last stored greeting instead.
      if (detail.messages.length === 1) {
        sendJson(res, 200, { status: 'no_further_swipe' });
        return;
      }
      // Streaming branch, same shape as handleChatCompletions's: SSE headers deferred until the
      // first delta, deltas relayed live via onDelta, and the failure/abort outcome decided by
      // whether any bytes were already committed. A dropped client connection cancels the LLM call
      // (plan Edge Cases) — detached on every exit so a late close can't abort the next turn.
      const streamingRp = detail.session.kind === 'rp' && stream === true;
      const sseId = `chatcmpl-${randomUUID()}`;
      let streamHeadersSent = false;
      const onClientClose = () => {
        if (streamingRp) abortTurn(chatId);
      };
      if (streamingRp) req.on('close', onClientClose);
      const onDelta = (delta: string) => {
        if (!streamHeadersSent) {
          writeStreamHeaders(res);
          streamHeadersSent = true;
        }
        res.write(`data: ${JSON.stringify(buildChatCompletionChunk(detail.session.params.model ?? '', sseId, { role: 'assistant', content: delta }, null))}\n\n`);
      };
      const result = await regenerateSwipe(deps, userId, chatId, detail, messageId, streamingRp, onDelta);
      if (!result.ok) {
        if (streamingRp && streamHeadersSent) {
          // Streaming had already begun: headers are committed, so surface the failure/abort as
          // the terminal frame before [DONE] instead of an HTTP status change (plan Contracts).
          // Nothing was persisted (recordSwipe never ran) — the client that sees this frame knows
          // the regeneration didn't complete.
          log.error(`swipe regenerate failed for chat ${chatId} after streaming began`, result.error);
          writeStreamErrorTerminalFrame(res, result.aborted === true, result.error);
          req.off('close', onClientClose);
          return;
        }
        // 499 = the user stopped this regeneration (POST /v1/chat/abort) — same contract as the
        // main turn's aborted response, so the frontend treats both the same way.
        req.off('close', onClientClose);
        sendJson(res, result.aborted ? 499 : 500, { error: result.error });
        return;
      }
      if (streamingRp) {
        // The stream resolved and recordSwipe persisted the regenerated swipe above. The final SSE
        // frames go out only now — a client that sees [DONE] can trust the swipe is already saved
        // (plan Logic), the same guarantee the non-streaming response gives.
        if (!streamHeadersSent) writeStreamHeaders(res);
        res.write(`data: ${JSON.stringify(buildChatCompletionChunk(detail.session.params.model ?? '', sseId, {}, 'stop'))}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        req.off('close', onClientClose);
        // endpoint.md §5: fire the location-image generation pass only once the reply is actually
        // sent — a provider round-trip has no place in the request path, so the trigger rides the
        // response's 'finish' event, decoupled the same way chatMemorySync.ts's tick is.
        if (result.locationId) {
          res.once('finish', () => fireLocationImageGeneration(deps, userId, chatId, result.locationId!));
        }
        return;
      }
      sendJson(res, 200, { message: await decorateMessageForDisplay(deps.db, deps.settings, userId, detail.session, result.message) });
      // endpoint.md §5: fire the location-image generation pass only once the reply is actually
      // sent — a provider round-trip has no place in the request path, so the trigger rides the
      // response's 'finish' event, decoupled the same way chatMemorySync.ts's tick is.
      if (result.locationId) {
        res.once('finish', () => fireLocationImageGeneration(deps, userId, chatId, result.locationId!));
      }
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

// A lightweight side channel for a chat still mid-flight (docs/bootstrap.md: /v1/chat/completions
// is a single blocking POST, not a stream) — the frontend polls this while waiting, to show which
// tool loop.ts's runTurn is currently running (orchestrator/turnStatus.ts). taskId for a
// persisted-session turn is always its chat_id (httpServer.ts's own handleChatCompletions), so
// that's what this keys on; no status ever existing (not yet started, already finished, or a
// stateless Open WebUI turn with no chat_id) is a normal, empty response, not an error.
async function handleChatTurnStatus(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  const chatId = new URL(req.url ?? '', 'http://placeholder').searchParams.get('chat_id');
  sendJson(res, 200, { status: chatId ? (getTurnStatus(chatId) ?? null) : null });
}

// The Stop button's server side (orchestrator/turnAbort.ts): abort every LLM task currently in
// flight for this chat — the interactive turn runTurn is running AND any cleanup-loop repair
// churning on the same chat (the stop is meant to kill the chat's whole active LLM spend at
// once). 200 means at least one task was aborted; 404 means nothing was in flight (turn already
// finished, or never started — a no-op, not an error). Ownership-checked via chats.getChat so a
// user can only stop their own chat's work, unlike the read-only /v1/chat/status side channel.
async function handleChatAbort(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  let body: { chat_id?: string };
  try {
    body = (await readJsonBody(req)) as { chat_id?: string };
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  if (typeof body.chat_id !== 'string' || !body.chat_id) {
    sendJson(res, 400, { error: 'expected { chat_id: string }' });
    return;
  }
  const chat = await deps.chats.getChat(userId, body.chat_id);
  if (!chat) {
    sendJson(res, 404, { error: 'unknown chat_id' });
    return;
  }
  const aborted = abortTurn(body.chat_id);
  if (!aborted) {
    sendJson(res, 404, { error: 'no turn in flight for this chat' });
    return;
  }
  sendJson(res, 200, { aborted: true });
}

// The async cleanup subloop's (cleanupLoop.ts) read surface for the chat's floating status pill —
// the TRG-style unchanged | thinking | modified | ⚠flagged state of the newest eligible message,
// plus how many messages are still pending. Polled by the frontend the same way it polls
// /v1/chat/status; the loop's per-message jobs in cleanup_jobs are the source of truth.
async function handleCleanupStatus(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  const chatId = new URL(req.url ?? '', 'http://placeholder').searchParams.get('chat_id');
  if (!chatId) {
    sendJson(res, 400, { error: 'expected a ?chat_id= query parameter' });
    return;
  }
  const status = await getCleanupStatus(deps.db, userId, chatId);
  if (!status) {
    sendJson(res, 404, { error: 'unknown chat_id' });
    return;
  }
  sendJson(res, 200, status);
}

// The Cleanup page's run-now: one immediate pass over one chat (the poll tick keeps every other
// enabled chat). Fire-and-forget like fireLocationImageGeneration — the request returns at once
// and the caller polls GET /v1/cleanup/status for the results; the loop is fail-open throughout,
// so there's no partial-success error shape to surface.
async function handleCleanupRunNow(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  let body: { chat_id?: string };
  try {
    body = (await readJsonBody(req)) as { chat_id?: string };
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  if (typeof body.chat_id !== 'string' || !body.chat_id) {
    sendJson(res, 400, { error: 'expected { chat_id: string }' });
    return;
  }
  void runCleanupNow({ db: deps.db, llm: deps.llm, settings: deps.settings, chats: deps.chats }, userId, body.chat_id);
  sendJson(res, 202, { started: true });
}

// The Cleanup page's "recent activity" read: the newest cleanup_jobs rows for one chat (the page
// picks the chat via a selector), each with a short content preview and the fail-open notes.
// User-scoped by cleanup_jobs' own RLS (via chat_messages.user_id) — a user only ever sees their
// own chats' jobs, same as /v1/cleanup/status.
async function handleCleanupJobs(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  const url = new URL(req.url ?? '', 'http://placeholder');
  const chatId = url.searchParams.get('chat_id');
  if (!chatId) {
    sendJson(res, 400, { error: 'expected a ?chat_id= query parameter' });
    return;
  }
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 20, 1), 100) : 20;
  sendJson(res, 200, { jobs: await getCleanupJobs(deps.db, userId, chatId, limit) });
}

// Admin-gated counterpart of the cleanup setup surface: the four header/footer config keys +
// the slop-rules table, read/written as one block (adminServer.ts's get/parse/set trio). The
// subloop re-reads both live every tick (cleanupLoop.ts), so a save takes effect on the next
// poll — no restart, same shape as notification/canon settings above.
async function handleCleanupSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getCleanupSettings(deps.settings, deps.db));
}

async function handleCleanupSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetCleanupSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, {
      error: 'expected at least one of { header_regex?, header_prompt?, footer_regex?, footer_prompt?, slop_rules?: [...] }',
    });
    return;
  }

  await setCleanupSettings(deps.settings, deps.db, parsed);
  sendJson(res, 200, await getCleanupSettings(deps.settings, deps.db));
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
