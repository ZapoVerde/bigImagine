/**
 * @file orchestrator/src/portraits/reflection.ts
 * @stamp 2026-08-18
 * @architectural-role Pure Function — the reflection contract: the forced submit_lesson tool, the
 *   lesson output validator, the server-computed candidate diff, and the reflection user-prompt
 *   builder (bi_principles.md §8)
 * @description
 * The Portrait Studio reflection contract (docs/plans/portrait-studio-vision-review-harness-plan.md
 * §Reflection contract): reflection receives one compact episode record — goal, parent chromosome,
 * server-computed before→after diffs per candidate, the human's ratings/notes/rationale/layer
 * assessments, prior lesson ids, and a bounded wiki context — and returns strict structured data
 * through a single forced `submit_lesson` tool call (the existing tool-calling path, never a raw
 * JSON body; see evoprompt.ts's file header for why forced raw JSON is avoided on this platform).
 *
 * The model may not "rediscover" the diff from long composed prompts: the server computes it here
 * (computeCandidateDiff) from the immutable parent chromosome, and the prompt builder never
 * includes composed prompts at all. The model never claims to have seen an image — the prompt
 * instructs it that it has not; a rating without an explanation is preference data, not a lesson.
 *
 * Only a validated `conclusion` is a reusable lesson. `insufficient_evidence` is an explicit,
 * honest terminal state; a provider error, timeout, or malformed tool call is `failed` (handled by
 * the orchestrator, not this module). The validator rejects a layer appearing in both `next_change`
 * and `preserve`, requires `next_change` only for a conclusion, and validates every enum.
 *
 * Pure by construction: identical inputs always produce identical output — no IO, no state, no
 * randomness.
 *
 * @api-declaration
 * LessonStatus — 'conclusion' | 'insufficient_evidence'
 * LessonConfidence — 'low' | 'medium' | 'high'
 * LessonOutput — the normalized, validated lesson the orchestrator persists
 * SUBMIT_LESSON_TOOL — the single forced ToolDefinition
 * DEFAULT_REFLECTION_SYSTEM_PROMPT — the built-in system prompt (bi_principles.md §17)
 * computeCandidateDiff(parent, child) -> { changed, unchanged } — pure per-candidate diff
 * validateLessonCall(call) -> { ok, output } | { ok: false, reason } — pure strict validation
 * buildReflectionUserPrompt(snapshot) -> string — pure; the compact episode record
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO, no state, no randomness)
 *     state_ownership: []
 *     external_io:     []
 */

import type { ToolCall, ToolDefinition } from '../io/llm/types.js';
import type { SlotMap } from './composer.js';

export type LessonStatus = 'conclusion' | 'insufficient_evidence';
export type LessonConfidence = 'low' | 'medium' | 'high';

export const LESSON_STATUSES: readonly LessonStatus[] = ['conclusion', 'insufficient_evidence'];
export const LESSON_CONFIDENCES: readonly LessonConfidence[] = ['low', 'medium', 'high'];

/** The validated reflection output the orchestrator persists. Only a conclusion is a reusable
 *  lesson: for insufficient_evidence, none of the lesson fields exist. */
export type LessonOutput =
  | { status: 'insufficient_evidence' }
  | {
      status: 'conclusion';
      lesson: string;
      evidence: string;
      nextChange: { layer: string; instruction: string };
      preserve: string[];
      confidence: LessonConfidence;
    };

/** The conclusion branch of LessonOutput — the only output that creates a lesson. */
export type LessonConclusion = Extract<LessonOutput, { status: 'conclusion' }>;

/** The single forced reflection tool. Everything the reflection result needs arrives in one call —
 *  there is no investigation loop any more (the plan retires pull_wiki_entry/submit_conclusion). */
export const SUBMIT_LESSON_TOOL: ToolDefinition = {
  name: 'submit_lesson',
  description:
    'Submit the round\'s derived lesson: status "conclusion" with one actionable next change, ' +
    'the unchanged layers to preserve, the supporting evidence, and a confidence, or status ' +
    '"insufficient_evidence" when the supplied evidence does not clearly support one change.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['conclusion', 'insufficient_evidence'],
        description: '"conclusion" for a reusable lesson; "insufficient_evidence" when the evidence is ambiguous.',
      },
      lesson: { type: 'string', description: 'The short, reusable lesson statement. Required for a conclusion.' },
      evidence: { type: 'string', description: 'The supplied evidence supporting the lesson. Required for a conclusion.' },
      next_change: {
        type: 'object',
        properties: {
          layer: { type: 'string', description: 'The layer id the one actionable change targets.' },
          instruction: { type: 'string', description: 'The precise instruction for the next mutation.' },
        },
        required: ['layer', 'instruction'],
        additionalProperties: false,
      },
      preserve: {
        type: 'array',
        items: { type: 'string' },
        description: 'Layers the next mutation must keep unchanged. Must not include next_change.layer.',
      },
      confidence: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'How confident the conclusion is, given the supplied evidence.',
      },
    },
    required: ['status'],
    additionalProperties: false,
  },
};

/** The built-in reflection system prompt — the same "default + bespoke" shape as every prompt key
 *  (bi_principles.md §17): empty visual_reflection_system_prompt_override → this; non-empty → the
 *  override verbatim. The prompt must never claim to have seen an image. */
export const DEFAULT_REFLECTION_SYSTEM_PROMPT =
  'You are the Portrait Studio reflection engine. You receive one human-evaluated portrait ' +
  'generation round as a compact record: the goal, the parent chromosome, the server-computed ' +
  'before→after diffs for every candidate, the human\'s ratings, notes, rationale, and optional ' +
  'layer assessments, the prior lessons used, and a bounded set of existing wiki lessons.\n\n' +
  'You have NOT seen any image. Never claim or imply that you have. Reason only from the supplied ' +
  'evidence — the human\'s assessment and the diffs.\n\n' +
  'Call submit_lesson with exactly one of:\n' +
  '- status "conclusion": one actionable next_change (a layer id + a precise instruction for the ' +
  'next mutation), the unchanged layers to preserve, the supporting evidence, a confidence of ' +
  'low/medium/high, and a short reusable lesson statement.\n' +
  '- status "insufficient_evidence": when the rationale, ratings, notes, and diffs do not clearly ' +
  'support one actionable change.\n\n' +
  'Rules: use only supplied evidence; exactly one next_change; a layer may not appear in both ' +
  'next_change and preserve; prefer insufficient_evidence over a forced or vague conclusion; a ' +
  'rating without an explanation is preference data, not a completed lesson.';

interface DecodedLessonArgs {
  status?: unknown;
  lesson?: unknown;
  evidence?: unknown;
  next_change?: unknown;
  preserve?: unknown;
  confidence?: unknown;
}

/** Decode a tool call's arguments — adapters may hand back an object or a JSON string (the same
 *  tolerance evoprompt.ts's decoder has). Throws on undecodable input. */
function decodeArguments(raw: unknown): DecodedLessonArgs {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error('submit_lesson arguments were not valid JSON');
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('submit_lesson arguments were not an object');
  }
  return value as DecodedLessonArgs;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function parseNextChange(v: unknown): { layer: string; instruction: string } | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const nc = v as Record<string, unknown>;
  if (!isNonEmptyString(nc.layer) || !isNonEmptyString(nc.instruction)) return undefined;
  return { layer: nc.layer.trim(), instruction: nc.instruction.trim() };
}

function parseStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') return undefined;
    if (item.trim() !== '') out.push(item.trim());
  }
  return out;
}

export type LessonValidation =
  | { ok: true; output: LessonOutput }
  | { ok: false; reason: string };

/** Pure strict validation of a submit_lesson call. Rejects:
 *  - an unknown status, or a conclusion missing lesson/evidence/next_change/confidence;
 *  - a layer appearing in both next_change and preserve;
 *  - a confidence outside low/medium/high.
 *  The normalize step trims strings and dedupes preserve. */
export function validateLessonCall(call: ToolCall): LessonValidation {
  try {
    const args = decodeArguments(call.arguments);
    const status = args.status;
    if (status !== 'conclusion' && status !== 'insufficient_evidence') {
      return { ok: false, reason: 'submit_lesson status must be "conclusion" or "insufficient_evidence"' };
    }
    if (status === 'insufficient_evidence') {
      return { ok: true, output: { status: 'insufficient_evidence' } };
    }

    if (!isNonEmptyString(args.lesson)) return { ok: false, reason: 'submit_lesson conclusion requires a non-empty lesson' };
    if (!isNonEmptyString(args.evidence)) return { ok: false, reason: 'submit_lesson conclusion requires a non-empty evidence' };
    if (!LESSON_CONFIDENCES.includes(args.confidence as LessonConfidence)) {
      return { ok: false, reason: 'submit_lesson confidence must be low, medium, or high' };
    }
    const nextChange = parseNextChange(args.next_change);
    if (!nextChange) return { ok: false, reason: 'submit_lesson conclusion requires a next_change with layer and instruction' };
    const preserve = parseStringArray(args.preserve);
    if (!preserve) return { ok: false, reason: 'submit_lesson preserve must be an array of layer ids' };
    if (preserve.includes(nextChange.layer)) {
      return { ok: false, reason: `submit_lesson layer "${nextChange.layer}" appears in both next_change and preserve` };
    }

    return {
      ok: true,
      output: {
        status: 'conclusion',
        lesson: args.lesson.trim(),
        evidence: args.evidence.trim(),
        nextChange,
        preserve: [...new Set(preserve)],
        confidence: args.confidence as LessonConfidence,
      },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface CandidateDiff {
  /** Slots whose value differs between the parent and this candidate — server-computed, the model
   *  must never rediscover it from composed prompts. */
  changed: { layer: string; slot: string; before: string; after: string }[];
  /** Slot names whose value is identical in parent and candidate. */
  unchanged: string[];
}

/** Pure: the server-computed before→after diff of one candidate chromosome against its parent.
 *  A missing value on either side is the empty string, so a removed or newly-added slot still
 *  shows as a change. Layer/slot order is deterministic (parent insertion order, then child-only
 *  layers in child order). */
export function computeCandidateDiff(parent: SlotMap, child: SlotMap): CandidateDiff {
  const layers = new Set<string>([...Object.keys(parent ?? {}), ...Object.keys(child ?? {})]);
  const changed: CandidateDiff['changed'] = [];
  const unchanged: string[] = [];
  for (const layer of layers) {
    const parentLayer = (parent ?? {})[layer] ?? {};
    const childLayer = (child ?? {})[layer] ?? {};
    const slots = new Set<string>([...Object.keys(parentLayer), ...Object.keys(childLayer)]);
    for (const slot of slots) {
      const before = typeof parentLayer[slot] === 'string' ? parentLayer[slot] : '';
      const after = typeof childLayer[slot] === 'string' ? childLayer[slot] : '';
      if (before !== after) {
        changed.push({ layer, slot, before, after });
      } else if (before !== '') {
        unchanged.push(`${layer}.${slot}`);
      }
    }
  }
  return { changed, unchanged };
}

export interface CandidateDiffEntry {
  candidateId: string;
  isWinner: boolean;
  rating?: number;
  note?: string;
  diff: CandidateDiff;
}

export interface ReflectionSnapshot {
  goal: string;
  parentSlots: SlotMap;
  candidates: CandidateDiffEntry[];
  rationale: string;
  /** The human's optional per-layer assessments; when omitted, the prompt tells the model they
   *  were not supplied (any derived assessments it mentions must be labeled inference). */
  layerAssessments: { layer: string; assessment: 'improved' | 'unchanged' | 'regressed' }[];
  priorLessonIds: string[];
  /** Bounded full-body wiki context, pre-formatted by the caller; '' when the wiki is empty. */
  wikiContext: string;
  /** The revision ids the wiki context was selected from. */
  wikiRevisionIds: string[];
}

function formatSlots(slots: SlotMap): string {
  const lines: string[] = [];
  for (const [layerId, layerSlots] of Object.entries(slots ?? {})) {
    const entries = Object.entries(layerSlots ?? {});
    if (entries.length === 0) {
      lines.push(`- ${layerId}: (no slots)`);
      continue;
    }
    lines.push(`- ${layerId}: ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  }
  return lines.join('\n');
}

function formatAssessments(assessments: ReflectionSnapshot['layerAssessments']): string {
  if (assessments.length === 0) {
    return '(none supplied — the ratings/notes/rationale are the evidence; any layer judgement you ' +
      'add must be labeled as inference)';
  }
  return assessments.map((a) => `- ${a.layer}: ${a.assessment}`).join('\n');
}

/** Pure: the compact episode record as the reflection call's user content. No composed prompts —
 *  only the parent chromosome and the server-computed diffs. */
export function buildReflectionUserPrompt(snapshot: ReflectionSnapshot): string {
  const parts: string[] = [`Round goal: ${snapshot.goal}`];
  parts.push('Parent chromosome:', formatSlots(snapshot.parentSlots));
  parts.push(
    'Candidate changes:',
    snapshot.candidates
      .map((c) => {
        const rating = c.rating !== undefined ? ` [rating ${c.rating}/5]` : '';
        const note = c.note && c.note !== '' ? ` note: ${c.note}` : '';
        const head = `- ${c.candidateId}${c.isWinner ? ' (winner)' : ''}${rating}${note}`;
        const changed = c.diff.changed.map((ch) => `    ${ch.layer}.${ch.slot}: ${ch.before || '(empty)'} -> ${ch.after || '(empty)'}`).join('\n');
        const unchanged = c.diff.unchanged.length > 0 ? `    unchanged: ${c.diff.unchanged.join(', ')}` : '';
        const body = [changed, unchanged].filter((s) => s !== '').join('\n');
        return body === '' ? `${head}\n    (no changes)` : `${head}\n${body}`;
      })
      .join('\n\n'),
  );
  parts.push('Human assessment:');
  parts.push(`  rationale: ${snapshot.rationale || '(none — a winner was picked without prose; treat the ratings/notes as the evidence)'}`);
  parts.push(`  layer assessments:\n${formatAssessments(snapshot.layerAssessments)}`);
  parts.push(`Winner: ${snapshot.candidates.find((c) => c.isWinner)?.candidateId ?? '(none)'}`);
  parts.push(
    `Prior lessons used: ${snapshot.priorLessonIds.length > 0 ? snapshot.priorLessonIds.join(', ') : '(none — exploratory round)'}`,
  );
  parts.push(
    snapshot.wikiContext.trim() !== ''
      ? `Wiki context (current lessons, bounded — ${snapshot.wikiRevisionIds.length} revision(s)):\n${snapshot.wikiContext}`
      : 'Wiki context: (empty — no lessons projected yet)',
  );
  parts.push('Call submit_lesson with your derived lesson, or insufficient_evidence if the evidence is ambiguous.');
  return parts.join('\n\n');
}