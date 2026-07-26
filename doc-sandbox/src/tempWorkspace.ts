/**
 * @file doc-sandbox/src/tempWorkspace.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — a per-request scratch directory, always cleaned up
 * @description
 * Every conversion gets its own directory under the OS temp dir, removed afterward regardless of
 * outcome — this is the container's only real filesystem state, and nothing here is meant to
 * survive past a single request. Kept separate from convertOffice.ts/ocrPdf.ts since both need
 * the exact same create/cleanup shape.
 *
 * @api-declaration
 * withTempDir(fn) — creates a fresh temp dir, awaits fn(dir), always removes the dir afterward
 *
 * @contract
 *   assertions:
 *     purity:          impure (filesystem)
 *     state_ownership: []
 *     external_io:     [filesystem]
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'doc-sandbox-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
