/**
 * @file doc-sandbox/src/server.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — the doc-sandbox HTTP surface
 * @description
 * A tiny, internal-only HTTP server (raw Node http, no framework, matching bigBrain's own
 * orchestrator/src/server/httpServer.ts convention) reachable only from the orchestrator over the
 * compose-internal network — no auth, no public port, no Cloudflare Access in front of it; the
 * whole point of this container is isolating untrusted-file parsing, not a second surface to
 * secure. Three routes:
 *   POST /convert-office?ext=<docx|odt|rtf|doc> — raw file bytes in, HTML out
 *   POST /ocr-pdf — raw PDF bytes in, plain text out
 *   GET /healthz
 *
 * @api-declaration
 * startServer(port) — binds and listens, returns the underlying http.Server
 *
 * @contract
 *   assertions:
 *     purity:          impure (opens a listening socket)
 *     state_ownership: [the http.Server instance it creates]
 *     external_io:     [inbound HTTP]
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { convertOfficeDocumentToHtml } from './convertOffice.js';
import { ocrPdfToText } from './ocrPdf.js';

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const ALLOWED_OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'odt', 'rtf']);

class BodyTooLargeError extends Error {}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      throw new BodyTooLargeError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBodyOrRespond(req: IncomingMessage, res: ServerResponse): Promise<Buffer | undefined> {
  try {
    return await readRawBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: 'request body too large' });
      return undefined;
    }
    throw err;
  }
}

async function handleConvertOffice(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const ext = url.searchParams.get('ext') ?? '';
  if (!ALLOWED_OFFICE_EXTENSIONS.has(ext)) {
    sendJson(res, 400, { error: `expected ?ext= one of ${[...ALLOWED_OFFICE_EXTENSIONS].join(', ')}` });
    return;
  }
  const bytes = await readBodyOrRespond(req, res);
  if (!bytes) return;

  try {
    const html = await convertOfficeDocumentToHtml(bytes, ext);
    sendText(res, 200, 'text/html; charset=utf-8', html);
  } catch (err) {
    console.error('convert-office failed', err);
    sendJson(res, 422, { error: 'conversion failed — the file may be corrupted or password-protected' });
  }
}

async function handleOcrPdf(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bytes = await readBodyOrRespond(req, res);
  if (!bytes) return;

  try {
    const text = await ocrPdfToText(bytes);
    sendText(res, 200, 'text/plain; charset=utf-8', text);
  } catch (err) {
    console.error('ocr-pdf failed', err);
    sendJson(res, 422, { error: 'OCR failed — the file may be corrupted' });
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '', 'http://placeholder');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/convert-office') {
    await handleConvertOffice(req, res, url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/ocr-pdf') {
    await handleOcrPdf(req, res);
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

export function startServer(port: number): Server {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('unhandled error in doc-sandbox HTTP handler', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });
  server.listen(port, () => {
    console.log(`doc-sandbox HTTP server listening on :${port}`);
  });
  return server;
}
