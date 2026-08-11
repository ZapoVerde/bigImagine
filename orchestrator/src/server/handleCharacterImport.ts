/**
 * @file orchestrator/src/server/handleCharacterImport.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — parses an uploaded card file and imports it as a character
 * @description
 * The business logic behind POST /v1/characters/import — same split as
 * handleUploadAttachment.ts's extractAttachmentUpload: parses the already-authenticated request
 * body and returns a plain {status, body} pair for httpServer.ts's own thin route handler to send.
 * Busboy for the same reason handleUploadAttachment.ts uses it (a maintained multipart parser, not
 * a hand-rolled one) — the size ceiling is lower here (10MB) since a card is a PNG image plus a
 * small embedded JSON blob, not an arbitrary document upload.
 *
 * Only the multipart parsing happens here — PNG chunk decoding, card JSON parsing, and the
 * characters table write all happen inside plugins/characters' import_character_card tool
 * (invoked via toolInvoke.ts's invokeTool), since orchestrator never depends on a plugin package
 * (plugins depend on @bigbrain/orchestrator, never the reverse — pluginLoader.ts's own preamble).
 *
 * @api-declaration
 * importCharacterCard(req, deps, userId) — parses the multipart body and imports it via
 *   import_character_card, returning {status, body} ready for httpServer.ts to send
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads the request stream, Postgres IO via invokeTool)
 *     state_ownership: []
 *     external_io:     [inbound HTTP body, Postgres, filesystem (via the invoked tool)]
 */

import type { IncomingMessage } from 'node:http';
import Busboy from 'busboy';
import { log } from '../io/logger.js';
import type { PostgresClient } from '../io/postgres.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import type { ToolRegistry } from '../orchestrator/toolRegistry.js';
import { invokeTool } from './toolInvoke.js';

// A card is a PNG image plus a small embedded JSON blob — generous but well under
// handleUploadAttachment.ts's 20MB document ceiling.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface ParsedUpload {
  filename: string;
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

    let found: { filename: string } | undefined;
    let sizeLimitHit = false;
    const chunks: Buffer[] = [];

    bb.on('file', (_fieldName, stream, info) => {
      found = { filename: info.filename };
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
      resolve({ filename: found.filename, bytes: Buffer.concat(chunks) });
    });

    req.pipe(bb);
  });
}

export async function importCharacterCard(
  req: IncomingMessage,
  deps: { db: PostgresClient; tools: ToolRegistry; embeddings: EmbeddingProvider },
  userId: string,
): Promise<{ status: number; body: unknown }> {
  let upload: ParsedUpload;
  try {
    upload = await parseMultipartUpload(req);
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      return {
        status: 413,
        body: { error: `card file exceeds the ${Math.floor(err.maxBytes / (1024 * 1024))}MB upload limit` },
      };
    }
    log.error('failed to parse multipart character card upload', err);
    return { status: 400, body: { error: 'expected a multipart/form-data body with a single file field' } };
  }

  return invokeTool(deps.db, deps.tools, deps.embeddings, userId, 'import_character_card', {
    filename: upload.filename,
    fileBase64: upload.bytes.toString('base64'),
  });
}
