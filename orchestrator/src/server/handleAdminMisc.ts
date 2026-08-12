/**
 * @file orchestrator/src/server/handleAdminMisc.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — the leftover small admin route handlers from httpServer.ts
 * @description
 * The admin routes that didn't fit a settings-panel module
 * (docs/plans/completed/httpserver-breakdown-plan.md step 1): notifications, the admin read/write side of
 * screen-lock settings (the household read side lives in httpServer.ts's handleMisc block), the
 * chub avatar image proxy (the one place a chub CDN URL crosses straight from the browser, gated
 * by an explicit host allowlist before fetchThroughPiaProxy — an unguarded `url` param would be
 * an open SSRF relay), the PIA proxy URL, and persona settings. Every handler is pure
 * request/response against orchestrator_settings (or an upstream fetch for the avatar proxy);
 * the dispatcher applies the admin gate before any of these run.
 *
 * @api-declaration
 * handle{Notification,AdminScreenLock,PiaProxyUrl,Persona}Settings{Get,Set}(req, res, deps)
 *   — GET/POST /v1/admin/<kind>-settings
 * handleChubAvatarProxy(req, res, deps) — GET /v1/characters/chub-avatar?url=
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads/writes orchestrator_settings; proxies an upstream image)
 *     state_ownership: []
 *     external_io:     [Postgres (via deps.settings), outbound HTTP via fetchThroughPiaProxy]
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { fetchThroughPiaProxy } from '../io/piaProxyFetch.js';
import {
  getNotificationSettings,
  getPersonaSettings,
  getPiaProxyUrl,
  getScreenLockSettings,
  parseSetNotificationSettingsBody,
  parseSetPersonaSettingsBody,
  parseSetPiaProxyUrlBody,
  parseSetScreenLockSettingsBody,
  setNotificationSettings,
  setPersonaSettings,
  setPiaProxyUrl,
  setScreenLockSettings,
} from './adminServer.js';
import { readJsonBody, sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';

export async function handleNotificationSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getNotificationSettings(deps.settings));
}

export async function handleNotificationSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetNotificationSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { server_url?: non-empty string, enabled?: boolean }, at least one' });
    return;
  }

  await setNotificationSettings(deps.settings, parsed);
  // No restart needed — the next send_push_notification call reads both fields live.
  sendJson(res, 200, await getNotificationSettings(deps.settings));
}

// Admin-gated counterpart to handleScreenLockSettingsGet in httpServer.ts's handleMisc block —
// same value, but this is the Settings tab's own read (and the only place the password gets
// written), so it's behind the admin key like every other Settings-tab field, not the lighter
// household gate the overlay uses.
export async function handleAdminScreenLockSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getScreenLockSettings(deps.settings));
}

export async function handleAdminScreenLockSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const parsed = parseSetScreenLockSettingsBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { password?: string, timeout_minutes?: positive number }, at least one' });
    return;
  }

  await setScreenLockSettings(deps.settings, parsed);
  // No restart needed — ScreenLockOverlay.tsx polls /v1/screen-lock-settings live.
  sendJson(res, 200, await getScreenLockSettings(deps.settings));
}

// GET /v1/characters/chub-avatar?url= — the one place a chub CDN URL crosses straight from the
// browser (BrowseChubView.tsx's search-result grid) rather than through a tool call, so it needs
// its own guard beyond fetchThroughPiaProxy: an unrestricted `url` param would make this an open
// image-fetch relay to anywhere on the internet (an SSRF hole reachable from any authenticated
// household member's browser, not just an LLM tool call). Restricted to chub's own avatar CDN
// host, confirmed live (2026-08-05) as the host every avatar_url/max_res_url in chub's search and
// character-detail responses actually uses.
const CHUB_AVATAR_ALLOWED_HOSTS = new Set(['avatars.charhub.io']);

export async function handleChubAvatarProxy(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const target = new URL(req.url ?? '', 'http://placeholder').searchParams.get('url');
  if (!target) {
    sendJson(res, 400, { error: 'missing url query param' });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    sendJson(res, 400, { error: 'invalid url' });
    return;
  }
  if (!CHUB_AVATAR_ALLOWED_HOSTS.has(parsed.hostname)) {
    sendJson(res, 400, { error: `url must be hosted on one of: ${Array.from(CHUB_AVATAR_ALLOWED_HOSTS).join(', ')}` });
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetchThroughPiaProxy(deps.settings, target);
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : 'chub-avatar proxy fetch failed' });
    return;
  }
  if (!upstream.ok) {
    sendJson(res, upstream.status, { error: `chub.ai returned HTTP ${upstream.status}` });
    return;
  }

  const bytes = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'content-length': bytes.length,
  });
  res.end(bytes);
}

// GET/POST /v1/admin/pia-proxy-settings — admin-only, no household-authed counterpart (unlike
// timezone/screen-lock): pia_proxy_url is only ever read server-side, by io/piaProxyFetch.ts, never
// by the frontend directly.
export async function handlePiaProxyUrlGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, { url: await getPiaProxyUrl(deps.settings) });
}

export async function handlePiaProxyUrlSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const value = parseSetPiaProxyUrlBody(raw);
  if (!value) {
    sendJson(res, 400, { error: 'expected { value: a non-empty http(s) URL, e.g. "http://pia-proxy:8080" }' });
    return;
  }

  await setPiaProxyUrl(deps.settings, value);
  sendJson(res, 200, { url: await getPiaProxyUrl(deps.settings) });
}

// GET/POST /v1/admin/persona-settings — the household's own name/description
// (docs/plans/prompt-macros.md's Stage 1), read live by
// plugins/context-stack-presets' applyPromptStackToChatTool.ts. Same admin-authed,
// read-back-in-full shape as screen-lock/notification settings.
export async function handlePersonaSettingsGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, await getPersonaSettings(deps.settings));
}

export async function handlePersonaSettingsSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }

  const body = parseSetPersonaSettingsBody(raw);
  if (!body) {
    sendJson(res, 400, { error: 'expected { name?: string, description?: string }, at least one present' });
    return;
  }

  await setPersonaSettings(deps.settings, body);
  // No restart needed — applyPromptStackToChatTool.ts reads both fields live on every apply.
  sendJson(res, 200, await getPersonaSettings(deps.settings));
}
