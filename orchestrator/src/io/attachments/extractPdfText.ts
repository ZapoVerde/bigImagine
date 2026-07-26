/**
 * @file orchestrator/src/io/attachments/extractPdfText.ts
 * @stamp 2026-07-26
 * @architectural-role Pure Function — extracts a PDF's embedded text layer, if it has one
 * @description
 * Uses pdfjs-dist directly (Mozilla's own PDF.js) rather than one of the thin wrapper packages on
 * npm — this parses attacker-controlled binary input by design, and a from-scratch, single-
 * maintainer rewrap of pdf.js (e.g. pdf-parse@2.x, whose only real dependency IS pdfjs-dist plus
 * an unrelated native canvas addon) is a worse trust surface than the real engine itself for no
 * real benefit. The `legacy` build is the one pdf.js ships specifically for non-browser
 * environments with no DOM/Worker global; it falls back to an in-process "fake worker"
 * automatically when no real Worker exists, which is exactly the Node case here.
 * `standardFontDataUrl` points at pdf.js's own bundled standard-font metrics so a PDF using one of
 * the 14 standard fonts (Helvetica, Times, etc.) without embedding it still extracts real
 * character mappings instead of warning and guessing.
 *
 * Only handles a PDF with a real text layer (one exported from Word, Google Docs, a webpage,
 * etc.) — a scanned/image-only PDF has no text to extract at all, which pdf.js simply returns as
 * empty output rather than an error. hasTextLayer is a plain length heuristic on that output:
 * distinguishing "genuinely empty" from "a few incidental characters pdf.js picked up off a
 * scanned page's embedded metadata" isn't worth a smarter model here — dispatchExtraction.ts
 * treats anything below the floor as needing OCR (a later stage), so a false negative just means
 * the OCR path runs on a page that had a little text either way, not a lost document.
 *
 * A malformed/corrupted PDF makes getDocument's promise reject — that's a real failure, not a
 * "no text layer" case, so this lets it throw rather than swallowing it; dispatchExtraction.ts
 * catches it and reports an honest "couldn't be read" rather than a false needs-ocr.
 *
 * @api-declaration
 * extractPdfText(bytes) — { hasTextLayer, text }; rejects if the PDF can't be parsed at all
 *
 * @contract
 *   assertions:
 *     purity:          pure (CPU-bound parsing only; the only "read" is pdf.js's own bundled,
 *                      invariant standard-font metrics, never anything caller-supplied)
 *     state_ownership: []
 *     external_io:     []
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const STANDARD_FONT_DATA_URL = `${join(
  dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json'))),
  'standard_fonts',
)}/`;

// Below this many non-whitespace characters across the whole document, treat it as having no
// meaningful text layer.
const MIN_MEANINGFUL_CHARS = 20;

export interface PdfTextExtraction {
  hasTextLayer: boolean;
  text: string;
}

export async function extractPdfText(bytes: Buffer): Promise<PdfTextExtraction> {
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });

  try {
    const doc = await loadingTask.promise;
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
    }

    const text = pageTexts.join('\n\n').trim();
    const meaningfulChars = text.replace(/\s/g, '').length;
    return { hasTextLayer: meaningfulChars >= MIN_MEANINGFUL_CHARS, text };
  } finally {
    // Destroys the loading task itself — PDFDocumentProxy (the resolved `doc`) has no destroy()
    // of its own; this is what actually releases pdf.js's internal worker/transport state.
    await loadingTask.destroy();
  }
}
