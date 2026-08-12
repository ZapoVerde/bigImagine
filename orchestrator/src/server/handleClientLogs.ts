/**
 * @file orchestrator/src/server/handleClientLogs.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — the client log ingestion endpoint from httpServer.ts
 * @description
 * POST /v1/client-logs, the frontend's batch log upload (io/clientLogSink.ts). Deliberately
 * unauthenticated, same posture as GET /healthz — not /v1/whoami, which does 401 without a
 * valid key. The errors most worth capturing here are exactly the ones that happen before
 * whoami() resolves (a broken unlock flow, a crash during initial mount). authenticate() still
 * runs, best-effort, so a userId gets attached whenever one's already resolvable; abuse surface
 * is bounded by readJsonBody's existing size cap, the entries-per-request cap below, and
 * fileLogBuffer's own on-disk ring cap regardless of how much gets posted.
 *
 * @api-declaration
 * handleClientLogs(req, res, deps) — POST /v1/client-logs { entries: [...] }
 *
 * @contract
 *   assertions:
 *     purity:          impure (writes the client-log ring via recordClientLogBatch)
 *     state_ownership: []
 *     external_io:     [local fileLogBuffer (io/clientLogSink.ts)]
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { recordClientLogBatch, type ClientLogEntry } from '../io/clientLogSink.js';
import { authenticate, JsonBodyTooLargeError, readJsonBody, sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';

const MAX_CLIENT_LOG_ENTRIES = 200;

// Deliberately unauthenticated, same posture as GET /healthz — not /v1/whoami, which does 401
// without a valid key. The errors most worth capturing here are exactly the ones that happen
// before whoami() resolves (a broken unlock flow, a crash during initial mount). authenticate()
// still runs, best-effort, so a userId gets attached whenever one's already resolvable; abuse
// surface is bounded by readJsonBody's existing size cap, the entries-per-request cap below, and
// fileLogBuffer's own on-disk ring cap regardless of how much gets posted.
export async function handleClientLogs(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err instanceof JsonBodyTooLargeError ? 413 : 400, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const entries = (body as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) {
    sendJson(res, 400, { error: 'expected { entries: [...] }' });
    return;
  }
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  const accepted = entries.slice(0, MAX_CLIENT_LOG_ENTRIES) as ClientLogEntry[];
  recordClientLogBatch(accepted, { userId });
  sendJson(res, 202, { accepted: accepted.length });
}
