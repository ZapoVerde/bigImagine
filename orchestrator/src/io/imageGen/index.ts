/**
 * @file orchestrator/src/io/imageGen/index.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — image provider adapter factory and dispatch layer
 *   (endpoint.md §3.2)
 * @description
 * The single seam between the generation pass (orchestrator/generateLocationImage.ts) and the
 * five provider adapters (endpoint.md §3.2). Given an ImageConnectionProfile (the decrypted row,
 * io/imageConnections.ts), createImageGenProvider returns the one adapter for its `kind` — a
 * straight lookup, never a fallback chain — wrapped in a uniform
 * `generate(req) -> Promise<string>` that every adapter implements. This is the IO wrapper layer
 * of the four-kinds split (bi_principles.md §8): zero reasoning here, just dispatch and a shared
 * request shape (io/imageGen/types.ts).
 *
 * Each adapter returns the direct remote CDN Image URL string (endpoint.md §3.2 header) — no
 * image bytes ever touch this process, honoring the stateless-media commitment (endpoint.md §1.1).
 * The pollinations adapter makes no network call either (its URL *is* the render request), but it
 * is NOT keyless — Pollinations has required a token since 2025 (anonymous requests are
 * watermarked/rate-limited), so the connection's apiKey rides along as the `token` URL param
 * (io/imageGen/pollinations.ts).
 *
 * @api-declaration
 * createImageGenProvider(profile: ImageConnectionProfile) -> ImageGenProvider
 *   .generate(req: ImageGenRequest) -> Promise<string> — the CDN image URL for this request
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs network-calling adapters)
 *     state_ownership: []
 *     external_io:     [the provider's API, via the chosen adapter]
 */

import type { ImageConnectionProfile } from '../imageConnections.js';
import { generateComfyUiImage } from './comfyUi.js';
import { generateFalAiImage } from './falAi.js';
import { generateOpenAiImage } from './openaiImages.js';
import { generatePollinationsImage } from './pollinations.js';
import { generateRunwareImage } from './runware.js';
import type { ImageGenRequest } from './types.js';

export interface ImageGenProvider {
  generate(req: ImageGenRequest): Promise<string>;
}

export function createImageGenProvider(profile: ImageConnectionProfile): ImageGenProvider {
  switch (profile.kind) {
    case 'runware':
      return { generate: (req) => generateRunwareImage(req) };
    case 'fal-ai':
      return { generate: (req) => generateFalAiImage(req) };
    case 'pollinations':
      return { generate: (req) => generatePollinationsImage(req) };
    case 'comfyui':
      return { generate: (req) => generateComfyUiImage(req) };
    case 'openai-images':
      return { generate: (req) => generateOpenAiImage(req) };
  }
}
