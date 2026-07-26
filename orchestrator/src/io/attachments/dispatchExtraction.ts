/**
 * @file orchestrator/src/io/attachments/dispatchExtraction.ts
 * @stamp 2026-07-26
 * @architectural-role Orchestrator — routes a staged file to its extractor by extension
 * @description
 * The one place bigBrain decides how an uploaded file becomes chat-turn Markdown. Plain text/
 * code/data (extractPlainText.ts), PDFs with a real text layer (extractPdfText.ts), scanned/
 * image-only PDFs (OCR via doc-sandbox), and rich documents — docx/odt/rtf/doc, converted via
 * doc-sandbox's headless-LibreOffice step (extractRichDocument.ts) — are all wired in. Only
 * images remain out of scope, on principle rather than as a gap: bb_principles.md §2 puts
 * interpreting an image's actual content on the LLM alone, not a deterministic preprocessing
 * step, so that track waits on real vision support in the provider adapters instead of a
 * substitute here.
 *
 * A doc-sandbox call failing (the service unreachable, a corrupted/password-protected file, a
 * conversion timeout) is reported as `unsupported` with an honest reason — never silently
 * downgraded to empty text and never left to throw past this function, matching this module's own
 * contract that extractAttachmentText never throws.
 *
 * Fencing is conditional on language tag, not automatic: a real code/data file (a real
 * languageTag from extractPlainText.ts) is wrapped in a fenced block, since that's the right
 * rendering everywhere it ends up — the chat turn, a promoted Note, or a promoted Document (which
 * already expects fenced code, per plugins/documents' own Turndown output). Plain text, Markdown,
 * PDF text, and converted rich documents are all attached completely unfenced, because their
 * content already *is* prose/document body: fencing a Markdown or converted docx's own headings
 * would turn them into inert literal text the instant it's promoted to a Document (rendered via
 * ReactMarkdown, same as any other saved document) — the exact bug this comment is here to
 * prevent regressing.
 *
 * @api-declaration
 * AttachmentFile, ExtractionResult
 * extractAttachmentText(file) — never throws; unsupported is a result, not an exception
 *
 * @contract
 *   assertions:
 *     purity:          impure (network IO via docSandboxClient for the rich-document/OCR
 *                      branches; the plain-text/PDF-text-layer branches are pure)
 *     state_ownership: []
 *     external_io:     [the doc-sandbox HTTP service]
 */

import { extractPdfText } from './extractPdfText.js';
import { extractPlainText } from './extractPlainText.js';
import { extractRichDocument } from './extractRichDocument.js';
import { ocrScannedPdf } from './docSandboxClient.js';
import { log } from '../logger.js';
import { truncateForContext, DEFAULT_ATTACHMENT_CHAR_CAP, type TruncationMeta } from '../../util/truncateForContext.js';

export interface AttachmentFile {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export type ExtractionResult =
  | { status: 'ok'; markdown: string; truncated: boolean; meta: TruncationMeta }
  | { status: 'unsupported'; reason: string };

const RICH_DOCUMENT_EXTENSIONS = new Set(['.doc', '.docx', '.odt', '.rtf']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif', '.svg']);

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx).toLowerCase();
}

function capAndReturn(content: string, isProse: boolean, languageTag: string): ExtractionResult {
  const { text, truncated, meta } = truncateForContext(content, DEFAULT_ATTACHMENT_CHAR_CAP);
  const markdown = isProse ? text : `\`\`\`${languageTag}\n${text}\n\`\`\``;
  return { status: 'ok', markdown, truncated, meta };
}

export async function extractAttachmentText(file: AttachmentFile): Promise<ExtractionResult> {
  const extension = extensionOf(file.filename);

  if (extension === '.pdf') {
    let extraction;
    try {
      extraction = await extractPdfText(file.bytes);
    } catch (err) {
      log.error('failed to parse a PDF attachment', err);
      return { status: 'unsupported', reason: "this PDF couldn't be read — it may be corrupted or password-protected" };
    }
    if (extraction.hasTextLayer) {
      // Extracted PDF text is prose, like a plain-text/Markdown file — never fenced.
      return capAndReturn(extraction.text, true, '');
    }
    try {
      const ocrText = await ocrScannedPdf(file.bytes);
      return capAndReturn(ocrText, true, '');
    } catch {
      return {
        status: 'unsupported',
        reason: "this PDF has no text layer and couldn't be OCR'd — the conversion service may be unavailable",
      };
    }
  }

  if (RICH_DOCUMENT_EXTENSIONS.has(extension)) {
    try {
      const markdown = await extractRichDocument(file.bytes, extension.slice(1));
      return capAndReturn(markdown, true, '');
    } catch {
      return {
        status: 'unsupported',
        reason: `this ${extension} file couldn't be converted — it may be corrupted, password-protected, or the conversion service may be unavailable`,
      };
    }
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return {
      status: 'unsupported',
      reason: "images aren't processed by file upload — vision support for photos is a separate, not-yet-built feature",
    };
  }

  const { content, languageTag } = extractPlainText(file.filename, file.bytes);
  const isProse = languageTag === '' || languageTag === 'markdown';
  return capAndReturn(content, isProse, languageTag);
}
