/**
 * @file orchestrator/src/server/httpUtils.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — shared HTTP plumbing for the orchestrator's server surface
 * @description
 * The generic request/response helpers that used to live at the top of httpServer.ts and are
 * shared by every handler module extracted from it (docs/plans/httpserver-breakdown-plan.md):
 * body reading with the size cap, the two auth paths (Cloudflare Access identity first, then the
 * Bearer API key / static admin key — see httpServer.ts's own preamble for the reasoning),
 * JSON responses, SSE framing, and static-file serving for the built frontend SPA.
 *
 * readJsonBody throws JsonBodyTooLargeError (a real class, not an opaque error) so callers that
 * care — handleClientLogs maps it to 413 — can distinguish the cap from malformed JSON.
 *
 * @api-declaration
 * readJsonBody(req) — drains and JSON-parses a request body ({} when empty)
 * authenticate(req, apiKeys, accessIdentity) — resolves a user_id via Access then Bearer key
 * isAdminAuthorized(req, adminApiKey, accessIdentity) — same precedence, admin gate
 * sendJson(res, status, body) — one JSON response, content-length set
 * writeStreamHeaders(res) / writeStreamErrorTerminalFrame(res, aborted, message) — SSE framing
 * serveStaticFile(res, filePath) — 200 with the right content-type, 404 on read failure
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads request bodies, writes responses, reads the filesystem)
 *     state_ownership: []
 *     external_io:     [inbound HTTP, the frontend dist/ directory]
 */

import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import type { AccessIdentityResolver } from '../io/accessIdentity.js';
import type { ApiKeyStore } from './apiKeyStore.js';

// Uncapped until Stage 5 (images/vision) — a chat-completions body carrying several base64-encoded
// images is the first realistic way this could balloon; everything else here is chat text, which
// never approached a size worth guarding against. Generous enough for MAX_IMAGES_PER_TURN images
// at openai.ts's own MAX_IMAGE_BYTES ceiling, plus normal chat text/attachments Markdown.
const MAX_JSON_BODY_BYTES = 40 * 1024 * 1024;

export class JsonBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`request body exceeded ${maxBytes} bytes`);
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += (chunk as Buffer).length;
    if (totalBytes > MAX_JSON_BODY_BYTES) throw new JsonBodyTooLargeError(MAX_JSON_BODY_BYTES);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export async function authenticate(
  req: IncomingMessage,
  apiKeys: ApiKeyStore,
  accessIdentity: AccessIdentityResolver,
): Promise<string | undefined> {
  const accessJwt = req.headers['cf-access-jwt-assertion'];
  if (typeof accessJwt === 'string') {
    const userId = await accessIdentity.userIdForAccessJwt(accessJwt);
    if (userId) return userId;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return apiKeys.userIdForKey(header.slice('Bearer '.length));
}

// Any household member who already cleared Cloudflare Access to reach this hostname at all is
// trusted for admin actions too — Access is the real gate; a second static secret behind it was
// redundant friction for a single-household deployment. The static BIGBRAIN_ADMIN_API_KEY check
// remains as the only path in for deployments with no Access configured (accessIdentity is then a
// no-op resolver, see io/accessIdentity.ts) and for any non-browser/API automation.
//
// A plain === on the key would leak timing information about how many leading bytes of the
// presented key matched the real one — this key alone can rotate every other credential in the
// system, worth the extra care even though apiKeyStore.ts's per-household-member check doesn't
// bother.
export async function isAdminAuthorized(
  req: IncomingMessage,
  adminApiKey: string,
  accessIdentity: AccessIdentityResolver,
): Promise<boolean> {
  const accessJwt = req.headers['cf-access-jwt-assertion'];
  if (typeof accessJwt === 'string') {
    const userId = await accessIdentity.userIdForAccessJwt(accessJwt);
    if (userId) return true;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(adminApiKey);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// The SSE response headers both streaming routes (handleChatCompletions's RP branch and the
// swipe route's needs_regenerate stream) write — same framing the existing non-RP fake-stream
// branch has always used, so any OpenAI-compatible client parses both identically.
export function writeStreamHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

// The SSE abort/error terminal frame (docs/plans/rp-streaming-plan.md Contracts) — one extra
// data: line before [DONE], usable only once streaming has begun (headers committed, so an HTTP
// status code is no longer an option). Emitted identically by both streaming routes. A success
// completion never emits this: it keeps today's stop-finish chunk + [DONE], so an OpenAI-
// compatible client that has never heard of bigimagine_error simply never sees it.
export function writeStreamErrorTerminalFrame(res: ServerResponse, aborted: boolean, message: string): void {
  res.write(
    `data: ${JSON.stringify({ bigimagine_error: true, aborted, message })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

// Where the built frontend/ SPA lands at Docker build time (Dockerfile: npm run build
// --workspace=@bigbrain/frontend), resolved the same way index.ts resolves pluginsDir.
export const FRONTEND_DIST_DIR = new URL('../../../frontend/dist', import.meta.url).pathname;

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

export async function serveStaticFile(res: ServerResponse, filePath: string): Promise<void> {
  try {
    const content = await readFile(filePath);
    const contentType = STATIC_CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': contentType, 'content-length': content.length });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}
