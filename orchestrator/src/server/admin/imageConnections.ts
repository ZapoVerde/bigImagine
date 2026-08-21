/**
 * @file orchestrator/src/server/admin/imageConnections.ts
 * @stamp 2026-08-21
 * @architectural-role Pure Function (request parsing) + IO Wrapper (connection-store IO + one-off
 * provider calls) — the same dual-role split the original adminServer.ts image-connections block
 * used; moved here verbatim as part of the adminServer domain split
 * @description
 * Image-generation connection administration (docs/plans/vistalyze_integration/endpoint.md §3):
 * the Connections tab's image-section create/update body parsing, and the per-connection Test
 * button's diagnostic generation probe. General image prompt settings and location settings are
 * deliberately elsewhere (admin/locationSettings.ts); LLM connections are in
 * admin/llmConnections.ts.
 *
 * @api-declaration
 * parseCreateImageConnectionBody(raw) — validates an ImageConnectionInit (apiKey optional — only
 *   a local comfyui endpoint has none; every cloud provider, Pollinations included, requires one,
 *   endpoint.md §2.1); undefined on any malformed shape
 * parseUpdateImageConnectionBody(raw) — validates an ImageConnectionPatch; undefined on any malformed
 *   shape
 * testImageConnection(imageConnections, settings, id) — endpoint.md §3.3's diagnostic probe
 *   through one saved image connection, synthesized through the Master Image Prompt Template with
 *   the connection's style prefix (parallax_fade_teststep.md §4.2); undefined only if the id
 *   doesn't exist, otherwise always a result (a bad key/unreachable endpoint surfaces as
 *   { ok: false, error }, not a thrown error)
 *
 * @contract
 *   assertions:
 *     purity:          parseCreateImageConnectionBody/parseUpdateImageConnectionBody are pure;
 *                      testImageConnection is impure (a generation call to the named connection's
 *                      provider)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected ImageConnectionStore/OrchestratorSettingsStore);
 *                       the configured image-gen provider API]
 */

import type {
  ImageConnectionInit,
  ImageConnectionKind,
  ImageConnectionPatch,
  ImageConnectionPurpose,
  ImageConnectionStore,
} from '../../io/imageConnections.js';
import { createImageGenProvider } from '../../io/imageGen/index.js';
import { synthesizeImagePrompt, IMAGE_GEN_SEED } from '../../util/synthesizeImagePrompt.js';
import type { OrchestratorSettingsStore } from '../../io/orchestratorSettings.js';

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

function isImagePurpose(value: unknown): value is ImageConnectionPurpose {
  return value === 'background' || value === 'portrait' || value === 'bgrm';
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
    purpose,
    seed,
  } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) return undefined;
  if (!isImageKind(kind)) return undefined;
  if (typeof model !== 'string' || !model) return undefined;
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey)) return undefined;
  if (purpose !== undefined && !isImagePurpose(purpose)) return undefined;
  if (purpose === 'bgrm' && kind !== 'runware') return undefined;
  if (baseUrl !== undefined && typeof baseUrl !== 'string') return undefined;
  if (seed !== undefined && seed !== null && (typeof seed !== 'number' || !Number.isInteger(seed))) return undefined;
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
    purpose: isImagePurpose(purpose) ? purpose : undefined,
    baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
    width: typeof width === 'number' ? width : undefined,
    height: typeof height === 'number' ? height : undefined,
    samplingSteps: typeof samplingSteps === 'number' ? samplingSteps : undefined,
    cfgScale: typeof cfgScale === 'number' ? cfgScale : undefined,
    samplerName: typeof samplerName === 'string' ? samplerName : undefined,
    masterPositiveStylePrefix: typeof masterPositiveStylePrefix === 'string' ? masterPositiveStylePrefix : undefined,
    masterNegativePrompt: typeof masterNegativePrompt === 'string' ? masterNegativePrompt : undefined,
    workflowParameters: isJsonObject(workflowParameters) ? workflowParameters : undefined,
    seed: typeof seed === 'number' ? seed : null,
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
    purpose,
    seed,
  } = raw as Record<string, unknown>;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return undefined;
  if (kind !== undefined && !isImageKind(kind)) return undefined;
  if (model !== undefined && (typeof model !== 'string' || !model)) return undefined;
  if (purpose !== undefined && !isImagePurpose(purpose)) return undefined;
  if (purpose === 'bgrm' && kind !== undefined && kind !== 'runware') return undefined;
  if (seed !== undefined && seed !== null && (typeof seed !== 'number' || !Number.isInteger(seed))) return undefined;
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
  if (purpose !== undefined) patch.purpose = purpose as ImageConnectionPurpose;
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
  if (seed !== undefined) patch.seed = seed as number | null;
  return patch;
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
