/**
 * @file orchestrator/src/server/handleUploadAttachment.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — parses a multipart file upload and runs it through extraction
 * @description
 * The business logic behind POST /v1/attachments/extract, split out from httpServer.ts the same
 * way toolInvoke.ts's invokeTool is: this module never touches the raw ServerResponse or
 * calls authenticate() itself (both stay private to httpServer.ts, per its own convention) — it
 * takes the already-authenticated request, does the actual work, and returns a plain {status,
 * body} pair for httpServer.ts's own thin route handler to send, same shape invokeTool returns.
 *
 * Multipart parsing is Busboy rather than a hand-rolled parser: this is the first request body in
 * bigBrain shaped and sized by whatever a household member (or a malicious client) chooses to
 * attach, and the wire format itself (multipart boundaries) is exactly the kind of thing worth a
 * maintained library rather than bigBrain's usual "no framework" stance — that stance has always
 * been about HTTP routing, not reimplementing a binary format parser. Busboy's own
 * `limits.fileSize` enforces the size ceiling by aborting the stream mid-parse, so an oversized
 * upload never fully buffers into memory in the first place — readJsonBody's "buffer everything,
 * check after" shape would be the wrong model for a file upload specifically.
 *
 * @api-declaration
 * extractAttachmentUpload(req) — parses the multipart body, dispatches to extractAttachmentText,
 *   and returns {status, body} ready for httpServer.ts to send as the HTTP response
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads the request stream)
 *     state_ownership: []
 *     external_io:     [inbound HTTP body]
 */

import type { IncomingMessage } from 'node:http';
import Busboy from 'busboy';
import { extractAttachmentText } from '../io/attachments/dispatchExtraction.js';
import { log } from '../io/logger.js';

// Generous for anything in the plain text/code/data track, and for the rich-document/PDF tracks
// too — a household-scale docx/PDF is comfortably under this.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

interface ParsedUpload {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

class UploadTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`uploaded file exceeded ${maxBytes} bytes`);
  }
}

function parseMultipartUpload(req: IncomingMessage): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof Busboy>;
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    } catch (err) {
      reject(err);
      return;
    }

    let found: { filename: string; mimeType: string } | undefined;
    let sizeLimitHit = false;
    const chunks: Buffer[] = [];

    bb.on('file', (_fieldName, stream, info) => {
      found = { filename: info.filename, mimeType: info.mimeType };
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => {
        sizeLimitHit = true;
      });
    });
    bb.on('error', reject);
    bb.on('finish', () => {
      if (sizeLimitHit) {
        reject(new UploadTooLargeError(MAX_UPLOAD_BYTES));
        return;
      }
      if (!found) {
        reject(new Error('multipart body carried no file field'));
        return;
      }
      resolve({ filename: found.filename, mimeType: found.mimeType, bytes: Buffer.concat(chunks) });
    });

    req.pipe(bb);
  });
}

export async function extractAttachmentUpload(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
  let upload: ParsedUpload;
  try {
    upload = await parseMultipartUpload(req);
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      return {
        status: 413,
        body: { error: `file exceeds the ${Math.floor(err.maxBytes / (1024 * 1024))}MB upload limit` },
      };
    }
    log.error('failed to parse multipart attachment upload', err);
    return { status: 400, body: { error: 'expected a multipart/form-data body with a single file field' } };
  }

  const result = await extractAttachmentText({
    filename: upload.filename,
    mimeType: upload.mimeType,
    bytes: upload.bytes,
  });

  if (result.status === 'unsupported') {
    return { status: 422, body: { error: result.reason } };
  }

  log.info('extracted chat attachment', {
    filename: upload.filename,
    mimeType: upload.mimeType,
    bytesIn: upload.bytes.length,
    charsOut: result.meta.totalChars,
    truncated: result.truncated,
  });

  return {
    status: 200,
    body: {
      filename: upload.filename,
      mimeType: upload.mimeType,
      markdown: result.markdown,
      truncated: result.truncated,
      meta: result.meta,
    },
  };
}
