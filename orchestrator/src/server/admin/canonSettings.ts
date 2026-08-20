/**
 * @file orchestrator/src/server/admin/canonSettings.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (settings-store IO) — the same
 * dual-role split the original adminServer.ts canon block used; moved here verbatim as part of the
 * adminServer domain split
 * @description
 * The Canonize feature's admin knobs: canon_recall_top_k (how many canon facts the recall lane
 * returns, read live on every recall call), canon_recall_min (the dynamic-cutoff Min floor), and
 * canon_extraction_prompt (the background extraction call's prompt template — "default + bespoke"
 * override per bi_principles.md §17). Settings configuration only; the extraction pass that
 * consumes the prompt is Director Pass work, deliberately not wired or owned here.
 *
 * @api-declaration
 * getCanonSettings(store) — { recallTopK, recallMin, extractionPrompt, extractionPromptIsDefault },
 *   defaulting when unset (topK 8, min null, prompt the built-in)
 * parseSetCanonSettingsBody(raw) — validates { recall_top_k?, recall_min?, extraction_prompt? },
 *   at least one present; undefined on any malformed shape
 * setCanonSettings(store, body) — upserts whichever fields the body names
 *
 * @contract
 *   assertions:
 *     purity:          parseSetCanonSettingsBody is pure; the rest are impure (Postgres IO via the
 *                      injected settings store)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected OrchestratorSettingsStore)]
 */

import type { OrchestratorSettingsStore } from '../../io/orchestratorSettings.js';
import { DEFAULT_CANON_EXTRACTION_PROMPT } from '../../io/canonExtraction.js';

// --- Canon settings (docs/canonize-plan.md §6, bi_principles.md §13/§17) ---
// The Canonize feature's knobs: canon_recall_top_k (integer-as-text, default '8' — how many
// canon facts recall_canon_facts returns, read live on every recall call, no restart) and
// canon_extraction_prompt (the background extraction call's prompt template — "default + bespoke"
// override per bi_principles.md §17, empty clears back to the built-in, same shape as the
// chat_memory_* prompts above). Since migration 0092 (docs/plans/completed/rag-dynamic-cutoff-plan.md
// Stage 2) canon_recall_top_k doubles as the fact lane's per-channel **Max** for the dynamic
// cutoff, with canon_recall_min (default '2') as its Min floor — read live by
// buildAutoRecallParts alongside the shared 0091 knobs. The extraction pass that consumes the
// prompt is Director Pass work (canonize-plan.md §2) — not wired yet; the setting is still
// surfaced now so it exists before the pass does.

export interface CanonSettings {
  recallTopK: number;
  recallMin: number | null;
  extractionPrompt: string;
  extractionPromptIsDefault: boolean;
}

export async function getCanonSettings(store: OrchestratorSettingsStore): Promise<CanonSettings> {
  const [topKRaw, minRaw, extractionPrompt] = await Promise.all([
    store.get('canon_recall_top_k'),
    store.get('canon_recall_min'),
    store.get('canon_extraction_prompt'),
  ]);
  const parsedTopK = topKRaw ? Number(topKRaw) : NaN;
  return {
    recallTopK: Number.isInteger(parsedTopK) && parsedTopK > 0 ? parsedTopK : 8,
    recallMin: minRaw ? Number(minRaw) : null,
    extractionPrompt: extractionPrompt || DEFAULT_CANON_EXTRACTION_PROMPT,
    extractionPromptIsDefault: !extractionPrompt,
  };
}

export interface SetCanonSettingsBody {
  recallTopK?: number;
  recallMin?: number;
  extractionPrompt?: string;
}

// Both fields optional and independently settable; an empty string on the prompt field clears the
// override back to its built-in default (there is no separate "reset" endpoint — see
// io/orchestratorSettings.ts's own doc on this). Wire keys are snake_case, same convention as
// every other parseSet*Body in this file.
export function parseSetCanonSettingsBody(raw: unknown): SetCanonSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { recall_top_k, recall_min, extraction_prompt } = raw as Record<string, unknown>;
  if (recall_top_k === undefined && recall_min === undefined && extraction_prompt === undefined) return undefined;
  if (recall_top_k !== undefined && (typeof recall_top_k !== 'number' || !Number.isInteger(recall_top_k) || recall_top_k <= 0)) {
    return undefined;
  }
  if (recall_min !== undefined && (typeof recall_min !== 'number' || !Number.isInteger(recall_min) || recall_min <= 0)) {
    return undefined;
  }
  if (extraction_prompt !== undefined && typeof extraction_prompt !== 'string') return undefined;
  return {
    recallTopK: recall_top_k as number | undefined,
    recallMin: recall_min as number | undefined,
    extractionPrompt: extraction_prompt as string | undefined,
  };
}

export async function setCanonSettings(store: OrchestratorSettingsStore, body: SetCanonSettingsBody): Promise<void> {
  if (body.recallTopK !== undefined) await store.set('canon_recall_top_k', String(body.recallTopK));
  if (body.recallMin !== undefined) await store.set('canon_recall_min', String(body.recallMin));
  if (body.extractionPrompt !== undefined) await store.set('canon_extraction_prompt', body.extractionPrompt);
}