/**
 * @file orchestrator/src/io/attachments/dispatchExtraction.ts
 * @stamp 2026-07-26
 * @architectural-role Orchestrator — routes a staged file to its extractor by extension
 * @description
 * The one place bigBrain decides how an uploaded file becomes chat-turn Markdown. Plain text/
 * code/data (extractPlainText.ts) and PDFs with a real text layer (extractPdfText.ts) are wired
 * in; rich documents (docx/odt/rtf) and scanned/image-only PDFs route to an honest "not yet"
 * rather than being silently mis-decoded as garbage text or lost entirely — the `needs-ocr`
 * status exists specifically so a later sandboxed-OCR stage can fill in the scanned-PDF case here
 * without any of this module's callers changing at all.
 *
 * Fencing is conditional on language tag, not automatic: a real code/data file (a real
 * languageTag from extractPlainText.ts) is wrapped in a fenced block, since that's the right
 * rendering everywhere it ends up — the chat turn, a promoted Note, or a promoted Document (which
 * already expects fenced code, per plugins/documents' own Turndown output). Plain text and
 * Markdown files (no tag, or the 'markdown' tag) are attached completely unfenced, because their
 * content already *is* the document body: fencing a Markdown file's own headings would turn them
 * into inert literal text the instant it's promoted to a Document (rendered via ReactMarkdown,
 * same as any other saved document) — the exact bug this comment is here to prevent regressing.
 *
 * @api-declaration
 * AttachmentFile, ExtractionResult
 * extractAttachmentText(file) — never throws; unsupported/needs-ocr are results, not exceptions
 *
 * @contract
 *   assertions:
 *     purity:          impure (declared as such because a later sandboxed-conversion stage will
 *                      call out over the network from here; both branches wired today are pure)
 *     state_ownership: []
 *     external_io:     []
 */

import { extractPdfText } from './extractPdfText.js';
import { extractPlainText } from './extractPlainText.js';
import { log } from '../logger.js';
import { truncateForContext, DEFAULT_ATTACHMENT_CHAR_CAP, type TruncationMeta } from '../../util/truncateForContext.js';

export interface AttachmentFile {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export type ExtractionResult =
  | { status: 'ok'; markdown: string; truncated: boolean; meta: TruncationMeta }
  | { status: 'unsupported'; reason: string }
  | { status: 'needs-ocr' };

// Formats with their own dedicated track, landing in a later implementation stage — routed to an
// explicit "not yet" so an upload never silently turns into mis-decoded garbage text.
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
    if (!extraction.hasTextLayer) {
      return { status: 'needs-ocr' };
    }
    // Extracted PDF text is prose, like a plain-text/Markdown file — never fenced.
    return capAndReturn(extraction.text, true, '');
  }

  if (RICH_DOCUMENT_EXTENSIONS.has(extension)) {
    return { status: 'unsupported', reason: `${extension || 'this file type'} isn't supported yet` };
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
