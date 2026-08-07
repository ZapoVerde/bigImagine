/**
 * @file orchestrator/src/io/imageGen/types.ts
 * @stamp 2026-08-13
 * @architectural-role Pure Function — shared image-generation request shape + aspect-ratio parse
 * @description
 * The one request shape every provider adapter (endpoint.md §3.2) accepts, plus the pure
 * aspect-ratio parser that turns a connection's "16:9"-style string (endpoint.md §2.1) into the
 * pixel dimensions each adapter's API actually takes. Keeping the parse here means every adapter
 * agrees on what "16:9" means — a single source for the width/height every provider receives, so
 * the same location renders at the same proportions whichever backend is active.
 *
 * The resolution table uses the native Flux/SDXL-friendly sizes (multiples of 64, roughly
 * 1-megapixel) so a diffusion model isn't handed an odd dimension it must round anyway. Unknown or
 * malformed ratios fall back to square — the conservative default every provider handles.
 *
 * @api-declaration
 * ImageGenRequest — prompt/negative/model/dimensions/seed/steps/cfg/sampler + provider bits
 * parseAspectRatio(ratio: string) -> { width, height } — pure
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO)
 *     state_ownership: []
 *     external_io:     []
 */

/** The request every io/imageGen adapter receives. width/height are already parsed pixels;
 *  apiKey/baseUrl are the connection's own (null for keyless/local backends); workflowParameters
 *  is the ComfyUI graph (endpoint.md §2.1), ignored by every other adapter. */
export interface ImageGenRequest {
  prompt: string;
  negativePrompt: string;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
  width: number;
  height: number;
  seed: number | null;
  steps: number;
  cfgScale: number;
  samplerName: string | null;
  workflowParameters: Record<string, unknown> | null;
}

const ASPECT_RATIOS: Record<string, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
  '3:2': { width: 1216, height: 832 },
  '2:3': { width: 832, height: 1216 },
  '4:3': { width: 1152, height: 896 },
  '3:4': { width: 896, height: 1152 },
  '21:9': { width: 1536, height: 640 },
};

export function parseAspectRatio(ratio: string): { width: number; height: number } {
  const normalized = ratio.trim().replace(/\s+/g, '');
  return ASPECT_RATIOS[normalized] ?? { width: 1024, height: 1024 };
}
