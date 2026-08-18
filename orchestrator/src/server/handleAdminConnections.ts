/**
 * @file orchestrator/src/server/handleAdminConnections.ts
 * @stamp 2026-08-17
 * @architectural-role IO Wrapper — the admin credentials + connections CRUD surface from httpServer.ts
 * @description
 * Three related admin surfaces, all gated by the dispatcher's isAdminAuthorized before this
 * module runs (docs/plans/completed/httpserver-breakdown-plan.md step 4):
 *
 * - Provider credentials (io/providerCredentials.ts): GET/POST /v1/admin/credentials. A
 *   successful POST writes the new value then exits the process (triggerRestart) so restart:
 *   unless-stopped picks it up at boot.
 * - LLM connections (io/llmConnections.ts): GET/POST /v1/admin/connections; GET/PATCH/DELETE
 *   plus /activate (202+restart, the active llm is a boot-time singleton — bi_principles.md
 *   §14), /models, /providers?model=, /test, and /reliability (io/providerReliability.ts's
 *   background provider sweep: POST starts / GET polls / POST :id/reliability/stop aborts one).
 *   The sweep's optional quantizations filter (provider.quantizations on every probe) rides the
 *   start body.
 * - Image connections (io/imageConnections.ts, endpoint.md §3): the same id-in-path shape as the
 *   LLM connections handler above without /models or /providers preview routes; activation is a
 *   plain 200, NOT the LLM connections' 202+restart, because the active image connection is
 *   resolved live on every generateLocationImage call (bi_principles.md §13).
 *
 * @api-declaration
 * handleAdminCredentialsList(res, deps)                 — GET /v1/admin/credentials
 * handleAdminCredentialsSet(req, res, deps)             — POST /v1/admin/credentials
 * handleAdminConnectionRoutes(req, res, deps, url)      — /v1/admin/connections[/pricing-sync | /:id[/activate|/models|/providers|/test|/reliability[/stop]]]
 * handleAdminImageConnectionRoutes(req, res, deps, url) — /v1/admin/image-connections[/:id[/activate|/test]]
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads/writes provider_credentials and the connection registries)
 *     state_ownership: []
 *     external_io:     [Postgres (via deps.credentials/llmConnections/imageConnections), outbound
 *                       HTTP via testConnection/listModelsForConnection/listProvidersForConnection]
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../io/logger.js';
import { syncDeepSeekPricing } from '../io/deepseekPricingSync.js';
import {
  getProviderReliabilitySweep,
  startProviderReliabilitySweep,
  stopProviderReliabilitySweep,
} from '../io/providerReliability.js';
import {
  listCredentials,
  listModelsForConnection,
  listProvidersForConnection,
  parseCreateConnectionBody,
  parseCreateImageConnectionBody,
  parseReliabilitySweepBody,
  parseSetCredentialBody,
  parseUpdateConnectionBody,
  parseUpdateImageConnectionBody,
  setCredential,
  testConnection,
  testImageConnection,
} from './adminServer.js';
import { readJsonBody, sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';

export async function handleAdminCredentialsList(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const credentials = await listCredentials(deps.credentials);
  sendJson(res, 200, { credentials });
}

export async function handleAdminCredentialsSet(
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

// The Connections tab's CRUD surface (io/llmConnections.ts) — same id-in-path shape as
// handleFolders.ts's handleFolderRoutes. GET/POST on the collection; GET/PATCH/DELETE plus two
// catalog-preview sub-routes on one connection by id.
export async function handleAdminConnectionRoutes(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps, url: URL): Promise<void> {
  const rest = url.pathname.slice('/v1/admin/connections'.length); // '' | '/<id>' | '/<id>/activate' | '/<id>/models' | '/<id>/providers' | '/<id>/test' | '/<id>/reliability[/stop]'
  const segments = rest.split('/').filter(Boolean);

  // Collection-level action, checked before the id is parsed (a one-shot manual DeepSeek pricing
  // sync — docs/plans/deepseek-pricing-sync.md — the same function the daily loop runs, shared so
  // the manual button and the scheduled pass can never drift apart).
  if (segments.length === 1 && segments[0] === 'pricing-sync' && req.method === 'POST') {
    try {
      const result = await syncDeepSeekPricing({ llmConnections: deps.llmConnections, fetchHtml: deps.fetchHtml });
      sendJson(res, 200, result);
    } catch (err) {
      log.error('deepseek pricing sync failed', err);
      sendJson(res, 502, { error: 'failed to fetch or parse the DeepSeek pricing page' });
    }
    return;
  }

  if (segments.length === 0) {
    if (req.method === 'GET') {
      sendJson(res, 200, { connections: await deps.llmConnections.list() });
      return;
    }
    if (req.method === 'POST') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const parsed = parseCreateConnectionBody(raw);
      if (!parsed) {
        sendJson(res, 400, {
          error:
            'expected { name: non-empty string, kind: "anthropic" | "openai-compatible" | "deepseek" | "openrouter", model: non-empty string, ' +
            'apiKey OR copyApiKeyFrom (exactly one, both non-empty strings — omitted entirely for deepseek/openrouter, whose shared key is set in Settings), ' +
            'baseUrl? (required for openai-compatible), supportsVision?, providerOrder?: string[], allowFallbacks?, quantizations?: string[] }',
        });
        return;
      }
      let created;
      try {
        created = await deps.llmConnections.create(parsed);
      } catch (err) {
        // A store-level validation error (e.g. a provider kind sneaking a key through) is a 400,
        // not a 500.
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'failed to create connection' });
        return;
      }
      sendJson(res, 201, created);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const id = decodeURIComponent(segments[0]!);

  if (segments.length === 1) {
    if (req.method === 'PATCH') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const parsed = parseUpdateConnectionBody(raw);
      if (!parsed) {
        sendJson(res, 400, { error: 'expected a partial connection patch — see POST /v1/admin/connections for field shapes' });
        return;
      }
      let updated;
      try {
        updated = await deps.llmConnections.update(id, parsed);
      } catch (err) {
        // A store-level validation error (e.g. switching away from a shared-key kind without
        // supplying a per-connection key) is a 400, not a 500.
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'failed to update connection' });
        return;
      }
      if (!updated) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, updated);
      return;
    }
    if (req.method === 'DELETE') {
      const result = await deps.llmConnections.remove(id);
      if (result === 'not_found') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      if (result === 'is_active') {
        sendJson(res, 409, { error: 'cannot delete the active connection — activate a different one first' });
        return;
      }
      sendJson(res, 200, { deleted: true });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (segments.length === 2 && segments[1] === 'activate' && req.method === 'POST') {
    const activated = await deps.llmConnections.activate(id);
    if (!activated) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const payload = JSON.stringify({ status: 'restarting' });
    res.writeHead(202, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload, () => {
      const restart = deps.triggerRestart ?? (() => process.exit(0));
      setTimeout(restart, 100);
    });
    return;
  }

  if (segments.length === 2 && segments[1] === 'models' && req.method === 'GET') {
    let result;
    try {
      result = await listModelsForConnection(deps.llmConnections, id);
    } catch (err) {
      log.error(`failed to list models for connection "${id}"`, err);
      sendJson(res, 502, { error: 'failed to reach this connection to list its models' });
      return;
    }
    if (!result) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (segments.length === 2 && segments[1] === 'test' && req.method === 'POST') {
    const result = await testConnection(deps.llmConnections, id);
    if (!result) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (segments.length === 2 && segments[1] === 'providers' && req.method === 'GET') {
    const modelId = url.searchParams.get('model');
    if (!modelId) {
      sendJson(res, 400, { error: 'expected a ?model=<id> query parameter' });
      return;
    }
    let result;
    try {
      result = await listProvidersForConnection(deps.llmConnections, id, modelId);
    } catch (err) {
      log.error(`failed to list providers for model "${modelId}" on connection "${id}"`, err);
      sendJson(res, 502, { error: 'failed to reach this connection to list its providers' });
      return;
    }
    if (!result) {
      sendJson(res, 404, { error: 'not found, or this connection has no provider catalog' });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (segments.length === 2 && segments[1] === 'reliability' && req.method === 'GET') {
    const state = getProviderReliabilitySweep(id);
    // No sweep has ever run for this connection — a 200 'idle' rather than 404, so the editor's
    // poll can treat "nothing yet" as a normal first-run state instead of an error.
    sendJson(res, 200, state ?? { status: 'idle' });
    return;
  }

  if (segments.length === 2 && segments[1] === 'reliability' && req.method === 'POST') {
    let raw: unknown;
    try {
      raw = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'expected a JSON request body' });
      return;
    }
    const parsed = parseReliabilitySweepBody(raw);
    if (!parsed) {
      sendJson(res, 400, {
        error: 'expected { attemptsPerProvider?: 1-10, delayMs?: 500-10000, quantizations?: string[] }',
      });
      return;
    }
    const result = await startProviderReliabilitySweep(deps.llmConnections, id, parsed);
    if (!result.ok) {
      if (result.reason === 'already_running') {
        sendJson(res, 409, { error: 'a reliability sweep is already running for this connection' });
        return;
      }
      sendJson(res, 404, { error: 'not found, or this connection has no provider catalog to sweep' });
      return;
    }
    sendJson(res, 200, { state: result.state });
    return;
  }

  if (segments.length === 3 && segments[1] === 'reliability' && segments[2] === 'stop' && req.method === 'POST') {
    const state = stopProviderReliabilitySweep(id);
    if (!state) {
      sendJson(res, 404, { error: 'no reliability sweep exists for this connection' });
      return;
    }
    sendJson(res, 200, { state });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

// The Connections tab's image-generation section CRUD (io/imageConnections.ts, endpoint.md §3) —
// same id-in-path shape as handleAdminConnectionRoutes above. GET/POST on the collection;
// GET/PATCH/DELETE plus Test on one connection by id. No /models or /providers preview routes:
// image connections have no model/provider catalogs to browse (a kind is a fixed adapter, a model
// is a free-text id the admin types). Activation is a plain 200, deliberately NOT the LLM
// connections' 202+restart: the active image connection is resolved live on every
// generateLocationImage call (bi_principles.md §13), so switching takes effect on the next render
// with no restart.
export async function handleAdminImageConnectionRoutes(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps, url: URL): Promise<void> {
  const rest = url.pathname.slice('/v1/admin/image-connections'.length); // '' | '/<id>' | '/<id>/activate' | '/<id>/test'
  const segments = rest.split('/').filter(Boolean);

  if (segments.length === 0) {
    if (req.method === 'GET') {
      sendJson(res, 200, { connections: await deps.imageConnections.list() });
      return;
    }
    if (req.method === 'POST') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const parsed = parseCreateImageConnectionBody(raw);
      if (!parsed) {
        sendJson(res, 400, {
          error:
            'expected { name: non-empty string, kind: "runware" | "fal-ai" | "pollinations" | "comfyui" | "openai-images", ' +
            'model: non-empty string, apiKey?, baseUrl?, width? (64-8192), height? (64-8192), samplingSteps?, cfgScale?, samplerName?, ' +
            'masterPositiveStylePrefix?, masterNegativePrompt?, workflowParameters? }',
        });
        return;
      }
      const created = await deps.imageConnections.create(parsed);
      sendJson(res, 201, created);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const id = decodeURIComponent(segments[0]!);

  if (segments.length === 1) {
    if (req.method === 'PATCH') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const parsed = parseUpdateImageConnectionBody(raw);
      if (!parsed) {
        sendJson(res, 400, { error: 'expected a partial image-connection patch — see POST /v1/admin/image-connections for field shapes' });
        return;
      }
      const updated = await deps.imageConnections.update(id, parsed);
      if (!updated) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, updated);
      return;
    }
    if (req.method === 'DELETE') {
      const result = await deps.imageConnections.remove(id);
      if (result === 'not_found') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      if (result === 'is_active') {
        sendJson(res, 409, { error: 'cannot delete the active image connection — activate a different one first' });
        return;
      }
      sendJson(res, 200, { deleted: true });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (segments.length === 2 && segments[1] === 'activate' && req.method === 'POST') {
    let activated: boolean;
    try {
      activated = await deps.imageConnections.activate(id);
    } catch (err) {
      // activate() throws (rolling back) when the target vanished mid-transaction — from the
      // client's perspective the id is gone, so this is a 404, not a 500. Any other error here
      // (a genuine DB failure) also reads as not-found; the atomic rollback guarantees state was
      // never corrupted either way (bi_principles.md §11: log the seam).
      log.error(`image connection activation failed for "${id}"`, err);
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!activated) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    // 200, not the LLM connections' 202+restart — the active image connection is resolved live
    // on every generation call (see the handler's doc comment above).
    sendJson(res, 200, { activated: true });
    return;
  }

  if (segments.length === 2 && segments[1] === 'test' && req.method === 'POST') {
    const result = await testImageConnection(deps.imageConnections, deps.settings, id);
    if (!result) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
