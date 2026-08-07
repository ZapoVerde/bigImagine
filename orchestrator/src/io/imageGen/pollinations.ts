/**
 * @file orchestrator/src/io/imageGen/pollinations.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — Pollinations image adapter (endpoint.md §3.2.3)
 * @description
 * Pollinations is the zero-key fallback: no API call at all. Its model serves images from a
 * plain GET URL — https://image.pollinations.ai/prompt/{prompt}?width=..&height=..&model=..&seed=..
 * — so "generation" here is just formatting that URL from the request and returning it. This is
 * why the connection's apiKey is nullable in the shared model: this adapter never reads one.
 *
 * The URL is returned as-is (the browser loads it directly), which makes this backend both the
 * cheapest and the least controllable — the prompt is baked into the URL, the aspect ratio is
 * expressed in width/height pixels rather than a model-native size, and there is no negative
 * prompt or CFG parameter. That's the documented tradeoff of the zero-key fallback (endpoint.md
 * §3.2.3): it exists so an unconfigured deployment still gets *an* image, not so it competes with
 * a real backend on quality.
 *
 * @api-declaration
 * generatePollinationsImage(req: ImageGenRequest) -> Promise<string> — the direct Pollinations
 *   image URL (no network call; the URL *is* the render request)
 *
 * @contract
 *   assertions:
 *     purity:          impure (formats a URL; performs no network IO itself)
 *     state_ownership: []
 *     external_io:     [] (the caller/browser fetches the returned URL)
 */

import type { ImageGenRequest } from './types.js';

export async function generatePollinationsImage(req: ImageGenRequest): Promise<string> {
  const params = new URLSearchParams({
    width: String(req.width),
    height: String(req.height),
    model: req.model,
    nologo: 'true',
  });
  if (req.seed !== null && req.seed !== undefined) params.set('seed', String(req.seed));
  const prompt = req.prompt.trim();
  if (!prompt) throw new Error('pollinations: empty prompt — nothing to render');
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
}
