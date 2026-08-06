/**
 * @file orchestrator/src/server/httpServer.ts
 * @stamp 2026-08-05
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
 * POST /v1/chats/:id/messages/:messageId/swipe (body: { direction: 'prev' | 'next' }) — swipe
 * capability on the last LLM response (docs/bi_principles.md), only ever valid for messageId ==
 * this chat's current last message. cycleSwipe (io/chatSessions.ts) is a pure content swap between
 * already-stored variants for most calls; 'next' past the newest stored variant is what "Rerun"
 * actually is now (regenerateSwipe below, in place via recordSwipe, no truncate/resend) — the two
 * are the same action from the store's point of view, so the frontend's Rerun button just sends
 * 'next'. Deleting the current last turn naturally re-exposes whatever's now last with its own,
 * never-pruned swipe history still intact — no restore logic needed for that (see migration
 * 0059's own comment for why).
 *
 * handleChatCompletions also always prepends a current-date/time system message
 * (util/dateContext.ts, using the household_timezone admin setting) ahead of a chat's own custom
 * system prompt, for every turn regardless of chat_id — an LLM has no reliable sense of "today"
 * on its own, and date-taking tools need it.
 *
 * docs/prompt-macros.md's Stage 1: an 'rp' chat's system prompt is scanned for `{{char}}`/
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
import { createGatedLlmProvider } from '../io/llm/llmGate.js';
import { log } from '../io/logger.js';
import { recordClientLogBatch, type ClientLogEntry } from '../io/clientLogSink.js';
import { runTurn } from '../orchestrator/loop.js';
import { getTurnStatus } from '../orchestrator/turnStatus.js';
import { archiveChatMemory } from '../orchestrator/chatMemorySync.js';
import { appendAttachmentsToLatestUserMessage, attachImagesToLatestUserMessage } from '../util/attachmentContext.js';
import { formatCurrentDateContext } from '../util/dateContext.js';
import { interpolateMacros, type MacroSnapshot } from '../util/interpolateMacros.js';
import { assemblePromptStack, type MarkerKey, type PromptStackFields, type PromptStackSlot } from '../util/assemblePromptStack.js';
import { importCharacterCard } from './handleCharacterImport.js';
import { handleCharacterExportRoutes } from './handleCharacterExport.js';
import { extractAttachmentUpload } from './handleUploadAttachment.js';
import { fetchThroughPiaProxy } from '../io/piaProxyFetch.js';
import type { AccessIdentityResolver } from '../io/accessIdentity.js';
import type { ChatDetail, ChatParams, ChatSessionStore, StoredChatMessage } from '../io/chatSessions.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import type { LlmMessage, LlmProvider } from '../io/llm/types.js';
import type { PostgresClient } from '../io/postgres.js';
import type { ProviderCredentialStore } from '../io/providerCredentials.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { filterToolRegistry, type ToolRegistry } from '../orchestrator/toolRegistry.js';
import type { ApiKeyStore } from './apiKeyStore.js';
import {
  getCanonSettings,
  getChatMemorySettings,
  getChatMemorySyncStatus,
  getHouseholdTimezone,
  getNotificationSettings,
  getPersonaSettings,
  getPiaProxyUrl,
  getScreenLockSettings,
  listCredentials,
  listModelsForConnection,
  listProvidersForConnection,
  parseCreateConnectionBody,
  parseSetCanonSettingsBody,
  parseSetChatMemorySettingsBody,
  parseSetCredentialBody,
  parseSetNotificationSettingsBody,
  parseSetPersonaSettingsBody,
  parseSetPiaProxyUrlBody,
  parseSetScreenLockSettingsBody,
  parseSetTimezoneBody,
  parseUpdateConnectionBody,
  setCanonSettings,
  setChatMemorySettings,
  setCredential,
  setHouseholdTimezone,
  setNotificationSettings,
  setPersonaSettings,
  setPiaProxyUrl,
  setScreenLockSettings,
  testConnection,
} from './adminServer.js';
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
// recallChatHistoryTool.ts's own doc for why full-turn recall stays an explicit tool call instead).
// household_memory is every user's own row (RLS already scopes it); chat_memory_entries is this
// one chat's distilled digest of whatever's rolled off the live window below. household_memory is
// skipped entirely for an 'rp' chat (docs/bi_principles.md §4/§16, db/migrations/0049_chat_kind.sql)
// — in-fiction details have no business leaking into unrelated chats, or vice versa.
// chat_memory_entries stays in for RP too: it's already scoped per chat_id, and still useful in a
// long roleplay.
async function buildChatMemorySystemPrompt(
  db: PostgresClient,
  userId: string,
  chatId: string,
  kind: 'chat' | 'rp',
): Promise<string> {
  return db.withUserScope(userId, async (session) => {
    const [household, entries] = await Promise.all([
      kind === 'rp'
        ? Promise.resolve([])
        : session.query<{ content: string }>(
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

// docs/prompt-macros.md's Stage 1 — only called when the caller already knows systemText contains
// at least one `{{`, so this always does its reads for real, never a wasted round-trip. Character
// fields (name/persona/scenario) are read live rather than trusted from whatever
// apply_prompt_stack_to_chat baked in at Apply time, same reasoning as household persona settings
// below: a card edited after Apply should be reflected on the very next turn.
async function resolveMacrosInSystemPrompt(
  systemText: string,
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  userId: string,
  characterId: string | null,
): Promise<string> {
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

  const snapshot: MacroSnapshot = {
    charName: characterRow?.name,
    userName: persona.name || undefined,
    persona: persona.description ? (persona.name ? `${persona.name}: ${persona.description}` : persona.description) : persona.name || undefined,
    description: characterRow?.persona || undefined,
    scenario: characterRow?.scenario || undefined,
  };
  return interpolateMacros(systemText, snapshot);
}

interface SlotDbRow {
  slot_type: string;
  marker_key: string | null;
  enabled: boolean;
  custom_role: string | null;
  custom_content: string | null;
  label: string | null;
}

// PromptStackSlot plus the cosmetic label column (migration 0060) — assemblePromptStack's own
// contract has no use for it (assembly doesn't care what a slot is called), but the prompt
// inspector below (buildNarratorStackItems) needs it to label a slot the same way
// PromptStacksView's own slotLabel() does.
type PromptStackSlotWithLabel = PromptStackSlot & { label?: string };

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
async function loadPromptStackSlots(db: PostgresClient, userId: string, presetId: string): Promise<PromptStackSlotWithLabel[]> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<SlotDbRow>(
      `select slot_type, marker_key, enabled, custom_role, custom_content, label
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
  }));
}

// docs/turn-loop-plan.md §3.2: the per-turn replacement for apply_prompt_stack_to_chat's
// bake-once-at-Apply behavior. Same two-phase pattern that tool already uses (assemblePromptStack
// then interpolateMacros) — re-run fresh every turn instead of frozen into params.system, and with
// memory_recall folded in as a field the preset's own slot ordering places, instead of
// buildChatMemorySystemPrompt's result being concatenated on unconditionally after the fact.
//
// canon_facts is deliberately left unset here even when a preset enables that slot:
// recall_canon_facts (plugins/canonize/src/recallCanonFactsTool.ts) scopes by scene_id via
// scene_presence/scenes.active_location_id, and chat_sessions has no scene_id column linking a
// chat to a scene — there is no trusted scope to auto-fetch against yet. The tool itself stays
// live for the model to call mid-turn when it does have a scene_id; this is a real gap (a chat<->
// scene link doesn't exist), not an oversight, flagged rather than guessed at.
// docs/bi_principles.md §18 ("every prompt is surfaced for manual tuning"): one labeled item per
// enabled, non-empty slot, in preset order — the same population assemblePromptStack itself would
// emit, just not yet collapsed into one joined string. Both assembleNarratorSystemText (the real
// per-turn call) and buildPromptPreview (the read-only inspector below) call this, so a preview
// can never drift from what a turn actually sends — there is exactly one place this assembly runs.
async function buildNarratorStackItems(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  userId: string,
  characterId: string | null,
  presetId: string,
  memoryContext: string,
): Promise<PromptPreviewItem[]> {
  const [slots, characterRows, persona] = await Promise.all([
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
  ]);
  // The preset was deleted, or has no slots, since Apply — nothing to assemble against. Caller
  // falls back to formatCurrentDateContext alone rather than crashing the turn over stale config.
  if (slots.length === 0) return [];

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
    memory_recall: memoryContext || undefined,
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
  for (const slot of slots) {
    if (!slot.enabled) continue;
    if (slot.slotType === 'custom') {
      if (!slot.customContent) continue;
      items.push(toPreviewItem(slot.customRole ?? 'system', interpolateMacros(slot.customContent, snapshot), { label: slot.label }));
      continue;
    }
    const value = slot.markerKey ? fields[slot.markerKey as MarkerKey] : undefined;
    if (!value) continue;
    items.push(toPreviewItem('system', interpolateMacros(value, snapshot), { markerKey: slot.markerKey, label: slot.label }));
  }
  return items;
}

async function assembleNarratorSystemText(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  userId: string,
  characterId: string | null,
  presetId: string,
  memoryContext: string,
): Promise<string> {
  const items = await buildNarratorStackItems(db, settings, userId, characterId, presetId, memoryContext);
  return items.map((i) => i.content).join('\n\n');
}

// docs/turn-loop-plan.md §4: an optional, unconditional-when-set post-processing pass over the
// raw generated turn — BigImagine's analogue of the user's real-world Triggeryze sideCall (banned
// constructions/names/words, header reconstruction, internal-thoughts-suffix fixups). Per the
// user's own direction, exposed as its own context_stack_presets row (mostly custom-type slots,
// {{message}} embedded in their text) rather than a second, simpler "instruction content" schema —
// so this reuses loadPromptStackSlots/assemblePromptStack exactly like the narrator does, just
// with an empty fields object (a cleanup preset has no card/persona/memory fields to draw from,
// only {{message}}) and each slot's own chosen role preserved rather than collapsed into one
// system string, since this becomes its own fresh messages array, not a system-prompt fragment.
//
// Runs through the same gated llm.complete() (kind: 'chat', same taskId as the main turn — this
// is part of the turn the user is waiting on, not a background job, so it should never be
// throttled by agent_routine caps and gets the standard retry/backoff for free from llmGate.ts).
// On exhausted-retry failure: logged, the raw reply is kept unchanged — per the user's explicit
// call, cleanup failing never blocks or degrades the turn itself.
async function runCleanupPass(
  db: PostgresClient,
  userId: string,
  chatId: string,
  cleanupPresetId: string,
  turnLlm: LlmProvider,
  reply: string,
): Promise<string> {
  const slots = await loadPromptStackSlots(db, userId, cleanupPresetId);
  const messages = assemblePromptStack({}, slots).map((m) => ({
    ...m,
    content: interpolateMacros(m.content, { message: reply }),
  }));
  if (messages.length === 0) return reply;

  try {
    const turn = await runWithCallContext({ taskId: chatId, kind: 'chat', userId }, () => turnLlm.complete(messages, []));
    return turn.message.content || reply;
  } catch (err) {
    log.error(`cleanup pass failed for chat ${chatId}, keeping the raw reply`, err);
    return reply;
  }
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

// Shared by handleChatCompletions and regenerateSwipe below — a persisted chat's system prompt
// assembly (memory digest + either per-turn narrator assembly or the legacy frozen params.system,
// macro-resolved for 'rp') is identical whichever of the two is producing the reply; only how the
// result gets persisted differs (append a new turn vs. recordSwipe in place).
async function assembleSessionTurnContext(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  userId: string,
  chatId: string,
  sessionKind: 'chat' | 'rp',
  sessionCharacterId: string | null,
  sessionPromptStackPresetId: string | null,
  sessionParams: ChatParams,
  messagesForLlm: LlmMessage[],
  timezone: string,
): Promise<{ systemPrompt: string; messagesForLlm: LlmMessage[] }> {
  const [memoryContext, trimmed] = await Promise.all([
    buildChatMemorySystemPrompt(db, userId, chatId, sessionKind),
    trimToLiveWindow(messagesForLlm, settings),
  ]);

  if (sessionKind === 'rp' && sessionPromptStackPresetId) {
    // Per-turn narrator assembly (docs/turn-loop-plan.md §3.2): re-run assemblePromptStack fresh
    // every turn instead of replaying the frozen string apply_prompt_stack_to_chat baked once into
    // params.system at Apply-click — a character-card/persona/memory-digest edit takes effect on
    // the very next message, no re-apply needed. memory_recall is folded in as a field the preset's
    // own slot ordering places, not appended after the fact.
    // No formatCurrentDateContext here — unlike a 'chat'-kind session, an in-character narrator
    // has no business knowing the real-world wall-clock time unless the prompt stack itself surfaces
    // it (e.g. a scenario slot), so it's omitted for 'rp' rather than unconditionally prepended.
    const narratorText = await assembleNarratorSystemText(db, settings, userId, sessionCharacterId, sessionPromptStackPresetId, memoryContext);
    return { systemPrompt: narratorText, messagesForLlm: trimmed };
  }

  // No applied preset — a 'chat'-kind chat, or an 'rp' chat that's never been through Apply:
  // unchanged legacy behavior, the frozen params.system, macro-resolved if 'rp'. Date context still
  // applies to 'chat'-kind sessions (household assistant use), just not 'rp' ones (see above).
  let system = sessionParams.system;
  if (sessionKind === 'rp' && system?.includes('{{')) {
    system = await resolveMacrosInSystemPrompt(system, db, settings, userId, sessionCharacterId);
  }
  const dateContext = sessionKind === 'rp' ? undefined : formatCurrentDateContext(timezone);
  return {
    systemPrompt: [dateContext, system, memoryContext].filter(Boolean).join('\n\n'),
    messagesForLlm: trimmed,
  };
}

export interface PromptPreview {
  /** Everything folded into the system prompt, in the exact order it's sent — date context first,
   *  then either the narrator preset's slots or the legacy system+memory pair. */
  systemStack: PromptPreviewItem[];
  /** The trimmed conversation history (trimToLiveWindow) that rides alongside systemStack in the
   *  same call — the two together are the complete request body an actual turn would send. */
  messages: PromptPreviewItem[];
  totalChars: number;
  totalEstimatedTokens: number;
}

// The read-only twin of assembleSessionTurnContext's 'rp' branch above: same memory/preset/legacy
// logic, called against a chat's currently-persisted messages rather than a new incoming one, and
// returning the itemized breakdown instead of a joined string — nothing here can drift from what a
// real turn sends, since both paths call the same buildNarratorStackItems/resolveMacrosInSystemPrompt.
// RP-only (docs/bi_principles.md's household-memory/canon scoping is what makes a 'chat'-kind
// session's system prompt uninteresting to audit this way — it's just the frozen params.system).
async function buildPromptPreview(
  deps: HttpServerDeps,
  userId: string,
  chatId: string,
): Promise<{ ok: true; preview: PromptPreview } | { ok: false; status: number; error: string }> {
  const detail = await deps.chats.getChat(userId, chatId);
  if (!detail) return { ok: false, status: 404, error: 'not found' };
  const { session } = detail;
  if (session.kind !== 'rp') {
    return { ok: false, status: 422, error: 'prompt preview is only available for rp chats' };
  }

  const messagesForLlm: LlmMessage[] = detail.messages.map((m) => ({ role: m.role, content: m.content }));
  const [memoryContext, trimmed] = await Promise.all([
    buildChatMemorySystemPrompt(deps.db, userId, chatId, session.kind),
    trimToLiveWindow(messagesForLlm, deps.settings),
  ]);

  // No date-context item — 'rp' turns no longer get formatCurrentDateContext prepended (see
  // assembleSessionTurnContext's 'rp' branch above), and this preview must never show something an
  // actual turn wouldn't send.
  const systemStack: PromptPreviewItem[] = [];

  if (session.promptStackPresetId) {
    systemStack.push(
      ...(await buildNarratorStackItems(deps.db, deps.settings, userId, session.characterId, session.promptStackPresetId, memoryContext)),
    );
  } else {
    let system = session.params.system;
    if (system?.includes('{{')) {
      system = await resolveMacrosInSystemPrompt(system, deps.db, deps.settings, userId, session.characterId);
    }
    if (system) systemStack.push(toPreviewItem('system', system, { markerKey: 'system' }));
    if (memoryContext) systemStack.push(toPreviewItem('system', memoryContext, { markerKey: 'memory_recall' }));
  }

  const messages = trimmed.map((m) => toPreviewItem(m.role as PromptPreviewItem['role'], m.content));

  const allChars = [...systemStack, ...messages].reduce((sum, i) => sum + i.chars, 0);
  return {
    ok: true,
    preview: {
      systemStack,
      messages,
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
async function resolveTurnLlm(
  deps: HttpServerDeps,
  sessionParams: ChatParams,
  chatId: string | undefined,
): Promise<{ turnLlm: LlmProvider; turnDefaultModel: string }> {
  let turnLlm = deps.llm;
  let turnDefaultModel = deps.modelName;
  if (sessionParams.profile) {
    const profile = await deps.llmConnections.resolveByName(sessionParams.profile);
    if (profile) {
      // A per-chat override builds its own throwaway provider (this function's own doc above) —
      // gated the same as deps.llm (index.ts wraps that one once, at boot), since a call through
      // an override is exactly as real a call as one through the household's active connection
      // (bb_principles.md §14 doesn't carve out an exception for "which connection").
      turnLlm = createGatedLlmProvider(createLlmProviderForProfile(profile), deps.db, deps.settings);
      turnDefaultModel = profile.model;
    } else {
      log.error(
        `chat_id ${chatId} names unknown connection "${sessionParams.profile}" — falling back to the active connection`,
      );
    }
  }
  return { turnLlm, turnDefaultModel };
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
): Promise<{ ok: true; message: StoredChatMessage } | { ok: false; error: string }> {
  const { db, chats } = deps;
  const { session } = detail;
  const priorMessages = detail.messages.slice(0, -1);
  const messagesForLlm: LlmMessage[] = priorMessages.map((m) => ({ role: m.role, content: m.content }));
  const anchorMessageId = [...priorMessages].reverse().find((m) => m.role === 'user')?.messageId;

  const sessionTools = session.toolNames !== null ? filterToolRegistry(deps.tools, session.toolNames) : deps.tools;
  const { turnLlm } = await resolveTurnLlm(deps, session.params, chatId);
  const timezone = await getHouseholdTimezone(deps.settings);
  const { systemPrompt, messagesForLlm: trimmed } = await assembleSessionTurnContext(
    db,
    deps.settings,
    userId,
    chatId,
    session.kind,
    session.characterId,
    session.promptStackPresetId,
    session.params,
    messagesForLlm,
    timezone,
  );

  let reply: string;
  let focusedNoteId: string | undefined;
  try {
    ({ content: reply, focusedNoteId } = await runTurn({
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
    }));
  } catch (err) {
    log.error(`swipe regenerate failed for chat ${chatId}`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (session.cleanupPresetId) {
    reply = await runCleanupPass(db, userId, chatId, session.cleanupPresetId, turnLlm, reply);
  }

  const updated = await chats.recordSwipe(userId, chatId, messageId, reply);
  if (!updated) {
    return { ok: false, error: 'message no longer exists' };
  }
  if (focusedNoteId !== undefined) {
    await chats.updateChat(userId, chatId, { canvasNoteId: focusedNoteId });
  }
  return { ok: true, message: updated };
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
  const { db, tools, apiKeys, accessIdentity, chats } = deps;

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
  let sessionKind: 'chat' | 'rp' = 'chat';
  // Which character (if any) this chat is linked to (applyCharacterToChatTool.ts) — only read
  // here for docs/prompt-macros.md's {{char}} macro (see the interpolateMacros call below);
  // everything else about the turn is indifferent to it.
  let sessionCharacterId: string | null = null;
  // Which context_stack_presets row (if any) drives this turn's per-turn narrator assembly
  // (docs/turn-loop-plan.md §3.2) and, separately, the post-runTurn cleanup pass (§4). Two
  // independent optional presets, only the first read here — cleanupPresetId is read straight off
  // detail.session where it's used, below.
  let sessionPromptStackPresetId: string | null = null;
  // The already-persisted latest user message's id (rerun/edit-resend case, where there's no new
  // user turn to insert) — carried forward so point-in-time canon recall still has an anchor to
  // use even when this turn doesn't add a fresh chat_messages row of its own.
  let existingLatestUserMessageId: string | undefined;
  let sessionDetail: Awaited<ReturnType<ChatSessionStore['getChat']>> | undefined;
  if (body.chat_id) {
    const detail = await chats.getChat(userId, body.chat_id);
    if (!detail) {
      sendJson(res, 404, { error: 'unknown chat_id' });
      return;
    }
    sessionDetail = detail;
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

  const { turnLlm, turnDefaultModel } = await resolveTurnLlm(deps, sessionParams, body.chat_id);

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

  // docs/prompt-macros.md's Stage 1: resolved fresh every turn (not baked at apply_prompt_stack_
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
  if (body.chat_id) {
    const assembled = await assembleSessionTurnContext(
      db,
      deps.settings,
      userId,
      body.chat_id,
      sessionKind,
      sessionCharacterId,
      sessionPromptStackPresetId,
      sessionParams,
      messagesForLlm,
      timezone,
    );
    systemPrompt = assembled.systemPrompt;
    messagesForLlm = assembled.messagesForLlm;
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

  let reply: string;
  let focusedNoteId: string | null | undefined;
  try {
    ({ content: reply, focusedNoteId } = await runTurn({
      userId,
      // A stateless request (no chat_id — Open WebUI's traffic, or any caller not using bigBrain's
      // own persisted-session frontend) still needs a task id for bb_principles.md §14: a fresh
      // one per turn is fine there, since kind stays 'chat' (never capped, only metered) and
      // nothing needs it to be stable across calls the way an agent_routine's job_id must be.
      taskId: body.chat_id ?? randomUUID(),
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

  // Step 5 of the seven-step turn loop (docs/turn-loop-plan.md §4.2): between runTurn resolving
  // and the assistant message being persisted. Skipped entirely (zero cost) for the common case —
  // no chat_id, or a chat that hasn't opted into a cleanup preset.
  const cleanupPresetId = sessionDetail?.session.cleanupPresetId;
  if (body.chat_id && cleanupPresetId) {
    reply = await runCleanupPass(db, userId, body.chat_id, cleanupPresetId, turnLlm, reply);
  }

  if (body.chat_id) {
    // The user message (if this was a genuinely new turn) is already persisted above, before
    // runTurn ran — only the assistant reply is appended here now.
    await chats.appendMessages(userId, body.chat_id, [{ role: 'assistant', content: reply }]);
    // First exchange in a still-untitled session names it, once — bigBrain never retitles a
    // chat again after this. Reuses the same llm/provider the turn itself just used (this is a
    // single tiny forced-schema call, not worth a separate cheap-model concept); a truncated
    // fallback keeps a naming hiccup from being visible as a broken turn.
    if (sessionWasEmpty && sessionTitle === 'New chat' && latestUserMessage) {
      let title: string;
      try {
        title = await runWithCallContext({ taskId: body.chat_id, kind: 'system', userId }, () =>
          generateChatTitle(turnLlm, latestUserMessage.content, reply),
        );
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
// (docs/prompt-macros.md's Stage 1), read live by
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
    if (segments.length === 4 && segments[3] === 'swipe' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const direction = (body as Record<string, unknown>)?.direction;
      if (direction !== 'prev' && direction !== 'next') {
        sendJson(res, 400, { error: 'expected { direction: "prev" | "next" }' });
        return;
      }

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
        sendJson(res, 200, { message: cycled.message });
        return;
      }
      if (cycled.status === 'no_earlier_swipe') {
        sendJson(res, 200, { status: 'no_earlier_swipe' });
        return;
      }
      // needs_regenerate: 'next' past the newest stored variant — this is "Rerun" (this module's
      // own preamble on the swipe route).
      const result = await regenerateSwipe(deps, userId, chatId, detail, messageId);
      if (!result.ok) {
        sendJson(res, 500, { error: result.error });
        return;
      }
      sendJson(res, 200, { message: result.message });
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
  if (req.method === 'GET' && req.url === '/v1/screen-lock-settings') {
    await handleScreenLockSettingsGet(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/v1/chat/status')) {
    await handleChatTurnStatus(req, res, deps);
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
