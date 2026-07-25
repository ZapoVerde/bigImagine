/**
 * @file plugins/documents/src/saveDocument.ts
 * @stamp 2026-07-25
 * @architectural-role Orchestrator — sequences a document save across git, the LLM, and Postgres
 * @description
 * Shared by save_document and ingest_url's tool handlers, so both go through exactly one save
 * sequence rather than two copies of it: commit the markdown to the user's own content repo
 * (gitRepo.ts), summarize+embed it (classifyDocument.ts / the injected EmbeddingProvider), then
 * upsert the `documents` row keyed on (repo, file_path) so re-saving the same document updates its
 * existing row instead of creating a duplicate. `repo` is a per-user label (`local/<user_id>`), not
 * a real remote — see gitRepo.ts's module preamble for why every user gets their own local repo.
 *
 * @api-declaration
 * saveDocument(deps, userId, args) — returns the upserted document's id/title/summary/commit sha
 *
 * @contract
 *   assertions:
 *     purity:          impure (filesystem/git via gitRepo.ts, LLM, embeddings, Postgres)
 *     state_ownership: []
 *     external_io:     [filesystem, the local `git` binary, LLM, embeddings provider, Postgres]
 */

import type { EmbeddingProvider } from '@bigbrain/orchestrator/embeddings';
import type { LlmProvider } from '@bigbrain/orchestrator/llm-types';
import type { DbSession } from '@bigbrain/orchestrator/postgres';
import { toPgVectorLiteral } from '@bigbrain/orchestrator/pgvector';
import { summarizeDocument } from './classifyDocument.js';
import { slugifyTitle, writeDocumentFile } from './gitRepo.js';

export interface SaveDocumentArgs {
  title: string;
  contentMarkdown: string;
  path?: string;
}

export interface SaveDocumentResult {
  docId: string;
  title: string;
  filePath: string;
  summaryShort: string;
  commitSha: string;
}

interface DocumentRow {
  doc_id: string;
  title: string;
  file_path: string;
  summary_short: string;
}

export async function saveDocument(
  deps: { llm: LlmProvider; embeddings: EmbeddingProvider; db: DbSession },
  userId: string,
  args: SaveDocumentArgs,
): Promise<SaveDocumentResult> {
  const filePath = args.path?.trim() || slugifyTitle(args.title);
  const repo = `local/${userId}`;

  const commitSha = await writeDocumentFile(userId, filePath, args.contentMarkdown, `save: ${args.title}`);
  const [summaryShort, [vector]] = await Promise.all([
    summarizeDocument(deps.llm, args.title, args.contentMarkdown),
    deps.embeddings.embed([args.contentMarkdown]),
  ]);

  const [row] = await deps.db.query<DocumentRow>(
    `insert into documents (user_id, repo, file_path, last_synced_sha, vector_embed, summary_short, title, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'fresh')
     on conflict (repo, file_path) do update set
       last_synced_sha = excluded.last_synced_sha,
       vector_embed = excluded.vector_embed,
       summary_short = excluded.summary_short,
       title = excluded.title,
       status = 'fresh',
       updated_at = now()
     returning doc_id, title, file_path, summary_short`,
    [userId, repo, filePath, commitSha, toPgVectorLiteral(vector!), summaryShort, args.title],
  );

  return {
    docId: row!.doc_id,
    title: row!.title,
    filePath: row!.file_path,
    summaryShort: row!.summary_short,
    commitSha,
  };
}
