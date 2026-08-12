/**
 * @file orchestrator/src/server/handleFolders.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — the /v1/folders CRUD surface from httpServer.ts
 * @description
 * The Chat tab's folder tree (io/chatSessions.ts): GET/POST /v1/folders and
 * POST/DELETE /v1/folders/:id. The dispatcher resolves the userId first (household-key/Access
 * gate, same as /v1/chats) and passes it in — this module never authenticates on its own.
 *
 * @api-declaration
 * handleFolderRoutes(req, res, deps, userId, url)
 *   — GET/POST /v1/folders, POST/DELETE /v1/folders/:id
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads/writes folders via deps.chats)
 *     state_ownership: []
 *     external_io:     [Postgres (via deps.chats)]
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';

export async function handleFolderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  userId: string,
  url: URL,
): Promise<void> {
  const rest = url.pathname.slice('/v1/folders'.length); // '' | '/<id>'

  if (rest === '' || rest === '/') {
    if (req.method === 'GET') {
      sendJson(res, 200, { folders: await deps.chats.listFolders(userId) });
      return;
    }
    if (req.method === 'POST') {
      const body = (await readJsonBody(req)) as { name?: string; parent_id?: string };
      if (typeof body.name !== 'string' || !body.name.trim()) {
        sendJson(res, 400, { error: 'expected { name: non-empty string, parent_id? }' });
        return;
      }
      const folder = await deps.chats.createFolder(userId, {
        name: body.name.trim(),
        parentId: typeof body.parent_id === 'string' ? body.parent_id : undefined,
      });
      sendJson(res, 201, folder);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const folderId = decodeURIComponent(rest.slice(1));
  if (req.method === 'POST') {
    const body = (await readJsonBody(req)) as { name?: string; parent_id?: string | null };
    const updated = await deps.chats.updateFolder(userId, folderId, {
      name: typeof body.name === 'string' ? body.name : undefined,
      parentId: body.parent_id !== undefined ? body.parent_id : undefined,
    });
    if (!updated) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, updated);
    return;
  }
  if (req.method === 'DELETE') {
    const deleted = await deps.chats.deleteFolder(userId, folderId);
    sendJson(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: 'not found' });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}
