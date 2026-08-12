/**
 * @file orchestrator/src/server/handleAdminLorebooks.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — the Lorebooks admin CRUD surface from httpServer.ts
 * @description
 * The /v1/admin/lorebooks and /v1/admin/lorebook-entries route family
 * (docs/lorebook-plan.md §8a) — the Lorebooks page's library list + entry editor. Books/entries
 * are user-scoped RLS tables, so every write body carries the owning user_id (from the list
 * response); the admin key grants the cross-user read, and each write runs under that user's
 * scope. One dispatcher function routes both path prefixes by segment, mirroring the other
 * admin route modules (docs/plans/completed/httpserver-breakdown-plan.md step 2). The dispatcher in
 * httpServer.ts applies the admin gate before this handler runs.
 *
 * @api-declaration
 * handleAdminLorebookRoutes(req, res, deps, url)
 *   — GET/POST /v1/admin/lorebooks, POST /v1/admin/lorebooks/import
 *   — PATCH/DELETE /v1/admin/lorebooks/:id, GET /v1/admin/lorebooks/:id/export?userId=
 *   — POST /v1/admin/lorebook-entries, PATCH/DELETE /v1/admin/lorebook-entries/:id
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads/writes Postgres; entry create/update embed via deps.embeddings)
 *     state_ownership: []
 *     external_io:     [Postgres (via deps.db), EmbeddingProvider (via deps.embeddings)]
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createLorebookAdmin,
  createLorebookEntryAdmin,
  deleteLorebookAdmin,
  deleteLorebookEntryAdmin,
  exportLorebookWorldInfo,
  getLorebooksAdmin,
  importLorebookWorldInfo,
  updateLorebookAdmin,
  updateLorebookEntryAdmin,
  type LorebookEntryInput,
  type LorebookEntryPatch,
} from './adminServer.js';
import { readJsonBody, sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';

// docs/lorebook-plan.md §8a — the Lorebooks page's library list + entry editor. Books/entries are
// user-scoped RLS tables, so every write body carries the owning user_id (from the list response);
// the admin key grants the cross-user read, and each write runs under that user's scope.
export async function handleAdminLorebookRoutes(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps, url: URL): Promise<void> {
  const segments = url.pathname.split('/').filter(Boolean); // ['v1','admin','lorebooks', ...]
  const intField = (v: unknown, min = 0, max = Infinity) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;

  if (segments[2] === 'lorebooks') {
    const rest = segments.slice(3);
    if (rest.length === 0 && req.method === 'GET') {
      sendJson(res, 200, { lorebooks: await getLorebooksAdmin(deps.db) });
      return;
    }
    if (rest.length === 0 && req.method === 'POST') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const body = raw as Record<string, unknown> | null;
      if (!body || typeof body.user_id !== 'string' || !body.user_id || typeof body.name !== 'string' || !body.name.trim()) {
        sendJson(res, 400, { error: 'expected { user_id: string, name: non-empty string }' });
        return;
      }
      const created = await createLorebookAdmin(deps.db, body.user_id, body.name.trim());
      if (!created) {
        sendJson(res, 404, { error: 'user not found' });
        return;
      }
      sendJson(res, 201, created);
      return;
    }
    // Import (step 7): POST /v1/admin/lorebooks/import with an ST world-info export
    // `{ user_id, world_info: { name, entries: { [uid]: entryObject } } }` — parses into a new
    // book with source_json capturing each entryObject verbatim (0051's format).
    if (rest.length === 1 && rest[0] === 'import' && req.method === 'POST') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const body = raw as { user_id?: unknown; world_info?: unknown } | null;
      const wi = body?.world_info;
      if (!body || typeof body.user_id !== 'string' || !body.user_id || typeof wi !== 'object' || wi === null || Array.isArray(wi)) {
        sendJson(res, 400, { error: 'expected { user_id: string, world_info: { name, entries } }' });
        return;
      }
      const worldInfo = wi as { name?: unknown; entries?: unknown };
      if (typeof worldInfo.name !== 'string' || !worldInfo.name.trim() || worldInfo.entries === undefined) {
        sendJson(res, 400, { error: 'world_info must have a non-empty name and an entries object' });
        return;
      }
      const result = await importLorebookWorldInfo(deps.db, deps.embeddings, body.user_id, worldInfo.name, worldInfo.entries);
      if (!result) {
        sendJson(res, 400, { error: 'import failed — unknown user, blank name, or malformed entries (uid keys must be non-negative integers, values must be objects)' });
        return;
      }
      sendJson(res, 201, result);
      return;
    }
    if (rest.length === 1 && rest[0] !== 'import') {
      const lorebookId = decodeURIComponent(rest[0]!);
      if (req.method === 'PATCH') {
        let raw: unknown;
        try {
          raw = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: 'expected a JSON request body' });
          return;
        }
        const body = raw as Record<string, unknown> | null;
        if (!body || typeof body.user_id !== 'string' || !body.user_id) {
          sendJson(res, 400, { error: 'expected { user_id: string, ... }' });
          return;
        }
        const patch: { name?: string; globalScope?: boolean; characterIds?: string[] } = {};
        if (body.name !== undefined) {
          if (typeof body.name !== 'string' || !body.name.trim()) {
            sendJson(res, 400, { error: 'name must be a non-empty string' });
            return;
          }
          patch.name = body.name.trim();
        }
        if (body.global_scope !== undefined) {
          if (typeof body.global_scope !== 'boolean') {
            sendJson(res, 400, { error: 'global_scope must be a boolean' });
            return;
          }
          patch.globalScope = body.global_scope;
        }
        if (body.character_ids !== undefined) {
          if (!Array.isArray(body.character_ids) || body.character_ids.some((c) => typeof c !== 'string')) {
            sendJson(res, 400, { error: 'character_ids must be an array of strings' });
            return;
          }
          patch.characterIds = body.character_ids as string[];
        }
        const updated = await updateLorebookAdmin(deps.db, body.user_id, lorebookId, patch);
        if (!updated) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        sendJson(res, 200, { updated: true });
        return;
      }
      if (req.method === 'DELETE') {
        const userId = url.searchParams.get('userId');
        if (!userId) {
          sendJson(res, 400, { error: 'expected ?userId= query param' });
          return;
        }
        const deleted = await deleteLorebookAdmin(deps.db, userId, lorebookId);
        if (!deleted) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        sendJson(res, 200, { deleted: true });
        return;
      }
    }
    // Export (step 7): GET /v1/admin/lorebooks/:id/export?userId= — reverses the import
    // losslessly (§7): `{ name, entries: { [uid]: entryObject } }` with entryObject = the
    // verbatim source_json when the entry was imported, else an ST-shaped reconstruction.
    if (rest.length === 2 && rest[1] === 'export' && req.method === 'GET') {
      const lorebookId = decodeURIComponent(rest[0]!);
      const userId = url.searchParams.get('userId');
      if (!userId) {
        sendJson(res, 400, { error: 'expected ?userId= query param' });
        return;
      }
      const exported = await exportLorebookWorldInfo(deps.db, userId, lorebookId);
      if (!exported) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, exported);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (segments[2] === 'lorebook-entries') {
    const rest = segments.slice(3);
    if (rest.length === 0 && req.method === 'POST') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const body = raw as Record<string, unknown> | null;
      if (!body || typeof body.user_id !== 'string' || !body.user_id || typeof body.lorebook_id !== 'string' || typeof body.content !== 'string') {
        sendJson(res, 400, { error: 'expected { user_id: string, lorebook_id: string, content: string, ... }' });
        return;
      }
      const input: LorebookEntryInput = {
        lorebookId: body.lorebook_id,
        content: body.content,
      };
      if (body.key !== undefined) {
        if (!Array.isArray(body.key) || body.key.some((k) => typeof k !== 'string')) {
          sendJson(res, 400, { error: 'key must be an array of strings' });
          return;
        }
        input.key = body.key as string[];
      }
      if (body.comment !== undefined) {
        if (typeof body.comment !== 'string') {
          sendJson(res, 400, { error: 'comment must be a string' });
          return;
        }
        input.comment = body.comment;
      }
      for (const [name, target] of [
        ['constant', 'constant'],
        ['disable', 'disable'],
        ['use_probability', 'useProbability'],
        ['group_override', 'groupOverride'],
      ] as const) {
        if (body[name] !== undefined) {
          if (typeof body[name] !== 'boolean') {
            sendJson(res, 400, { error: `${name} must be a boolean` });
            return;
          }
          (input as unknown as Record<string, unknown>)[target] = body[name];
        }
      }
      for (const [name, target] of [
        ['order_value', 'orderValue'],
        ['probability', 'probability'],
        ['group_weight', 'groupWeight'],
        ['sticky', 'sticky'],
        ['cooldown', 'cooldown'],
        ['delay', 'delay'],
      ] as const) {
        if (body[name] !== undefined) {
          const v = intField(body[name]);
          if (v === undefined) {
            sendJson(res, 400, { error: `${name} must be a non-negative integer` });
            return;
          }
          (input as unknown as Record<string, unknown>)[target] = v;
        }
      }
      const created = await createLorebookEntryAdmin(deps.db, deps.embeddings, body.user_id, input);
      if (!created) {
        sendJson(res, 404, { error: 'book not found' });
        return;
      }
      sendJson(res, 201, created);
      return;
    }
    if (rest.length === 1) {
      const entryId = decodeURIComponent(rest[0]!);
      if (req.method === 'PATCH') {
        let raw: unknown;
        try {
          raw = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: 'expected a JSON request body' });
          return;
        }
        const body = raw as Record<string, unknown> | null;
        if (!body || typeof body.user_id !== 'string' || !body.user_id) {
          sendJson(res, 400, { error: 'expected { user_id: string, ... }' });
          return;
        }
        const patch: LorebookEntryPatch = {};
        if (body.key !== undefined) {
          if (!Array.isArray(body.key) || body.key.some((k) => typeof k !== 'string')) {
            sendJson(res, 400, { error: 'key must be an array of strings' });
            return;
          }
          patch.key = body.key as string[];
        }
        if (body.comment !== undefined) {
          if (typeof body.comment !== 'string') {
            sendJson(res, 400, { error: 'comment must be a string' });
            return;
          }
          patch.comment = body.comment;
        }
        if (body.content !== undefined) {
          if (typeof body.content !== 'string') {
            sendJson(res, 400, { error: 'content must be a string' });
            return;
          }
          patch.content = body.content;
        }
        for (const [name, target] of [
          ['constant', 'constant'],
          ['disable', 'disable'],
          ['use_probability', 'useProbability'],
          ['group_override', 'groupOverride'],
        ] as const) {
          if (body[name] !== undefined) {
            if (typeof body[name] !== 'boolean') {
              sendJson(res, 400, { error: `${name} must be a boolean` });
              return;
            }
            (patch as unknown as Record<string, unknown>)[target] = body[name];
          }
        }
        for (const [name, target] of [
          ['order_value', 'orderValue'],
          ['probability', 'probability'],
          ['group_weight', 'groupWeight'],
          ['sticky', 'sticky'],
          ['cooldown', 'cooldown'],
          ['delay', 'delay'],
        ] as const) {
          if (body[name] !== undefined) {
            const v = intField(body[name]);
            if (v === undefined) {
              sendJson(res, 400, { error: `${name} must be a non-negative integer` });
              return;
            }
            (patch as unknown as Record<string, unknown>)[target] = v;
          }
        }
        const updated = await updateLorebookEntryAdmin(deps.db, deps.embeddings, body.user_id, entryId, patch);
        if (!updated) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        sendJson(res, 200, { updated: true });
        return;
      }
      if (req.method === 'DELETE') {
        const userId = url.searchParams.get('userId');
        if (!userId) {
          sendJson(res, 400, { error: 'expected ?userId= query param' });
          return;
        }
        const deleted = await deleteLorebookEntryAdmin(deps.db, userId, entryId);
        if (!deleted) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        sendJson(res, 200, { deleted: true });
        return;
      }
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
