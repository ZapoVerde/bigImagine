/**
 * @file orchestrator/src/io/embeddings/index.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — provider selection
 * @description
 * Mirrors io/llm/index.ts. Fails closed on missing/unrecognized config rather than defaulting —
 * an embedding written with the wrong provider or dimension is much harder to notice later than
 * a startup error now. output_dimension is required, not defaulted here, because it must match
 * whatever the Postgres vector(N) columns were migrated to (see db/migrations/README.md) — that
 * coupling belongs in deployment config (.env), not in code.
 *
 * @api-declaration
 * createEmbeddingProvider(env: NodeJS.ProcessEnv) — reads BIGBRAIN_EMBEDDINGS_PROVIDER,
 *   BIGBRAIN_EMBEDDINGS_MODEL, BIGBRAIN_EMBEDDINGS_API_KEY, BIGBRAIN_EMBEDDINGS_OUTPUT_DIMENSION
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads process env)
 *     state_ownership: []
 *     external_io:     []
 */

import { createVoyageEmbeddingProvider } from './voyage.js';
import type { EmbeddingProvider } from './types.js';

export type { EmbeddingProvider } from './types.js';

export function createEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const provider = env.BIGBRAIN_EMBEDDINGS_PROVIDER;

  if (provider === 'voyage') {
    const apiKey = env.BIGBRAIN_EMBEDDINGS_API_KEY;
    const model = env.BIGBRAIN_EMBEDDINGS_MODEL;
    const outputDimensionRaw = env.BIGBRAIN_EMBEDDINGS_OUTPUT_DIMENSION;
    if (!apiKey) throw new Error('BIGBRAIN_EMBEDDINGS_API_KEY is required when BIGBRAIN_EMBEDDINGS_PROVIDER=voyage');
    if (!model) throw new Error('BIGBRAIN_EMBEDDINGS_MODEL is required when BIGBRAIN_EMBEDDINGS_PROVIDER=voyage');
    if (!outputDimensionRaw) {
      throw new Error(
        'BIGBRAIN_EMBEDDINGS_OUTPUT_DIMENSION is required when BIGBRAIN_EMBEDDINGS_PROVIDER=voyage — ' +
          'it must match the Postgres vector(N) column width (see db/migrations/README.md)',
      );
    }
    const outputDimension = Number(outputDimensionRaw);
    if (!Number.isInteger(outputDimension) || outputDimension <= 0) {
      throw new Error(`BIGBRAIN_EMBEDDINGS_OUTPUT_DIMENSION must be a positive integer, got "${outputDimensionRaw}"`);
    }
    return createVoyageEmbeddingProvider({ apiKey, model, outputDimension });
  }

  throw new Error(
    `BIGBRAIN_EMBEDDINGS_PROVIDER is ${provider ? `set to unrecognized value "${provider}"` : 'not set'} — ` +
      'set it to a supported provider (currently: "voyage") rather than falling back to a default.',
  );
}
