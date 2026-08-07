/**
 * @file orchestrator/src/server/adminServer.ts
 * @stamp 2026-07-24
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
 * getImageSettings(store) — { template, templateIsDefault } for the master image prompt template
 *   (endpoint.md §2.2, bi_principles.md §18; '' = built-in default)
 * parseSetImageSettingsBody(raw) — validates { template?: string }; undefined on any malformed shape
 * setImageSettings(store, template) — upserts image_prompt_template
 * testImageConnection(imageConnections, settings, id) — endpoint.md §3.3's diagnostic probe
 *   through one saved image connection, synthesized through the Master Image Prompt Template with
 *   the connection's style prefix (parallax_fade_teststep.md §4.2); undefined only if the id
 *   doesn't exist, otherwise always a result (a bad key/unreachable endpoint surfaces as
 *   { ok: false, error }, not a thrown error)
 * getChatBackgroundSettings(store) — { parallaxEnabled } (default false) for the ChatView
 *   location-background parallax pan (parallax_fade_teststep.md §2.2)
 * parseSetChatBackgroundSettingsBody(raw) — validates { parallaxEnabled?: boolean }; undefined on
 *   any malformed shape
 * setChatBackgroundSettings(store, enabled) — upserts chat_background_parallax as 'true'/'false'
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
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { createLlmProviderForProfile } from '../io/llm/index.js';
import type { LlmConnectionInit, LlmConnectionPatch, LlmConnectionStore } from '../io/llmConnections.js';
import type { ImageConnectionInit, ImageConnectionKind, ImageConnectionPatch, ImageConnectionStore } from '../io/imageConnections.js';
import { createImageGenProvider } from '../io/imageGen/index.js';
import { synthesizeImagePrompt } from '../util/synthesizeImagePrompt.js';
import { DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT } from '../io/chatMemory/classifyChatChunk.js';
import { DEFAULT_DISTILL_CHAT_MEMORY_PROMPT } from '../io/chatMemory/distillChatMemory.js';
import { DEFAULT_HOUSEHOLD_MEMORY_PROMPT } from '../io/chatMemory/classifyHouseholdMemory.js';
import { DEFAULT_BRIDGE_PROMPT } from '../io/chatMemory/bridgeChatMemory.js';
import { DEFAULT_LOREBOOK_CURATOR_PROMPT } from '../io/chatMemory/curateLorebook.js';
import { DEFAULT_PEOPLE_CURATOR_PROMPT } from '../io/chatMemory/curatePeople.js';
import { DEFAULT_CANON_EXTRACTION_PROMPT } from '../io/canonExtraction.js';
import type { PostgresClient } from '../io/postgres.js';

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

export function parseCreateConnectionBody(raw: unknown): LlmConnectionInit | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, kind, model, apiKey, copyApiKeyFrom, baseUrl, supportsVision, providerOrder, allowFallbacks, quantizations } =
    raw as Record<string, unknown>;
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
  };
}

// Every field optional (a PATCH — only touch what's given), unlike create's required set.
// baseUrl/providerOrder/quantizations additionally accept `null` to explicitly clear a
// previously-set value, distinct from `undefined` ("leave it alone") — same three-state shape
// io/llmConnections.ts's own LlmConnectionPatch already expects.
export function parseUpdateConnectionBody(raw: unknown): LlmConnectionPatch | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, model, apiKey, copyApiKeyFrom, baseUrl, supportsVision, providerOrder, allowFallbacks, quantizations } =
    raw as Record<string, unknown>;
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

// --- Image generation connections (docs/vistalyze_integration/endpoint.md §3) ---
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
// result (bi_principles.md §18 — prompts are surfaced, never hidden).
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

// --- Image settings (endpoint.md §2.2, bi_principles.md §18) ---
// The one orchestrator-settings key this subsystem adds: image_prompt_template, the Master Image
// Prompt Template synthesizeImagePrompt.ts expands against a location's visual_description/
// environment. Live-read on every generation call (no restart), empty value = built-in default.

export interface ImageSettings {
  template: string;
  templateIsDefault: boolean;
}

// parallax_fade_teststep.md §2.2: the ChatView location-background parallax toggle. Stored as
// text 'true'/'false' in orchestrator_settings (migration 0069); unset = false (matching ST
// Vistalyze's own parallaxEnabled=false default). Read live by the frontend at chat load via
// GET /v1/chat-background-settings — same no-restart shape as household_timezone.
export interface ChatBackgroundSettings {
  parallaxEnabled: boolean;
}

export async function getChatBackgroundSettings(store: OrchestratorSettingsStore): Promise<ChatBackgroundSettings> {
  return { parallaxEnabled: (await store.get('chat_background_parallax')) === 'true' };
}

export function parseSetChatBackgroundSettingsBody(raw: unknown): { parallaxEnabled?: boolean } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { parallaxEnabled } = raw as Record<string, unknown>;
  if (parallaxEnabled === undefined) return undefined;
  if (typeof parallaxEnabled !== 'boolean') return undefined;
  return { parallaxEnabled };
}

export async function setChatBackgroundSettings(store: OrchestratorSettingsStore, enabled: boolean): Promise<void> {
  await store.set('chat_background_parallax', enabled ? 'true' : 'false');
}

export async function getImageSettings(store: OrchestratorSettingsStore): Promise<ImageSettings> {
  const template = (await store.get('image_prompt_template')) ?? '';
  return { template, templateIsDefault: !template };
}

export function parseSetImageSettingsBody(raw: unknown): { template?: string } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { template } = raw as Record<string, unknown>;
  if (template === undefined) return undefined;
  if (typeof template !== 'string') return undefined;
  return { template };
}

export async function setImageSettings(store: OrchestratorSettingsStore, template: string): Promise<void> {
  await store.set('image_prompt_template', template);
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
      seed: null,
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

// --- Persona settings (migration 0053, docs/prompt-macros.md's Stage 1) ---
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
  chunkSummaryPrompt: string;
  chunkSummaryPromptIsDefault: boolean;
  distillPrompt: string;
  distillPromptIsDefault: boolean;
  householdMemoryPrompt: string;
  householdMemoryPromptIsDefault: boolean;
  bridgePrompt: string;
  bridgePromptIsDefault: boolean;
  lorebookCuratorPrompt: string;
  lorebookCuratorPromptIsDefault: boolean;
  peopleCuratorPrompt: string;
  peopleCuratorPromptIsDefault: boolean;
}

export async function getChatMemorySettings(store: OrchestratorSettingsStore): Promise<ChatMemorySettings> {
  const [
    profile,
    liveRaw,
    syncRaw,
    digestHorizonRaw,
    chunkSummaryPrompt,
    distillPrompt,
    householdMemoryPrompt,
    bridgePrompt,
    lorebookCuratorPrompt,
    peopleCuratorPrompt,
  ] = await Promise.all([
    store.get('chat_memory_profile'),
    store.get('chat_memory_live_window_pairs'),
    store.get('chat_memory_sync_every_pairs'),
    store.get('chat_memory_digest_horizon_pairs'),
    store.get('chat_memory_chunk_summary_prompt'),
    store.get('chat_memory_distill_prompt'),
    store.get('chat_memory_household_memory_prompt'),
    store.get('chat_memory_bridge_prompt'),
    store.get('chat_memory_lorebook_curator_prompt'),
    store.get('chat_memory_people_curator_prompt'),
  ]);
  return {
    profile: profile || null,
    liveWindowPairs: liveRaw ? Number(liveRaw) : null,
    syncEveryPairs: syncRaw ? Number(syncRaw) : null,
    digestHorizonPairs: digestHorizonRaw ? Number(digestHorizonRaw) : null,
    chunkSummaryPrompt: chunkSummaryPrompt || DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT,
    chunkSummaryPromptIsDefault: !chunkSummaryPrompt,
    distillPrompt: distillPrompt || DEFAULT_DISTILL_CHAT_MEMORY_PROMPT,
    distillPromptIsDefault: !distillPrompt,
    householdMemoryPrompt: householdMemoryPrompt || DEFAULT_HOUSEHOLD_MEMORY_PROMPT,
    householdMemoryPromptIsDefault: !householdMemoryPrompt,
    bridgePrompt: bridgePrompt || DEFAULT_BRIDGE_PROMPT,
    bridgePromptIsDefault: !bridgePrompt,
    lorebookCuratorPrompt: lorebookCuratorPrompt || DEFAULT_LOREBOOK_CURATOR_PROMPT,
    lorebookCuratorPromptIsDefault: !lorebookCuratorPrompt,
    peopleCuratorPrompt: peopleCuratorPrompt || DEFAULT_PEOPLE_CURATOR_PROMPT,
    peopleCuratorPromptIsDefault: !peopleCuratorPrompt,
  };
}

export interface SetChatMemorySettingsBody {
  profile?: string;
  liveWindowPairs?: number;
  syncEveryPairs?: number;
  digestHorizonPairs?: number;
  chunkSummaryPrompt?: string;
  distillPrompt?: string;
  householdMemoryPrompt?: string;
  bridgePrompt?: string;
  lorebookCuratorPrompt?: string;
  peopleCuratorPrompt?: string;
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
    chunk_summary_prompt,
    distill_prompt,
    household_memory_prompt,
    bridge_prompt,
    lorebook_curator_prompt,
    people_curator_prompt,
  } = raw as Record<string, unknown>;
  if (
    profile === undefined &&
    live_window_pairs === undefined &&
    sync_every_pairs === undefined &&
    digest_horizon_pairs === undefined &&
    chunk_summary_prompt === undefined &&
    distill_prompt === undefined &&
    household_memory_prompt === undefined &&
    bridge_prompt === undefined &&
    lorebook_curator_prompt === undefined &&
    people_curator_prompt === undefined
  ) {
    return undefined;
  }
  if (profile !== undefined && typeof profile !== 'string') return undefined;
  if (live_window_pairs !== undefined && (typeof live_window_pairs !== 'number' || live_window_pairs <= 0)) return undefined;
  if (sync_every_pairs !== undefined && (typeof sync_every_pairs !== 'number' || sync_every_pairs <= 0)) return undefined;
  if (digest_horizon_pairs !== undefined && (typeof digest_horizon_pairs !== 'number' || digest_horizon_pairs <= 0)) return undefined;
  if (chunk_summary_prompt !== undefined && typeof chunk_summary_prompt !== 'string') return undefined;
  if (distill_prompt !== undefined && typeof distill_prompt !== 'string') return undefined;
  if (household_memory_prompt !== undefined && typeof household_memory_prompt !== 'string') return undefined;
  if (bridge_prompt !== undefined && typeof bridge_prompt !== 'string') return undefined;
  if (lorebook_curator_prompt !== undefined && typeof lorebook_curator_prompt !== 'string') return undefined;
  if (people_curator_prompt !== undefined && typeof people_curator_prompt !== 'string') return undefined;
  return {
    profile: profile as string | undefined,
    liveWindowPairs: live_window_pairs as number | undefined,
    syncEveryPairs: sync_every_pairs as number | undefined,
    digestHorizonPairs: digest_horizon_pairs as number | undefined,
    chunkSummaryPrompt: chunk_summary_prompt as string | undefined,
    distillPrompt: distill_prompt as string | undefined,
    householdMemoryPrompt: household_memory_prompt as string | undefined,
    bridgePrompt: bridge_prompt as string | undefined,
    lorebookCuratorPrompt: lorebook_curator_prompt as string | undefined,
    peopleCuratorPrompt: people_curator_prompt as string | undefined,
  };
}

export async function setChatMemorySettings(store: OrchestratorSettingsStore, body: SetChatMemorySettingsBody): Promise<void> {
  if (body.profile !== undefined) await store.set('chat_memory_profile', body.profile);
  if (body.liveWindowPairs !== undefined) await store.set('chat_memory_live_window_pairs', String(body.liveWindowPairs));
  if (body.syncEveryPairs !== undefined) await store.set('chat_memory_sync_every_pairs', String(body.syncEveryPairs));
  if (body.digestHorizonPairs !== undefined) await store.set('chat_memory_digest_horizon_pairs', String(body.digestHorizonPairs));
  if (body.chunkSummaryPrompt !== undefined) await store.set('chat_memory_chunk_summary_prompt', body.chunkSummaryPrompt);
  if (body.distillPrompt !== undefined) await store.set('chat_memory_distill_prompt', body.distillPrompt);
  if (body.householdMemoryPrompt !== undefined) await store.set('chat_memory_household_memory_prompt', body.householdMemoryPrompt);
  if (body.bridgePrompt !== undefined) await store.set('chat_memory_bridge_prompt', body.bridgePrompt);
  if (body.lorebookCuratorPrompt !== undefined) await store.set('chat_memory_lorebook_curator_prompt', body.lorebookCuratorPrompt);
  if (body.peopleCuratorPrompt !== undefined) await store.set('chat_memory_people_curator_prompt', body.peopleCuratorPrompt);
}

// --- Canon settings (docs/canonize-plan.md §6, bi_principles.md §13/§18) ---
// The Canonize feature's two knobs: canon_recall_top_k (integer-as-text, default '8' — how many
// canon facts recall_canon_facts returns, read live on every recall call, no restart) and
// canon_extraction_prompt (the background extraction call's prompt template — "default + bespoke"
// override per bi_principles.md §18, empty clears back to the built-in, same shape as the
// chat_memory_* prompts above). The extraction pass that consumes the prompt is Director Pass
// work (canonize-plan.md §2) — not wired yet; the setting is still surfaced now so it exists
// before the pass does.

export interface CanonSettings {
  recallTopK: number;
  extractionPrompt: string;
  extractionPromptIsDefault: boolean;
}

export async function getCanonSettings(store: OrchestratorSettingsStore): Promise<CanonSettings> {
  const [topKRaw, extractionPrompt] = await Promise.all([
    store.get('canon_recall_top_k'),
    store.get('canon_extraction_prompt'),
  ]);
  const parsedTopK = topKRaw ? Number(topKRaw) : NaN;
  return {
    recallTopK: Number.isInteger(parsedTopK) && parsedTopK > 0 ? parsedTopK : 8,
    extractionPrompt: extractionPrompt || DEFAULT_CANON_EXTRACTION_PROMPT,
    extractionPromptIsDefault: !extractionPrompt,
  };
}

export interface SetCanonSettingsBody {
  recallTopK?: number;
  extractionPrompt?: string;
}

// Both fields optional and independently settable; an empty string on the prompt field clears the
// override back to its built-in default (there is no separate "reset" endpoint — see
// io/orchestratorSettings.ts's own doc on this). Wire keys are snake_case, same convention as
// every other parseSet*Body in this file.
export function parseSetCanonSettingsBody(raw: unknown): SetCanonSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { recall_top_k, extraction_prompt } = raw as Record<string, unknown>;
  if (recall_top_k === undefined && extraction_prompt === undefined) return undefined;
  if (recall_top_k !== undefined && (typeof recall_top_k !== 'number' || !Number.isInteger(recall_top_k) || recall_top_k <= 0)) {
    return undefined;
  }
  if (extraction_prompt !== undefined && typeof extraction_prompt !== 'string') return undefined;
  return {
    recallTopK: recall_top_k as number | undefined,
    extractionPrompt: extraction_prompt as string | undefined,
  };
}

export async function setCanonSettings(store: OrchestratorSettingsStore, body: SetCanonSettingsBody): Promise<void> {
  if (body.recallTopK !== undefined) await store.set('canon_recall_top_k', String(body.recallTopK));
  if (body.extractionPrompt !== undefined) await store.set('canon_extraction_prompt', body.extractionPrompt);
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

