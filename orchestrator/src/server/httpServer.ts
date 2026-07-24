/**
 * @file orchestrator/src/server/httpServer.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — the orchestrator's HTTP surface
 * @description
 * The only "server" bigBrain exposes. Speaks just enough of the OpenAI Chat Completions shape
 * for a client like Open WebUI's "OpenAI API" connection type to treat bigBrain as a model
 * (Phase 4 decision: bigBrain drives, the chat UI only displays). Every request is authenticated
 * via a bearer token resolved through ApiKeyStore to a user_id — that resolved value, never
 * anything the request body says, is what gets passed to runTurn's userId, per
 * bb_principles.md §4.
 *
 * Streaming responses are not real token-level streaming: runTurn resolves the full reply
 * before this module has anything to send, so a stream:true request gets its answer as one SSE
 * chunk followed immediately by the terminator, not a token at a time. Good enough for a chat UI
 * to render correctly; true streaming would need runTurn itself to support it.
 *
 * Also serves a second, additive surface (openApiToolServer.ts): GET /v1/tools/openapi.json and
 * POST /v1/tools/:name let an external OpenAPI-aware caller (Open WebUI's "OpenAPI tool server"
 * connection type) invoke one registered tool directly, bypassing runTurn — the caller's own
 * model already decided which tool and with what arguments, so there's no reasoning left for
 * bigBrain to do. Same Bearer-key auth as /v1/chat/completions; same RLS scoping regardless of
 * which front door a call came through.
 *
 * GET / (landingPage.ts) is the root page at bigbrain.your-domain.example — a title and a hamburger menu
 * linking to Settings, unauthenticated at the app layer same as the admin page below (Cloudflare
 * Access gates the whole hostname; neither page's markup carries a secret).
 *
 * A third, admin-only surface (adminServer.ts/adminPage.ts): GET /v1/admin serves a static
 * credential-rotation page, GET/POST /v1/admin/credentials read/write provider_credentials
 * (io/providerCredentials.ts). Gated by a single static BIGBRAIN_ADMIN_API_KEY, not ApiKeyStore —
 * this isn't user data and there's no admin/regular tier in that map. A successful POST writes
 * the new value then exits the process (triggerRestart) so restart: unless-stopped picks up the
 * new credential at boot — see index.ts's provider-resolution sequence. triggerRestart is
 * injectable specifically so tests can exercise this route without killing the test process.
 *
 * @api-declaration
 * startHttpServer(deps) — binds and listens on deps.port, returns the underlying http.Server
 *
 * @contract
 *   assertions:
 *     purity:          impure (opens a listening socket)
 *     state_ownership: [the http.Server instance it creates]
 *     external_io:     [inbound HTTP]
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { log } from '../io/logger.js';
import { runTurn } from '../orchestrator/loop.js';
import type { LlmMessage, LlmProvider } from '../io/llm/types.js';
import type { PostgresClient } from '../io/postgres.js';
import type { ProviderCredentialStore } from '../io/providerCredentials.js';
import type { ToolRegistry } from '../orchestrator/toolRegistry.js';
import type { ApiKeyStore } from './apiKeyStore.js';
import { listCredentials, parseSetCredentialBody, setCredential } from './adminServer.js';
import { renderAdminPage } from './adminPage.js';
import { renderLandingPage } from './landingPage.js';
import { buildOpenApiSpec, invokeTool } from './openApiToolServer.js';
import {
  buildChatCompletion,
  buildChatCompletionChunk,
  buildModelsList,
  isChatCompletionRequestBody,
} from './openai.js';

export interface HttpServerDeps {
  llm: LlmProvider;
  db: PostgresClient;
  tools: ToolRegistry;
  apiKeys: ApiKeyStore;
  adminApiKey: string;
  credentials: ProviderCredentialStore;
  modelName: string;
  port: number;
  /** Where this server is externally reachable from — used only to fill in the OpenAPI spec's
   *  `servers` entry (openApiToolServer.ts). Defaults to http://localhost:<port> when unset,
   *  which is fine for local verification but wrong for a real deployment behind Docker/Traefik —
   *  set this to the real reachable URL there (see .env.example). */
  publicBaseUrl?: string;
  /** Defaults to a real process.exit(0) — restart: unless-stopped relaunches the container, which
   *  reads the newly-saved credential at boot. Overridable so tests can prove a POST reached this
   *  point without actually killing the test process. */
  triggerRestart?: () => void;
}

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function authenticate(req: IncomingMessage, apiKeys: ApiKeyStore): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return apiKeys.userIdForKey(header.slice('Bearer '.length));
}

// A plain === would leak timing information about how many leading bytes of the presented key
// matched the real one — this key alone can rotate every other credential in the system, worth
// the extra care even though apiKeyStore.ts's per-household-member check doesn't bother.
function isAdminAuthenticated(req: IncomingMessage, adminApiKey: string): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(adminApiKey);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  const { llm, db, tools, apiKeys, modelName } = deps;

  const userId = authenticate(req, apiKeys);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }

  const body = await readJsonBody(req);
  if (!isChatCompletionRequestBody(body)) {
    sendJson(res, 400, { error: 'expected { messages: [{role, content}, ...] }' });
    return;
  }

  const messages: LlmMessage[] = body.messages
    .filter((m) => ALLOWED_ROLES.has(m.role))
    .map((m) => ({ role: m.role as LlmMessage['role'], content: m.content }));

  // A client's own model picker (Open WebUI's dropdown, populated from GET /v1/models) sends
  // its selection here — that's what actually takes effect, not the fixed modelName below.
  // modelName only remains as the label echoed back when the request didn't specify one.
  const model = body.model;
  const reply = await runTurn({ userId, messages, model, llm, db, tools });
  const echoedModel = model ?? modelName;

  if (body.stream) {
    const id = `chatcmpl-${randomUUID()}`;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(
      `data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, id, { role: 'assistant', content: reply }, null))}\n\n`,
    );
    res.write(`data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, id, {}, 'stop'))}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  sendJson(res, 200, buildChatCompletion(echoedModel, reply));
}

async function handleOpenApiSpec(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const baseUrl = `${deps.publicBaseUrl ?? `http://localhost:${deps.port}`}/v1/tools`;
  sendJson(res, 200, buildOpenApiSpec(deps.tools.definitions(), baseUrl));
}

async function handleToolInvoke(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  toolName: string,
): Promise<void> {
  const userId = authenticate(req, deps.apiKeys);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  if (!toolName) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  let args: unknown;
  try {
    args = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const { status, body } = await invokeTool(deps.db, deps.tools, userId, toolName, args);
  sendJson(res, status, body);
}

async function handleAdminCredentialsList(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const credentials = await listCredentials(deps.credentials);
  sendJson(res, 200, { credentials });
}

async function handleAdminCredentialsSet(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetCredentialBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { name: one of the known credential names, value: non-empty string }' });
    return;
  }

  await setCredential(deps.credentials, parsed.name, parsed.value);

  const payload = JSON.stringify({ status: 'restarting' });
  res.writeHead(202, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload, () => {
    const restart = deps.triggerRestart ?? (() => process.exit(0));
    setTimeout(restart, 100);
  });
}

async function handleModels(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  if (deps.llm.listModels) {
    try {
      const models = await deps.llm.listModels();
      sendJson(res, 200, buildModelsList(models.map((m) => m.id)));
      return;
    } catch (err) {
      log.error('failed to fetch live model catalog, falling back to the static entry', err);
    }
  }
  sendJson(res, 200, buildModelsList([deps.modelName]));
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/') {
    sendHtml(res, 200, renderLandingPage());
    return;
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    await handleModels(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    await handleChatCompletions(req, res, deps);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/tools/openapi.json') {
    await handleOpenApiSpec(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/v1/tools/')) {
    const toolName = decodeURIComponent(new URL(req.url, 'http://placeholder').pathname.slice('/v1/tools/'.length));
    await handleToolInvoke(req, res, deps, toolName);
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin') {
    sendHtml(res, 200, renderAdminPage());
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/admin/credentials') {
    if (!isAdminAuthenticated(req, deps.adminApiKey)) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleAdminCredentialsList(res, deps);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/admin/credentials') {
    if (!isAdminAuthenticated(req, deps.adminApiKey)) {
      sendJson(res, 401, { error: 'missing or incorrect admin key' });
      return;
    }
    await handleAdminCredentialsSet(req, res, deps);
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

export function startHttpServer(deps: HttpServerDeps): Server {
  const server = createServer((req, res) => {
    handleRequest(req, res, deps).catch((err) => {
      log.error('unhandled error in HTTP handler', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });

  server.listen(deps.port, () => {
    log.info(`orchestrator HTTP server listening on :${deps.port}`);
  });

  return server;
}
