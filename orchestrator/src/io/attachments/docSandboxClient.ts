/**
 * @file orchestrator/src/io/attachments/docSandboxClient.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — calls the doc-sandbox conversion service
 * @description
 * doc-sandbox/ (repo root) is a separate, internal-only container that isolates untrusted-file
 * parsing (headless LibreOffice, poppler, Tesseract) from the main orchestrator process — see
 * docker-compose.yml's own comment on that service for the full reasoning. This client is a plain
 * fetch() to BIGBRAIN_DOC_SANDBOX_URL, deliberately not run through io/httpRetry.ts's
 * fetchWithRetry: a stuck or slow conversion isn't a transient network blip worth silently
 * retrying, and doc-sandbox's own execFile timeouts already bound how long any one attempt can
 * take — a single try with a generous client-side timeout and an honest, logged failure is the
 * right default here.
 *
 * @api-declaration
 * convertOfficeDocument(bytes, extension) — extension without the leading dot; resolves to HTML
 * ocrScannedPdf(bytes) — resolves to plain text
 *
 * @contract
 *   assertions:
 *     purity:          impure (network IO)
 *     state_ownership: []
 *     external_io:     [the doc-sandbox HTTP service]
 */

import { log } from '../logger.js';

const REQUEST_TIMEOUT_MS = 90_000;

function sandboxBaseUrl(): string {
  const url = process.env.BIGBRAIN_DOC_SANDBOX_URL;
  if (!url) {
    throw new Error('BIGBRAIN_DOC_SANDBOX_URL is not configured — the doc-sandbox service is required for this file type');
  }
  return url;
}

async function postBytes(path: string, bytes: Buffer): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${sandboxBaseUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`doc-sandbox ${path} returned ${res.status}: ${body}`);
    }
    return res.text();
  } finally {
    clearTimeout(timeout);
  }
}

export async function convertOfficeDocument(bytes: Buffer, extension: string): Promise<string> {
  try {
    return await postBytes(`/convert-office?ext=${encodeURIComponent(extension)}`, bytes);
  } catch (err) {
    log.error('doc-sandbox office conversion failed', err);
    throw err;
  }
}

export async function ocrScannedPdf(bytes: Buffer): Promise<string> {
  try {
    return await postBytes('/ocr-pdf', bytes);
  } catch (err) {
    log.error('doc-sandbox OCR failed', err);
    throw err;
  }
}
