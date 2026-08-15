/**
 * @file orchestrator/src/server/handleTurnControl.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — chat turn status/abort side channels from httpServer.ts
 * @description
 * Two lightweight turn-control endpoints keyed on chat_id: GET /v1/chat/status (read-only) and
 * POST /v1/chat/abort (the Stop button's server side). Both authenticate as regular users;
 * abort additionally ownership-checks via chats.getChat so a user can only stop their own chat's
 * work. The status side channel exists because /v1/chat/completions is a single blocking POST,
 * not a stream (docs/bootstrap.md) — the frontend polls it while waiting.
 *
 * @api-declaration
 * handleChatTurnStatus(req, res, deps) — GET /v1/chat/status?chat_id=
 * handleChatAbort(req, res, deps)     — POST /v1/chat/abort { chat_id }
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads turnStatus registry; aborts in-flight LLM tasks)
 *     state_ownership: []
 *     external_io:     [Postgres (via deps.chats), in-process turn registry/abort set]
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getTurnStatus } from '../orchestrator/turnStatus.js';
import { isInteractiveTurnActive } from '../orchestrator/interactiveTurnLock.js';
import { abortTurn } from '../orchestrator/turnAbort.js';
import { authenticate, readJsonBody, sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';

// A lightweight side channel for a chat still mid-flight (docs/bootstrap.md: /v1/chat/completions
// is a single blocking POST, not a stream) — the frontend polls this while waiting, to show which
// tool loop.ts's runTurn is currently running (orchestrator/turnStatus.ts). taskId for a
// persisted-session turn is always its chat_id (httpServer.ts's own handleChatCompletions), so
// that's what this keys on; no status ever existing (not yet started, already finished, or a
// stateless Open WebUI turn with no chat_id) is a normal, empty response, not an error.
// `active` is the real "is a turn running" answer (robust-chat-turns-plan.md): it reads the
// per-chat interactive-turn lock (orchestrator/interactiveTurnLock.ts) that both turn-producing
// endpoints gate on — unlike `status`, which is only a "still thinking" hint set while a tool
// round is churning and reads null between rounds and for the whole RP streaming lane. The client
// uses `active` to reconcile on mount/visibility change (a turn this tab lost track of is running
// server-side); `status` stays what it always was.
export async function handleChatTurnStatus(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const userId = await authenticate(req, deps.apiKeys, deps.accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }
  const chatId = new URL(req.url ?? '', 'http://placeholder').searchParams.get('chat_id');
  sendJson(res, 200, {
    status: chatId ? (getTurnStatus(chatId) ?? null) : null,
    active: chatId ? isInteractiveTurnActive(chatId) : false,
  });
}

// The Stop button's server side (orchestrator/turnAbort.ts): abort every LLM task currently in
// flight for this chat — the interactive turn runTurn is running AND any cleanup-loop repair
// churning on the same chat (the stop is meant to kill the chat's whole active LLM spend at
// once). 200 means at least one task was aborted; 404 means nothing was in flight (turn already
// finished, or never started — a no-op, not an error). Ownership-checked via chats.getChat so a
// user can only stop their own chat's work, unlike the read-only /v1/chat/status side channel.
export async function handleChatAbort(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
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
  const chat = await deps.chats.getChat(userId, body.chat_id);
  if (!chat) {
    sendJson(res, 404, { error: 'unknown chat_id' });
    return;
  }
  const aborted = abortTurn(body.chat_id);
  if (!aborted) {
    sendJson(res, 404, { error: 'no turn in flight for this chat' });
    return;
  }
  sendJson(res, 200, { aborted: true });
}
