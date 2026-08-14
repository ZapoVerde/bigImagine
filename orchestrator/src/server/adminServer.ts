/**
 * @file orchestrator/src/server/adminServer.ts
 * @stamp 2026-08-10
 * @architectural-role Pure Function (request parsing) + IO Wrapper (credential store IO) — same
 * dual-role split already established by toolInvoke.ts for this codebase's other additive HTTP
 * surface
 * @description
 * The admin-only counterpart to toolInvoke.ts: instead of letting the frontend invoke a
 * user-scoped tool, this lets the one admin rotate a provider credential
 * (io/providerCredentials.ts) without a rebuild. Gated by a single static admin bearer key
 * (BIGBRAIN_ADMIN_API_KEY), checked in httpServer.ts via isAdminAuthenticated — deliberately not
 * ApiKeyStore/BIGBRAIN_API_KEYS, since this isn't user data and there is no admin/regular
 * distinction in that per-household-member map (nor should there be one bolted on for this).
 *
 * Never returns a plaintext or ciphertext credential value — listCredentials only ever reports
 * whether each fixed name (CREDENTIAL_NAMES) is configured and when it was last touched. Write-
 * only by construction (docs/bb_principles.md §12): the Settings tab is built around that —
 * credentials can be set/rotated, never viewed back.
 *
 * Also backs the Connections tab's CRUD (GET/POST/PATCH/DELETE /v1/admin/connections,
 * io/llmConnections.ts) — unlike credentials, a connection's name/model/baseUrl aren't secrets, so
 * list() returns them in full; only apiKey stays write-only (never round-tripped back out).
 * listModelsForConnection/listProvidersForConnection build a throwaway LlmProvider for one already-
 * saved connection (by id) purely to call its listModels()/listProviders(), so the Connections
 * tab's model/provider-pinning dropdowns can preview a connection's live catalog after it's saved.
 *
 * Also backs the Settings tab's timezone field (GET/POST /v1/admin/timezone) — the household's
 * IANA zone name, read fresh on every chat turn (server/httpServer.ts's handleChatCompletions via
 * util/dateContext.ts) to tell the LLM the actual current date/time. Unlike the connection
 * picker, this needs no restart to take effect (getHouseholdTimezone's caller just reads it live
 * per request), so its POST route responds 200 immediately rather than 202/restarting.
 * parseSetTimezoneBody validates the given name is one Intl actually recognizes, rejecting a typo
 * before it's stored rather than failing later inside dateContext.ts.
 *
 * Also backs the Settings tab's notification fields (GET/POST /v1/admin/notification-settings) —
 * ntfy_server_url and notifications_enabled (plugins/notifications). Live-update shape like
 * timezone: sendPushNotificationTool.ts reads both fresh on every send_push_notification call, so
 * a Settings-tab edit (including flipping the kill switch off) takes effect on the very next
 * call, no restart. No legacy env fallback here — this is a new feature with no pre-existing
 * env-only deployment to stay compatible with.
 *
 * Also backs the Settings tab's screen-lock fields (GET/POST /v1/admin/screen-lock-settings) —
 * screen_lock_password/screen_lock_timeout_minutes, ported from SillyTavern-Playground's idle-lock
 * (driver/ui/lockScreen.js). The one household-authed (not admin-only) GET here is
 * httpServer.ts's own /v1/screen-lock-settings route — the overlay itself has to poll this as a
 * regular authenticated user, not an admin, same reasoning as /v1/timezone below.
 *
 * @api-declaration
 * parseSetCredentialBody(raw) — validates {name, value}; undefined on any malformed shape
 * listCredentials(store) — CredentialSummary[] for every fixed name in CREDENTIAL_NAMES
 * setCredential(store, name, value) — encrypts + upserts the one named credential
 * parseCreateConnectionBody(raw) — validates an LlmConnectionInit; undefined on any malformed shape
 * parseUpdateConnectionBody(raw) — validates an LlmConnectionPatch; undefined on any malformed shape
 * parseCreateImageConnectionBody(raw) — validates an ImageConnectionInit (apiKey optional — only
 *   a local comfyui endpoint has none; every cloud provider, Pollinations included, requires one,
 *   endpoint.md §2.1); undefined on any malformed shape
 * parseUpdateImageConnectionBody(raw) — validates an ImageConnectionPatch; undefined on any malformed
 *   shape
 * getImageSettings(store) — { template, templateIsDefault, describerPrompt, describerPromptIsDefault,
 *   describerHistoryPairs } for the image subsystem's settings (endpoint.md §2.2 + describer.md;
 *   bi_principles.md §17 — '' = built-in default for the two prompts, '' = built-in 1 for the pairs)
 * parseSetImageSettingsBody(raw) — validates { template?, describer_prompt?, describer_history_pairs? },
 *   at least one present; undefined on any malformed shape
 * setImageSettings(store, patch) — upserts whichever fields the patch names
 * testImageConnection(imageConnections, settings, id) — endpoint.md §3.3's diagnostic probe
 *   through one saved image connection, synthesized through the Master Image Prompt Template with
 *   the connection's style prefix (parallax_fade_teststep.md §4.2); undefined only if the id
 *   doesn't exist, otherwise always a result (a bad key/unreachable endpoint surfaces as
 *   { ok: false, error }, not a thrown error)
 * getChatBackgroundSettings(store) — the ChatView location-background controls
 *   (parallax_fade_teststep.md §2.2 + migration 0073): { parallaxEnabled, overlayOpacity,
 *   overlayShade, bubbleOpacity, bubbleUserShade, bubbleAssistantShade }, each defaulting when
 *   unset (parallax false, veil 0.5 '#000000', bubbles 0.7 '#4f46e5'/'#26272c')
 * parseSetChatBackgroundSettingsBody(raw) — validates a partial patch of those six fields;
 *   undefined on any malformed shape (non-boolean parallax, out-of-range/NaN opacity,
 *   non-#rrggbb shade, or an empty body)
 * setChatBackgroundSettings(store, patch) — upserts whichever fields the patch names
 * listModelsForConnection(connections, id) — the live model catalog for one saved connection
 *   (or its single static model if the provider kind has no listModels), for the Connections tab
 *   to show before an admin commits to a model choice
 * listProvidersForConnection(connections, id, modelId) — the live list of upstream inference
 *   providers OpenRouter can route the named model to, undefined if the connection's kind has no
 *   listProviders capability (i.e. isn't OpenRouter)
 * testConnection(connections, id) — a cheap, capped-tokens real call through this saved
 *   connection; undefined only if the id doesn't exist, otherwise always a result (a bad key/model
 *   surfaces as { ok: false, error }, not a thrown error)
 * getHouseholdTimezone(store) — the stored IANA zone name, or 'UTC' if never set
 * parseSetTimezoneBody(raw) — validates {value} is a real IANA zone name Intl recognizes;
 *   undefined on any malformed shape or unrecognized name
 * setHouseholdTimezone(store, value) — upserts household_timezone
 * getNotificationSettings(store) — { serverUrl, enabled }, no env fallback
 * parseSetNotificationSettingsBody(raw) — validates {server_url?, enabled?}, at least one present;
 *   undefined on any malformed shape
 * setNotificationSettings(store, body) — upserts whichever of ntfy_server_url/
 *   notifications_enabled was given
 * getScreenLockSettings(store) — { password, timeoutMinutes }, defaults timeoutMinutes to 5 when
 *   unset; password defaults to '' (feature off)
 * parseSetScreenLockSettingsBody(raw) — validates {password?, timeout_minutes?: positive number},
 *   at least one present; undefined on any malformed shape
 * setScreenLockSettings(store, body) — upserts whichever of screen_lock_password/
 *   screen_lock_timeout_minutes was given
 * getPiaProxyUrl(store) — the stored pia-proxy URL, or null if never set
 * parseSetPiaProxyUrlBody(raw) — validates {value: a non-empty http(s) URL}; undefined on any
 *   malformed shape
 * setPiaProxyUrl(store, value) — upserts pia_proxy_url
 * getPersonaSettings(store) — {name, description}, each '' if never set
 * parseSetPersonaSettingsBody(raw) — validates {name?, description?: string}, at least one
 *   present; undefined on any malformed shape
 * setPersonaSettings(store, body) — upserts whichever of persona_name/persona_description was given
 * getLocationRenderStatus(db) — the bg-gen pipeline's proof-it-ran read (bi_principles.md §11):
 *   the most-recently-touched locations per user with which render stages actually completed
 *   (described/defined/rendered/hasRenderHash + status + timestamps) — same roster-every-user
 *   RLS-scope shape as getChatMemorySyncStatus
 *
 * @contract
 *   assertions:
 *     purity:          parseSetCredentialBody/parseCreateConnectionBody/parseUpdateConnectionBody/
 *                      parseSetTimezoneBody/isValidTimeZone/parseSetNotificationSettingsBody/
 *                      parseSetScreenLockSettingsBody/parseSetPiaProxyUrlBody/
 *                      parseSetPersonaSettingsBody are pure; the rest are
 *                      impure (Postgres IO via the injected store, or a
 *                      network call to the named connection for listModelsForConnection)
 *     state_ownership: []
 *     external_io:     [Postgres (via the stores it's given); the configured LLM provider APIs]
 */

import type { CredentialName, CredentialSummary, ProviderCredentialStore } from '../io/providerCredentials.js';
import { CREDENTIAL_NAMES } from '../io/providerCredentials.js';
import type { OrchestratorSettingsStore, SettingName } from '../io/orchestratorSettings.js';
import { createLlmProviderForProfile } from '../io/llm/index.js';
import type { LlmConnectionInit, LlmConnectionPatch, LlmConnectionStore } from '../io/llmConnections.js';
import type { ImageConnectionInit, ImageConnectionKind, ImageConnectionPatch, ImageConnectionStore } from '../io/imageConnections.js';
import { createImageGenProvider } from '../io/imageGen/index.js';
import { synthesizeImagePrompt, IMAGE_GEN_SEED } from '../util/synthesizeImagePrompt.js';
import { DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT } from '../io/chatMemory/classifyChatChunk.js';
import { DEFAULT_DISTILL_CHAT_MEMORY_PROMPT } from '../io/chatMemory/distillChatMemory.js';
import { DEFAULT_HOUSEHOLD_MEMORY_PROMPT } from '../io/chatMemory/classifyHouseholdMemory.js';
import { DEFAULT_BRIDGE_PROMPT } from '../io/chatMemory/bridgeChatMemory.js';
import { DEFAULT_WORLD_MEMORY_CURATOR_PROMPT } from '../io/chatMemory/curateWorldMemory.js';
import { DEFAULT_PEOPLE_CURATOR_PROMPT } from '../io/chatMemory/curatePeople.js';
import {
  DEFAULT_INJECT_BRIDGE_PROMPT,
  DEFAULT_INJECT_PLOT_PROMPT,
  DEFAULT_INJECT_AUTO_RECALL_PROMPT,
  DEFAULT_AUTO_RECALL_CHUNK_PROMPT,
  DEFAULT_AUTO_RECALL_LEAD_IN_PROMPT,
  DEFAULT_INJECT_RECENT_HISTORY_PROMPT,
} from '../io/chatMemory/memoryInjection.js';
import { DEFAULT_CANON_EXTRACTION_PROMPT } from '../io/canonExtraction.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import { toPgVectorLiteral } from '../util/pgvector.js';
import type { LorebookEntryDraft } from '../util/parseCharacterBookEntries.js';
import { DEFAULT_CLEANUP_CONFIG } from '../orchestrator/cleanupHeuristics.js';
import { DEFAULT_REASONING_CLOSE_TAG, DEFAULT_REASONING_OPEN_TAG } from '../orchestrator/liveReasoning.js';
import { DEFAULT_LOCATION_DESCRIBER_PROMPT } from '../orchestrator/describeLocation.js';
import { DEFAULT_LOCATION_BLOCK_TEMPLATE } from '../util/renderLocationBlock.js';
import { loadSlopRules, replaceSlopRules, type SlopRuleInput } from '../orchestrator/cleanupLoop.js';
import type { PostgresClient } from '../io/postgres.js';
import { log } from '../io/logger.js';

export interface SetCredentialBody {
  name: CredentialName;
  value: string;
}

export function parseSetCredentialBody(raw: unknown): SetCredentialBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, value } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !(CREDENTIAL_NAMES as readonly string[]).includes(name)) return undefined;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return { name: name as CredentialName, value };
}

export function listCredentials(store: ProviderCredentialStore): Promise<CredentialSummary[]> {
  return store.list();
}

export function setCredential(store: ProviderCredentialStore, name: CredentialName, value: string): Promise<void> {
  return store.set(name, value);
}

// llm_vision_capable_profiles' value is a JSON array of profile names — a retired setting, kept in
// orchestratorSettings.ts's SETTING_NAMES (never narrowed, same precedent as CREDENTIAL_NAMES'
// deepseek/openrouter entries) purely so index.ts's one-time llm_connections seed can still read a
// pre-cutover deployment's env-defined profiles' vision flags into each new row's supports_vision
// column. No longer read anywhere after that seed runs — a connection's own supports_vision column
// (io/llmConnections.ts) is the live source of truth from then on.
export function parseVisionCapableProfiles(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((name) => typeof name === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

// Shared by parseCreateConnectionBody/parseUpdateConnectionBody — provider_order/quantizations are
// both "at most a couple of provider tags"/"a quantization filter list", never validated against a
// live catalog here (that would mean a network call just to parse a request body); an unrecognized
// tag is caught downstream, the same way an unrecognized model id already is (the actual API call
// fails, surfaced to the admin as a 502 from the models/providers preview routes, not silently).
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

// Price fields (USD per 1M tokens) — a price is a finite non-negative number. Null is accepted
// only on the patch parser (explicitly clear a previously-set price, distinct from undefined =
// "leave it alone"), never on create.
function isPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function parseCreateConnectionBody(raw: unknown): LlmConnectionInit | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, kind, model, apiKey, copyApiKeyFrom, baseUrl, supportsVision, providerOrder, allowFallbacks, quantizations,
    priceInputPerMillion, priceOutputPerMillion, priceCacheHitPerMillion } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) return undefined;
  if (kind !== 'anthropic' && kind !== 'openai-compatible') return undefined;
  if (typeof model !== 'string' || !model) return undefined;
  // Exactly one of apiKey/copyApiKeyFrom — a fresh key, or reuse another connection's by id
  // (io/llmConnections.ts's copyCiphertext) instead of re-pasting the same key into every
  // connection that shares one underlying provider.
  const hasApiKey = typeof apiKey === 'string' && apiKey.length > 0;
  const hasCopyFrom = typeof copyApiKeyFrom === 'string' && copyApiKeyFrom.length > 0;
  if (hasApiKey === hasCopyFrom) return undefined;
  if (kind === 'openai-compatible' && (typeof baseUrl !== 'string' || !baseUrl)) return undefined;
  if (baseUrl !== undefined && typeof baseUrl !== 'string') return undefined;
  if (supportsVision !== undefined && typeof supportsVision !== 'boolean') return undefined;
  if (providerOrder !== undefined && !isStringArray(providerOrder)) return undefined;
  if (allowFallbacks !== undefined && typeof allowFallbacks !== 'boolean') return undefined;
  if (quantizations !== undefined && !isStringArray(quantizations)) return undefined;
  if (priceInputPerMillion !== undefined && !isPrice(priceInputPerMillion)) return undefined;
  if (priceOutputPerMillion !== undefined && !isPrice(priceOutputPerMillion)) return undefined;
  if (priceCacheHitPerMillion !== undefined && !isPrice(priceCacheHitPerMillion)) return undefined;
  return {
    name: name.trim(),
    kind,
    model,
    apiKey: hasApiKey ? (apiKey as string) : undefined,
    copyApiKeyFrom: hasCopyFrom ? (copyApiKeyFrom as string) : undefined,
    baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
    supportsVision: typeof supportsVision === 'boolean' ? supportsVision : undefined,
    providerOrder: providerOrder as string[] | undefined,
    allowFallbacks: typeof allowFallbacks === 'boolean' ? allowFallbacks : undefined,
    quantizations: quantizations as string[] | undefined,
    priceInputPerMillion: isPrice(priceInputPerMillion) ? priceInputPerMillion : undefined,
    priceOutputPerMillion: isPrice(priceOutputPerMillion) ? priceOutputPerMillion : undefined,
    priceCacheHitPerMillion: isPrice(priceCacheHitPerMillion) ? priceCacheHitPerMillion : undefined,
  };
}

// Every field optional (a PATCH — only touch what's given), unlike create's required set.
// baseUrl/providerOrder/quantizations additionally accept `null` to explicitly clear a
// previously-set value, distinct from `undefined` ("leave it alone") — same three-state shape
// io/llmConnections.ts's own LlmConnectionPatch already expects.
export function parseUpdateConnectionBody(raw: unknown): LlmConnectionPatch | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, model, apiKey, copyApiKeyFrom, baseUrl, supportsVision, providerOrder, allowFallbacks, quantizations,
    priceInputPerMillion, priceOutputPerMillion, priceCacheHitPerMillion } = raw as Record<string, unknown>;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return undefined;
  if (model !== undefined && (typeof model !== 'string' || !model)) return undefined;
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey)) return undefined;
  if (copyApiKeyFrom !== undefined && (typeof copyApiKeyFrom !== 'string' || !copyApiKeyFrom)) return undefined;
  // Rotating the key at most one way per request — pick a fresh one or reuse another connection's,
  // not both at once.
  if (apiKey !== undefined && copyApiKeyFrom !== undefined) return undefined;
  if (baseUrl !== undefined && baseUrl !== null && typeof baseUrl !== 'string') return undefined;
  if (supportsVision !== undefined && typeof supportsVision !== 'boolean') return undefined;
  if (providerOrder !== undefined && providerOrder !== null && !isStringArray(providerOrder)) return undefined;
  if (allowFallbacks !== undefined && typeof allowFallbacks !== 'boolean') return undefined;
  if (quantizations !== undefined && quantizations !== null && !isStringArray(quantizations)) return undefined;
  if (priceInputPerMillion !== undefined && priceInputPerMillion !== null && !isPrice(priceInputPerMillion)) return undefined;
  if (priceOutputPerMillion !== undefined && priceOutputPerMillion !== null && !isPrice(priceOutputPerMillion)) return undefined;
  if (priceCacheHitPerMillion !== undefined && priceCacheHitPerMillion !== null && !isPrice(priceCacheHitPerMillion)) return undefined;

  const patch: LlmConnectionPatch = {};
  if (name !== undefined) patch.name = (name as string).trim();
  if (model !== undefined) patch.model = model as string;
  if (apiKey !== undefined) patch.apiKey = apiKey as string;
  if (copyApiKeyFrom !== undefined) patch.copyApiKeyFrom = copyApiKeyFrom as string;
  if (baseUrl !== undefined) patch.baseUrl = baseUrl as string | null;
  if (supportsVision !== undefined) patch.supportsVision = supportsVision as boolean;
  if (providerOrder !== undefined) patch.providerOrder = providerOrder as string[] | null;
  if (allowFallbacks !== undefined) patch.allowFallbacks = allowFallbacks as boolean;
  if (quantizations !== undefined) patch.quantizations = quantizations as string[] | null;
  if (priceInputPerMillion !== undefined) patch.priceInputPerMillion = priceInputPerMillion as number | null;
  if (priceOutputPerMillion !== undefined) patch.priceOutputPerMillion = priceOutputPerMillion as number | null;
  if (priceCacheHitPerMillion !== undefined) patch.priceCacheHitPerMillion = priceCacheHitPerMillion as number | null;
  return patch;
}

export interface ProfileModelsResult {
  models: { id: string; pricing?: { prompt: string; completion: string } }[];
  defaultModel: string;
}

export async function listModelsForConnection(
  connections: LlmConnectionStore,
  id: string,
): Promise<ProfileModelsResult | undefined> {
  const profile = await connections.resolveById(id);
  if (!profile) return undefined;
  const provider = createLlmProviderForProfile(profile);
  const models = provider.listModels ? await provider.listModels() : [{ id: profile.model }];
  return { models, defaultModel: profile.model };
}

export interface ModelProvidersResult {
  providers: { name: string; tag: string; pricing?: { prompt: string; completion: string } }[];
}

// listModelsForConnection's counterpart for OpenRouter's per-model provider routing table —
// undefined return covers both "no such connection" and "this connection's kind has no
// listProviders capability" (every non-OpenRouter kind), so the route handler doesn't need to tell
// those two apart: either way, there's nothing to show.
export async function listProvidersForConnection(
  connections: LlmConnectionStore,
  id: string,
  modelId: string,
): Promise<ModelProvidersResult | undefined> {
  const profile = await connections.resolveById(id);
  if (!profile) return undefined;
  const provider = createLlmProviderForProfile(profile);
  if (!provider.listProviders) return undefined;
  const providers = await provider.listProviders(modelId);
  return { providers };
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  reply?: string;
  error?: string;
}

// A one-off real call through this saved connection — a cheap, capped-tokens round trip so the
// Connections tab's "Test" button can confirm the key/model/baseUrl actually work before an admin
// leans on it, rather than finding out at the next real chat turn. Deliberately ungated, same as
// this file's own listModelsForConnection/listProvidersForConnection preview calls just above —
// bb_principles.md §14's gate exists to attribute and budget real per-turn spend to a household
// user (llm_calls.user_id is a NOT NULL FK to users), and an admin diagnostic probe run from the
// Connections tab has no such user to attribute to, same reasoning that already keeps the model/
// provider catalog previews outside the gate. Undefined only for "no such connection" (404); a
// reachable-but-failing connection is a normal { ok: false } result, not a thrown error, since a
// bad key/model is exactly the thing this button exists to surface.
export async function testConnection(connections: LlmConnectionStore, id: string): Promise<ConnectionTestResult | undefined> {
  const profile = await connections.resolveById(id);
  if (!profile) return undefined;
  const provider = createLlmProviderForProfile(profile);
  const start = Date.now();
  try {
    const turn = await provider.complete([{ role: 'user', content: 'Reply with exactly one word: ok' }], [], { maxTokens: 8 });
    return { ok: true, latencyMs: Date.now() - start, reply: turn.message.content };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- Image generation connections (docs/plans/vistalyze_integration/endpoint.md §3) ---
// The Connections tab's image section CRUD (GET/POST/PATCH/DELETE /v1/admin/image-connections,
// io/imageConnections.ts), plus the image-settings GET/POST and the per-connection Test button.
// Same shapes as the LLM-connection functions above, with two differences that fall out of the
// spec:
//   * create's apiKey is optional, not "exactly one of apiKey/copyApiKeyFrom" — only a local
//     comfyui endpoint has no key to enter (Pollinations stopped being keyless in 2025; its token
//     is required and rides as the `token` URL param, endpoint.md §2.1/§3.2.3).
//   * activate needs no restart and no 202: the active connection is resolved live on every
//     generateLocationImage call (bi_principles.md §13), so the route replies 200 immediately.
// The Test button (endpoint.md §3.3) fires a single, low-cost diagnostic generation probe through
// the saved connection and reports latency + the generated test Image URL without saving the URL
// to any location record — the same "reachable-and-failing is a normal { ok: false } result, not a
// thrown error" contract as testConnection above. The probe prompt is *synthesized* through the
// real engine (util/synthesizeImagePrompt.ts) with fixed sample inputs — including the
// connection's own master positive style prefix — so Test shows what this connection will
// actually render (parallax_fade_teststep.md §4.2), and the exact prompt sent is returned in the
// result (bi_principles.md §17 — prompts are surfaced, never hidden).
//
// NOTE: testImageConnection genuinely calls the provider adapter. Pollinations needs no network
// (its URL *is* the render request, io/imageGen/pollinations.ts) — the probe is the URL
// construction itself, instant, but it still requires the connection's key and throws without it.

const IMAGE_KINDS = ['runware', 'fal-ai', 'pollinations', 'comfyui', 'openai-images'] as const;

function isImageKind(value: unknown): value is ImageConnectionKind {
  return typeof value === 'string' && (IMAGE_KINDS as readonly string[]).includes(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCreateImageConnectionBody(raw: unknown): ImageConnectionInit | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const {
    name,
    kind,
    model,
    apiKey,
    baseUrl,
    width,
    height,
    samplingSteps,
    cfgScale,
    samplerName,
    masterPositiveStylePrefix,
    masterNegativePrompt,
    workflowParameters,
  } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) return undefined;
  if (!isImageKind(kind)) return undefined;
  if (typeof model !== 'string' || !model) return undefined;
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey)) return undefined;
  if (baseUrl !== undefined && typeof baseUrl !== 'string') return undefined;
  if (width !== undefined && (typeof width !== 'number' || !Number.isInteger(width) || width < 64 || width > 8192)) {
    return undefined;
  }
  if (height !== undefined && (typeof height !== 'number' || !Number.isInteger(height) || height < 64 || height > 8192)) {
    return undefined;
  }
  if (samplingSteps !== undefined && (typeof samplingSteps !== 'number' || !Number.isInteger(samplingSteps) || samplingSteps <= 0)) {
    return undefined;
  }
  if (cfgScale !== undefined && (typeof cfgScale !== 'number' || !Number.isFinite(cfgScale) || cfgScale <= 0)) return undefined;
  if (samplerName !== undefined && typeof samplerName !== 'string') return undefined;
  if (masterPositiveStylePrefix !== undefined && typeof masterPositiveStylePrefix !== 'string') return undefined;
  if (masterNegativePrompt !== undefined && typeof masterNegativePrompt !== 'string') return undefined;
  if (workflowParameters !== undefined && !isJsonObject(workflowParameters)) return undefined;
  return {
    name: name.trim(),
    kind,
    model,
    apiKey: typeof apiKey === 'string' ? apiKey : undefined,
    baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
    width: typeof width === 'number' ? width : undefined,
    height: typeof height === 'number' ? height : undefined,
    samplingSteps: typeof samplingSteps === 'number' ? samplingSteps : undefined,
    cfgScale: typeof cfgScale === 'number' ? cfgScale : undefined,
    samplerName: typeof samplerName === 'string' ? samplerName : undefined,
    masterPositiveStylePrefix: typeof masterPositiveStylePrefix === 'string' ? masterPositiveStylePrefix : undefined,
    masterNegativePrompt: typeof masterNegativePrompt === 'string' ? masterNegativePrompt : undefined,
    workflowParameters: isJsonObject(workflowParameters) ? workflowParameters : undefined,
  };
}

// Every field optional (a PATCH); nullable string/jsonb fields additionally accept `null` to
// explicitly clear a previously-set value, distinct from `undefined` ("leave it alone") — the
// same three-state shape io/imageConnections.ts's ImageConnectionPatch expects.
export function parseUpdateImageConnectionBody(raw: unknown): ImageConnectionPatch | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const {
    name,
    kind,
    model,
    apiKey,
    baseUrl,
    width,
    height,
    samplingSteps,
    cfgScale,
    samplerName,
    masterPositiveStylePrefix,
    masterNegativePrompt,
    workflowParameters,
  } = raw as Record<string, unknown>;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return undefined;
  if (kind !== undefined && !isImageKind(kind)) return undefined;
  if (model !== undefined && (typeof model !== 'string' || !model)) return undefined;
  // apiKey undefined leaves the stored key untouched; empty string is rejected (there's no
  // "clear the key" — keyless connections are created without one, not rotated to nothing).
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey)) return undefined;
  if (baseUrl !== undefined && baseUrl !== null && typeof baseUrl !== 'string') return undefined;
  if (width !== undefined && (typeof width !== 'number' || !Number.isInteger(width) || width < 64 || width > 8192)) {
    return undefined;
  }
  if (height !== undefined && (typeof height !== 'number' || !Number.isInteger(height) || height < 64 || height > 8192)) {
    return undefined;
  }
  if (samplingSteps !== undefined && (typeof samplingSteps !== 'number' || !Number.isInteger(samplingSteps) || samplingSteps <= 0)) {
    return undefined;
  }
  if (cfgScale !== undefined && (typeof cfgScale !== 'number' || !Number.isFinite(cfgScale) || cfgScale <= 0)) return undefined;
  if (samplerName !== undefined && samplerName !== null && typeof samplerName !== 'string') return undefined;
  if (masterPositiveStylePrefix !== undefined && masterPositiveStylePrefix !== null && typeof masterPositiveStylePrefix !== 'string') {
    return undefined;
  }
  if (masterNegativePrompt !== undefined && masterNegativePrompt !== null && typeof masterNegativePrompt !== 'string') {
    return undefined;
  }
  if (workflowParameters !== undefined && workflowParameters !== null && !isJsonObject(workflowParameters)) return undefined;

  const patch: ImageConnectionPatch = {};
  if (name !== undefined) patch.name = (name as string).trim();
  if (kind !== undefined) patch.kind = kind as ImageConnectionKind;
  if (model !== undefined) patch.model = model as string;
  if (apiKey !== undefined) patch.apiKey = apiKey as string;
  if (baseUrl !== undefined) patch.baseUrl = baseUrl as string | null;
  if (width !== undefined) patch.width = width as number;
  if (height !== undefined) patch.height = height as number;
  if (samplingSteps !== undefined) patch.samplingSteps = samplingSteps as number;
  if (cfgScale !== undefined) patch.cfgScale = cfgScale as number;
  if (samplerName !== undefined) patch.samplerName = samplerName as string | null;
  if (masterPositiveStylePrefix !== undefined) patch.masterPositiveStylePrefix = masterPositiveStylePrefix as string | null;
  if (masterNegativePrompt !== undefined) patch.masterNegativePrompt = masterNegativePrompt as string | null;
  if (workflowParameters !== undefined) patch.workflowParameters = workflowParameters as Record<string, unknown> | null;
  return patch;
}

// --- Image settings (endpoint.md §2.2, bi_principles.md §17) ---
// The three orchestrator-settings keys this subsystem adds: image_prompt_template, the Master
// Image Prompt Template synthesizeImagePrompt.ts expands against a location's visual_description/
// environment; location_describer_prompt, the room-description LLM prompt describeLocation.ts
// expands (migration 0078, describer.md — empty = built-in default); and
// location_describer_history_pairs, how many trailing turn-pairs the describer reads as context
// (integer-as-text, default 1). All three are live-read on every call (no restart).

export interface ImageSettings {
  template: string;
  templateIsDefault: boolean;
  describerPrompt: string;
  describerPromptIsDefault: boolean;
  describerHistoryPairs: string;
}

// parallax_fade_teststep.md §2.2 + migration 0073: the ChatView location-background controls —
// the parallax pan toggle, the dimming veil ("overlay") over the location image, and the bubble
// fill. Stored as text in orchestrator_settings; unset = the defaults below. The shade defaults
// are the dark-theme bubble colors (this is a single-user build on the dark theme) — before the
// Settings fieldset is ever saved, ChatView.css falls back to the per-theme tokens, so an
// unsaved light-theme install keeps its own colors until the first save.
export interface ChatBackgroundSettings {
  parallaxEnabled: boolean;
  /** 0..1 — the veil's strength over the location background. Default 0.5, the pre-0073
   *  resting bg dimming, now a real layer so the image itself stays at full opacity. */
  overlayOpacity: number;
  /** '#rrggbb' — the veil's color. Default '#000000'. */
  overlayShade: string;
  /** 0..1 — bubble background alpha. Default 0.7, the old hardcoded rgba alpha. */
  bubbleOpacity: number;
  /** '#rrggbb' — user bubble fill. Default '#4f46e5' (dark-theme indigo). */
  bubbleUserShade: string;
  /** '#rrggbb' — assistant bubble fill. Default '#26272c' (dark-theme gray). */
  bubbleAssistantShade: string;
}

/** A partial update: every field optional, at least one present (enforced by the parser). */
export interface ChatBackgroundSettingsPatch {
  parallaxEnabled?: boolean;
  overlayOpacity?: number;
  overlayShade?: string;
  bubbleOpacity?: number;
  bubbleUserShade?: string;
  bubbleAssistantShade?: string;
}

const CHAT_BG_DEFAULTS = {
  overlayOpacity: 0.5,
  overlayShade: '#000000',
  bubbleOpacity: 0.7,
  bubbleUserShade: '#4f46e5',
  bubbleAssistantShade: '#26272c',
} as const;

function parseClampedOpacity(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function getChatBackgroundSettings(store: OrchestratorSettingsStore): Promise<ChatBackgroundSettings> {
  const [parallax, overlayOpacity, overlayShade, bubbleOpacity, bubbleUserShade, bubbleAssistantShade] = await Promise.all([
    store.get('chat_background_parallax'),
    store.get('chat_background_overlay_opacity'),
    store.get('chat_background_overlay_shade'),
    store.get('chat_background_bubble_opacity'),
    store.get('chat_background_bubble_user_shade'),
    store.get('chat_background_bubble_assistant_shade'),
  ]);
  return {
    parallaxEnabled: parallax === 'true',
    overlayOpacity: parseClampedOpacity(overlayOpacity, CHAT_BG_DEFAULTS.overlayOpacity),
    overlayShade: overlayShade ?? CHAT_BG_DEFAULTS.overlayShade,
    bubbleOpacity: parseClampedOpacity(bubbleOpacity, CHAT_BG_DEFAULTS.bubbleOpacity),
    bubbleUserShade: bubbleUserShade ?? CHAT_BG_DEFAULTS.bubbleUserShade,
    bubbleAssistantShade: bubbleAssistantShade ?? CHAT_BG_DEFAULTS.bubbleAssistantShade,
  };
}

export function parseSetChatBackgroundSettingsBody(raw: unknown): ChatBackgroundSettingsPatch | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const {
    parallaxEnabled,
    overlayOpacity,
    overlayShade,
    bubbleOpacity,
    bubbleUserShade,
    bubbleAssistantShade,
  } = raw as Record<string, unknown>;
  const isBoundedOpacity = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (parallaxEnabled !== undefined && typeof parallaxEnabled !== 'boolean') return undefined;
  if (overlayOpacity !== undefined && !isBoundedOpacity(overlayOpacity)) return undefined;
  if (bubbleOpacity !== undefined && !isBoundedOpacity(bubbleOpacity)) return undefined;
  for (const shade of [overlayShade, bubbleUserShade, bubbleAssistantShade]) {
    if (shade !== undefined && (typeof shade !== 'string' || !HEX_COLOR_RE.test(shade))) return undefined;
  }
  if (
    parallaxEnabled === undefined &&
    overlayOpacity === undefined &&
    overlayShade === undefined &&
    bubbleOpacity === undefined &&
    bubbleUserShade === undefined &&
    bubbleAssistantShade === undefined
  ) {
    return undefined;
  }
  return {
    parallaxEnabled: typeof parallaxEnabled === 'boolean' ? parallaxEnabled : undefined,
    overlayOpacity: isBoundedOpacity(overlayOpacity) ? overlayOpacity : undefined,
    overlayShade: typeof overlayShade === 'string' && HEX_COLOR_RE.test(overlayShade) ? overlayShade : undefined,
    bubbleOpacity: isBoundedOpacity(bubbleOpacity) ? bubbleOpacity : undefined,
    bubbleUserShade: typeof bubbleUserShade === 'string' && HEX_COLOR_RE.test(bubbleUserShade) ? bubbleUserShade : undefined,
    bubbleAssistantShade:
      typeof bubbleAssistantShade === 'string' && HEX_COLOR_RE.test(bubbleAssistantShade) ? bubbleAssistantShade : undefined,
  };
}

export async function setChatBackgroundSettings(store: OrchestratorSettingsStore, patch: ChatBackgroundSettingsPatch): Promise<void> {
  const writes: Array<[SettingName, string]> = [];
  if (patch.parallaxEnabled !== undefined) writes.push(['chat_background_parallax', patch.parallaxEnabled ? 'true' : 'false']);
  if (patch.overlayOpacity !== undefined) writes.push(['chat_background_overlay_opacity', String(patch.overlayOpacity)]);
  if (patch.overlayShade !== undefined) writes.push(['chat_background_overlay_shade', patch.overlayShade]);
  if (patch.bubbleOpacity !== undefined) writes.push(['chat_background_bubble_opacity', String(patch.bubbleOpacity)]);
  if (patch.bubbleUserShade !== undefined) writes.push(['chat_background_bubble_user_shade', patch.bubbleUserShade]);
  if (patch.bubbleAssistantShade !== undefined) writes.push(['chat_background_bubble_assistant_shade', patch.bubbleAssistantShade]);
  for (const [key, value] of writes) await store.set(key, value);
}

/**
 * The ChatView "Text legibility" toggles (migrations 0074 + 0075) — opt-in text-rendering
 * tricks for prose on translucent bubbles over the location background, exposed as a collapsible
 * menu in the chat settings rail (components/chat/LegibilityMenu.tsx). Each toggle is stored as
 * text ('true'/'false'), default false when unset; the halo strength dial (0075) is text
 * '0'..'1', default 0.6 — opt-in, so an untouched install keeps the built-in look exactly. Household-wide settings: one set applies to every chat. The frontend reads them
 * live at chat load (GET /v1/chat-legibility-settings, same no-restart shape as
 * household_timezone) and applies them as data-legibility tokens on the chat view root; the CSS
 * rule sets of the same names (ChatView.css) key off [data-legibility~=…]. The menu POSTs each
 * toggle immediately (partial patch, admin-gated) — no Save button.
 */
export interface ChatLegibilitySettings {
  /** text-shadow halo ring around bubble prose (subtitle-renderer trick). */
  halo: boolean;
  /** 0..1 — the halo ring's intensity (migration 0075), default 0.6 when unset; applied as a
   *  color-mix percentage over the per-theme halo colors (their own alpha preserved, strength
   *  multiplied on top), so 0 = invisible ring, 1 = the full-force ring. */
  haloStrength: number;
  /** crisp 0.5px -webkit-text-stroke on quoted dialogue, headings, <summary>. */
  outline: boolean;
  /** solid near-black code chips + <pre> blocks with light text. */
  solidCode: boolean;
  /** font-weight 500 on em/i, blockquotes, and pending bubbles' muted text. */
  weightBump: boolean;
  /** hovering a bubble raises its fill opacity to 92% just for that message. */
  hoverFocus: boolean;
}

/** A partial update: every field optional, at least one present (enforced by the parser). */
export interface ChatLegibilitySettingsPatch {
  halo?: boolean;
  haloStrength?: number;
  outline?: boolean;
  solidCode?: boolean;
  weightBump?: boolean;
  hoverFocus?: boolean;
}

export async function getChatLegibilitySettings(store: OrchestratorSettingsStore): Promise<ChatLegibilitySettings> {
  const [halo, haloStrength, outline, solidCode, weightBump, hoverFocus] = await Promise.all([
    store.get('chat_legibility_halo'),
    store.get('chat_legibility_halo_strength'),
    store.get('chat_legibility_outline'),
    store.get('chat_legibility_solid_code'),
    store.get('chat_legibility_weight'),
    store.get('chat_legibility_hover_focus'),
  ]);
  return {
    halo: halo === 'true',
    haloStrength: parseClampedOpacity(haloStrength, 0.6),
    outline: outline === 'true',
    solidCode: solidCode === 'true',
    weightBump: weightBump === 'true',
    hoverFocus: hoverFocus === 'true',
  };
}

export function parseSetChatLegibilitySettingsBody(raw: unknown): ChatLegibilitySettingsPatch | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { halo, haloStrength, outline, solidCode, weightBump, hoverFocus } = raw as Record<string, unknown>;
  const isBoundedOpacity = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (halo !== undefined && typeof halo !== 'boolean') return undefined;
  if (haloStrength !== undefined && !isBoundedOpacity(haloStrength)) return undefined;
  if (outline !== undefined && typeof outline !== 'boolean') return undefined;
  if (solidCode !== undefined && typeof solidCode !== 'boolean') return undefined;
  if (weightBump !== undefined && typeof weightBump !== 'boolean') return undefined;
  if (hoverFocus !== undefined && typeof hoverFocus !== 'boolean') return undefined;
  if (
    halo === undefined &&
    haloStrength === undefined &&
    outline === undefined &&
    solidCode === undefined &&
    weightBump === undefined &&
    hoverFocus === undefined
  ) {
    return undefined;
  }
  return {
    halo: typeof halo === 'boolean' ? halo : undefined,
    haloStrength: isBoundedOpacity(haloStrength) ? haloStrength : undefined,
    outline: typeof outline === 'boolean' ? outline : undefined,
    solidCode: typeof solidCode === 'boolean' ? solidCode : undefined,
    weightBump: typeof weightBump === 'boolean' ? weightBump : undefined,
    hoverFocus: typeof hoverFocus === 'boolean' ? hoverFocus : undefined,
  };
}

export async function setChatLegibilitySettings(store: OrchestratorSettingsStore, patch: ChatLegibilitySettingsPatch): Promise<void> {
  const writes: Array<[SettingName, string]> = [];
  if (patch.halo !== undefined) writes.push(['chat_legibility_halo', patch.halo ? 'true' : 'false']);
  if (patch.haloStrength !== undefined) writes.push(['chat_legibility_halo_strength', String(patch.haloStrength)]);
  if (patch.outline !== undefined) writes.push(['chat_legibility_outline', patch.outline ? 'true' : 'false']);
  if (patch.solidCode !== undefined) writes.push(['chat_legibility_solid_code', patch.solidCode ? 'true' : 'false']);
  if (patch.weightBump !== undefined) writes.push(['chat_legibility_weight', patch.weightBump ? 'true' : 'false']);
  if (patch.hoverFocus !== undefined) writes.push(['chat_legibility_hover_focus', patch.hoverFocus ? 'true' : 'false']);
  for (const [key, value] of writes) await store.set(key, value);
}

export async function getImageSettings(store: OrchestratorSettingsStore): Promise<ImageSettings> {
  const [template, describerPrompt, describerHistoryPairs] = await Promise.all([
    store.get('image_prompt_template'),
    store.get('location_describer_prompt'),
    store.get('location_describer_history_pairs'),
  ]);
  return {
    template: template ?? '',
    templateIsDefault: !template,
    describerPrompt: describerPrompt ?? '',
    describerPromptIsDefault: !describerPrompt,
    describerHistoryPairs: describerHistoryPairs ?? '',
  };
}

export function parseSetImageSettingsBody(raw: unknown): { template?: string; describer_prompt?: string; describer_history_pairs?: string } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { template, describer_prompt, describer_history_pairs } = raw as Record<string, unknown>;
  if (template === undefined && describer_prompt === undefined && describer_history_pairs === undefined) return undefined;
  if (template !== undefined && typeof template !== 'string') return undefined;
  if (describer_prompt !== undefined && typeof describer_prompt !== 'string') return undefined;
  if (describer_history_pairs !== undefined && typeof describer_history_pairs !== 'string') return undefined;
  return { template, describer_prompt, describer_history_pairs };
}

export async function setImageSettings(
  store: OrchestratorSettingsStore,
  patch: { template?: string; describer_prompt?: string; describer_history_pairs?: string },
): Promise<void> {
  const writes: Array<[SettingName, string]> = [];
  if (patch.template !== undefined) writes.push(['image_prompt_template', patch.template]);
  if (patch.describer_prompt !== undefined) writes.push(['location_describer_prompt', patch.describer_prompt]);
  if (patch.describer_history_pairs !== undefined) writes.push(['location_describer_history_pairs', patch.describer_history_pairs]);
  for (const [key, value] of writes) await store.set(key, value);
}

// --- Location Tracker settings (docs/plans/vistalyze_integration/location.md §6.3) ---
// The Locations page's unified settings surface: the tracker's three keys plus the room
// describer's two (moved entirely from the Backgrounds page — the image-settings endpoint above
// keeps accepting the describer_* patch keys for back-compat, but the page no longer sends them).

export interface LocationSettings {
  splitEnabled: boolean;
  injectionEnabled: boolean;
  injectionPrompt: string;
  injectionPromptIsDefault: boolean;
  describerPrompt: string;
  describerPromptIsDefault: boolean;
  describerHistoryPairs: string;
}

export async function getLocationSettings(store: OrchestratorSettingsStore): Promise<LocationSettings> {
  const [splitEnabled, injectionEnabled, injectionPrompt, describerPrompt, describerHistoryPairs] = await Promise.all([
    store.get('location_split_enabled'),
    store.get('location_injection_enabled'),
    store.get('location_injection_prompt'),
    store.get('location_describer_prompt'),
    store.get('location_describer_history_pairs'),
  ]);
  return {
    splitEnabled: splitEnabled !== 'false',
    injectionEnabled: injectionEnabled !== 'false',
    injectionPrompt: injectionPrompt?.trim() ? injectionPrompt : DEFAULT_LOCATION_BLOCK_TEMPLATE,
    injectionPromptIsDefault: !injectionPrompt?.trim(),
    describerPrompt: describerPrompt?.trim() ? describerPrompt : DEFAULT_LOCATION_DESCRIBER_PROMPT,
    describerPromptIsDefault: !describerPrompt?.trim(),
    describerHistoryPairs: describerHistoryPairs ?? '',
  };
}

export function parseSetLocationSettingsBody(
  raw: unknown,
):
  | {
      split_enabled?: string;
      injection_enabled?: string;
      injection_prompt?: string;
      describer_prompt?: string;
      describer_history_pairs?: string;
    }
  | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { split_enabled, injection_enabled, injection_prompt, describer_prompt, describer_history_pairs } = raw as Record<string, unknown>;
  if (
    split_enabled === undefined &&
    injection_enabled === undefined &&
    injection_prompt === undefined &&
    describer_prompt === undefined &&
    describer_history_pairs === undefined
  ) {
    return undefined;
  }
  if (split_enabled !== undefined && typeof split_enabled !== 'boolean') return undefined;
  if (injection_enabled !== undefined && typeof injection_enabled !== 'boolean') return undefined;
  if (injection_prompt !== undefined && typeof injection_prompt !== 'string') return undefined;
  if (describer_prompt !== undefined && typeof describer_prompt !== 'string') return undefined;
  if (describer_history_pairs !== undefined && typeof describer_history_pairs !== 'string') return undefined;
  return {
    split_enabled: split_enabled === undefined ? undefined : split_enabled ? 'true' : 'false',
    injection_enabled: injection_enabled === undefined ? undefined : injection_enabled ? 'true' : 'false',
    injection_prompt,
    describer_prompt,
    describer_history_pairs,
  };
}

export async function setLocationSettings(
  store: OrchestratorSettingsStore,
  patch: {
    split_enabled?: string;
    injection_enabled?: string;
    injection_prompt?: string;
    describer_prompt?: string;
    describer_history_pairs?: string;
  },
): Promise<void> {
  const writes: Array<[SettingName, string]> = [];
  if (patch.split_enabled !== undefined) writes.push(['location_split_enabled', patch.split_enabled]);
  if (patch.injection_enabled !== undefined) writes.push(['location_injection_enabled', patch.injection_enabled]);
  if (patch.injection_prompt !== undefined) writes.push(['location_injection_prompt', patch.injection_prompt]);
  if (patch.describer_prompt !== undefined) writes.push(['location_describer_prompt', patch.describer_prompt]);
  if (patch.describer_history_pairs !== undefined) writes.push(['location_describer_history_pairs', patch.describer_history_pairs]);
  for (const [key, value] of writes) await store.set(key, value);
}

export interface ImageConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  imageUrl?: string;
  /** The exact synthesized positive prompt that was sent to the provider (parallax_fade_teststep.md
   *  §4.2) — present on both success and failure so the admin always sees what was sent. */
  prompt?: string;
  error?: string;
}

// endpoint.md §3.3's Test button: a single, low-cost diagnostic generation probe through one
// saved image connection, reporting latency + the generated test Image URL. The URL is never
// saved to any location record — this is a probe, not a render. Undefined only for "no such
// connection" (404); a reachable-but-failing connection (bad key, unreachable endpoint) is a
// normal { ok: false } result, not a thrown error.
//
// The probe prompt is synthesized exactly like a real render (generateLocationImage.ts): fixed
// sample visual description + environment (the same sample ST's test-step populates), expanded
// through the Master Image Prompt Template (live-read from the settings store — empty = built-in
// default) with this connection's master positive style prefix and negative prompt, so Test
// exercises the same synthesis path a real render does (parallax_fade_teststep.md §4.2).
const PROBE_VISUAL_DESCRIPTION = 'a serene mountain landscape at golden hour, soft mist over the valley';
const PROBE_ENVIRONMENT = { time_of_day: 'golden hour', weather: 'clear', mood: 'serene', lighting: 'soft golden light' } as const;

export async function testImageConnection(
  imageConnections: ImageConnectionStore,
  settings: OrchestratorSettingsStore,
  id: string,
): Promise<ImageConnectionTestResult | undefined> {
  const profile = await imageConnections.resolveById(id);
  if (!profile) return undefined;
  const { positive, negative } = synthesizeImagePrompt({
    template: (await settings.get('image_prompt_template')) ?? '',
    visualDescription: PROBE_VISUAL_DESCRIPTION,
    environment: PROBE_ENVIRONMENT,
    stylePrefix: profile.masterPositiveStylePrefix ?? '',
    negativePrompt: profile.masterNegativePrompt ?? '',
  });
  const start = Date.now();
  try {
    const imageUrl = await createImageGenProvider(profile).generate({
      prompt: positive,
      negativePrompt: negative,
      model: profile.model,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      width: profile.width,
      height: profile.height,
      seed: IMAGE_GEN_SEED,
      steps: profile.samplingSteps,
      cfgScale: profile.cfgScale,
      samplerName: profile.samplerName,
      workflowParameters: profile.workflowParameters,
    });
    return { ok: true, latencyMs: Date.now() - start, imageUrl, prompt: positive };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
      prompt: positive,
    };
  }
}

// UTC is a deliberate, safe default — not a real guess at where the household is, just a value
// that keeps the date/time this backs (util/dateContext.ts) well-defined before anyone's set it.
const DEFAULT_TIMEZONE = 'UTC';

export async function getHouseholdTimezone(store: OrchestratorSettingsStore): Promise<string> {
  return (await store.get('household_timezone')) ?? DEFAULT_TIMEZONE;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function parseSetTimezoneBody(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { value } = raw as Record<string, unknown>;
  if (typeof value !== 'string' || value.length === 0 || !isValidTimeZone(value)) return undefined;
  return value;
}

export function setHouseholdTimezone(store: OrchestratorSettingsStore, value: string): Promise<void> {
  return store.set('household_timezone', value);
}

// --- Notification settings (docs/bb_principles.md §13, §2 — neither value is reasoning, one's a
// selector and the other a toggle) ---
// Live-read shape, same as timezone: sendPushNotificationTool.ts reads both fresh
// on every call, so a Settings-tab edit — including turning the kill switch off — takes effect on
// the very next send_push_notification call, no restart.

export interface NotificationSettings {
  serverUrl: string | null;
  enabled: boolean;
}

export async function getNotificationSettings(store: OrchestratorSettingsStore): Promise<NotificationSettings> {
  const serverUrl = (await store.get('ntfy_server_url')) ?? null;
  const enabled = (await store.get('notifications_enabled')) === 'true';
  return { serverUrl, enabled };
}

export interface SetNotificationSettingsBody {
  serverUrl?: string;
  enabled?: boolean;
}

export function parseSetNotificationSettingsBody(raw: unknown): SetNotificationSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { server_url, enabled } = raw as Record<string, unknown>;
  if (server_url === undefined && enabled === undefined) return undefined;
  if (server_url !== undefined && (typeof server_url !== 'string' || server_url.length === 0)) return undefined;
  if (enabled !== undefined && typeof enabled !== 'boolean') return undefined;
  return {
    serverUrl: typeof server_url === 'string' ? server_url : undefined,
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
  };
}

export async function setNotificationSettings(store: OrchestratorSettingsStore, body: SetNotificationSettingsBody): Promise<void> {
  if (body.serverUrl !== undefined) await store.set('ntfy_server_url', body.serverUrl);
  if (body.enabled !== undefined) await store.set('notifications_enabled', String(body.enabled));
}

// --- Screen lock settings (docs/bi_principles.md §12, §13 — ported from SillyTavern-Playground's
// driver/ui/lockScreen.js) ---
// password isn't a secret by §12's own test: it protects nothing the real household-key/Access
// auth in App.tsx hasn't already gated, purely a privacy shield for an unattended screen. Read
// back and displayed in full, same shape as timezone/notifications above, not write-only like a
// provider credential. Empty password (the default) means the feature is off.

export interface ScreenLockSettings {
  password: string;
  timeoutMinutes: number;
}

const DEFAULT_SCREEN_LOCK_TIMEOUT_MINUTES = 5;

export async function getScreenLockSettings(store: OrchestratorSettingsStore): Promise<ScreenLockSettings> {
  const password = (await store.get('screen_lock_password')) ?? '';
  const rawTimeout = await store.get('screen_lock_timeout_minutes');
  const timeoutMinutes = rawTimeout ? Number(rawTimeout) : DEFAULT_SCREEN_LOCK_TIMEOUT_MINUTES;
  return { password, timeoutMinutes: Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes : DEFAULT_SCREEN_LOCK_TIMEOUT_MINUTES };
}

export interface SetScreenLockSettingsBody {
  password?: string;
  timeoutMinutes?: number;
}

export function parseSetScreenLockSettingsBody(raw: unknown): SetScreenLockSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { password, timeout_minutes } = raw as Record<string, unknown>;
  if (password === undefined && timeout_minutes === undefined) return undefined;
  if (password !== undefined && typeof password !== 'string') return undefined;
  if (timeout_minutes !== undefined && (typeof timeout_minutes !== 'number' || !Number.isFinite(timeout_minutes) || timeout_minutes <= 0)) {
    return undefined;
  }
  return {
    password: typeof password === 'string' ? password : undefined,
    timeoutMinutes: typeof timeout_minutes === 'number' ? timeout_minutes : undefined,
  };
}

export async function setScreenLockSettings(store: OrchestratorSettingsStore, body: SetScreenLockSettingsBody): Promise<void> {
  if (body.password !== undefined) await store.set('screen_lock_password', body.password);
  if (body.timeoutMinutes !== undefined) await store.set('screen_lock_timeout_minutes', String(body.timeoutMinutes));
}

// --- Persona settings (migration 0053, docs/plans/prompt-macros.md's Stage 1) ---
// The household's own name and self-description — read back and displayed in full, same shape as
// screen lock/notifications above, not write-only like a provider credential. Empty (the default)
// means the 'persona' prompt-stack marker slot has nothing to inject even if a preset enables it
// (assemblePromptStack.ts already treats an empty/undefined field as "skip this slot").

export interface PersonaSettings {
  name: string;
  description: string;
}

export async function getPersonaSettings(store: OrchestratorSettingsStore): Promise<PersonaSettings> {
  const name = (await store.get('persona_name')) ?? '';
  const description = (await store.get('persona_description')) ?? '';
  return { name, description };
}

export interface SetPersonaSettingsBody {
  name?: string;
  description?: string;
}

export function parseSetPersonaSettingsBody(raw: unknown): SetPersonaSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, description } = raw as Record<string, unknown>;
  if (name === undefined && description === undefined) return undefined;
  if (name !== undefined && typeof name !== 'string') return undefined;
  if (description !== undefined && typeof description !== 'string') return undefined;
  return {
    name: typeof name === 'string' ? name : undefined,
    description: typeof description === 'string' ? description : undefined,
  };
}

export async function setPersonaSettings(store: OrchestratorSettingsStore, body: SetPersonaSettingsBody): Promise<void> {
  if (body.name !== undefined) await store.set('persona_name', body.name);
  if (body.description !== undefined) await store.set('persona_description', body.description);
}

// --- pia-proxy settings (io/piaProxyFetch.ts, migration 0052) ---
// Same live-read, no-restart shape as ntfy_server_url — a plain internal container address, not a
// secret, so it's read back and displayed in full rather than only reported as "configured".

export async function getPiaProxyUrl(store: OrchestratorSettingsStore): Promise<string | null> {
  return (await store.get('pia_proxy_url')) ?? null;
}

export function parseSetPiaProxyUrlBody(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { value } = raw as Record<string, unknown>;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }
  return value;
}

export function setPiaProxyUrl(store: OrchestratorSettingsStore, value: string): Promise<void> {
  return store.set('pia_proxy_url', value);
}

// --- Chat memory settings (docs/chat-memory.md) ---
// Mirrors SillyTavern-Canonize's own "Connections & Prompts" settings panel: a connection override
// for the rolling-sync pipeline's classification calls (unset = the household's active connection,
// same fallback shape as a chat's own params.profile), three timing knobs in turn-pairs (live
// window, sync-every, and digest-horizon — the last mirroring Canonize's own bridge-summary
// horizon), and a "default + bespoke" override per prompt. Read live on every sync tick
// (orchestrator/src/orchestrator/chatMemorySync.ts) — a save here takes effect on the next tick,
// no restart, same shape as notification settings above. profileNames isn't included here —
// httpServer.ts's route handler attaches it from deps.llmConnections.list(), same split as the
// Connections tab's own listing route.

export interface ChatMemorySettings {
  profile: string | null;
  liveWindowPairs: number | null;
  syncEveryPairs: number | null;
  digestHorizonPairs: number | null;
  // Chunk size in turn-pairs (migration 0099, docs/plans/chunk-size-resize-plan.md) — read live
  // by the sync tick, the eager path, the recall decay SQL, and the admin-triggered re-chunk
  // backfill (orchestrator/chatChunkResize.ts). null = unset (built-in default of 2 pairs = the
  // classic 4-message chunk); a saved value only affects NEW chunks — existing archives keep
  // their old size until the resize backfill re-chunks them.
  chunkPairs: number | null;
  chunkSummaryPrompt: string;
  chunkSummaryPromptIsDefault: boolean;
  distillPrompt: string;
  distillPromptIsDefault: boolean;
  householdMemoryPrompt: string;
  householdMemoryPromptIsDefault: boolean;
  bridgePrompt: string;
  bridgePromptIsDefault: boolean;
  worldCuratorPrompt: string;
  worldCuratorPromptIsDefault: boolean;
  peopleCuratorPrompt: string;
  peopleCuratorPromptIsDefault: boolean;
  // RP read-path injection templates (2026-08-13 component split, io/chatMemory/memoryInjection.ts)
  // — the per-component prompt wrappers rendered by the narrator stack for the bridge /
  // plot_threads / auto_recall markers. Same "default + bespoke" shape as the digest prompts
  // above: empty string = built-in CNZ-shaped default.
  injectBridgePrompt: string;
  injectBridgePromptIsDefault: boolean;
  injectPlotPrompt: string;
  injectPlotPromptIsDefault: boolean;
  injectAutoRecallPrompt: string;
  injectAutoRecallPromptIsDefault: boolean;
  injectRecentHistoryPrompt: string;
  injectRecentHistoryPromptIsDefault: boolean;
  autoRecallChunkPrompt: string;
  autoRecallChunkPromptIsDefault: boolean;
  // Lead-in window (migration 0100, docs/plans/chunk-lead-in-context-plan.md) — how many
  // preceding chunks' summaries ride along with each recalled chunk (recallForPrompt.ts merges
  // them before injection; 0 disables; null = unset, built-in default 2, capped at 3), plus the
  // per-entry template those summaries render under in the narrator stack (empty string = the
  // built-in '[Just before: {{text}}]', same default+bespoke shape as the other prompt fields).
  autoRecallLeadInChunks: number | null;
  autoRecallLeadInPrompt: string;
  autoRecallLeadInPromptIsDefault: boolean;
  // RP read-path retrieval knobs (migration 0077, io/chatMemory/recallForPrompt.ts) — read live
  // on every RP prompt assembly, no restart. null = unset (use the built-in default).
  autoRecallEnabled: boolean;
  autoRecallPairs: number | null;
  autoRecallChunkTopK: number | null;
  // RAG dynamic-cutoff knobs (migration 0091, io/chatMemory/recallCutoff.ts —
  // docs/plans/completed/rag-dynamic-cutoff-plan.md, Stage 1 of the CNZ retrieval port) — read live on
  // every RP prompt assembly alongside the 0077 trio, no restart. autoRecallChunkTopK above is
  // the **Max** ceiling the cutoff clamps to; these three are the Min floor, the Pool Multiple P
  // (candidate pool = P × Max, min 6), and the strictness mode in raw-distance space where lower
  // is better. null = unset (use the built-in default).
  autoRecallMin: number | null;
  autoRecallPoolMultiple: number | null;
  autoRecallCutoffMode: 'mean' | 'mean+1sd' | 'mean+2sd' | null;
  // Ranked plot-arc lane knobs (migration 0097, io/chatMemory/recallPlotLane.ts —
  // docs/plans/plot-arc-recall-plan.md) — read live on every RP prompt assembly alongside the
  // others, no restart. plotRecallTopK is the **Max** ceiling for per-arc cards (default 6,
  // fewer than the fact lane's 8 since each card is multi-entry), plotRecallMin is the Min
  // floor (default 1), plotRecallFloorSyncs is the recency floor (default 2: an arc touched in
  // the chat's last N sync ticks stays visible regardless of score). The 0091 Pool Multiple /
  // Cutoff Mode are shared with the plot lane unchanged. null = unset (use the built-in default).
  plotRecallTopK: number | null;
  plotRecallMin: number | null;
  plotRecallFloorSyncs: number | null;
}

export async function getChatMemorySettings(store: OrchestratorSettingsStore): Promise<ChatMemorySettings> {
  const [
    profile,
    liveRaw,
    syncRaw,
    digestHorizonRaw,
    chunkPairsRaw,
    chunkSummaryPrompt,
    distillPrompt,
    householdMemoryPrompt,
    bridgePrompt,
    worldCuratorPrompt,
    peopleCuratorPrompt,
    autoRecallEnabledRaw,
    autoRecallPairsRaw,
    autoRecallChunkTopKRaw,
    autoRecallChunkMinRaw,
    autoRecallPoolMultipleRaw,
    autoRecallCutoffModeRaw,
    plotRecallTopKRaw,
    plotRecallMinRaw,
    plotRecallFloorRaw,
    injectBridgePrompt,
    injectPlotPrompt,
    injectAutoRecallPrompt,
    injectRecentHistoryPrompt,
    autoRecallChunkPrompt,
    autoRecallLeadInChunksRaw,
    autoRecallLeadInPrompt,
  ] = await Promise.all([
    store.get('chat_memory_profile'),
    store.get('chat_memory_live_window_pairs'),
    store.get('chat_memory_sync_every_pairs'),
    store.get('chat_memory_digest_horizon_pairs'),
    store.get('chat_memory_chunk_pairs'),
    store.get('chat_memory_chunk_summary_prompt'),
    store.get('chat_memory_distill_prompt'),
    store.get('chat_memory_household_memory_prompt'),
    store.get('chat_memory_bridge_prompt'),
    store.get('chat_memory_world_curator_prompt'),
    store.get('chat_memory_people_curator_prompt'),
    store.get('chat_memory_auto_recall_enabled'),
    store.get('chat_memory_auto_recall_pairs'),
    store.get('chat_memory_auto_recall_chunk_top_k'),
    store.get('chat_memory_auto_recall_chunk_min'),
    store.get('chat_memory_auto_recall_pool_multiple'),
    store.get('chat_memory_auto_recall_cutoff_mode'),
    store.get('chat_memory_plot_recall_top_k'),
    store.get('chat_memory_plot_recall_min'),
    store.get('chat_memory_plot_recall_floor_syncs'),
    store.get('chat_memory_inject_bridge_prompt'),
    store.get('chat_memory_inject_plot_prompt'),
    store.get('chat_memory_inject_auto_recall_prompt'),
    store.get('chat_memory_inject_recent_history_prompt'),
    store.get('chat_memory_auto_recall_chunk_prompt'),
    store.get('chat_memory_auto_recall_lead_in_chunks'),
    store.get('chat_memory_auto_recall_lead_in_prompt'),
  ]);
  return {
    profile: profile || null,
    liveWindowPairs: liveRaw ? Number(liveRaw) : null,
    syncEveryPairs: syncRaw ? Number(syncRaw) : null,
    digestHorizonPairs: digestHorizonRaw ? Number(digestHorizonRaw) : null,
    chunkPairs: chunkPairsRaw ? Number(chunkPairsRaw) : null,
    chunkSummaryPrompt: chunkSummaryPrompt || DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT,
    chunkSummaryPromptIsDefault: !chunkSummaryPrompt,
    distillPrompt: distillPrompt || DEFAULT_DISTILL_CHAT_MEMORY_PROMPT,
    distillPromptIsDefault: !distillPrompt,
    householdMemoryPrompt: householdMemoryPrompt || DEFAULT_HOUSEHOLD_MEMORY_PROMPT,
    householdMemoryPromptIsDefault: !householdMemoryPrompt,
    bridgePrompt: bridgePrompt || DEFAULT_BRIDGE_PROMPT,
    bridgePromptIsDefault: !bridgePrompt,
    worldCuratorPrompt: worldCuratorPrompt || DEFAULT_WORLD_MEMORY_CURATOR_PROMPT,
    worldCuratorPromptIsDefault: !worldCuratorPrompt,
    peopleCuratorPrompt: peopleCuratorPrompt || DEFAULT_PEOPLE_CURATOR_PROMPT,
    peopleCuratorPromptIsDefault: !peopleCuratorPrompt,
    // autoRecallEnabled: default true when unset — only the literal string 'false' turns the
    // silent per-turn recall off (recallForPrompt.ts treats any other value as on).
    autoRecallEnabled: autoRecallEnabledRaw !== 'false',
    autoRecallPairs: autoRecallPairsRaw ? Number(autoRecallPairsRaw) : null,
    autoRecallChunkTopK: autoRecallChunkTopKRaw ? Number(autoRecallChunkTopKRaw) : null,
    autoRecallMin: autoRecallChunkMinRaw ? Number(autoRecallChunkMinRaw) : null,
    autoRecallPoolMultiple: autoRecallPoolMultipleRaw ? Number(autoRecallPoolMultipleRaw) : null,
    autoRecallCutoffMode:
      autoRecallCutoffModeRaw === 'mean' || autoRecallCutoffModeRaw === 'mean+1sd' || autoRecallCutoffModeRaw === 'mean+2sd'
        ? autoRecallCutoffModeRaw
        : null,
    plotRecallTopK: plotRecallTopKRaw ? Number(plotRecallTopKRaw) : null,
    plotRecallMin: plotRecallMinRaw ? Number(plotRecallMinRaw) : null,
    plotRecallFloorSyncs: plotRecallFloorRaw ? Number(plotRecallFloorRaw) : null,
    injectBridgePrompt: injectBridgePrompt || DEFAULT_INJECT_BRIDGE_PROMPT,
    injectBridgePromptIsDefault: !injectBridgePrompt,
    injectPlotPrompt: injectPlotPrompt || DEFAULT_INJECT_PLOT_PROMPT,
    injectPlotPromptIsDefault: !injectPlotPrompt,
    injectAutoRecallPrompt: injectAutoRecallPrompt || DEFAULT_INJECT_AUTO_RECALL_PROMPT,
    injectAutoRecallPromptIsDefault: !injectAutoRecallPrompt,
    injectRecentHistoryPrompt: injectRecentHistoryPrompt || DEFAULT_INJECT_RECENT_HISTORY_PROMPT,
    injectRecentHistoryPromptIsDefault: !injectRecentHistoryPrompt,
    autoRecallChunkPrompt: autoRecallChunkPrompt || DEFAULT_AUTO_RECALL_CHUNK_PROMPT,
    autoRecallChunkPromptIsDefault: !autoRecallChunkPrompt,
    autoRecallLeadInChunks: autoRecallLeadInChunksRaw ? Number(autoRecallLeadInChunksRaw) : null,
    autoRecallLeadInPrompt: autoRecallLeadInPrompt || DEFAULT_AUTO_RECALL_LEAD_IN_PROMPT,
    autoRecallLeadInPromptIsDefault: !autoRecallLeadInPrompt,
  };
}

export interface SetChatMemorySettingsBody {
  profile?: string;
  liveWindowPairs?: number;
  syncEveryPairs?: number;
  digestHorizonPairs?: number;
  chunkPairs?: number;
  chunkSummaryPrompt?: string;
  distillPrompt?: string;
  householdMemoryPrompt?: string;
  bridgePrompt?: string;
  worldCuratorPrompt?: string;
  peopleCuratorPrompt?: string;
  autoRecallEnabled?: boolean;
  autoRecallPairs?: number;
  autoRecallChunkTopK?: number;
  autoRecallMin?: number;
  autoRecallPoolMultiple?: number;
  autoRecallCutoffMode?: string;
  plotRecallTopK?: number;
  plotRecallMin?: number;
  plotRecallFloorSyncs?: number;
  injectBridgePrompt?: string;
  injectPlotPrompt?: string;
  injectAutoRecallPrompt?: string;
  injectRecentHistoryPrompt?: string;
  autoRecallChunkPrompt?: string;
  /** Lead-in window: 0 disables (recallForPrompt.ts skips the walk), 1–3 = how many preceding
   *  chunks' summaries ride along. Negative rejects. */
  autoRecallLeadInChunks?: number;
  autoRecallLeadInPrompt?: string;
}

// Every field is optional and independently settable; an empty string on any prompt field clears
// the override back to its built-in default (there is no separate "reset" endpoint — see
// io/orchestratorSettings.ts's own doc on this). Wire keys are snake_case, same convention as
// every other parseSet*Body in this file (server_url, live_window_pairs, ...).
export function parseSetChatMemorySettingsBody(raw: unknown): SetChatMemorySettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const {
    profile,
    live_window_pairs,
    sync_every_pairs,
    digest_horizon_pairs,
    chunk_pairs,
    chunk_summary_prompt,
    distill_prompt,
    household_memory_prompt,
    bridge_prompt,
    world_curator_prompt,
    people_curator_prompt,
    auto_recall_enabled,
    auto_recall_pairs,
    auto_recall_chunk_top_k,
    auto_recall_chunk_min,
    auto_recall_pool_multiple,
    auto_recall_cutoff_mode,
    plot_recall_top_k,
    plot_recall_min,
    plot_recall_floor_syncs,
    inject_bridge_prompt,
    inject_plot_prompt,
    inject_auto_recall_prompt,
    inject_recent_history_prompt,
    auto_recall_chunk_prompt,
    auto_recall_lead_in_chunks,
    auto_recall_lead_in_prompt,
  } = raw as Record<string, unknown>;
  if (
    profile === undefined &&
    live_window_pairs === undefined &&
    sync_every_pairs === undefined &&
    digest_horizon_pairs === undefined &&
    chunk_pairs === undefined &&
    chunk_summary_prompt === undefined &&
    distill_prompt === undefined &&
    household_memory_prompt === undefined &&
    bridge_prompt === undefined &&
    world_curator_prompt === undefined &&
    people_curator_prompt === undefined &&
    auto_recall_enabled === undefined &&
    auto_recall_pairs === undefined &&
    auto_recall_chunk_top_k === undefined &&
    auto_recall_chunk_min === undefined &&
    auto_recall_pool_multiple === undefined &&
    auto_recall_cutoff_mode === undefined &&
    plot_recall_top_k === undefined &&
    plot_recall_min === undefined &&
    plot_recall_floor_syncs === undefined &&
    inject_bridge_prompt === undefined &&
    inject_plot_prompt === undefined &&
    inject_auto_recall_prompt === undefined &&
    inject_recent_history_prompt === undefined &&
    auto_recall_chunk_prompt === undefined &&
    auto_recall_lead_in_chunks === undefined &&
    auto_recall_lead_in_prompt === undefined
  ) {
    return undefined;
  }
  if (profile !== undefined && typeof profile !== 'string') return undefined;
  if (live_window_pairs !== undefined && (typeof live_window_pairs !== 'number' || live_window_pairs <= 0)) return undefined;
  if (sync_every_pairs !== undefined && (typeof sync_every_pairs !== 'number' || sync_every_pairs <= 0)) return undefined;
  if (digest_horizon_pairs !== undefined && (typeof digest_horizon_pairs !== 'number' || digest_horizon_pairs <= 0)) return undefined;
  if (chunk_pairs !== undefined && (typeof chunk_pairs !== 'number' || chunk_pairs <= 0)) return undefined;
  if (chunk_summary_prompt !== undefined && typeof chunk_summary_prompt !== 'string') return undefined;
  if (distill_prompt !== undefined && typeof distill_prompt !== 'string') return undefined;
  if (household_memory_prompt !== undefined && typeof household_memory_prompt !== 'string') return undefined;
  if (bridge_prompt !== undefined && typeof bridge_prompt !== 'string') return undefined;
  if (world_curator_prompt !== undefined && typeof world_curator_prompt !== 'string') return undefined;
  if (people_curator_prompt !== undefined && typeof people_curator_prompt !== 'string') return undefined;
  if (auto_recall_enabled !== undefined && typeof auto_recall_enabled !== 'boolean') return undefined;
  if (auto_recall_pairs !== undefined && (typeof auto_recall_pairs !== 'number' || auto_recall_pairs <= 0)) return undefined;
  if (auto_recall_chunk_top_k !== undefined && (typeof auto_recall_chunk_top_k !== 'number' || auto_recall_chunk_top_k <= 0)) return undefined;
  if (auto_recall_chunk_min !== undefined && (typeof auto_recall_chunk_min !== 'number' || auto_recall_chunk_min <= 0)) return undefined;
  if (auto_recall_pool_multiple !== undefined && (typeof auto_recall_pool_multiple !== 'number' || auto_recall_pool_multiple <= 0)) return undefined;
  if (auto_recall_cutoff_mode !== undefined && typeof auto_recall_cutoff_mode !== 'string') return undefined;
  if (plot_recall_top_k !== undefined && (typeof plot_recall_top_k !== 'number' || plot_recall_top_k <= 0)) return undefined;
  if (plot_recall_min !== undefined && (typeof plot_recall_min !== 'number' || plot_recall_min <= 0)) return undefined;
  if (plot_recall_floor_syncs !== undefined && (typeof plot_recall_floor_syncs !== 'number' || plot_recall_floor_syncs <= 0)) return undefined;
  if (inject_bridge_prompt !== undefined && typeof inject_bridge_prompt !== 'string') return undefined;
  if (inject_plot_prompt !== undefined && typeof inject_plot_prompt !== 'string') return undefined;
  if (inject_auto_recall_prompt !== undefined && typeof inject_auto_recall_prompt !== 'string') return undefined;
  if (inject_recent_history_prompt !== undefined && typeof inject_recent_history_prompt !== 'string') return undefined;
  if (auto_recall_chunk_prompt !== undefined && typeof auto_recall_chunk_prompt !== 'string') return undefined;
  // 0 is meaningful (disables lead-ins), so the check is `>= 0` — unlike the positive-only knobs.
  if (auto_recall_lead_in_chunks !== undefined && (typeof auto_recall_lead_in_chunks !== 'number' || auto_recall_lead_in_chunks < 0)) return undefined;
  if (auto_recall_lead_in_prompt !== undefined && typeof auto_recall_lead_in_prompt !== 'string') return undefined;
  return {
    profile: profile as string | undefined,
    liveWindowPairs: live_window_pairs as number | undefined,
    syncEveryPairs: sync_every_pairs as number | undefined,
    digestHorizonPairs: digest_horizon_pairs as number | undefined,
    chunkPairs: chunk_pairs as number | undefined,
    chunkSummaryPrompt: chunk_summary_prompt as string | undefined,
    distillPrompt: distill_prompt as string | undefined,
    householdMemoryPrompt: household_memory_prompt as string | undefined,
    bridgePrompt: bridge_prompt as string | undefined,
    worldCuratorPrompt: world_curator_prompt as string | undefined,
    peopleCuratorPrompt: people_curator_prompt as string | undefined,
    autoRecallEnabled: auto_recall_enabled as boolean | undefined,
    autoRecallPairs: auto_recall_pairs as number | undefined,
    autoRecallChunkTopK: auto_recall_chunk_top_k as number | undefined,
    autoRecallMin: auto_recall_chunk_min as number | undefined,
    autoRecallPoolMultiple: auto_recall_pool_multiple as number | undefined,
    autoRecallCutoffMode: auto_recall_cutoff_mode as string | undefined,
    plotRecallTopK: plot_recall_top_k as number | undefined,
    plotRecallMin: plot_recall_min as number | undefined,
    plotRecallFloorSyncs: plot_recall_floor_syncs as number | undefined,
    injectBridgePrompt: inject_bridge_prompt as string | undefined,
    injectPlotPrompt: inject_plot_prompt as string | undefined,
    injectAutoRecallPrompt: inject_auto_recall_prompt as string | undefined,
    injectRecentHistoryPrompt: inject_recent_history_prompt as string | undefined,
    autoRecallChunkPrompt: auto_recall_chunk_prompt as string | undefined,
    autoRecallLeadInChunks: auto_recall_lead_in_chunks as number | undefined,
    autoRecallLeadInPrompt: auto_recall_lead_in_prompt as string | undefined,
  };
}

export async function setChatMemorySettings(store: OrchestratorSettingsStore, body: SetChatMemorySettingsBody): Promise<void> {
  if (body.profile !== undefined) await store.set('chat_memory_profile', body.profile);
  if (body.liveWindowPairs !== undefined) await store.set('chat_memory_live_window_pairs', String(body.liveWindowPairs));
  if (body.syncEveryPairs !== undefined) await store.set('chat_memory_sync_every_pairs', String(body.syncEveryPairs));
  if (body.digestHorizonPairs !== undefined) await store.set('chat_memory_digest_horizon_pairs', String(body.digestHorizonPairs));
  if (body.chunkPairs !== undefined) await store.set('chat_memory_chunk_pairs', String(body.chunkPairs));
  if (body.chunkSummaryPrompt !== undefined) await store.set('chat_memory_chunk_summary_prompt', body.chunkSummaryPrompt);
  if (body.distillPrompt !== undefined) await store.set('chat_memory_distill_prompt', body.distillPrompt);
  if (body.householdMemoryPrompt !== undefined) await store.set('chat_memory_household_memory_prompt', body.householdMemoryPrompt);
  if (body.bridgePrompt !== undefined) await store.set('chat_memory_bridge_prompt', body.bridgePrompt);
  if (body.worldCuratorPrompt !== undefined) await store.set('chat_memory_world_curator_prompt', body.worldCuratorPrompt);
  if (body.peopleCuratorPrompt !== undefined) await store.set('chat_memory_people_curator_prompt', body.peopleCuratorPrompt);
  if (body.autoRecallEnabled !== undefined) await store.set('chat_memory_auto_recall_enabled', body.autoRecallEnabled ? 'true' : 'false');
  if (body.autoRecallPairs !== undefined) await store.set('chat_memory_auto_recall_pairs', String(body.autoRecallPairs));
  if (body.autoRecallChunkTopK !== undefined) await store.set('chat_memory_auto_recall_chunk_top_k', String(body.autoRecallChunkTopK));
  if (body.autoRecallMin !== undefined) await store.set('chat_memory_auto_recall_chunk_min', String(body.autoRecallMin));
  if (body.autoRecallPoolMultiple !== undefined) await store.set('chat_memory_auto_recall_pool_multiple', String(body.autoRecallPoolMultiple));
  if (body.autoRecallCutoffMode !== undefined) await store.set('chat_memory_auto_recall_cutoff_mode', body.autoRecallCutoffMode);
  if (body.plotRecallTopK !== undefined) await store.set('chat_memory_plot_recall_top_k', String(body.plotRecallTopK));
  if (body.plotRecallMin !== undefined) await store.set('chat_memory_plot_recall_min', String(body.plotRecallMin));
  if (body.plotRecallFloorSyncs !== undefined) await store.set('chat_memory_plot_recall_floor_syncs', String(body.plotRecallFloorSyncs));
  if (body.injectBridgePrompt !== undefined) await store.set('chat_memory_inject_bridge_prompt', body.injectBridgePrompt);
  if (body.injectPlotPrompt !== undefined) await store.set('chat_memory_inject_plot_prompt', body.injectPlotPrompt);
  if (body.injectAutoRecallPrompt !== undefined) await store.set('chat_memory_inject_auto_recall_prompt', body.injectAutoRecallPrompt);
  if (body.injectRecentHistoryPrompt !== undefined) await store.set('chat_memory_inject_recent_history_prompt', body.injectRecentHistoryPrompt);
  if (body.autoRecallChunkPrompt !== undefined) await store.set('chat_memory_auto_recall_chunk_prompt', body.autoRecallChunkPrompt);
  if (body.autoRecallLeadInChunks !== undefined) await store.set('chat_memory_auto_recall_lead_in_chunks', String(body.autoRecallLeadInChunks));
  if (body.autoRecallLeadInPrompt !== undefined) await store.set('chat_memory_auto_recall_lead_in_prompt', body.autoRecallLeadInPrompt);
}

// --- Cleanup settings (migration 0072, plan v2 §3 — the Cleanup page's setup surface) ---
// The four cleanup config keys (the header/footer trigger regex + repair prompt — "the format
// expressed as a prompt") plus the slop-rules table, read/written together as the page's single
// settings block. Same live-read shape as the other Settings-tab fields: the subloop re-reads
// both every tick (cleanupLoop.ts's resolveCleanupConfig/loadSlopRules), so a save here takes
// effect on the very next poll, no restart. Slop rules are a full-set replace (delete-all +
// insert-each in one system-scoped transaction, cleanupLoop.ts's replaceSlopRules) — the page
// edits the whole set and saves; there is no per-rule CRUD surface.
//
// The reasoning tag pair (reasoning_open_tag / reasoning_close_tag, migration 0095,
// docs/plans/reasoning-blocks-plan.md) lives on this same block per the plan's §13/§17
// alignment with the cleanup config's existing scope — the Cleanup page is the "in-stream
// transform" surface, and the tags are another one. Like the header regex, an empty value is a
// deliberate override: the detector disables when either tag is blank (liveReasoning.ts's
// resolveReasoningTags), so saving '' here turns reasoning blocks off; the defaults ('<think>' /
// '</think>') are the built-in pair liveReasoning.ts falls back to when a key is unset. Because
// the values are read live at the start of every RP streaming turn, a save takes effect on the
// very next turn — no restart.

export interface CleanupSettings {
  headerRegex: string;
  headerPrompt: string;
  footerRegex: string;
  footerPrompt: string;
  slopRules: SlopRuleInput[];
  /** The reasoning-block tag pair (defaults '<think>' / '</think>'); either one blank =
   *  detection disabled. Same live-read shape as the header/footer regex fields. */
  reasoningOpenTag: string;
  reasoningCloseTag: string;
}

export async function getCleanupSettings(store: OrchestratorSettingsStore, db: PostgresClient): Promise<CleanupSettings> {
  const [headerRegex, headerPrompt, footerRegex, footerPrompt, reasoningOpenTag, reasoningCloseTag] = await Promise.all([
    store.get('cleanup_header_regex'),
    store.get('cleanup_header_prompt'),
    store.get('cleanup_footer_regex'),
    store.get('cleanup_footer_prompt'),
    store.get('reasoning_open_tag'),
    store.get('reasoning_close_tag'),
  ]);
  const slopRules = await loadSlopRules(db);
  return {
    headerRegex: headerRegex ?? DEFAULT_CLEANUP_CONFIG.headerRegex,
    headerPrompt: headerPrompt ?? DEFAULT_CLEANUP_CONFIG.headerPrompt,
    footerRegex: footerRegex ?? DEFAULT_CLEANUP_CONFIG.footerRegex,
    footerPrompt: footerPrompt ?? DEFAULT_CLEANUP_CONFIG.footerPrompt,
    slopRules,
    reasoningOpenTag: reasoningOpenTag ?? DEFAULT_REASONING_OPEN_TAG,
    reasoningCloseTag: reasoningCloseTag ?? DEFAULT_REASONING_CLOSE_TAG,
  };
}

export interface SetCleanupSettingsBody {
  headerRegex?: string;
  headerPrompt?: string;
  footerRegex?: string;
  footerPrompt?: string;
  /** Present = full-set replace (the page always sends its whole edited set). */
  slopRules?: SlopRuleInput[];
  /** The reasoning-block tag pair; either one '' = detection disabled. Optional, like the
   *  header/footer fields — omitted fields are left untouched. */
  reasoningOpenTag?: string;
  reasoningCloseTag?: string;
}

export function parseSetCleanupSettingsBody(raw: unknown): SetCleanupSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { header_regex, header_prompt, footer_regex, footer_prompt, slop_rules, reasoning_open_tag, reasoning_close_tag } = raw as Record<string, unknown>;
  if (
    header_regex === undefined &&
    header_prompt === undefined &&
    footer_regex === undefined &&
    footer_prompt === undefined &&
    slop_rules === undefined &&
    reasoning_open_tag === undefined &&
    reasoning_close_tag === undefined
  ) {
    return undefined;
  }
  if (header_regex !== undefined && typeof header_regex !== 'string') return undefined;
  if (header_prompt !== undefined && typeof header_prompt !== 'string') return undefined;
  if (footer_regex !== undefined && typeof footer_regex !== 'string') return undefined;
  if (footer_prompt !== undefined && typeof footer_prompt !== 'string') return undefined;
  if (reasoning_open_tag !== undefined && typeof reasoning_open_tag !== 'string') return undefined;
  if (reasoning_close_tag !== undefined && typeof reasoning_close_tag !== 'string') return undefined;
  if (slop_rules !== undefined) {
    if (!Array.isArray(slop_rules)) return undefined;
    const rules: SlopRuleInput[] = [];
    for (const r of slop_rules) {
      if (typeof r !== 'object' || r === null) return undefined;
      const {
        set_name,
        position,
        pattern,
        flags,
        action,
        replacement,
        llm_prompt,
        enabled,
      } = r as Record<string, unknown>;
      if (typeof set_name !== 'string' || set_name.length === 0) return undefined;
      if (typeof position !== 'number' || !Number.isInteger(position) || position < 0) return undefined;
      if (typeof pattern !== 'string' || pattern.length === 0) return undefined;
      if (flags !== undefined && typeof flags !== 'string') return undefined;
      if (action !== 'remove' && action !== 'replace-paragraph' && action !== 'llm') return undefined;
      if (replacement !== undefined && replacement !== null && typeof replacement !== 'string') return undefined;
      if (llm_prompt !== undefined && llm_prompt !== null && typeof llm_prompt !== 'string') return undefined;
      if (enabled !== undefined && typeof enabled !== 'boolean') return undefined;
      rules.push({
        setName: set_name,
        position,
        pattern,
        flags: typeof flags === 'string' ? flags : '',
        action,
        replacement: typeof replacement === 'string' ? replacement : null,
        llmPrompt: typeof llm_prompt === 'string' ? llm_prompt : null,
        enabled: typeof enabled === 'boolean' ? enabled : true,
      });
    }
    return {
      headerRegex: h(header_regex),
      headerPrompt: h(header_prompt),
      footerRegex: h(footer_regex),
      footerPrompt: h(footer_prompt),
      slopRules: rules,
      reasoningOpenTag: h(reasoning_open_tag),
      reasoningCloseTag: h(reasoning_close_tag),
    };
  }
  return {
    headerRegex: h(header_regex),
    headerPrompt: h(header_prompt),
    footerRegex: h(footer_regex),
    footerPrompt: h(footer_prompt),
    reasoningOpenTag: h(reasoning_open_tag),
    reasoningCloseTag: h(reasoning_close_tag),
  };
}

function h(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export async function setCleanupSettings(
  store: OrchestratorSettingsStore,
  db: PostgresClient,
  body: SetCleanupSettingsBody,
): Promise<void> {
  if (body.headerRegex !== undefined) await store.set('cleanup_header_regex', body.headerRegex);
  if (body.headerPrompt !== undefined) await store.set('cleanup_header_prompt', body.headerPrompt);
  if (body.footerRegex !== undefined) await store.set('cleanup_footer_regex', body.footerRegex);
  if (body.footerPrompt !== undefined) await store.set('cleanup_footer_prompt', body.footerPrompt);
  if (body.slopRules !== undefined) await replaceSlopRules(db, body.slopRules);
  if (body.reasoningOpenTag !== undefined) await store.set('reasoning_open_tag', body.reasoningOpenTag);
  if (body.reasoningCloseTag !== undefined) await store.set('reasoning_close_tag', body.reasoningCloseTag);
}

// --- Canon settings (docs/canonize-plan.md §6, bi_principles.md §13/§17) ---
// The Canonize feature's knobs: canon_recall_top_k (integer-as-text, default '8' — how many
// canon facts recall_canon_facts returns, read live on every recall call, no restart) and
// canon_extraction_prompt (the background extraction call's prompt template — "default + bespoke"
// override per bi_principles.md §17, empty clears back to the built-in, same shape as the
// chat_memory_* prompts above). Since migration 0092 (docs/plans/completed/rag-dynamic-cutoff-plan.md
// Stage 2) canon_recall_top_k doubles as the fact lane's per-channel **Max** for the dynamic
// cutoff, with canon_recall_min (default '2') as its Min floor — read live by
// buildAutoRecallParts alongside the shared 0091 knobs. The extraction pass that consumes the
// prompt is Director Pass work (canonize-plan.md §2) — not wired yet; the setting is still
// surfaced now so it exists before the pass does.

export interface CanonSettings {
  recallTopK: number;
  recallMin: number | null;
  extractionPrompt: string;
  extractionPromptIsDefault: boolean;
}

export async function getCanonSettings(store: OrchestratorSettingsStore): Promise<CanonSettings> {
  const [topKRaw, minRaw, extractionPrompt] = await Promise.all([
    store.get('canon_recall_top_k'),
    store.get('canon_recall_min'),
    store.get('canon_extraction_prompt'),
  ]);
  const parsedTopK = topKRaw ? Number(topKRaw) : NaN;
  return {
    recallTopK: Number.isInteger(parsedTopK) && parsedTopK > 0 ? parsedTopK : 8,
    recallMin: minRaw ? Number(minRaw) : null,
    extractionPrompt: extractionPrompt || DEFAULT_CANON_EXTRACTION_PROMPT,
    extractionPromptIsDefault: !extractionPrompt,
  };
}

export interface SetCanonSettingsBody {
  recallTopK?: number;
  recallMin?: number;
  extractionPrompt?: string;
}

// Both fields optional and independently settable; an empty string on the prompt field clears the
// override back to its built-in default (there is no separate "reset" endpoint — see
// io/orchestratorSettings.ts's own doc on this). Wire keys are snake_case, same convention as
// every other parseSet*Body in this file.
export function parseSetCanonSettingsBody(raw: unknown): SetCanonSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { recall_top_k, recall_min, extraction_prompt } = raw as Record<string, unknown>;
  if (recall_top_k === undefined && recall_min === undefined && extraction_prompt === undefined) return undefined;
  if (recall_top_k !== undefined && (typeof recall_top_k !== 'number' || !Number.isInteger(recall_top_k) || recall_top_k <= 0)) {
    return undefined;
  }
  if (recall_min !== undefined && (typeof recall_min !== 'number' || !Number.isInteger(recall_min) || recall_min <= 0)) {
    return undefined;
  }
  if (extraction_prompt !== undefined && typeof extraction_prompt !== 'string') return undefined;
  return {
    recallTopK: recall_top_k as number | undefined,
    recallMin: recall_min as number | undefined,
    extractionPrompt: extraction_prompt as string | undefined,
  };
}

export async function setCanonSettings(store: OrchestratorSettingsStore, body: SetCanonSettingsBody): Promise<void> {
  if (body.recallTopK !== undefined) await store.set('canon_recall_top_k', String(body.recallTopK));
  if (body.recallMin !== undefined) await store.set('canon_recall_min', String(body.recallMin));
  if (body.extractionPrompt !== undefined) await store.set('canon_extraction_prompt', body.extractionPrompt);
}

// --- Lorebook settings (docs/lorebook-plan.md §3d/§8a, step 5) ---
// The §3d keys were registered in orchestratorSettings.ts at the same commit that widened the
// CHECK (0088); this trio is the admin read/write surface the Lorebooks page's settings panel
// drives. Defaults mirror what resolveLorebook.ts reads when a key is unset: mode off (§2),
// recall top-K 8 (canon_recall_top_k's default), token budget unlimited, recursion off (its row
// exists but is deliberately unread — §9).
export interface LorebookSettings {
  lorebookMode: 'on' | 'off';
  lorebookModeIsDefault: boolean;
  /** null = unlimited (the unset/infinite default). */
  lorebookTokenBudget: number | null;
  lorebookTokenBudgetIsDefault: boolean;
  lorebookRecallTopK: number;
  lorebookRecallTopKIsDefault: boolean;
  lorebookRecursionEnabled: boolean;
  lorebookRecursionEnabledIsDefault: boolean;
}

export async function getLorebookSettings(store: OrchestratorSettingsStore): Promise<LorebookSettings> {
  const [modeRaw, budgetRaw, topKRaw, recursionRaw] = await Promise.all([
    store.get('lorebook_mode'),
    store.get('lorebook_token_budget'),
    store.get('lorebook_recall_top_k'),
    store.get('lorebook_recursion_enabled'),
  ]);
  const parsedBudget = budgetRaw ? Number(budgetRaw) : NaN;
  const parsedTopK = topKRaw ? Number(topKRaw) : NaN;
  return {
    lorebookMode: modeRaw === 'on' ? 'on' : 'off',
    lorebookModeIsDefault: modeRaw === undefined,
    // 'Infinity' is the canonical stored spelling for "no budget" (setLorebookSettings writes it
    // when the panel clears the field); both it and an unset row map to null.
    lorebookTokenBudget:
      budgetRaw === undefined || budgetRaw === 'Infinity' || !Number.isFinite(parsedBudget) || parsedBudget <= 0 ? null : parsedBudget,
    lorebookTokenBudgetIsDefault: budgetRaw === undefined,
    lorebookRecallTopK: Number.isInteger(parsedTopK) && parsedTopK > 0 ? parsedTopK : 8,
    lorebookRecallTopKIsDefault: topKRaw === undefined,
    lorebookRecursionEnabled: recursionRaw === 'true',
    lorebookRecursionEnabledIsDefault: recursionRaw === undefined,
  };
}

export interface SetLorebookSettingsBody {
  lorebookMode?: 'on' | 'off';
  /** null clears the budget back to unlimited. */
  lorebookTokenBudget?: number | null;
  lorebookRecallTopK?: number;
  lorebookRecursionEnabled?: boolean;
}

// All four fields optional and independently settable; wire keys are snake_case, same convention
// as every other parseSet*Body in this file. An explicit null on lorebook_token_budget clears the
// override back to unlimited (the "reset to default" gesture for that field).
export function parseSetLorebookSettingsBody(raw: unknown): SetLorebookSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { lorebook_mode, lorebook_token_budget, lorebook_recall_top_k, lorebook_recursion_enabled } = raw as Record<string, unknown>;
  if (
    lorebook_mode === undefined &&
    lorebook_token_budget === undefined &&
    lorebook_recall_top_k === undefined &&
    lorebook_recursion_enabled === undefined
  ) {
    return undefined;
  }
  if (lorebook_mode !== undefined && lorebook_mode !== 'on' && lorebook_mode !== 'off') return undefined;
  if (
    lorebook_token_budget !== undefined &&
    lorebook_token_budget !== null &&
    (typeof lorebook_token_budget !== 'number' || !Number.isFinite(lorebook_token_budget) || lorebook_token_budget <= 0)
  ) {
    return undefined;
  }
  if (lorebook_recall_top_k !== undefined && (typeof lorebook_recall_top_k !== 'number' || !Number.isInteger(lorebook_recall_top_k) || lorebook_recall_top_k <= 0)) {
    return undefined;
  }
  if (lorebook_recursion_enabled !== undefined && typeof lorebook_recursion_enabled !== 'boolean') return undefined;
  return {
    lorebookMode: lorebook_mode as 'on' | 'off' | undefined,
    lorebookTokenBudget: lorebook_token_budget as number | null | undefined,
    lorebookRecallTopK: lorebook_recall_top_k as number | undefined,
    lorebookRecursionEnabled: lorebook_recursion_enabled as boolean | undefined,
  };
}

export async function setLorebookSettings(store: OrchestratorSettingsStore, body: SetLorebookSettingsBody): Promise<void> {
  if (body.lorebookMode !== undefined) await store.set('lorebook_mode', body.lorebookMode);
  if (body.lorebookTokenBudget !== undefined) {
    await store.set('lorebook_token_budget', body.lorebookTokenBudget === null ? 'Infinity' : String(body.lorebookTokenBudget));
  }
  if (body.lorebookRecallTopK !== undefined) await store.set('lorebook_recall_top_k', String(body.lorebookRecallTopK));
  if (body.lorebookRecursionEnabled !== undefined) await store.set('lorebook_recursion_enabled', String(body.lorebookRecursionEnabled));
}

// --- Lorebook management CRUD (docs/lorebook-plan.md §8a, step 5) ---
// The Lorebooks page's library list + entry editor. Books/entries are user-scoped, RLS-forced
// tables (0051), so every write takes the owning userId explicitly and runs under that user's
// scope — the admin key grants cross-user *reads* (roster + per-user scan, same shape as
// getLocationsAdmin), but Postgres still refuses a system-scope write into a forced-RLS table.
// All FKs cascade (0051/0088), so deletes are single-statement. vector_embed is populated at
// create/update time by embedding `${bookName}\n${content}` (the §3c/chatMemorySync shape); an
// embedding failure fails open to a null vector — the entry still works, it just can't be ranked.
export interface LorebookEntryAdminRow {
  entryId: string;
  uid: number;
  key: string[];
  comment: string;
  content: string;
  constant: boolean;
  disable: boolean;
  orderValue: number;
  probability: number;
  useProbability: boolean;
  groupName: string;
  groupWeight: number;
  groupOverride: boolean;
  sticky: number;
  cooldown: number;
  delay: number;
  updatedAt: string;
}

export interface LorebookAdminRow {
  lorebookId: string;
  userId: string;
  name: string;
  globalScope: boolean;
  createdAt: string;
  updatedAt: string;
  characterIds: string[];
  chatOverrideCount: number;
  entries: LorebookEntryAdminRow[];
}

export interface LorebookEntryInput {
  lorebookId: string;
  content: string;
  key?: string[];
  comment?: string;
  constant?: boolean;
  disable?: boolean;
  orderValue?: number;
  probability?: number;
  useProbability?: boolean;
  groupName?: string;
  groupWeight?: number;
  groupOverride?: boolean;
  sticky?: number;
  cooldown?: number;
  delay?: number;
}

export type LorebookEntryPatch = Omit<LorebookEntryInput, 'lorebookId' | 'content'> & { content?: string };

interface LorebookEntryRowShape {
  entry_id: string;
  uid: number;
  key: string[];
  comment: string;
  content: string;
  constant: boolean;
  disable: boolean;
  order_value: number;
  probability: number;
  use_probability: boolean;
  group_name: string;
  group_weight: number;
  group_override: boolean;
  sticky: number;
  cooldown: number;
  delay: number;
  updated_at: string;
}

function toLorebookEntryAdminRow(r: LorebookEntryRowShape): LorebookEntryAdminRow {
  return {
    entryId: r.entry_id,
    uid: r.uid,
    key: r.key,
    comment: r.comment,
    content: r.content,
    constant: r.constant,
    disable: r.disable,
    orderValue: r.order_value,
    probability: r.probability,
    useProbability: r.use_probability,
    groupName: r.group_name,
    groupWeight: r.group_weight,
    groupOverride: r.group_override,
    sticky: r.sticky,
    cooldown: r.cooldown,
    delay: r.delay,
    updatedAt: r.updated_at,
  };
}

export async function getLorebooksAdmin(db: PostgresClient): Promise<LorebookAdminRow[]> {
  const users = await db.withSystemScope((session) => session.query<{ user_id: string }>('select user_id from users'));
  const rows: LorebookAdminRow[] = [];
  for (const { user_id: userId } of users) {
    const books = await db.withUserScope(userId, (session) =>
      session.query<{
        lorebook_id: string;
        name: string;
        global_scope: boolean;
        created_at: string;
        updated_at: string;
        chat_override_count: number;
        character_ids: string[] | null;
      }>(
        `select b.lorebook_id, b.name, b.global_scope, b.created_at, b.updated_at,
                (select count(*)::int from lorebook_chat_overrides co where co.lorebook_id = b.lorebook_id) as chat_override_count,
                (select coalesce(array_agg(cl.character_id order by cl.joined_at), '{}'::uuid[]) from lorebook_character_links cl
                 where cl.lorebook_id = b.lorebook_id) as character_ids
         from lorebooks b
         order by b.name`,
      ),
    );
    for (const b of books) {
      const entries = await db.withUserScope(userId, (session) =>
        session.query<LorebookEntryRowShape>(
          `select entry_id, uid, key, comment, content, constant, disable, order_value, probability,
                  use_probability, group_name, group_weight, group_override, sticky, cooldown, delay, updated_at
           from lorebook_entries where lorebook_id = $1
           order by order_value, uid`,
          [b.lorebook_id],
        ),
      );
      rows.push({
        lorebookId: b.lorebook_id,
        userId,
        name: b.name,
        globalScope: b.global_scope,
        createdAt: b.created_at,
        updatedAt: b.updated_at,
        characterIds: b.character_ids ?? [],
        chatOverrideCount: b.chat_override_count,
        entries: entries.map(toLorebookEntryAdminRow),
      });
    }
  }
  return rows;
}

export async function createLorebookAdmin(db: PostgresClient, userId: string, name: string): Promise<LorebookAdminRow | undefined> {
  return db.withUserScope(userId, async (session) => {
    const [row] = await session.query<{ lorebook_id: string; name: string; global_scope: boolean; created_at: string; updated_at: string }>(
      'insert into lorebooks (user_id, name) values ($1, $2) returning lorebook_id, name, global_scope, created_at, updated_at',
      [userId, name],
    );
    if (!row) return undefined;
    return {
      lorebookId: row.lorebook_id,
      userId,
      name: row.name,
      globalScope: row.global_scope,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      characterIds: [],
      chatOverrideCount: 0,
      entries: [],
    };
  });
}

export interface UpdateLorebookPatch {
  name?: string;
  globalScope?: boolean;
  /** Replaces the book's character-link set wholesale; omitted = leave links untouched. */
  characterIds?: string[];
}

export async function updateLorebookAdmin(
  db: PostgresClient,
  userId: string,
  lorebookId: string,
  patch: UpdateLorebookPatch,
): Promise<boolean> {
  return db.withUserScope(userId, async (session) => {
    if (patch.name !== undefined || patch.globalScope !== undefined) {
      const sets: string[] = [];
      const params: unknown[] = [lorebookId, userId];
      if (patch.name !== undefined) {
        params.push(patch.name);
        sets.push(`name = $${params.length}`);
      }
      if (patch.globalScope !== undefined) {
        params.push(patch.globalScope);
        sets.push(`global_scope = $${params.length}`);
      }
      await session.query(`update lorebooks set ${sets.join(', ')} where lorebook_id = $1 and user_id = $2`, params);
    }
    if (patch.characterIds !== undefined) {
      await session.query('delete from lorebook_character_links where lorebook_id = $1', [lorebookId]);
      for (const characterId of patch.characterIds) {
        await session.query(
          'insert into lorebook_character_links (lorebook_id, character_id, user_id) values ($1, $2, $3) on conflict do nothing',
          [lorebookId, characterId, userId],
        );
      }
    }
    // The book's user_id check above is what makes a foreign row a no-op: RLS hides it entirely.
    const [exists] = await session.query<{ n: number }>('select 1 as n from lorebooks where lorebook_id = $1', [lorebookId]);
    return exists !== undefined;
  });
}

export async function deleteLorebookAdmin(db: PostgresClient, userId: string, lorebookId: string): Promise<boolean> {
  return db.withUserScope(userId, async (session) => {
    await session.query('delete from lorebooks where lorebook_id = $1 and user_id = $2', [lorebookId, userId]);
    // session.query returns rows, not a pg result — detect "was there a row" with an exists probe.
    const [exists] = await session.query<{ n: number }>('select 1 as n from lorebooks where lorebook_id = $1', [lorebookId]);
    return exists === undefined;
  });
}

async function embedEntryText(embeddings: EmbeddingProvider, bookName: string, content: string): Promise<string | null> {
  try {
    const [vector] = await embeddings.embed([`${bookName}\n${content}`]);
    return vector ? toPgVectorLiteral(vector) : null;
  } catch {
    return null; // fail-open, same posture as every other embed path
  }
}

export async function createLorebookEntryAdmin(
  db: PostgresClient,
  embeddings: EmbeddingProvider,
  userId: string,
  input: LorebookEntryInput,
): Promise<LorebookEntryAdminRow | undefined> {
  return db.withUserScope(userId, async (session) => {
    const [book] = await session.query<{ name: string }>('select name from lorebooks where lorebook_id = $1', [input.lorebookId]);
    if (!book) return undefined; // book not found under this user's scope
    const vectorLiteral = await embedEntryText(embeddings, book.name, input.content);
    const [row] = await session.query<LorebookEntryRowShape>(
      `insert into lorebook_entries
         (lorebook_id, user_id, uid, key, comment, content, constant, disable, order_value, probability,
          use_probability, group_name, group_weight, group_override, sticky, cooldown, delay, source_json, vector_embed)
       values
         ($1, $2, (select coalesce(max(uid), 0) + 1 from lorebook_entries where lorebook_id = $1),
          $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, '{}'::jsonb, $17::vector)
       returning entry_id, uid, key, comment, content, constant, disable, order_value, probability,
                 use_probability, group_name, group_weight, group_override, sticky, cooldown, delay, updated_at`,
      [
        input.lorebookId,
        userId,
        input.key ?? [],
        input.comment ?? '',
        input.content,
        input.constant ?? false,
        input.disable ?? false,
        input.orderValue ?? 100,
        input.probability ?? 100,
        input.useProbability ?? false,
        input.groupName ?? '',
        input.groupWeight ?? 1,
        input.groupOverride ?? false,
        input.sticky ?? 0,
        input.cooldown ?? 0,
        input.delay ?? 0,
        vectorLiteral,
      ],
    );
    return row ? toLorebookEntryAdminRow(row) : undefined;
  });
}

export async function updateLorebookEntryAdmin(
  db: PostgresClient,
  embeddings: EmbeddingProvider,
  userId: string,
  entryId: string,
  patch: LorebookEntryPatch,
): Promise<boolean> {
  return db.withUserScope(userId, async (session) => {
    const [existing] = await session.query<{ lorebook_id: string; content: string }>(
      'select lorebook_id, content from lorebook_entries where entry_id = $1',
      [entryId],
    );
    if (!existing) return false;
    const content = patch.content ?? existing.content;
    const [book] = await session.query<{ name: string }>('select name from lorebooks where lorebook_id = $1', [existing.lorebook_id]);
    const vectorLiteral = await embedEntryText(embeddings, book?.name ?? '', content);

    const sets: string[] = [];
    const params: unknown[] = [entryId, userId];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.key !== undefined) push('key', patch.key);
    if (patch.comment !== undefined) push('comment', patch.comment);
    if (patch.content !== undefined) push('content', patch.content);
    if (patch.constant !== undefined) push('constant', patch.constant);
    if (patch.disable !== undefined) push('disable', patch.disable);
    if (patch.orderValue !== undefined) push('order_value', patch.orderValue);
    if (patch.probability !== undefined) push('probability', patch.probability);
    if (patch.useProbability !== undefined) push('use_probability', patch.useProbability);
    if (patch.groupName !== undefined) push('group_name', patch.groupName);
    if (patch.groupWeight !== undefined) push('group_weight', patch.groupWeight);
    if (patch.groupOverride !== undefined) push('group_override', patch.groupOverride);
    if (patch.sticky !== undefined) push('sticky', patch.sticky);
    if (patch.cooldown !== undefined) push('cooldown', patch.cooldown);
    if (patch.delay !== undefined) push('delay', patch.delay);
    if (patch.content !== undefined || patch.key !== undefined) push('vector_embed', vectorLiteral ? `${vectorLiteral}::vector` : null);
    if (sets.length === 0) return true;
    await session.query(`update lorebook_entries set ${sets.join(', ')} where entry_id = $1 and user_id = $2`, params);
    // The update touched whatever row exists in this user's scope; the probe tells the caller
    // whether that row was really there (a foreign row is invisible under RLS, so the update
    // would have silently no-op'd — this is the honest "was anything updated" signal).
    const [exists] = await session.query<{ n: number }>('select 1 as n from lorebook_entries where entry_id = $1', [entryId]);
    return exists !== undefined;
  });
}

export async function deleteLorebookEntryAdmin(db: PostgresClient, userId: string, entryId: string): Promise<boolean> {
  return db.withUserScope(userId, async (session) => {
    await session.query('delete from lorebook_entries where entry_id = $1 and user_id = $2', [entryId, userId]);
    const [exists] = await session.query<{ n: number }>('select 1 as n from lorebook_entries where entry_id = $1', [entryId]);
    return exists === undefined;
  });
}

// --- Lorebook import/export (docs/lorebook-plan.md §8a step 7, bi_principles.md §7) ---
// The ST world-info on-disk format (0051's header comment): `{ name, entries: { [uid]: entryObject } }`
// where entryObject is ST's real entry definition (~35 fields, world-info.js
// newWorldInfoEntryDefinition). Import stores the verbatim entryObject in source_json (nothing
// lost even though only a subset of fields are modeled as columns); export reverses it — a
// non-empty source_json round-trips byte-for-byte, and entries created in the BigImagine UI
// (whose source_json is '{}') reconstruct an ST-shaped object from the modeled columns so the
// export is still a valid ST import.

// The draft shape is shared with the chub character_book parser
// (util/parseCharacterBookEntries.ts) — both produce lorebook_entries column values, from
// differently-sourced input.

/** Parses one ST entryObject into the column values. Unknown fields are deliberately ignored —
 *  they live on in source_json. Non-numeric/invalid fields fall back to the column defaults so a
 *  hand-edited export can't poison the row. */
function parseWorldInfoEntry(raw: unknown): LorebookEntryDraft | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
  const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const int = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isInteger(v) ? v : fallback);
  return {
    uid: 0, // filled by the caller from the object key
    key: strArr(e.key),
    keysecondary: strArr(e.keysecondary),
    comment: str(e.comment, ''),
    content: str(e.content, ''),
    constant: bool(e.constant, false),
    selective: bool(e.selective, true),
    disable: bool(e.disable, false),
    orderValue: int(e.order, 100),
    position: int(e.position, 0),
    probability: int(e.probability, 100),
    depth: typeof e.depth === 'number' ? e.depth : null,
    groupName: str(e.group, ''),
    useProbability: bool(e.useProbability, false),
    groupWeight: int(e.groupWeight, 1),
    groupOverride: bool(e.groupOverride, false),
    sticky: int(e.sticky, 0),
    cooldown: int(e.cooldown, 0),
    delay: int(e.delay, 0),
    sourceJson: e,
  };
}

export interface WorldInfoImportResult {
  lorebookId: string;
  name: string;
  entryCount: number;
}

/** Imports an ST world-info export `{ name, entries: { [uid]: entryObject } }` into a new book.
 *  Returns undefined when the user doesn't exist, the name is blank, or the entries object has a
 *  non-integer key / non-object value (all-or-nothing — a malformed export must not half-land).
 *  Embeddings are batched in one call (fail-open: null vectors on provider failure). */
export async function importLorebookWorldInfo(
  db: PostgresClient,
  embeddings: EmbeddingProvider,
  userId: string,
  name: string,
  rawEntries: unknown,
): Promise<WorldInfoImportResult | undefined> {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  if (typeof rawEntries !== 'object' || rawEntries === null || Array.isArray(rawEntries)) return undefined;

  const entries: { uid: number; parsed: LorebookEntryDraft }[] = [];
  for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    const uid = Number(key);
    if (!Number.isInteger(uid) || uid < 0) return undefined;
    const parsed = parseWorldInfoEntry(value);
    if (!parsed) return undefined;
    entries.push({ uid, parsed: { ...parsed, uid } });
  }

  return db.withUserScope(userId, async (session) => {
    const [user] = await session.query<{ user_id: string }>('select user_id from users where user_id = $1', [userId]);
    if (!user) return undefined;
    const [book] = await session.query<{ lorebook_id: string }>(
      'insert into lorebooks (user_id, name) values ($1, $2) returning lorebook_id',
      [userId, trimmed],
    );
    if (!book) return undefined;

    // One batched embed call for every content (fail-open → null vectors, entries still land).
    let vectors: (string | null)[] | null = null;
    try {
      const embedded = await embeddings.embed(entries.map((e) => `${trimmed}\n${e.parsed.content}`));
      vectors = embedded.map((v) => (v ? toPgVectorLiteral(v) : null));
    } catch (err) {
      log.warn('importLorebookWorldInfo: embed failed, importing without vectors', { userId, lorebookId: book.lorebook_id, err });
    }

    for (let i = 0; i < entries.length; i++) {
      const p = entries[i]!.parsed;
      await session.query(
        `insert into lorebook_entries
           (lorebook_id, user_id, uid, key, keysecondary, comment, content, constant, selective,
            disable, order_value, position, probability, depth, group_name, use_probability,
            group_weight, group_override, sticky, cooldown, delay, source_json, vector_embed)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                 $19, $20, $21, $22::jsonb, $23::vector)`,
        [
          book.lorebook_id,
          userId,
          p.uid,
          p.key,
          p.keysecondary,
          p.comment,
          p.content,
          p.constant,
          p.selective,
          p.disable,
          p.orderValue,
          p.position,
          p.probability,
          p.depth,
          p.groupName,
          p.useProbability,
          p.groupWeight,
          p.groupOverride,
          p.sticky,
          p.cooldown,
          p.delay,
          JSON.stringify(p.sourceJson),
          vectors?.[i] ?? null,
        ],
      );
    }
    return { lorebookId: book.lorebook_id, name: trimmed, entryCount: entries.length };
  });
}

interface WorldInfoExportRow {
  uid: number;
  key: string[];
  keysecondary: string[];
  comment: string;
  content: string;
  constant: boolean;
  selective: boolean;
  disable: boolean;
  order_value: number;
  position: number;
  probability: number;
  depth: number | null;
  group_name: string;
  use_probability: boolean;
  group_weight: number;
  group_override: boolean;
  sticky: number;
  cooldown: number;
  delay: number;
  source_json: unknown;
}

/** Reverses an import losslessly (§7): `{ name, entries: { [uid]: entryObject } }` where
 *  entryObject is the verbatim source_json when the entry was imported (non-empty object), or an
 *  ST-shaped reconstruction from the columns for UI-created entries (source_json '{}'). Returns
 *  undefined when the book isn't visible to the user. */
export async function exportLorebookWorldInfo(db: PostgresClient, userId: string, lorebookId: string): Promise<{ name: string; entries: Record<string, unknown> } | undefined> {
  return db.withUserScope(userId, async (session) => {
    const [book] = await session.query<{ name: string }>('select name from lorebooks where lorebook_id = $1', [lorebookId]);
    if (!book) return undefined;
    const rows = await session.query<WorldInfoExportRow>(
      `select uid, key, keysecondary, comment, content, constant, selective, disable, order_value,
              position, probability, depth, group_name, use_probability, group_weight, group_override,
              sticky, cooldown, delay, source_json
       from lorebook_entries
       where lorebook_id = $1 and user_id = $2
       order by uid`,
      [lorebookId, userId],
    );
    const entries: Record<string, unknown> = {};
    for (const r of rows) {
      const hasSource =
        typeof r.source_json === 'object' && r.source_json !== null && Object.keys(r.source_json as object).length > 0;
      entries[String(r.uid)] = hasSource
        ? r.source_json
        : {
            key: r.key,
            keysecondary: r.keysecondary,
            comment: r.comment,
            content: r.content,
            constant: r.constant,
            selective: r.selective,
            disable: r.disable,
            order: r.order_value,
            position: r.position,
            probability: r.probability,
            depth: r.depth,
            group: r.group_name,
            useProbability: r.use_probability,
            groupWeight: r.group_weight,
            groupOverride: r.group_override,
            sticky: r.sticky,
            cooldown: r.cooldown,
            delay: r.delay,
          };
    }
    return { name: book.name, entries };
  });
}

// --- Chat-memory sync status (bi_principles.md §11) ---
// The read side of orchestrator/chatMemorySync.ts's chat_memory_sync_status table (migration
// 0055) — the review panel's actual purpose per the user: confirmation that each background
// pipeline stage (chunk/embed/distill) is actually working, not an editing surface. Unlike every
// other function in this file, this reads chat-scoped Postgres tables directly rather than the
// settings store, so it needs the same "roster every user, then query each one under its own RLS
// scope" shape chatMemorySync.ts's own tick loop uses (there is no single userId an admin key
// resolves to, and withSystemScope alone can't read a user_id-scoped, RLS-forced table).

export interface ChatMemorySyncStatusRow {
  chatId: string;
  chatTitle: string;
  lastAttemptAt: string;
  lastStatus: 'ok' | 'skipped' | 'error';
  lastStep: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastChunksAdded: number | null;
  lastEntriesUpdated: number | null;
  consecutiveErrors: number;
  canonProposedCount: number;
  canonApprovedCount: number;
  canonLastProposedAt: string | null;
}

interface ChatMemorySyncStatusQueryRow {
  chat_id: string;
  chat_title: string;
  last_attempt_at: string;
  last_status: 'ok' | 'skipped' | 'error';
  last_step: string | null;
  last_error: string | null;
  last_success_at: string | null;
  last_chunks_added: number | null;
  last_entries_updated: number | null;
  consecutive_errors: number;
  canon_proposed_count: string;
  canon_approved_count: string;
  canon_last_proposed_at: string | null;
}

export async function getChatMemorySyncStatus(db: PostgresClient): Promise<ChatMemorySyncStatusRow[]> {
  const users = await db.withSystemScope((session) => session.query<{ user_id: string }>('select user_id from users'));
  const rows: ChatMemorySyncStatusRow[] = [];
  for (const { user_id: userId } of users) {
    const userRows = await db.withUserScope(userId, (session) =>
      session.query<ChatMemorySyncStatusQueryRow>(
        `select
           s.chat_id, cs.title as chat_title, s.last_attempt_at, s.last_status, s.last_step, s.last_error,
           s.last_success_at, s.last_chunks_added, s.last_entries_updated, s.consecutive_errors,
           coalesce(cf.proposed_count, 0)::text as canon_proposed_count,
           coalesce(cf.approved_count, 0)::text as canon_approved_count,
           cf.last_proposed_at as canon_last_proposed_at
         from chat_memory_sync_status s
         join chat_sessions cs on cs.chat_id = s.chat_id
         left join (
           select chat_id,
                  count(*) filter (where status = 'proposed') as proposed_count,
                  count(*) filter (where status = 'approved') as approved_count,
                  max(proposed_at) as last_proposed_at
           from canon_facts
           where chat_id is not null
           group by chat_id
         ) cf on cf.chat_id = s.chat_id
         order by (s.last_status = 'error') desc, s.last_attempt_at desc`,
      ),
    );
    for (const r of userRows) {
      rows.push({
        chatId: r.chat_id,
        chatTitle: r.chat_title,
        lastAttemptAt: r.last_attempt_at,
        lastStatus: r.last_status,
        lastStep: r.last_step,
        lastError: r.last_error,
        lastSuccessAt: r.last_success_at,
        lastChunksAdded: r.last_chunks_added,
        lastEntriesUpdated: r.last_entries_updated,
        consecutiveErrors: r.consecutive_errors,
        canonProposedCount: Number(r.canon_proposed_count),
        canonApprovedCount: Number(r.canon_approved_count),
        canonLastProposedAt: r.canon_last_proposed_at,
      });
    }
  }
  return rows;
}

// --- Location render status (bi_principles.md §11) ---
// The read side of the bg-gen pipeline: one row per recently-touched location proving which
// stages actually ran — described (visual_description filled by describeLocation.ts / the
// describer's Definition half), rendered (image_url + render hash written by
// generateLocationImage.ts), plus the location's segway status (migration 0067). Same "roster
// every user, then query each one under its own RLS scope" shape as getChatMemorySyncStatus
// above — locations is user_id-scoped + RLS-forced, so an admin key alone can't read it.

export interface LocationRenderStatusRow {
  locationId: string;
  name: string;
  status: string | null;
  /** visual_description non-empty (the describer or the scraper's name seed). */
  described: boolean;
  /** definition non-empty (the describer's Definition half, migration 0078). */
  defined: boolean;
  /** image_url present — generateLocationImage.ts wrote a render for this row. */
  rendered: boolean;
  /** image_render_hash present — the cache-validation key (migration 0076). */
  hasRenderHash: boolean;
  imageGeneratedAt: string | null;
  updatedAt: string;
}

interface LocationRenderStatusQueryRow {
  location_id: string;
  name: string;
  status: string | null;
  described: boolean;
  defined: boolean;
  rendered: boolean;
  has_render_hash: boolean;
  image_generated_at: string | null;
  updated_at: string;
}

/** How many most-recently-touched locations each user's status table shows — a proof-it-ran
 *  surface, not a browser, so a cap keeps it cheap without hiding failures (errors surface as
 *  stale/missing stages on the newest rows). */
const LOCATION_RENDER_STATUS_LIMIT = 50;

export async function getLocationRenderStatus(db: PostgresClient): Promise<LocationRenderStatusRow[]> {
  const users = await db.withSystemScope((session) => session.query<{ user_id: string }>('select user_id from users'));
  const rows: LocationRenderStatusRow[] = [];
  for (const { user_id: userId } of users) {
    const userRows = await db.withUserScope(userId, (session) =>
      session.query<LocationRenderStatusQueryRow>(
        `select location_id, name, status,
                (visual_description is not null and visual_description <> '') as described,
                (definition is not null and definition <> '') as defined,
                (image_url is not null) as rendered,
                (image_render_hash is not null) as has_render_hash,
                image_generated_at, updated_at
         from locations
         order by updated_at desc
         limit $1`,
        [LOCATION_RENDER_STATUS_LIMIT],
      ),
    );
    for (const r of userRows) {
      rows.push({
        locationId: r.location_id,
        name: r.name,
        status: r.status,
        described: r.described,
        defined: r.defined,
        rendered: r.rendered,
        hasRenderHash: r.has_render_hash,
        imageGeneratedAt: r.image_generated_at,
        updatedAt: r.updated_at,
      });
    }
  }
  return rows;
}

// --- Locations browser (location.md §6.2.4) ---
// The Locations page's read-only known-locations table: every row with its parent (via
// parent_location_id, migration 0083), lifecycle status, and image thumbnail. Cross-user roster,
// the same shape as getLocationRenderStatus above — locations is user_id-scoped + RLS-forced,
// so an admin key alone can't read it. Parent-first ordering (coalesce on the parent's name)
// groups a place with its rooms.

export interface LocationAdminRow {
  locationId: string;
  userId: string;
  name: string;
  parentName: string | null;
  status: string | null;
  imageUrl: string | null;
  updatedAt: string;
  chatTitles: string[];
}

// db/migrations/0096's link table replaces the old anchor_chat_id column, so "which chat(s) is
// this row in" is now a join, not a field — surfaced here as titles (chat_sessions.title) so the
// roster visibly proves the chat-scope fix: an auto-registered row's chatTitles empties out the
// instant its last owning chat is deleted or its anchor message is edited away, at which point the
// cleanup trigger removes the row itself and it stops appearing at all. User-authored rows
// (status is null) never get a link row, so chatTitles is always [] for them.
export async function getLocationsAdmin(db: PostgresClient): Promise<LocationAdminRow[]> {
  const users = await db.withSystemScope((session) => session.query<{ user_id: string }>('select user_id from users'));
  const rows: LocationAdminRow[] = [];
  for (const { user_id: userId } of users) {
    const userRows = await db.withUserScope(userId, (session) =>
      session.query<{
        location_id: string;
        name: string;
        parent_name: string | null;
        status: string | null;
        image_url: string | null;
        updated_at: string;
        chat_titles: string[] | null;
      }>(
        `select l.location_id, l.name, p.name as parent_name, l.status, l.image_url, l.updated_at,
                (select coalesce(array_agg(cs.title order by cs.title), '{}')
                 from location_chat_links lcl
                 join chat_sessions cs on cs.chat_id = lcl.chat_id
                 where lcl.location_id = l.location_id) as chat_titles
         from locations l
         left join locations p on p.location_id = l.parent_location_id
         order by coalesce(p.name, l.name), l.name`,
      ),
    );
    for (const r of userRows) {
      rows.push({
        locationId: r.location_id,
        userId,
        name: r.name,
        parentName: r.parent_name,
        status: r.status,
        imageUrl: r.image_url,
        updatedAt: r.updated_at,
        chatTitles: r.chat_titles ?? [],
      });
    }
  }
  return rows;
}

