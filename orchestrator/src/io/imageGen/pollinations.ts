/**
 * @file orchestrator/src/io/imageGen/pollinations.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — Pollinations image adapter (endpoint.md §3.2.3)
 * @description
 * Pollinations has not been keyless since 2025 — its own auth (auth.pollinations.ai) gates the
 * usable tiers: anonymous requests are watermarked (since 2025-03-31), rate-limited to one
 * request per 15s, and locked to basic models. This adapter therefore REQUIRES the connection's
 * apiKey and carries it as the `token` query parameter — Pollinations' own extractFromRequest
 * checks `?token=` first (shared/extractFromRequest.js TOKEN_FIELDS, alongside the Authorization
 * header) — so the returned URL stays a plain browser-loadable CDN URL and the stateless-media
 * commitment (endpoint.md §1.1) holds: no image bytes ever touch this process, the DB stores
 * only the URL, and the <img> tag in ChatView fetches it directly with auth baked in.
 *
 * "Generation" is still just formatting that URL from the request — GET
 * https://image.pollinations.ai/prompt/{prompt}?width=..&height=..&model=..&seed=..&token=..
 * — no network call from this process. The prompt is baked into the URL, the aspect ratio is
 * expressed in width/height pixels rather than a model-native size, and there is no CFG
 * parameter: the documented tradeoff of a URL-only backend (endpoint.md §3.2.3), kept because a
 * token'd Pollinations URL remains the cheapest no-polling provider we have. The connection's
 * master negative prompt is forwarded as `negative_prompt` (Pollinations supports it natively,
 * the same way the upstream ST SD-extension proxy sends it).
 *
 * @api-declaration
 * generatePollinationsImage(req: ImageGenRequest) -> Promise<string> — the direct Pollinations
 *   image URL (no network call; the URL *is* the render request). Throws if the connection has
 *   no apiKey — mirroring the upstream ST SD-extension's 400 ("Pollinations API key not found").
 *
 * @contract
 *   assertions:
 *     purity:          impure (formats a URL; performs no network IO itself)
 *     state_ownership: []
 *     external_io:     [] (the caller/browser fetches the returned URL)
 */

import type { ImageGenRequest } from './types.js';

export async function generatePollinationsImage(req: ImageGenRequest): Promise<string> {
  if (!req.apiKey) {
    throw new Error(
      'pollinations: an apiKey is required — Pollinations is no longer keyless (anonymous requests are watermarked and rate-limited); set the connection key',
    );
  }
  const params = new URLSearchParams({
    width: String(req.width),
    height: String(req.height),
    model: req.model,
    token: req.apiKey,
    nologo: 'true',
  });
  if (req.seed !== null && req.seed !== undefined) params.set('seed', String(req.seed));
  const negative = req.negativePrompt.trim();
  if (negative) params.set('negative_prompt', negative);
  const prompt = req.prompt.trim();
  if (!prompt) throw new Error('pollinations: empty prompt — nothing to render');
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
}
