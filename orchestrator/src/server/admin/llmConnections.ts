/**
 * @file orchestrator/src/server/admin/llmConnections.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (connection-store IO + one-off
 * provider calls) — the same dual-role split the original adminServer.ts connections block used;
 * moved here verbatim as part of the adminServer domain split
 * @description
 * LLM connection administration: the Connections tab's create/update body parsing, the
 * provider-reliability sweep's request parsing, the model/provider catalog previews, and the
 * per-connection diagnostic test call. This module may call LLM providers because those operations
 * are part of connection administration. Image-generation connections are deliberately elsewhere
 * (admin/imageConnections.ts).
 *
 * @api-declaration
 * parseVisionCapableProfiles(raw) — parses the retired llm_vision_capable_profiles env JSON into a
 *   string[] (empty on malformed input); consumed only by index.ts's one-time llm_connections seed
 * parseCreateConnectionBody(raw) — validates an LlmConnectionInit; undefined on any malformed shape.
 *   Provider kinds (deepseek/openrouter) take no key (their shared provider_credentials key is set in
 *   Settings); freeform kinds need exactly one of apiKey/copyApiKeyFrom
 * parseUpdateConnectionBody(raw) — validates an LlmConnectionPatch; undefined on any malformed shape.
 *   Optional `kind` lets an admin change a connection's provider; provider-kind targets reject
 *   apiKey/copyApiKeyFrom, and the reverse transition must supply a per-connection key (the store
 *   enforces that last one and the route surfaces it as a 400)
 * parseReliabilitySweepBody(raw) — validates the provider-reliability sweep's request body;
 *   undefined on any malformed shape
 * listModelsForConnection(connections, id) — the live model catalog for one saved connection
 *   (or its single static model if the provider kind has no listModels), for the Connections tab
 *   to show before an admin commits to a model choice
 * listProvidersForConnection(connections, id, modelId) — the live list of upstream inference
 *   providers OpenRouter can route the named model to, undefined if the connection's kind has no
 *   listProviders capability (i.e. isn't OpenRouter)
 * testConnection(connections, id) — a cheap, capped-tokens real call through this saved
 *   connection; undefined only if the id doesn't exist, otherwise always a result (a bad key/model
 *   surfaces as { ok: false, error }, not a thrown error)
 *
 * @contract
 *   assertions:
 *     purity:          parseVisionCapableProfiles/parseCreateConnectionBody/parseUpdateConnectionBody/
 *                      parseReliabilitySweepBody are pure; listModelsForConnection/
 *                      listProvidersForConnection/testConnection are impure (a network call to the
 *                      named connection's provider)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected LlmConnectionStore); the configured LLM provider
 *                       APIs]
 */

import { createLlmProviderForProfile } from '../../io/llm/index.js';
import type { LlmConnectionInit, LlmConnectionPatch, LlmConnectionStore } from '../../io/llmConnections.js';
import { isProviderKind } from '../../io/llmConnections.js';

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

// The provider-reliability sweep's request body (POST /v1/admin/connections/:id/reliability,
// io/providerReliability.ts). Every field optional — absent fields fall back to the module's own
// defaults (3 attempts per provider, 2s start cadence). Bounded so an admin can't accidentally
// launch a runaway billed sweep: attempts per provider 1-10, start cadence 500-10000ms.
// quantizations filters every probe to the given formats (e.g. ["int8"]) — validated as a plain
// array of non-empty strings; an empty array means "unfiltered", same as absent.
export interface ReliabilitySweepBody {
  attemptsPerProvider?: number;
  delayMs?: number;
  quantizations?: string[];
}

export function parseReliabilitySweepBody(raw: unknown): ReliabilitySweepBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { attemptsPerProvider, delayMs, quantizations } = raw as Record<string, unknown>;
  if (
    attemptsPerProvider !== undefined &&
    (typeof attemptsPerProvider !== 'number' || !Number.isInteger(attemptsPerProvider) || attemptsPerProvider < 1 || attemptsPerProvider > 10)
  ) {
    return undefined;
  }
  if (delayMs !== undefined && (typeof delayMs !== 'number' || !Number.isInteger(delayMs) || delayMs < 500 || delayMs > 10000)) {
    return undefined;
  }
  if (quantizations !== undefined && (!Array.isArray(quantizations) || quantizations.some((q) => typeof q !== 'string' || q.trim() === ''))) {
    return undefined;
  }
  const quantizationsDefined = Array.isArray(quantizations) ? quantizations : undefined;
  return {
    ...(attemptsPerProvider !== undefined ? { attemptsPerProvider } : {}),
    ...(delayMs !== undefined ? { delayMs } : {}),
    ...(quantizationsDefined && quantizationsDefined.length > 0 ? { quantizations: quantizationsDefined } : {}),
  };
}

export function parseCreateConnectionBody(raw: unknown): LlmConnectionInit | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, kind, model, apiKey, copyApiKeyFrom, baseUrl, supportsVision, providerOrder, allowFallbacks, quantizations,
    priceInputPerMillion, priceOutputPerMillion, priceCacheHitPerMillion,
    pricePeakInputPerMillion, pricePeakOutputPerMillion, pricePeakCacheHitPerMillion } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) return undefined;
  if (kind !== 'anthropic' && kind !== 'openai-compatible' && kind !== 'deepseek' && kind !== 'openrouter') return undefined;
  // Empty is allowed on create: the model catalog preview (listModelsForConnection) needs a saved
  // connection's own id to query, so an admin picking a kind for the first time has nowhere to pick
  // a model from until after this first save — a name + kind shell, filled in on the next save.
  if (typeof model !== 'string') return undefined;
  const hasApiKey = typeof apiKey === 'string' && apiKey.length > 0;
  const hasCopyFrom = typeof copyApiKeyFrom === 'string' && copyApiKeyFrom.length > 0;
  // Key rules are kind-dependent: provider kinds (deepseek/openrouter) draw the shared
  // provider_credentials key and must NOT carry a per-connection key; freeform kinds
  // (anthropic/openai-compatible) need exactly one of apiKey/copyApiKeyFrom — a fresh key, or
  // reuse another connection's by id (io/llmConnections.ts's copyCiphertext) instead of re-pasting
  // the same key into every connection that shares one underlying provider.
  if (isProviderKind(kind)) {
    if (hasApiKey || hasCopyFrom) return undefined;
  } else if (hasApiKey === hasCopyFrom) {
    return undefined;
  }
  if (kind === 'openai-compatible' && (typeof baseUrl !== 'string' || !baseUrl)) return undefined;
  if (baseUrl !== undefined && typeof baseUrl !== 'string') return undefined;
  if (supportsVision !== undefined && typeof supportsVision !== 'boolean') return undefined;
  if (providerOrder !== undefined && !isStringArray(providerOrder)) return undefined;
  if (allowFallbacks !== undefined && typeof allowFallbacks !== 'boolean') return undefined;
  if (quantizations !== undefined && !isStringArray(quantizations)) return undefined;
  if (priceInputPerMillion !== undefined && !isPrice(priceInputPerMillion)) return undefined;
  if (priceOutputPerMillion !== undefined && !isPrice(priceOutputPerMillion)) return undefined;
  if (priceCacheHitPerMillion !== undefined && !isPrice(priceCacheHitPerMillion)) return undefined;
  if (pricePeakInputPerMillion !== undefined && !isPrice(pricePeakInputPerMillion)) return undefined;
  if (pricePeakOutputPerMillion !== undefined && !isPrice(pricePeakOutputPerMillion)) return undefined;
  if (pricePeakCacheHitPerMillion !== undefined && !isPrice(pricePeakCacheHitPerMillion)) return undefined;
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
    pricePeakInputPerMillion: isPrice(pricePeakInputPerMillion) ? pricePeakInputPerMillion : undefined,
    pricePeakOutputPerMillion: isPrice(pricePeakOutputPerMillion) ? pricePeakOutputPerMillion : undefined,
    pricePeakCacheHitPerMillion: isPrice(pricePeakCacheHitPerMillion) ? pricePeakCacheHitPerMillion : undefined,
  };
}

// Every field optional (a PATCH — only touch what's given), unlike create's required set.
// baseUrl/providerOrder/quantizations additionally accept `null` to explicitly clear a
// previously-set value, distinct from `undefined` ("leave it alone") — same three-state shape
// io/llmConnections.ts's own LlmConnectionPatch already expects.
export function parseUpdateConnectionBody(raw: unknown): LlmConnectionPatch | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, kind, model, apiKey, copyApiKeyFrom, baseUrl, supportsVision, providerOrder, allowFallbacks, quantizations,
    priceInputPerMillion, priceOutputPerMillion, priceCacheHitPerMillion,
    pricePeakInputPerMillion, pricePeakOutputPerMillion, pricePeakCacheHitPerMillion } = raw as Record<string, unknown>;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return undefined;
  if (kind !== undefined && kind !== 'anthropic' && kind !== 'openai-compatible' && kind !== 'deepseek' && kind !== 'openrouter') return undefined;
  // Empty is allowed here too, same reasoning as parseCreateConnectionBody: switching an existing
  // connection's kind mid-edit invalidates its old model with nowhere yet to pick a replacement
  // from (the catalog preview needs this save to land first) — a same-request kind change must be
  // able to clear model rather than being blocked on a value that no longer means anything.
  if (model !== undefined && typeof model !== 'string') return undefined;
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey)) return undefined;
  if (copyApiKeyFrom !== undefined && (typeof copyApiKeyFrom !== 'string' || !copyApiKeyFrom)) return undefined;
  // Rotating the key at most one way per request — pick a fresh one or reuse another connection's,
  // not both at once.
  if (apiKey !== undefined && copyApiKeyFrom !== undefined) return undefined;
  // A provider-kind target (deepseek/openrouter) never takes a per-connection key — its key is the
  // shared provider_credentials row, rotated in Settings. The reverse transition (provider kind ->
  // freeform, which DOES need a key) can't be fully validated here because the current row's kind
  // lives in the DB; the store's update() enforces it and the route turns that into a 400.
  if (kind !== undefined && isProviderKind(kind) && (apiKey !== undefined || copyApiKeyFrom !== undefined)) return undefined;
  if (baseUrl !== undefined && baseUrl !== null && typeof baseUrl !== 'string') return undefined;
  if (supportsVision !== undefined && typeof supportsVision !== 'boolean') return undefined;
  if (providerOrder !== undefined && providerOrder !== null && !isStringArray(providerOrder)) return undefined;
  if (allowFallbacks !== undefined && typeof allowFallbacks !== 'boolean') return undefined;
  if (quantizations !== undefined && quantizations !== null && !isStringArray(quantizations)) return undefined;
  if (priceInputPerMillion !== undefined && priceInputPerMillion !== null && !isPrice(priceInputPerMillion)) return undefined;
  if (priceOutputPerMillion !== undefined && priceOutputPerMillion !== null && !isPrice(priceOutputPerMillion)) return undefined;
  if (priceCacheHitPerMillion !== undefined && priceCacheHitPerMillion !== null && !isPrice(priceCacheHitPerMillion)) return undefined;
  if (pricePeakInputPerMillion !== undefined && pricePeakInputPerMillion !== null && !isPrice(pricePeakInputPerMillion)) return undefined;
  if (pricePeakOutputPerMillion !== undefined && pricePeakOutputPerMillion !== null && !isPrice(pricePeakOutputPerMillion)) return undefined;
  if (pricePeakCacheHitPerMillion !== undefined && pricePeakCacheHitPerMillion !== null && !isPrice(pricePeakCacheHitPerMillion)) return undefined;

  const patch: LlmConnectionPatch = {};
  if (name !== undefined) patch.name = (name as string).trim();
  if (kind !== undefined) patch.kind = kind as LlmConnectionPatch['kind'];
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
  if (pricePeakInputPerMillion !== undefined) patch.pricePeakInputPerMillion = pricePeakInputPerMillion as number | null;
  if (pricePeakOutputPerMillion !== undefined) patch.pricePeakOutputPerMillion = pricePeakOutputPerMillion as number | null;
  if (pricePeakCacheHitPerMillion !== undefined) patch.pricePeakCacheHitPerMillion = pricePeakCacheHitPerMillion as number | null;
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
// this file's own listModelsForConnection/listProvidersForConnection preview calls just below —
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