/**
 * @file orchestrator/src/io/embeddings/stub.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — deterministic EmbeddingProvider for local verification, never
 * selected by createEmbeddingProvider's config-driven dispatch (dev/test only)
 * @description
 * Same reasoning as io/llm/stub.ts: no live Voyage key is available in the sandbox this was
 * built in. Produces a fixed-length vector deterministically derived from each input string
 * (not random) so a verification script can assert the same text always embeds to the same
 * vector, and different text embeds differently — real embedding behavior a plugin's calling
 * code actually depends on, without calling out to Voyage.
 *
 * @api-declaration
 * createStubEmbeddingProvider(dimension: number) — returns an EmbeddingProvider
 *
 * @contract
 *   assertions:
 *     purity:          impure (interface parity with real providers; the embed function itself
 *                       is pure per-call)
 *     state_ownership: []
 *     external_io:     []
 */

import type { EmbeddingProvider } from './types.js';

function hashToUnitVector(text: string, dimension: number): number[] {
  const vector = new Array(dimension).fill(0);
  for (let i = 0; i < text.length; i++) {
    vector[i % dimension] += text.charCodeAt(i);
  }
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / magnitude);
}

export function createStubEmbeddingProvider(dimension: number): EmbeddingProvider {
  return {
    name: 'stub',
    dimension,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => hashToUnitVector(t, dimension));
    },
  };
}
