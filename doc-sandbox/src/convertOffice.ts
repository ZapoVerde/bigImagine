/**
 * @file doc-sandbox/src/convertOffice.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — converts a docx/odt/rtf/doc file to HTML via headless LibreOffice
 * @description
 * Shells out to the real `soffice` binary (argv array, never a shell string — matching
 * plugins/documents/src/gitRepo.ts's own execFile discipline) rather than a library, since
 * LibreOffice's own conversion filters are the actual authority on these formats. Each call gets
 * its own `-env:UserInstallation` profile directory: LibreOffice's headless mode locks a shared
 * user profile by default, so concurrent conversions without this clash — one hangs or fails
 * outright waiting on the other's lock. That's a real failure mode the moment two household
 * members upload a document at close to the same time, not a hypothetical one.
 *
 * A hard timeout (execFile's own `timeout` option) is the concrete defense against a pathological
 * input (a corrupt file, a zip-bomb-shaped docx, a deliberate resource-exhaustion attempt): a
 * stuck or slow conversion is killed and reported as a failure rather than left to hang.
 *
 * `--infilter` forces the specific import filter for the claimed format rather than letting
 * soffice auto-detect it from the file's own content — confirmed by hand against real fixtures
 * that without this, soffice silently reinterprets a garbage/corrupted "docx" as a plain-text
 * document and "succeeds" with the raw bytes as body text, instead of failing. With the filter
 * forced, a genuinely corrupt docx/doc/odt correctly makes soffice exit non-zero here. RTF is the
 * one exception: its own format is loose enough (plain text with optional control words) that
 * soffice's RTF filter still accepts arbitrary garbage as a degenerate document even with the
 * filter forced — a known, inherent property of RTF itself (Word has the same reputation), not
 * something forcing the filter can fix.
 *
 * @api-declaration
 * convertOfficeDocumentToHtml(bytes, extension) — extension without the leading dot (e.g. "docx")
 *
 * @contract
 *   assertions:
 *     purity:          impure (filesystem, child process)
 *     state_ownership: []
 *     external_io:     [filesystem, the local `soffice` binary]
 */

import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withTempDir } from './tempWorkspace.js';

const execFileAsync = promisify(execFile);
const CONVERT_TIMEOUT_MS = 60_000;

const IMPORT_FILTERS: Record<string, string> = {
  docx: 'MS Word 2007 XML',
  doc: 'MS Word 97',
  odt: 'writer8',
  rtf: 'Rich Text Format',
};

export async function convertOfficeDocumentToHtml(bytes: Buffer, extension: string): Promise<string> {
  const importFilter = IMPORT_FILTERS[extension];
  if (!importFilter) {
    throw new Error(`convertOfficeDocumentToHtml: no known import filter for extension "${extension}"`);
  }

  return withTempDir(async (dir) => {
    const inputPath = join(dir, `input.${extension}`);
    const profileDir = join(dir, 'profile');
    await writeFile(inputPath, bytes);

    await execFileAsync(
      'soffice',
      [
        '--headless',
        '--norestore',
        `-env:UserInstallation=file://${profileDir}`,
        // Must be one `--infilter=Name` token, not two separate argv elements — soffice's CLI
        // parser silently treats a separate `Name` argument as a stray filename and just prints
        // usage instead of erroring, which execFile then (correctly) reports as a failure, but
        // for the wrong reason. Confirmed by hand: the two-argv form fails even on a valid file.
        `--infilter=${importFilter}`,
        '--convert-to',
        'html:HTML',
        '--outdir',
        dir,
        inputPath,
      ],
      { timeout: CONVERT_TIMEOUT_MS },
    );

    const produced = (await readdir(dir)).find((name) => name.endsWith('.html'));
    if (!produced) {
      throw new Error('soffice did not produce an HTML output file');
    }
    return readFile(join(dir, produced), 'utf8');
  });
}
