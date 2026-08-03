/**
 * @file plugins/documents/src/ingestUrlTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — the web clipper
 * @description
 * docs/spec.md §6.6's first real caller of the write path: fetch a page, turn it into readable
 * Markdown (htmlToMarkdown.ts — Readability + Turndown), then save it exactly like save_document
 * would (saveDocument.ts — same underlying sequence, not a second copy of it). `url` is
 * LLM/chat-supplied, so it goes through fetchUntrustedUrl (orchestrator/src/io/fetchUntrusted.ts) —
 * a prompt-injected page could otherwise steer this tool at an internal address on the same Docker
 * network. Sends a browser-shaped User-Agent: at least one real site's response differs based on
 * it.
 *
 * htmlToMarkdown.ts's extracted siteName/author/publishedAt are passed through as saveDocument's
 * `metadata` — this is the only caller that ever sets it, since save_document's manual path has no
 * source page to attribute. That drives both a YAML frontmatter block in the saved file and the
 * new documents.source_url/site_name/author/published_at columns; see saveDocument.ts.
 *
 * @api-declaration
 * createIngestUrlTool(llm, embeddings) — returns the ingest_url RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (network fetch, LLM, embeddings, Postgres/filesystem/git via saveDocument)
 *     state_ownership: []
 *     external_io:     [the fetched URL, filesystem, the local `git` binary, LLM, embeddings, Postgres]
 */

import { fetchUntrustedUrl } from '@bigbrain/orchestrator/fetch-untrusted';
import type { EmbeddingProvider } from '@bigbrain/orchestrator/embeddings';
import type { LlmProvider } from '@bigbrain/orchestrator/llm-types';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { htmlToMarkdown } from './htmlToMarkdown.js';
import { saveDocument } from './saveDocument.js';

const FETCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function isIngestUrlArgs(value: unknown): value is { url: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).url === 'string' &&
    (value as Record<string, unknown>).url !== ''
  );
}

export function createIngestUrlTool(llm: LlmProvider, embeddings: EmbeddingProvider): RegisteredTool {
  return {
    definition: {
      name: 'ingest_url',
      description: 'Fetch a web page and save it as a readable Markdown document (a "clip"), stripped of navigation/ads/boilerplate.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The page to clip.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isIngestUrlArgs(args)) {
        throw new Error('ingest_url requires a url: string argument');
      }

      const response = await fetchUntrustedUrl(args.url, { headers: { 'User-Agent': FETCH_USER_AGENT } });
      if (!response.ok) {
        throw new Error(`ingest_url: fetching ${args.url} returned HTTP ${response.status}`);
      }
      const html = await response.text();
      const clipped = htmlToMarkdown(html, args.url);

      const result = await saveDocument({ llm, embeddings, db: ctx.db }, ctx.userId, {
        title: clipped.title,
        contentMarkdown: clipped.markdown,
        metadata: {
          sourceUrl: args.url,
          siteName: clipped.siteName,
          author: clipped.author,
          publishedAt: clipped.publishedAt,
        },
      });

      return {
        docId: result.docId,
        title: result.title,
        filePath: result.filePath,
        summaryShort: result.summaryShort,
        commitSha: result.commitSha,
        sourceUrl: args.url,
        siteName: clipped.siteName,
        author: clipped.author,
        publishedAt: clipped.publishedAt,
      };
    },
  };
}
