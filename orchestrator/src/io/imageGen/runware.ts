/**
 * @file orchestrator/src/io/imageGen/runware.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — Runware image adapter (endpoint.md §3.2.1)
 * @description
 * Connects to Runware's HTTP API (https://api.runware.ai/v1) with the synthesized positive/negative
 * prompts, the connection's model id ("runware:100@1" style), dimensions, steps, CFG scale and
 * seed, and returns the direct Runware CDN image URL. One round trip, no polling: the
 * imageInference task returns its imageURL synchronously in the same response.
 *
 * Request contract — verified against the live REST API shape used by the stack's own Canvalyze
 * extension (stacks/sillytavern/.../SillyTavern-Canvalyze/plugin/routes/runware.js) and the
 * current official SDK (Runware/runware-typescript, schema 2026-07-30): authenticate with an
 * `Authorization: Bearer` header, POST an ARRAY of task objects, and use `taskType:
 * 'imageInference'` with `positivePrompt`/`negativePrompt`/`CFGScale`/`scheduler` field names.
 * The legacy WebSocket-era shape — `apiKey` in the body, `taskType: 'imageGeneration'`,
 * `prompt`, `cfgScale`, `samplerName` — is not part of the REST contract and must not be
 * reintroduced (a half-migrated version of exactly that shape 401'd/validation-failed live).
 *
 * @api-declaration
 * generateRunwareImage(req: ImageGenRequest) -> Promise<string> — the Runware CDN image URL
 * generateRunwareImageWithReference(req: ImageGenRequest) -> Promise<GeneratedImage> — URL and
 *   the Runware image UUID when supplied
 *
 * @contract
 *   assertions:
 *     purity:          impure (network call via fetch)
 *     state_ownership: []
 *     external_io:     [https://api.runware.ai/v1]
 */

import { randomUUID } from 'node:crypto';
import { fetchWithRetry } from '../httpRetry.js';
import type { GeneratedImage, ImageGenRequest } from './types.js';

const RUNWARE_ENDPOINT = 'https://api.runware.ai/v1';

export async function generateRunwareImage(req: ImageGenRequest): Promise<string> {
  const result = await generateRunwareImageWithReference(req);
  return result.imageUrl;
}

export async function generateRunwareImageWithReference(req: ImageGenRequest): Promise<GeneratedImage> {
  if (!req.apiKey) throw new Error('runware: no API key configured for this connection');
  const taskUUID = randomUUID();
  const task: Record<string, unknown> = {
    taskType: 'imageInference',
    taskUUID,
    positivePrompt: req.prompt,
    model: req.model,
    width: req.width,
    height: req.height,
    numberResults: 1,
    // Proven live shape (Canvalyze sends the array form); the current SDK schema documents the
    // string 'URL'. outputType URL means the API hands back a CDN link — no bytes here, which is
    // exactly the stateless-media commitment (endpoint.md §1.1).
    outputType: ['URL'],
    outputFormat: 'JPG',
    // Same as Canvalyze: roleplay scenes must not be silently dropped by the content checker.
    checkNSFW: false,
  };
  const negative = req.negativePrompt.trim();
  if (negative) task.negativePrompt = negative;
  if (req.seed !== null && req.seed !== undefined) task.seed = req.seed;
  if (req.steps > 0) task.steps = req.steps;
  if (req.cfgScale > 0) task.CFGScale = req.cfgScale; // capital — the API's field name
  if (req.samplerName) task.scheduler = req.samplerName; // Runware's scheduler enum, not "samplerName"
  const res = await fetchWithRetry(RUNWARE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
    body: JSON.stringify([task]),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`runware: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }
  const parsed = (await res.json()) as {
    data?: Array<{
      taskUUID?: string;
      errorCode?: string;
      message?: string;
      imageURL?: string;
      imageUUID?: string;
    }>;
  };
  const rows = parsed.data ?? [];
  const taskResult = rows.find((r) => r.taskUUID === taskUUID) ?? rows[0];
  if (taskResult?.errorCode) {
    throw new Error(`runware: task error [${taskResult.errorCode}]: ${taskResult.message ?? taskResult.errorCode}`);
  }
  const imageUrl = taskResult?.imageURL;
  if (!imageUrl) throw new Error('runware: response contained no imageURL');
  return {
    imageUrl,
    ...(taskResult?.imageUUID ? { providerImageRef: taskResult.imageUUID } : {}),
  };
}
