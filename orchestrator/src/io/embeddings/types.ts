/**
 * @file orchestrator/src/io/embeddings/types.ts
 * @stamp 2026-07-23
 * @architectural-role Pure Function module — shared types only, no behavior
 * @description
 * Mirrors io/llm/types.ts: the seam so no code outside io/embeddings/ knows which embeddings
 * vendor is behind it, per the spirit of bb_principles.md §6 extended to this capability.
 * Batch-first (embed takes many texts, returns one vector per text in the same order) since the
 * GitHub Ingestion Gateway (Phase 9) will embed many document chunks per sync run.
 *
 * @api-declaration
 * EmbeddingProvider.embed(texts: string[]) — one vector per input text, same order, same length
 *
 * @contract
 *   assertions:
 *     purity:          pure (types only)
 *     state_ownership: []
 *     external_io:     []
 */

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}
