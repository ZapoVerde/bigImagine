/**
 * @file orchestrator/src/io/embeddings/voyage.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — EmbeddingProvider adapter for the Voyage AI embeddings API
 * @description
 * Voyage's general-purpose models (voyage-3-large included) don't support every dimension —
 * output_dimension is one of a fixed set the model allows, not an arbitrary integer. This
 * adapter takes the dimension as required config rather than guessing or hardcoding one, and
 * verifies every returned embedding actually has that length before handing it back — a silent
 * mismatch here would otherwise surface as a confusing Postgres error deep inside an insert.
 *
 * @api-declaration
 * createVoyageEmbeddingProvider(config: VoyageConfig) — config.apiKey, config.model,
 *   config.outputDimension all required and read from env by io/embeddings/index.ts
 *
 * @contract
 *   assertions:
 *     purity:          impure (network call)
 *     state_ownership: []
 *     external_io:     [Voyage AI embeddings API]
 */

import type { EmbeddingProvider } from './types.js';

export interface VoyageConfig {
  apiKey: string;
  model: string;
  outputDimension: number;
  baseUrl?: string;
}

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
}

export function createVoyageEmbeddingProvider(config: VoyageConfig): EmbeddingProvider {
  const baseUrl = config.baseUrl ?? 'https://api.voyageai.com';

  return {
    name: 'voyage',
    dimension: config.outputDimension,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const response = await fetch(`${baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model: config.model,
          output_dimension: config.outputDimension,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Voyage AI API error ${response.status}: ${body}`);
      }

      const payload = (await response.json()) as VoyageResponse;
      const vectors = [...payload.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);

      const wrongLength = vectors.find((v) => v.length !== config.outputDimension);
      if (wrongLength) {
        throw new Error(
          `Voyage AI returned a ${wrongLength.length}-dim embedding but output_dimension=${config.outputDimension} was requested — model "${config.model}" may not support that dimension`,
        );
      }

      return vectors;
    },
  };
}
