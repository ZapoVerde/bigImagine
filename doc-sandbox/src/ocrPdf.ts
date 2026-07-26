/**
 * @file doc-sandbox/src/ocrPdf.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — OCRs a scanned/image-only PDF to plain text
 * @description
 * Two real binaries, chained: `pdftoppm` (poppler-utils) rasterizes each page to a PNG, then
 * `tesseract` OCRs each page image to text. Both shelled out via execFile with argv arrays, same
 * discipline as convertOffice.ts. Page count is capped (MAX_PAGES) — a household scan/letter is
 * rarely more than a handful of pages, and this bounds how much CPU time a single malicious or
 * pathologically large PDF can consume in this container, independent of the per-binary timeout.
 *
 * pdftoppm zero-pads page numbers in its output filenames to a consistent width for the whole
 * batch (e.g. "page-01.png".."page-12.png" once there are more than 9 pages) — a plain
 * lexicographic sort of the produced filenames is therefore already page-order-correct within one
 * invocation; no natural-sort logic needed.
 *
 * @api-declaration
 * ocrPdfToText(bytes) — the concatenated per-page OCR text, in page order
 *
 * @contract
 *   assertions:
 *     purity:          impure (filesystem, child process)
 *     state_ownership: []
 *     external_io:     [filesystem, the local `pdftoppm`/`tesseract` binaries]
 */

import { execFile } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withTempDir } from './tempWorkspace.js';

const execFileAsync = promisify(execFile);
const RASTERIZE_TIMEOUT_MS = 60_000;
const OCR_TIMEOUT_MS_PER_PAGE = 30_000;
const MAX_PAGES = 20;

export async function ocrPdfToText(bytes: Buffer): Promise<string> {
  return withTempDir(async (dir) => {
    const inputPath = join(dir, 'input.pdf');
    await writeFile(inputPath, bytes);

    await execFileAsync('pdftoppm', ['-png', '-f', '1', '-l', String(MAX_PAGES), inputPath, join(dir, 'page')], {
      timeout: RASTERIZE_TIMEOUT_MS,
    });

    const pages = (await readdir(dir))
      .filter((name) => name.startsWith('page') && name.endsWith('.png'))
      .sort();

    const pageTexts: string[] = [];
    for (const page of pages) {
      const { stdout } = await execFileAsync('tesseract', [join(dir, page), 'stdout'], {
        timeout: OCR_TIMEOUT_MS_PER_PAGE,
        maxBuffer: 10 * 1024 * 1024,
      });
      pageTexts.push(stdout.trim());
    }
    return pageTexts.join('\n\n');
  });
}
