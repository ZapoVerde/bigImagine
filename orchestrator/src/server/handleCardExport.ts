/**
 * @file orchestrator/src/server/handleCardExport.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — streams Card export and Card media responses
 * @api-declaration handleCardExportRoutes(req, res, deps, userId, url)
 * @contract delegates Card-owned work to Cards tools; no runtime Character route/tool is used.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresClient } from '../io/postgres.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import type { ToolRegistry } from '../orchestrator/toolRegistry.js';
import { invokeTool } from './toolInvoke.js';

function json(res: ServerResponse, status: number, body: unknown): void { const value = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(value) }); res.end(value); }

export async function handleCardExportRoutes(_req: IncomingMessage, res: ServerResponse, deps: { db: PostgresClient; tools: ToolRegistry; embeddings: EmbeddingProvider }, userId: string, url: URL): Promise<void> {
  const parts = url.pathname.slice('/v1/cards'.length).split('/').filter(Boolean);
  if (parts.length !== 2) { json(res, 404, { error: 'not found' }); return; }
  const cardId = decodeURIComponent(parts[0]!); const action = parts[1]!;
  if (action === 'avatar') {
    const result = await invokeTool(deps.db, deps.tools, deps.embeddings, userId, 'get_card_avatar', { cardId }); const body = result.body as { found: boolean; mimeType?: string; base64?: string };
    if (result.status !== 200 || !body.found || !body.base64 || !body.mimeType) { json(res, 404, { error: 'not found' }); return; }
    const bytes = Buffer.from(body.base64, 'base64'); res.writeHead(200, { 'content-type': body.mimeType, 'content-length': bytes.length }); res.end(bytes); return;
  }
  if (action !== 'export.png' && action !== 'export.json') { json(res, 404, { error: 'not found' }); return; }
  const format = action === 'export.png' ? 'png' : 'json'; const result = await invokeTool(deps.db, deps.tools, deps.embeddings, userId, 'export_card', { cardId, format }); const body = result.body as { found: boolean; filename?: string; json?: unknown; mimeType?: string; base64?: string };
  if (result.status !== 200 || !body.found) { json(res, 404, { error: 'not found' }); return; }
  if (format === 'json') { const value = JSON.stringify(body.json, null, 2); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${body.filename}"`, 'content-length': Buffer.byteLength(value) }); res.end(value); return; }
  const bytes = Buffer.from(body.base64!, 'base64'); res.writeHead(200, { 'content-type': body.mimeType!, 'content-disposition': `attachment; filename="${body.filename}"`, 'content-length': bytes.length }); res.end(bytes);
}
