/**
 * @file orchestrator/src/io/imageGen/runware.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — Runware image adapter (endpoint.md §3.2.1)
 * @description
 * Connects to Runware's HTTP API (https://api.runware.ai/v1) with the synthesized positive/negative
 * prompts, the connection's model id ("runware:100@1" style), dimensions, steps, CFG scale and
 * seed, and returns the direct Runware CDN image URL. One round trip, no polling: the
 * imageGeneration task returns its imageURL synchronously in the same response.
 *
 * Runware's API takes a JSON object of task parameters (apiKey, taskType: 'imageGeneration',
 * model, prompt, negativePrompt, width, height, steps, cfgScale, seed). The response is
 * `{ data: [{ imageURL }] }`. apiKey is required — Runware is never keyless (unlike Pollinations),
 * so a connection whose ciphertext is null is a misconfiguration this adapter surfaces loudly
 * rather than guessing.
 *
 * @api-declaration
 * generateRunwareImage(req: ImageGenRequest) -> Promise<string> — the Runware CDN image URL
 *
 * @contract
 *   assertions:
 *     purity:          impure (network call via fetch)
 *     state_ownership: []
 *     external_io:     [https://api.runware.ai/v1]
 */

import { fetchWithRetry } from '../httpRetry.js';
import type { ImageGenRequest } from './types.js';

const RUNWARE_ENDPOINT = 'https://api.runware.ai/v1';

export async function generateRunwareImage(req: ImageGenRequest): Promise<string> {
  if (!req.apiKey) throw new Error('runware: no API key configured for this connection');
  const body = {
    apiKey: req.apiKey,
    taskType: 'imageGeneration',
    model: req.model,
    prompt: req.prompt,
    negativePrompt: req.negativePrompt || undefined,
    width: req.width,
    height: req.height,
    steps: req.steps,
    cfgScale: req.cfgScale,
    ...(req.seed !== null && req.seed !== undefined ? { seed: req.seed } : {}),
    ...(req.samplerName ? { samplerName: req.samplerName } : {}),
  };
  const res = await fetchWithRetry(RUNWARE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`runware: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }
  const parsed = (await res.json()) as { data?: { imageURL?: string }[] };
  const imageUrl = parsed.data?.[0]?.imageURL;
  if (!imageUrl) throw new Error('runware: response contained no imageURL');
  return imageUrl;
}
