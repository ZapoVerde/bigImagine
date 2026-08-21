/**
 * @file orchestrator/src/io/imageGen/removeBackground.ts
 * @stamp 2026-08-21
 * @architectural-role IO Wrapper — standalone Runware background-removal adapter
 * @description
 * Calls Runware's background-removal task separately from its image-generation adapter. BGRM
 * accepts an image reference and returns Runware's resulting transparent image URL without
 * downloading, converting, storing, or otherwise inspecting the source reference.
 *
 * @api-declaration
 * removeBackground(req: RemoveBackgroundRequest) -> Promise<RemoveBackgroundResult>
 *
 * @contract
 *   assertions:
 *     purity:          impure (network call via fetch)
 *     state_ownership: []
 *     external_io:     [https://api.runware.ai/v1]
 */

import { randomUUID } from 'node:crypto';
import { fetchWithRetry } from '../httpRetry.js';

const RUNWARE_ENDPOINT = 'https://api.runware.ai/v1';

export interface RemoveBackgroundRequest {
  image: string;
  model: string;
  apiKey: string;
}

export interface RemoveBackgroundResult {
  imageUrl: string;
}

export async function removeBackground(req: RemoveBackgroundRequest): Promise<RemoveBackgroundResult> {
  if (!req.apiKey?.trim()) throw new Error('runware bgrm: no API key configured');

  const taskUUID = randomUUID();
  const task = {
    taskType: 'removeBackground',
    taskUUID,
    model: req.model,
    inputs: { image: req.image },
    outputFormat: 'PNG',
  };
  const res = await fetchWithRetry(RUNWARE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
    body: JSON.stringify([task]),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`runware bgrm: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }

  const parsed = (await res.json()) as {
    data?: Array<{ taskUUID?: string; errorCode?: string; message?: string; imageURL?: string }>;
  };
  const rows = parsed.data ?? [];
  const taskResult = rows.find((row) => row.taskUUID === taskUUID) ?? rows[0];
  if (taskResult?.errorCode) {
    throw new Error(`runware bgrm: task error [${taskResult.errorCode}]: ${taskResult.message ?? taskResult.errorCode}`);
  }
  if (!taskResult?.imageURL) throw new Error('runware bgrm: response contained no imageURL');
  return { imageUrl: taskResult.imageURL };
}
