/**
 * @file orchestrator/src/portraits/portraitTelemetry.ts
 * @stamp 2026-08-19
 * @architectural-role Pure Function — merge + aggregation for Portrait Studio round telemetry
 *   (docs/plans/portrait-studio-telemetry-plan.md)
 * @description
 * The single aggregation implementation for a Portrait round's per-call account. It merges two
 * already-fetched row lists — llm_calls (RLS-exempt, the sole LLM accounting ledger) and
 * visual_round_image_calls (the image-render ledger this plan adds) — into one chronological
 * call list, derives each LLM row's phase/label from its call_label at read time, and computes
 * the round's totals. No database or provider calls; the route (portraitTelemetryRoutes.ts)
 * does all IO and hands the fetched rows in.
 *
 * Ordering (plan §Endpoint and polling): llm_calls rows sort by created_at (call-completion
 * order — adequate since portrait LLM calls in a round are sequential, never parallel); image
 * rows sort by started_at (they do run in parallel). The merge produces one ascending
 * chronological list across both sources.
 *
 * Wire-shape conventions (plan §HTTP / §Totals): unavailable token fields are OMITTED, never
 * returned as zero — an image call therefore carries duration and provider info but no
 * misleading token values, and a provider that reported no usage yields a call row with timing
 * and status only. Totals sum non-null values only; failed calls are included in duration
 * totals; cacheReadTokens appears only when at least one llm_calls row reported cache
 * accounting.
 *
 * An llm_calls row whose round_id is set but whose call_label isn't one of the three portrait
 * labels is a data anomaly that cannot happen by construction (round_id is only ever set by the
 * portrait paths, which always label their calls) — the merge skips it (there is no 5th phase to
 * represent), while totals still count it, matching the plan's literal "sum the round's
 * llm_calls rows".
 *
 * @api-declaration
 * LlmCallRow / ImageCallRow / VisualRoundRow — the row shapes the route's queries produce
 * mergeRoundCalls(llmRows, imageRows) -> PortraitCallTelemetry[] — pure chronological merge
 * computeRoundTotals(llmRows, imageRows, round) -> PortraitRoundTotals — pure aggregation
 * buildRoundTelemetry(round, llmRows, imageRows) -> PortraitRoundTelemetry — the endpoint payload
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO, no state, no randomness)
 *     state_ownership: []
 *     external_io:     []
 */

export type PortraitRoundStatus = 'running' | 'succeeded' | 'failed' | 'partial';
export type PortraitCallPhase = 'mutation' | 'wiki_pull' | 'image_render' | 'reflection';
export type PortraitCallStatus = 'running' | 'succeeded' | 'failed';

/** The llm_calls row shape the telemetry route selects (llm_calls is RLS-exempt, so the route
 *  explicitly filters by round_id AND user_id and passes the user-scoped subset in here). */
export interface LlmCallRow {
  call_id: string;
  user_id: string;
  outcome: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cache_read_tokens: number | null;
  duration_ms: number | null;
  reason: string | null;
  created_at: string;
  provider_kind: string;
  model: string;
  call_label: string | null;
}

/** The visual_round_image_calls row shape (normal user-scoped RLS — the route reads it through
 *  db.withUserScope). */
export interface ImageCallRow {
  call_id: string;
  round_id: string;
  candidate_id: string | null;
  status: string;
  provider_kind: string | null;
  model: string | null;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
}

/** The visual_rounds row shape the telemetry route loads FIRST — the ownership check (a missing
 *  row is a 404, and its started_at/completed_at drive wall-clock duration). */
export interface VisualRoundRow {
  round_id: string;
  goal: string;
  started_at: string;
  completed_at: string | null;
  status: string;
}

export interface PortraitCallTelemetry {
  callId: string;
  phase: PortraitCallPhase;
  label: string;
  status: PortraitCallStatus;
  providerKind?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  /** Set only on phase 'image_render' rows — visual_round_image_calls.candidate_id. LLM-sourced
   *  rows never carry one. */
  candidateId?: string;
  createdAt: string;
}

export interface PortraitRoundTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  llmDurationMs: number;
  imageDurationMs: number;
  wallClockDurationMs: number;
}

export interface PortraitRoundTelemetry {
  roundId: string;
  status: PortraitRoundStatus;
  calls: PortraitCallTelemetry[];
  totals: PortraitRoundTotals;
}

/** The three portrait call labels (plan §LLM calls) → their display phases. Any other label is
 *  not a portrait call and has no phase to represent. */
function phaseFromLabel(label: string | null): PortraitCallPhase | undefined {
  switch (label) {
    case 'portrait:mutation':
      return 'mutation';
    case 'portrait:wiki-pull':
      return 'wiki_pull';
    case 'portrait:reflection':
      return 'reflection';
    default:
      return undefined;
  }
}

/** An llm_calls row → its wire shape. An unrecognized call_label yields null (the row is
 *  skipped — there is no 5th phase to represent; see the header's anomaly note). Unavailable
 *  token fields are omitted, not zeroed (plan §HTTP). */
function llmRowToTelemetry(row: LlmCallRow): PortraitCallTelemetry | null {
  const phase = phaseFromLabel(row.call_label);
  if (!phase || !row.call_label) return null;
  return {
    callId: row.call_id,
    phase,
    label: row.call_label,
    status: row.outcome === 'ok' ? 'succeeded' : 'failed',
    ...(row.provider_kind ? { providerKind: row.provider_kind } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.prompt_tokens !== null ? { promptTokens: row.prompt_tokens } : {}),
    ...(row.completion_tokens !== null ? { completionTokens: row.completion_tokens } : {}),
    ...(row.total_tokens !== null ? { totalTokens: row.total_tokens } : {}),
    ...(row.cache_read_tokens !== null ? { cacheReadTokens: row.cache_read_tokens } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.reason ? { errorMessage: row.reason } : {}),
    createdAt: row.created_at,
  };
}

/** A visual_round_image_calls row → its wire shape: duration + provider info, NO token fields
 *  (image calls have none to report), exact provider error preserved on failure (plan §Edge
 *  Cases: rendered as escaped text, never as HTML). */
function imageRowToTelemetry(row: ImageCallRow): PortraitCallTelemetry {
  return {
    callId: row.call_id,
    phase: 'image_render',
    label: 'image_render',
    status: row.status === 'running' || row.status === 'succeeded' || row.status === 'failed' ? row.status : 'failed',
    ...(row.provider_kind ? { providerKind: row.provider_kind } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    ...(row.candidate_id ? { candidateId: row.candidate_id } : {}),
    createdAt: row.started_at,
  };
}

/** One ascending chronological call list across both sources (plan §Endpoint and polling):
 *  llm_calls rows on created_at, image rows on started_at. */
export function mergeRoundCalls(llmRows: LlmCallRow[], imageRows: ImageCallRow[]): PortraitCallTelemetry[] {
  const llmCalls = llmRows
    .map(llmRowToTelemetry)
    .filter((c): c is PortraitCallTelemetry => c !== null)
    .map((c) => ({ c, ts: Date.parse(c.createdAt) }));
  const imageCalls = imageRows.map(imageRowToTelemetry).map((c) => ({ c, ts: Date.parse(c.createdAt) }));
  return [...llmCalls, ...imageCalls]
    .sort((a, b) => a.ts - b.ts)
    .map((e) => e.c);
}

function sumNonNull(values: ReadonlyArray<number | null | undefined>): number {
  let sum = 0;
  for (const v of values) {
    if (typeof v === 'number') sum += v;
  }
  return sum;
}

/** The round's totals (plan §Totals): LLM token sums and LLM/image duration sums over non-null
 *  values from the already-fetched rows (failed calls included in durations); cacheReadTokens
 *  only when at least one llm_calls row reported cache accounting; wall-clock = completed_at
 *  (or now while running) minus started_at — NOT the sum of parallel image calls. */
export function computeRoundTotals(
  llmRows: LlmCallRow[],
  imageRows: ImageCallRow[],
  round: Pick<VisualRoundRow, 'started_at' | 'completed_at'>,
): PortraitRoundTotals {
  const promptTokens = sumNonNull(llmRows.map((r) => r.prompt_tokens));
  const completionTokens = sumNonNull(llmRows.map((r) => r.completion_tokens));
  const totalTokens = sumNonNull(llmRows.map((r) => r.total_tokens));
  const anyCache = llmRows.some((r) => r.cache_read_tokens !== null);
  const cacheReadTokens = anyCache ? sumNonNull(llmRows.map((r) => r.cache_read_tokens)) : undefined;
  const llmDurationMs = sumNonNull(llmRows.map((r) => r.duration_ms));
  const imageDurationMs = sumNonNull(imageRows.map((r) => r.duration_ms));
  const endMs = round.completed_at ? Date.parse(round.completed_at) : Date.now();
  const startMs = Date.parse(round.started_at);
  const wallClockDurationMs = Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(anyCache ? { cacheReadTokens } : {}),
    llmDurationMs,
    imageDurationMs,
    wallClockDurationMs,
  };
}

/** The GET /v1/portraits/rounds/:roundId/telemetry payload, straight from the route's fetched
 *  rows. */
export function buildRoundTelemetry(
  round: VisualRoundRow,
  llmRows: LlmCallRow[],
  imageRows: ImageCallRow[],
): PortraitRoundTelemetry {
  return {
    roundId: round.round_id,
    status: round.status === 'running' || round.status === 'succeeded' || round.status === 'failed' || round.status === 'partial' ? round.status : 'running',
    calls: mergeRoundCalls(llmRows, imageRows),
    totals: computeRoundTotals(llmRows, imageRows, round),
  };
}