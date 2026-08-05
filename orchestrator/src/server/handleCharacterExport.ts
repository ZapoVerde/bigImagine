/**
 * @file orchestrator/src/server/handleCharacterExport.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — streams a character's exported card or avatar as a binary response
 * @description
 * GET /v1/characters/:id/export.png, /export.json, and /avatar — three binary/file responses that
 * don't fit POST /v1/tools/:name's JSON-in-JSON-out shape (same reasoning as
 * /v1/attachments/extract), so they get their own thin routes here. All three delegate the actual
 * work to plugins/characters' export_character_card / get_character_avatar tools via
 * toolInvoke.ts's invokeTool — this file only turns that JSON result into the right
 * content-type/content-disposition headers and raw bytes, same split handleCharacterImport.ts uses
 * for the opposite direction.
 *
 * @api-declaration
 * handleCharacterExportRoutes(req, res, deps, userId, url) — dispatches
 *   /v1/characters/:id/{export.png,export.json,avatar}; writes directly to res since these are
 *   binary/file responses, not JSON httpServer.ts's own sendJson could send
 *
 * @contract
 *   assertions:
 *     purity:          impure (writes the HTTP response, Postgres IO via invokeTool)
 *     state_ownership: []
 *     external_io:     [outbound HTTP response, Postgres, filesystem (via the invoked tool)]
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresClient } from '../io/postgres.js';
import type { ToolRegistry } from '../orchestrator/toolRegistry.js';
import { invokeTool } from './toolInvoke.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export async function handleCharacterExportRoutes(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: { db: PostgresClient; tools: ToolRegistry },
  userId: string,
  url: URL,
): Promise<void> {
  const segments = url.pathname.slice('/v1/characters'.length).split('/').filter(Boolean);
  if (segments.length !== 2) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const characterId = decodeURIComponent(segments[0]!);
  const action = segments[1]!;

  if (action === 'avatar') {
    const result = await invokeTool(deps.db, deps.tools, userId, 'get_character_avatar', { characterId });
    const body = result.body as { found: boolean; mimeType?: string; base64?: string };
    if (result.status !== 200 || !body.found || !body.base64 || !body.mimeType) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const bytes = Buffer.from(body.base64, 'base64');
    res.writeHead(200, { 'content-type': body.mimeType, 'content-length': bytes.length });
    res.end(bytes);
    return;
  }

  if (action === 'export.png' || action === 'export.json') {
    const format = action === 'export.png' ? 'png' : 'json';
    const result = await invokeTool(deps.db, deps.tools, userId, 'export_character_card', { characterId, format });
    const body = result.body as {
      found: boolean;
      filename?: string;
      json?: unknown;
      mimeType?: string;
      base64?: string;
    };
    if (result.status !== 200 || !body.found) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (format === 'json') {
      const payload = JSON.stringify(body.json, null, 2);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${body.filename}"`,
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
      return;
    }
    const bytes = Buffer.from(body.base64!, 'base64');
    res.writeHead(200, {
      'content-type': body.mimeType!,
      'content-disposition': `attachment; filename="${body.filename}"`,
      'content-length': bytes.length,
    });
    res.end(bytes);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
