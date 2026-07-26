/**
 * @file orchestrator/src/util/htmlToMarkdown.ts
 * @stamp 2026-07-26
 * @architectural-role Pure Function — HTML fragment to normalized Markdown
 * @description
 * The Turndown configuration and heading-normalization pass shared by every HTML-to-Markdown
 * conversion in bigBrain. Originally private to plugins/documents/src/htmlToMarkdown.ts's web-
 * clipper pipeline; lifted here so the rich-document track (docx/odt/rtf, converted via a
 * sandboxed headless-LibreOffice step that also emits HTML) can reuse the exact same conversion
 * and heading convention instead of a second, drifting copy. Lives in the orchestrator rather
 * than a plugin so both plugins/documents and the orchestrator's own attachment pipeline can
 * depend on it without one plugin depending on another (plugins/documents' own htmlToMarkdown.ts
 * now delegates its final conversion step to this).
 *
 * normalizeHeadings remaps whatever heading levels the source HTML happened to produce so the
 * shallowest one becomes H3 — nesting under a document's own H2 title, DocumentsView's rendering
 * convention — and compresses deeper levels with no gaps, skipping fenced code blocks so a
 * `#`-prefixed code comment is never touched.
 *
 * `head`/`style`/`script` are explicitly removed before conversion — accepts a full HTML document,
 * not just a body fragment, since the rich-document track hands this LibreOffice's raw HTML export
 * (a complete `<html><head>...</head><body>...</body></html>`) with no Readability-style pass to
 * strip it down first; without this, a document's own `<style>` block's CSS text would leak into
 * the output as loose prose ahead of the real content.
 *
 * @api-declaration
 * convertHtmlToMarkdown(html) — runs Turndown, then normalizeHeadings, on the given HTML fragment
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
// Turndown walks whatever it's given and has no built-in notion of "non-visible" markup — the web
// clipper only avoids this because Readability.parse() already hands it a bare article fragment,
// but the rich-document track (docx/odt/rtf, converted via headless LibreOffice) hands this a full
// <html><head>...</head><body>...</body></html> document, whose <style>/<script>/<title> text
// would otherwise leak into the output as loose prose ahead of the real content.
turndown.remove(['head', 'style', 'script']);

const FENCE_RE = /^(```|~~~)/;
const HEADING_RE = /^(#{1,6})(\s+.*)$/;

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

export function convertHtmlToMarkdown(html: string): string {
  // A full-document input's whitespace-only text nodes around the (now-removed) <head> aren't
  // caught by Turndown's own inline-whitespace collapsing (that logic applies within recognized
  // block elements, not at the raw <html>/<head>/<body> structural boundary) — trimming the final
  // result is the simple, universally-correct cleanup rather than special-casing that boundary.
  return normalizeHeadings(turndown.turndown(html)).trim();
}
