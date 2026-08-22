/**
 * @file orchestrator/src/server/handleCardImport.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — parses Card multipart uploads
 * @api-declaration importCard(req, deps, userId) — invokes import_card and returns HTTP result
 * @contract parses HTTP only; Card persistence belongs to the Cards plugin.
 */

import type { IncomingMessage } from 'node:http';
import Busboy from 'busboy';
import type { PostgresClient } from '../io/postgres.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import type { ToolRegistry } from '../orchestrator/toolRegistry.js';
import { invokeTool } from './toolInvoke.js';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function importCard(req: IncomingMessage, deps: { db: PostgresClient; tools: ToolRegistry; embeddings: EmbeddingProvider }, userId: string): Promise<{ status: number; body: unknown }> {
  try {
    const upload = await new Promise<{ filename: string; bytes: Buffer }>((resolve, reject) => {
      let parser: ReturnType<typeof Busboy>;
      try { parser = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }); } catch (error) { reject(error); return; }
      let filename: string | undefined; let limited = false; const chunks: Buffer[] = [];
      parser.on('file', (_field, stream, info) => { filename = info.filename; stream.on('data', (chunk: Buffer) => chunks.push(chunk)); stream.on('limit', () => { limited = true; }); });
      parser.on('error', reject); parser.on('finish', () => limited ? reject(new Error('upload too large')) : filename ? resolve({ filename, bytes: Buffer.concat(chunks) }) : reject(new Error('no file')));
      req.pipe(parser);
    });
    return invokeTool(deps.db, deps.tools, deps.embeddings, userId, 'import_card', { filename: upload.filename, fileBase64: upload.bytes.toString('base64') });
  } catch (error) {
    return { status: error instanceof Error && error.message === 'upload too large' ? 413 : 400, body: { error: 'expected a multipart/form-data Card upload within the 10MB limit' } };
  }
}
