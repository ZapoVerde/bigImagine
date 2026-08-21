/**
 * @file orchestrator/src/io/imageGen/types.ts
 * @stamp 2026-08-13
 * @architectural-role Pure Function — shared image-generation request shape
 * @description
 * The one request shape every provider adapter (endpoint.md §3.2) accepts. width/height are the
 * connection's own explicit output pixels (image_connections.width/height, endpoint.md §2.1) —
 * every adapter's API takes pixel dimensions, and neither this subsystem nor the upstream VLZ
 * stack ever sends an aspect-ratio string to a provider.
 *
 * @api-declaration
 * ImageGenRequest — prompt/negative/model/dimensions/seed/steps/cfg/sampler + provider bits
 * GeneratedImage — generated CDN URL plus an optional provider-native reference
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO)
 *     state_ownership: []
 *     external_io:     []
 */

/** The request every io/imageGen adapter receives. width/height are the connection's explicit
 *  output pixels (defaults 1344×768 — a 16:9 landscape, matching VLZ's own background renders);
 *  apiKey/baseUrl are the connection's own (null only for a local comfyui endpoint — every
 *  cloud provider, Pollinations included, requires one); workflowParameters is the ComfyUI
 *  graph (endpoint.md §2.1), ignored by every other adapter. */
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

/** A generated image reference for consumers that may immediately post-process the asset. */
export interface GeneratedImage {
  imageUrl: string;
  providerImageRef?: string;
}
