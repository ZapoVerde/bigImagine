/**
 * @file orchestrator/src/server/handleCleanup.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — the cleanup subloop's HTTP surface from httpServer.ts
 * @description
 * The cleanup feature (orchestrator/cleanupLoop.ts) exposed over HTTP: the user-facing read
 * surface (GET /v1/cleanup/status?chat_id=, GET /v1/cleanup/jobs?chat_id=&limit=, POST
 * /v1/cleanup/run — fire-and-forget, results polled via status/jobs), plus the admin-gated
 * setup surface (GET/POST /v1/admin/cleanup-settings, the four header/footer config keys + the
 * slop-rules table read/written as one block via adminServer.ts's get/parse/set trio). The
 * subloop re-reads both live every tick, so a save takes effect on the next poll — no restart.
 *
 * @api-declaration
 * handleCleanupStatus(req, res, deps)    — GET /v1/cleanup/status?chat_id=
 * handleCleanupJobs(req, res, deps)      — GET /v1/cleanup/jobs?chat_id=&limit=
 * handleCleanupRunNow(req, res, deps)    — POST /v1/cleanup/run { chat_id }
 * handleCleanupSettings{Get,Set}         — GET/POST /v1/admin/cleanup-settings
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads cleanup_jobs/chat_messages; writes orchestrator_settings)
 *     state_ownership: []
 *     external_io:     [Postgres (via deps.db), LLM provider (passed to runCleanupNow)]
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getCleanupJobs, getCleanupStatus, runCleanupNow } from '../orchestrator/cleanupLoop.js';
import { getCleanupSettings, parseSetCleanupSettingsBody, setCleanupSettings } from './adminServer.js';
import { authenticate, readJsonBody, sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';

// The async cleanup subloop's (cleanupLoop.ts) read surface for the chat's floating status pills —
// the per-region (header/body/footer) pill states of the newest eligible message, each
// not-called | in-flux | deployed | flagged (in-stream-cleanup-plan.md), plus how many messages
// are still pending. Polled by the frontend the same way it polls /v1/chat/status; the loop's
// per-message jobs in cleanup_jobs are the source of truth, with the live in-stream path's
// cleanupLiveStatus map overlaid while a turn is actively streaming.
export async function handleCleanupStatus(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  const chatId = new URL(req.url ?? '', 'http://placeholder').searchParams.get('chat_id');
  if (!chatId) {
    sendJson(res, 400, { error: 'expected a ?chat_id= query parameter' });
    return;
  }
  const status = await getCleanupStatus(deps.db, userId, chatId);
  if (!status) {
    sendJson(res, 404, { error: 'unknown chat_id' });
    return;
  }
  sendJson(res, 200, status);
}

// The Cleanup page's run-now: one immediate pass over one chat (the poll tick keeps every other
// enabled chat). Fire-and-forget like fireLocationImageGeneration — the request returns at once
// and the caller polls GET /v1/cleanup/status for the results; the loop is fail-open throughout,
// so there's no partial-success error shape to surface.
export async function handleCleanupRunNow(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  let body: { chat_id?: string };
  try {
    body = (await readJsonBody(req)) as { chat_id?: string };
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  if (typeof body.chat_id !== 'string' || !body.chat_id) {
    sendJson(res, 400, { error: 'expected { chat_id: string }' });
    return;
  }
  void runCleanupNow({ db: deps.db, llm: deps.llm, settings: deps.settings, chats: deps.chats }, userId, body.chat_id);
  sendJson(res, 202, { started: true });
}

// The Cleanup page's "recent activity" read: the newest cleanup_jobs rows for one chat (the page
// picks the chat via a selector), each with a short content preview and the fail-open notes.
// User-scoped by cleanup_jobs' own RLS (via chat_messages.user_id) — a user only ever sees their
// own chats' jobs, same as /v1/cleanup/status.
export async function handleCleanupJobs(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  const url = new URL(req.url ?? '', 'http://placeholder');
  const chatId = url.searchParams.get('chat_id');
  if (!chatId) {
    sendJson(res, 400, { error: 'expected a ?chat_id= query parameter' });
    return;
  }
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 20, 1), 100) : 20;
  sendJson(res, 200, { jobs: await getCleanupJobs(deps.db, userId, chatId, limit) });
}

// Admin-gated counterpart of the cleanup setup surface: the four header/footer config keys +
// the slop-rules table, read/written as one block (adminServer.ts's get/parse/set trio). The
// subloop re-reads both live every tick (cleanupLoop.ts), so a save takes effect on the next
// poll — no restart, same shape as notification/canon settings above.
export async function handleCleanupSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getCleanupSettings(deps.settings, deps.db));
}

export async function handleCleanupSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetCleanupSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, {
      error: 'expected at least one of { header_regex?, header_prompt?, footer_regex?, footer_prompt?, slop_rules?: [...] }',
    });
    return;
  }

  await setCleanupSettings(deps.settings, deps.db, parsed);
  sendJson(res, 200, await getCleanupSettings(deps.settings, deps.db));
}
