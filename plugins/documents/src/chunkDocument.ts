/**
 * @file plugins/documents/src/chunkDocument.ts
 * @stamp 2026-07-25
 * @architectural-role Pure Function — splits a document's Markdown into embeddable chunks
 * @description
 * Splits along the document's own heading structure (real headings, since htmlToMarkdown.ts's
 * turndown output preserves them) rather than a fixed-size window — each heading, at any level,
 * starts a new chunk that runs until the next heading. A block still too long for one embedding
 * gets packed further along blank-line paragraph boundaries, greedily, up to CHUNK_CHAR_CAP; no
 * overlap between pieces, since paragraph boundaries already avoid mid-thought cuts. CHUNK_CHAR_CAP
 * is a plain heuristic (~4 chars/token, no tokenizer dependency exists anywhere in this repo) —
 * approximate by design, not a precise token count.
 *
 * Every chunk's content is prefixed with a heading breadcrumb ("{title} > {h1} > {h2}") before
 * returning — the same string gets stored and embedded, so a chunk surfaced by search_documents
 * is self-explanatory without needing the parent document alongside it.
 *
 * @api-declaration
 * chunkDocument(title, markdown) — always returns at least one chunk, even for heading-less text
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

const CHUNK_CHAR_CAP = 3000;

export interface DocumentChunk {
  ordinal: number;
  headingPath: string | null;
  content: string;
}

interface RawBlock {
  headingPath: string | null;
  text: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

function splitIntoBlocks(title: string, markdown: string): RawBlock[] {
  const lines = markdown.split('\n');
  const stack: string[] = [];
  const blocks: RawBlock[] = [];
  let current: string[] = [];

  function flush() {
    const text = current.join('\n').trim();
    if (text) {
      // A clipped article's H1 is almost always the title verbatim (Readability derives both
      // from the same source heading) — drop a stack entry that just repeats the segment before
      // it rather than showing "Title > Title > Section".
      const segments = [title, ...stack].filter(Boolean);
      const path = segments.filter((seg, i) => i === 0 || seg.toLowerCase() !== segments[i - 1]!.toLowerCase());
      blocks.push({ headingPath: stack.length ? path.join(' > ') : title, text });
    }
    current = [];
  }

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      flush();
      const level = match[1]!.length;
      stack.length = level - 1;
      stack[level - 1] = match[2]!.trim();
      current.push(line);
    } else {
      current.push(line);
    }
  }
  flush();

  return blocks.length ? blocks : [{ headingPath: title, text: markdown.trim() }];
}

function packParagraphs(text: string): string[] {
  if (text.length <= CHUNK_CHAR_CAP) return [text];

  const paragraphs = text.split(/\n\s*\n/);
  const pieces: string[] = [];
  let piece = '';
  for (const paragraph of paragraphs) {
    const candidate = piece ? `${piece}\n\n${paragraph}` : paragraph;
    if (candidate.length > CHUNK_CHAR_CAP && piece) {
      pieces.push(piece);
      piece = paragraph;
    } else {
      piece = candidate;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

export function chunkDocument(title: string, markdown: string): DocumentChunk[] {
  const blocks = splitIntoBlocks(title, markdown);
  const chunks: DocumentChunk[] = [];

  for (const block of blocks) {
    for (const piece of packParagraphs(block.text)) {
      const breadcrumb = block.headingPath ?? title;
      chunks.push({
        ordinal: chunks.length,
        headingPath: block.headingPath,
        content: `${breadcrumb}\n\n${piece}`,
      });
    }
  }

  return chunks;
}
