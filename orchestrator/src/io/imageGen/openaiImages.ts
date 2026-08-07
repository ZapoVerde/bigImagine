/**
 * @file orchestrator/src/io/imageGen/openaiImages.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — OpenAI / DALL-E image adapter (endpoint.md §3.2.5)
 * @description
 * Submits an image generation request to an OpenAI-compatible images/generations endpoint
 * (DALL-E 3, gpt-image-1, or any compatible backend) and returns the generated image URL.
 * Authorization is Bearer; baseUrl defaults to https://api.openai.com/v1 but a compatible
 * self-hosted endpoint can be pointed at via the connection's base_url.
 *
 * OpenAI's images API responds with either `data[].url` (a direct CDN link) or, for newer
 * models served over the standard tier, `data[].b64_json`. This adapter only ever returns a
 * remote URL — the stateless-media commitment (endpoint.md §1.1) means a base64 blob must not be
 * written anywhere on this platform, so a b64_json-only response is surfaced as an error telling
 * the admin the model/endpoint combination isn't usable here, rather than silently storing a
 * data URI.
 *
 * @api-declaration
 * generateOpenAiImage(req: ImageGenRequest) -> Promise<string> — the generated image URL
 *
 * @contract
 *   assertions:
 *     purity:          impure (network call via fetch)
 *     state_ownership: []
 *     external_io:     [https://api.openai.com/v1 or the connection's own baseUrl]
 */

import { fetchWithRetry } from '../httpRetry.js';
import type { ImageGenRequest } from './types.js';

const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1';

export async function generateOpenAiImage(req: ImageGenRequest): Promise<string> {
  if (!req.apiKey) throw new Error('openai-images: no API key configured for this connection');
  const base = (req.baseUrl ?? DEFAULT_OPENAI_ENDPOINT).replace(/\/+$/, '');
  const res = await fetchWithRetry(`${base}/images/generations`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${req.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: req.model,
      prompt: req.prompt,
      n: 1,
      size: `${req.width}x${req.height}`,
      ...(req.seed !== null && req.seed !== undefined ? { seed: req.seed } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`openai-images: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }
  const parsed = (await res.json()) as { data?: { url?: string; b64_json?: string }[] };
  const item = parsed.data?.[0];
  if (item?.url) return item.url;
  if (item?.b64_json) {
    throw new Error('openai-images: endpoint returned a base64 blob, not a URL — use a model/endpoint that serves direct image URLs (stateless media: this platform never stores image files)');
  }
  throw new Error('openai-images: response contained no image data');
}
