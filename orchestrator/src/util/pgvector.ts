/**
 * @file orchestrator/src/util/pgvector.ts
 * @stamp 2026-07-23
 * @architectural-role Pure Function — pgvector text-literal formatting
 * @description
 * pgvector accepts a vector column value as a bound text parameter in `[v1,v2,...]` form, which
 * Postgres casts on insert. Shared here (rather than duplicated per plugin) since every plugin
 * that writes an embedding — document ingestion now, GitHub ingestion later — needs it.
 *
 * @api-declaration
 * toPgVectorLiteral(vector: number[]) — formats a JS number array for a vector(N) column param
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export function toPgVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
