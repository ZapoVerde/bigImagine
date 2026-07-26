/**
 * @file orchestrator/src/io/attachments/dispatchExtraction.ts
 * @stamp 2026-07-26
 * @architectural-role Orchestrator — routes a staged file to its extractor by extension
 * @description
 * The one place bigBrain decides how an uploaded file becomes chat-turn Markdown. Only the plain
 * text/code/data track (extractPlainText.ts) is wired in yet; rich documents (docx/odt/rtf) and
 * PDFs route to an honest "not yet" rather than being silently mis-decoded as garbage text — the
 * `needs-ocr` status exists from the start so a later sandboxed-conversion stage can be wired in
 * here without any of this module's callers changing at all.
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
 *     purity:          impure (declared as such because later stages' extractors will do real IO;
 *                      today's only wired branch is pure)
 *     state_ownership: []
 *     external_io:     []
 */

import { extractPlainText } from './extractPlainText.js';
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
const RICH_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.odt', '.rtf']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif', '.svg']);

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx).toLowerCase();
}

export async function extractAttachmentText(file: AttachmentFile): Promise<ExtractionResult> {
  const extension = extensionOf(file.filename);

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
  const { text, truncated, meta } = truncateForContext(content, DEFAULT_ATTACHMENT_CHAR_CAP);
  const isProse = languageTag === '' || languageTag === 'markdown';
  const markdown = isProse ? text : `\`\`\`${languageTag}\n${text}\n\`\`\``;
  return { status: 'ok', markdown, truncated, meta };
}
