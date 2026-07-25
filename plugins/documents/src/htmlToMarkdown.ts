/**
 * @file plugins/documents/src/htmlToMarkdown.ts
 * @stamp 2026-07-25
 * @architectural-role Pure Function — HTML page -> readable Markdown
 * @description
 * The real web-clipper conversion docs/spec.md §6.6 calls for, distinct from
 * plugins/recipes/src/htmlToText.ts's crude plaintext stripper (built only as LLM-extraction
 * fallback text, never meant to be read by a person). `@mozilla/readability` first strips
 * nav/ads/footer/related-posts boilerplate and keeps just the article — the same library
 * Firefox's own reader view uses — then `turndown` converts what's left to real Markdown:
 * headings, links, lists, bold/italic survive, instead of htmlToText's flattened plain text.
 * `linkedom` supplies the DOM Readability needs without pulling in jsdom's much heavier footprint.
 *
 * Known limitation: linkedom's `parseHTML` has no base-URL option, so Readability can't resolve
 * relative links/images to absolute ones — a clipped page's relative `href`/`src` values pass
 * through as-is. Acceptable for now (the point is readable text, not a pixel-perfect clip);
 * revisit if relative links in practice turn out broken often enough to matter.
 *
 * @api-declaration
 * htmlToMarkdown(html, url) — throws if Readability finds no extractable article content
 *
 * @contract
 *   assertions:
 *     purity:          pure (in-memory DOM parsing only, no external reads/writes)
 *     state_ownership: []
 *     external_io:     []
 */

import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

export interface ClippedDocument {
  title: string;
  markdown: string;
  excerpt: string;
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

export function htmlToMarkdown(html: string, url: string): ClippedDocument {
  const { document } = parseHTML(html);
  const reader = new Readability(document as unknown as Document, { charThreshold: 200 });
  const article = reader.parse();
  if (!article?.content) {
    throw new Error(`htmlToMarkdown: Readability found no extractable article content at ${url}`);
  }
  return {
    title: article.title?.trim() || url,
    markdown: turndown.turndown(article.content),
    excerpt: article.excerpt ?? '',
  };
}
