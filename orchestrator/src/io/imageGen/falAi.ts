/**
 * @file orchestrator/src/io/imageGen/falAi.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — fal.ai image adapter (endpoint.md §3.2.2)
 * @description
 * Submits a generation job to a fal.ai model endpoint (Flux, SDXL — the model id is the
 * connection's, e.g. "fal-ai/flux/dev") and returns the direct fal.media CDN image URL. fal.ai's
 * queue API is asynchronous: POST /{model} returns a request_id, then the response URL is polled
 * until the job reaches SUCCESS, and finally the result endpoint returns the image URL. This
 * adapter does all three steps with a bounded poll (the queue can take tens of seconds under
 * load, so the wait is a real wait, not a fixed sleep).
 *
 * Authorization is the fal.ai REST key ("Key <key>" scheme). apiKey is required — fal.ai is never
 * keyless. baseUrl, when set on the connection, overrides the default https://queue.fal.run so a
 * self-hosted fal-compatible queue can be targeted; otherwise the standard endpoint is used.
 *
 * @api-declaration
 * generateFalAiImage(req: ImageGenRequest) -> Promise<string> — the fal.media CDN image URL
 *
 * @contract
 *   assertions:
 *     purity:          impure (network calls via fetch)
 *     state_ownership: []
 *     external_io:     [https://queue.fal.run or the connection's own baseUrl]
 */

import { fetchWithRetry } from '../httpRetry.js';
import type { ImageGenRequest } from './types.js';

const DEFAULT_FAL_ENDPOINT = 'https://queue.fal.run';

interface FalStatusResponse {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | unknown;
}

interface FalResultResponse {
  images?: { url?: string }[];
}

export async function generateFalAiImage(req: ImageGenRequest): Promise<string> {
  if (!req.apiKey) throw new Error('fal-ai: no API key configured for this connection');
  const base = (req.baseUrl ?? DEFAULT_FAL_ENDPOINT).replace(/\/+$/, '');
  const modelPath = req.model.startsWith('/') ? req.model : `/${req.model}`;
  const headers = {
    authorization: `Key ${req.apiKey}`,
    'content-type': 'application/json',
  };
  const submit = await fetchWithRetry(`${base}${modelPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt: req.prompt,
      negative_prompt: req.negativePrompt || undefined,
      num_inference_steps: req.steps,
      guidance_scale: req.cfgScale,
      image_size: { width: req.width, height: req.height },
      ...(req.seed !== null && req.seed !== undefined ? { seed: req.seed } : {}),
      ...(req.samplerName ? { sampler_name: req.samplerName } : {}),
    }),
  });
  if (!submit.ok) {
    const detail = await submit.text().catch(() => '');
    throw new Error(`fal-ai: submit HTTP ${submit.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }
  const submitted = (await submit.json()) as { request_id?: string };
  if (!submitted.request_id) throw new Error('fal-ai: submit response contained no request_id');

  // Poll the status endpoint until COMPLETED. The queue can legitimately take tens of seconds
  // under load, so keep waiting (bounded below) rather than giving up after a few fast attempts.
  const deadlineMs = Date.now() + 120_000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (Date.now() > deadlineMs) throw new Error('fal-ai: timed out waiting for the generation job');
    const statusRes = await fetchWithRetry(`${base}${modelPath}/requests/${submitted.request_id}/status`, { headers });
    if (!statusRes.ok) {
      const detail = await statusRes.text().catch(() => '');
      throw new Error(`fal-ai: status HTTP ${statusRes.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
    }
    const status = (await statusRes.json()) as FalStatusResponse;
    if (status.status === 'COMPLETED') break;
    if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') continue;
    // Unknown terminal-ish status: surface it rather than polling forever.
    throw new Error(`fal-ai: unexpected job status ${String(status.status)}`);
  }

  const resultRes = await fetchWithRetry(`${base}${modelPath}/requests/${submitted.request_id}`, { headers });
  if (!resultRes.ok) {
    const detail = await resultRes.text().catch(() => '');
    throw new Error(`fal-ai: result HTTP ${resultRes.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }
  const result = (await resultRes.json()) as FalResultResponse;
  const imageUrl = result.images?.[0]?.url;
  if (!imageUrl) throw new Error('fal-ai: result contained no image url');
  return imageUrl;
}
