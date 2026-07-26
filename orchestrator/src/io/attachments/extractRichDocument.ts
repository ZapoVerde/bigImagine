/**
 * @file orchestrator/src/io/attachments/extractRichDocument.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — docx/odt/rtf/doc bytes to Markdown
 * @description
 * Sends the raw bytes to doc-sandbox for conversion to HTML (a real headless-LibreOffice export,
 * not a guess), then runs the result through the same Turndown + heading-normalization pass
 * plugins/documents' web-clipper uses (@bigbrain/orchestrator's own util/htmlToMarkdown.ts) — one
 * shared conversion convention for every HTML-sourced Markdown in bigBrain, not a second,
 * drifting copy.
 *
 * @api-declaration
 * extractRichDocument(bytes, extension) — extension without the leading dot
 *
 * @contract
 *   assertions:
 *     purity:          impure (network IO via docSandboxClient)
 *     state_ownership: []
 *     external_io:     [the doc-sandbox HTTP service]
 */

import { convertOfficeDocument } from './docSandboxClient.js';
import { convertHtmlToMarkdown } from '../../util/htmlToMarkdown.js';

export async function extractRichDocument(bytes: Buffer, extension: string): Promise<string> {
  const html = await convertOfficeDocument(bytes, extension);
  return convertHtmlToMarkdown(html);
}
