/**
 * @file plugins/documents/src/htmlToMarkdown.ts
 * @stamp 2026-07-26
 * @architectural-role Pure Function — HTML page -> readable, "pretty" Markdown
 * @description
 * The real web-clipper conversion docs/spec.md §6.6 calls for, distinct from
 * plugins/recipes/src/htmlToText.ts's crude plaintext stripper (built only as LLM-extraction
 * fallback text, never meant to be read by a person). `@mozilla/readability` first strips
 * nav/ads/footer/related-posts boilerplate and keeps just the article — the same library
 * Firefox's own reader view uses — then `turndown` converts what's left to real Markdown:
 * headings, links, lists, bold/italic survive, instead of htmlToText's flattened plain text.
 * `linkedom` supplies the DOM Readability needs without pulling in jsdom's much heavier footprint.
 *
 * Three passes happen before/around Readability, in a specific order:
 *   1. extractMetadata reads whatever structured source info the page publishes (Schema.org
 *      JSON-LD, OpenGraph, a plain <meta name="author">) plus Readability's own byline/siteName/
 *      publishedTime as a last-resort fallback — deterministic sources first, matching the same
 *      "reuse before inventing" instinct saveDocument.ts's tag vocabulary already applies. Runs
 *      against the full, un-mutated document, since Readability.parse() can strip elements from
 *      the tree it's given.
 *   2. Absolute-URL resolution over every img/a src/href, also before Readability runs (it only
 *      removes elements, never rewrites attributes, so order relative to it doesn't matter for
 *      this pass specifically, but running it before keeps both DOM passes together). Fixes the
 *      previously-known limitation where a clipped page's relative links/images passed through
 *      unresolved and rendered broken once the page's own base URL was gone.
 *   3. normalizeHeadings runs on Turndown's output, after conversion. Sites often misuse heading
 *      levels for visual styling rather than real nesting; DocumentsView.tsx renders a document's
 *      title as its own <h2>, so body headings are remapped to start at H3 (nesting under the
 *      title) and compressed with no gaps, so every clip gets a consistent, sane outline instead
 *      of whatever a given site's CSS-driven markup happened to produce.
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
  siteName: string | null;
  author: string | null;
  publishedAt: string | null;
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

interface ExtractedMetadata {
  siteName: string | null;
  author: string | null;
  publishedAt: string | null;
}

function authorFromJsonLdValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return authorFromJsonLdValue(value[0]);
  if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
    return (value as { name: string }).name;
  }
  return null;
}

function toIsoDateOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Best-effort only — a missing or malformed source just yields nulls, never throws, same
 *  tolerance already given to tagChunks skipping a chunk it can't confidently tag. */
function extractMetadata(document: Document): ExtractedMetadata {
  let author: string | null = null;
  let publishedAt: string | null = null;
  let siteName: string | null = null;

  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const data = JSON.parse(script.textContent ?? '');
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        author ??= authorFromJsonLdValue((entry as { author?: unknown }).author);
        publishedAt ??= toIsoDateOrNull((entry as { datePublished?: string }).datePublished);
        const publisher = (entry as { publisher?: { name?: string } }).publisher;
        siteName ??= typeof publisher?.name === 'string' ? publisher.name : null;
      }
    } catch {
      // Not real JSON, or not the shape we expect — skip this script tag and keep looking.
    }
  }

  siteName ??= document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ?? null;
  author ??= document.querySelector('meta[name="author"]')?.getAttribute('content') ?? null;

  return { siteName, author, publishedAt };
}

function resolveRelativeUrls(document: Document, baseUrl: string): void {
  for (const el of Array.from(document.querySelectorAll('img[src], a[href]'))) {
    const attr = el.tagName === 'IMG' ? 'src' : 'href';
    const raw = el.getAttribute(attr);
    if (!raw) continue;
    try {
      el.setAttribute(attr, new URL(raw, baseUrl).href);
    } catch {
      // Genuinely malformed (e.g. "javascript:..." without a resolvable target) — leave as-is.
    }
  }
}

const FENCE_RE = /^(```|~~~)/;
const HEADING_RE = /^(#{1,6})(\s+.*)$/;

/** Remaps whatever heading levels a site actually used so the shallowest one becomes H3 (body
 *  content nests under DocumentsView's own <h2> title) and deeper levels compress with no gaps.
 *  Skips lines inside fenced code blocks so a code comment starting with "#" is never touched. */
function normalizeHeadings(markdown: string): string {
  const lines = markdown.split('\n');
  const levelsUsed = new Set<number>();
  let inFence = false;

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING_RE.exec(line);
    if (match) levelsUsed.add(match[1]!.length);
  }
  if (levelsUsed.size === 0) return markdown;

  const sorted = Array.from(levelsUsed).sort((a, b) => a - b);
  const remap = new Map<number, number>(sorted.map((level, i) => [level, Math.min(i + 3, 6)]));

  inFence = false;
  return lines
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const match = HEADING_RE.exec(line);
      if (!match) return line;
      const newLevel = remap.get(match[1]!.length)!;
      return '#'.repeat(newLevel) + match[2];
    })
    .join('\n');
}

export function htmlToMarkdown(html: string, url: string): ClippedDocument {
  const { document } = parseHTML(html);
  const dom = document as unknown as Document;

  const metadata = extractMetadata(dom);
  resolveRelativeUrls(dom, url);

  const reader = new Readability(dom, { charThreshold: 200 });
  const article = reader.parse();
  if (!article?.content) {
    throw new Error(`htmlToMarkdown: Readability found no extractable article content at ${url}`);
  }

  return {
    title: article.title?.trim() || url,
    markdown: normalizeHeadings(turndown.turndown(article.content)),
    excerpt: article.excerpt ?? '',
    siteName: metadata.siteName ?? article.siteName ?? null,
    author: metadata.author ?? article.byline ?? null,
    publishedAt: metadata.publishedAt ?? toIsoDateOrNull(article.publishedTime),
  };
}
