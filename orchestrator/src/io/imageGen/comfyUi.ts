/**
 * @file orchestrator/src/io/imageGen/comfyUi.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — ComfyUI image adapter (endpoint.md §3.2.4)
 * @description
 * Injects the synthesized prompt into a local or remote ComfyUI workflow graph and returns the
 * view URL of the rendered output. ComfyUI's own HTTP API is used: POST /prompt with the graph
 * ({prompt_id} returned), then the /history/{prompt_id} endpoint is polled until the run finishes
 * with an output image, whose /view?filename=..&subfolder=..&type=output URL is returned.
 *
 * The workflow graph itself lives on the connection row's `workflow_parameters` jsonb (endpoint.md
 * §2.1) — a plain ComfyUI-format graph ({node_id: {class_type, inputs}}). Prompt injection is
 * conventional, matching how ComfyUI graphs are usually authored: the first node whose
 * class_type starts with "CLIPTextEncode" receives the positive prompt in its `text` input, the
 * second receives the negative prompt, and the first node with class_type "KSampler" receives the
 * seed/steps/cfg (only when the request carries them). A graph that has none of these nodes is
 * still submitted as-is — it just won't reflect the location's text, which is the admin's graph
 * to own. baseUrl is required — ComfyUI is always a self-hosted endpoint, never a cloud default.
 *
 * @api-declaration
 * generateComfyUiImage(req: ImageGenRequest) -> Promise<string> — the ComfyUI view URL of the
 *   rendered output image
 *
 * @contract
 *   assertions:
 *     purity:          impure (network calls via fetch)
 *     state_ownership: []
 *     external_io:     [the connection's own baseUrl (ComfyUI server)]
 */

import { fetchWithRetry } from '../httpRetry.js';
import type { ImageGenRequest } from './types.js';

interface ComfyNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
}

interface ComfyHistoryEntry {
  outputs?: Record<string, { images?: { filename?: string; subfolder?: string; type?: string }[] }>;
}

export async function generateComfyUiImage(req: ImageGenRequest): Promise<string> {
  if (!req.baseUrl) throw new Error('comfyui: no base URL configured for this connection');
  const base = req.baseUrl.replace(/\/+$/, '');
  const graph = structuredClone((req.workflowParameters ?? {}) as Record<string, ComfyNode>);

  let textEncodeCount = 0;
  for (const node of Object.values(graph)) {
    if (!node || typeof node !== 'object') continue;
    const cls = String(node.class_type ?? '');
    if (cls.startsWith('CLIPTextEncode')) {
      node.inputs = node.inputs ?? {};
      node.inputs.text = textEncodeCount === 0 ? req.prompt : textEncodeCount === 1 ? req.negativePrompt : node.inputs.text;
      textEncodeCount++;
    } else if (cls === 'KSampler') {
      node.inputs = node.inputs ?? {};
      if (req.seed !== null && req.seed !== undefined) node.inputs.seed = req.seed;
      node.inputs.steps = req.steps;
      node.inputs.cfg = req.cfgScale;
    }
  }

  const submit = await fetchWithRetry(`${base}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph }),
  });
  if (!submit.ok) {
    const detail = await submit.text().catch(() => '');
    throw new Error(`comfyui: submit HTTP ${submit.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }
  const submitted = (await submit.json()) as { prompt_id?: string };
  if (!submitted.prompt_id) throw new Error('comfyui: submit response contained no prompt_id');

  // Poll history until this run's output images appear. A single generation usually takes a few
  // seconds on a local GPU; the bounded wait below covers queueing on a shared/remote server.
  const deadlineMs = Date.now() + 120_000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (Date.now() > deadlineMs) throw new Error('comfyui: timed out waiting for the generation job');
    const historyRes = await fetchWithRetry(`${base}/history/${submitted.prompt_id}`, {});
    if (!historyRes.ok) continue; // history may 404 briefly before the run is recorded
    const history = (await historyRes.json()) as Record<string, ComfyHistoryEntry>;
    const entry = history[submitted.prompt_id];
    const images = entry ? Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []) : [];
    if (images.length > 0) {
      const first = images[0];
      const query = new URLSearchParams({
        filename: first.filename ?? '',
        subfolder: first.subfolder ?? '',
        type: first.type ?? 'output',
      });
      return `${base}/view?${query.toString()}`;
    }
  }
}
