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
 * Also splits the document into chunks (chunkDocument.ts) and replaces its `document_chunks` rows
 * — delete-then-reinsert rather than upsert, since chunk count/boundaries can shift between saves
 * of the same document, same as how re-clipping a URL already replaces the whole document. The
 * doc-level embedding/summary above are unchanged and kept alongside these (list_documents' browse
 * still wants a document-level summary); the chunk embeddings are what search_documents actually
 * queries.
 *
 * Each chunk also gets auto-tagged (classifyDocument.ts's tagChunks), fed the user's existing tag
 * vocabulary (queried fresh on every save) as a nudge toward reuse rather than inventing near-
 * duplicates — see tagChunks's module preamble for why this is a nudge, not a guarantee.
 *
 * `args.metadata` (ingest_url only — save_document's manual path never sets it) drives two
 * separate things: a YAML frontmatter block prepended only to the string written to git (so a
 * clip is self-describing to a person or tool browsing the raw repo directly), and the new
 * `documents.source_url/site_name/author/published_at` columns (structured, queryable). Crucially
 * the frontmatter is NOT prepended to `args.contentMarkdown` itself — that string is what
 * chunkDocument/the doc-level embedding actually see, so frontmatter never pollutes chunk
 * boundaries, chunk embeddings, or tags.
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

import { stringify as toYaml } from 'yaml';
import type { EmbeddingProvider } from '@bigbrain/orchestrator/embeddings';
import type { LlmProvider } from '@bigbrain/orchestrator/llm-types';
import type { DbSession } from '@bigbrain/orchestrator/postgres';
import { toPgVectorLiteral } from '@bigbrain/orchestrator/pgvector';
import { chunkDocument } from './chunkDocument.js';
import { summarizeDocument, tagChunks } from './classifyDocument.js';
import { slugifyTitle, writeDocumentFile } from './gitRepo.js';

export interface SaveDocumentMetadata {
  sourceUrl: string;
  siteName: string | null;
  author: string | null;
  publishedAt: string | null;
}

export interface SaveDocumentArgs {
  title: string;
  contentMarkdown: string;
  path?: string;
  metadata?: SaveDocumentMetadata;
}

function buildFrontmatter(title: string, metadata: SaveDocumentMetadata): string {
  const frontmatter = toYaml({
    title,
    source: metadata.sourceUrl,
    domain: new URL(metadata.sourceUrl).hostname,
    author: metadata.author,
    date_saved: new Date().toISOString().slice(0, 10),
  });
  return `---\n${frontmatter}---\n\n`;
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

interface TagRow {
  tag: string;
}

export async function saveDocument(
  deps: { llm: LlmProvider; embeddings: EmbeddingProvider; db: DbSession },
  userId: string,
  args: SaveDocumentArgs,
): Promise<SaveDocumentResult> {
  const filePath = args.path?.trim() || slugifyTitle(args.title);
  const repo = `local/${userId}`;
  const chunks = chunkDocument(args.title, args.contentMarkdown);
  const fileContent = args.metadata
    ? buildFrontmatter(args.title, args.metadata) + args.contentMarkdown
    : args.contentMarkdown;

  const [commitSha, existingTagRows] = await Promise.all([
    writeDocumentFile(userId, filePath, fileContent, `save: ${args.title}`),
    deps.db.query<TagRow>('select distinct unnest(tags) as tag from document_chunks where user_id = $1 order by tag', [
      userId,
    ]),
  ]);
  const existingTags = existingTagRows.map((r) => r.tag);

  const [summaryShort, [vector], chunkVectors, chunkTags] = await Promise.all([
    summarizeDocument(deps.llm, args.title, args.contentMarkdown),
    deps.embeddings.embed([args.contentMarkdown]),
    deps.embeddings.embed(chunks.map((c) => c.content)),
    tagChunks(deps.llm, existingTags, chunks),
  ]);

  const [row] = await deps.db.query<DocumentRow>(
    `insert into documents (
       user_id, repo, file_path, last_synced_sha, vector_embed, summary_short, title, status,
       source_url, site_name, author, published_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, 'fresh', $8, $9, $10, $11)
     on conflict (repo, file_path) do update set
       last_synced_sha = excluded.last_synced_sha,
       vector_embed = excluded.vector_embed,
       summary_short = excluded.summary_short,
       title = excluded.title,
       status = 'fresh',
       updated_at = now(),
       source_url = excluded.source_url,
       site_name = excluded.site_name,
       author = excluded.author,
       published_at = excluded.published_at
     returning doc_id, title, file_path, summary_short`,
    [
      userId,
      repo,
      filePath,
      commitSha,
      toPgVectorLiteral(vector!),
      summaryShort,
      args.title,
      args.metadata?.sourceUrl ?? null,
      args.metadata?.siteName ?? null,
      args.metadata?.author ?? null,
      args.metadata?.publishedAt ?? null,
    ],
  );
  const docId = row!.doc_id;

  await deps.db.query('delete from document_chunks where doc_id = $1', [docId]);
  for (const [i, chunk] of chunks.entries()) {
    await deps.db.query(
      `insert into document_chunks (doc_id, user_id, ordinal, heading_path, content, vector_embed, tags)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        docId,
        userId,
        chunk.ordinal,
        chunk.headingPath,
        chunk.content,
        toPgVectorLiteral(chunkVectors[i]!),
        chunkTags.get(chunk.ordinal) ?? [],
      ],
    );
  }

  return {
    docId,
    title: row!.title,
    filePath: row!.file_path,
    summaryShort: row!.summary_short,
    commitSha,
  };
}
