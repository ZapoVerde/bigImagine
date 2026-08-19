/**
 * @file orchestrator/src/orchestrator/portraitFeedback.ts
 * @stamp 2026-08-18
 * @architectural-role Orchestrator — human evaluation, episode logging, the truthful reflection
 *   state machine, and the lesson ledger (docs/plans/portrait-studio-vision-review-harness-plan.md
 *   §Reflection contract / §State machine / §Data model)
 * @description
 * The feedback half of Portrait Studio, rebuilt for reliable reflection: submitPortraitFeedback
 * writes the visual_episodes row with a truthful reflection_status, stores per-candidate
 * ratings/notes and the episode-level rationale, promotes the winner per-entity per-layer (with a
 * winner_applied visual_episode_events row — changing slots is not evidence that learning
 * occurred), and — only when an explicit winner is selected — runs ONE bounded, evidence-based
 * reflection call (the plan retires the old multi-turn investigation loop and its
 * pull_wiki_entry/submit_conclusion tools).
 *
 * The reflection pass (plan §Reflection contract):
 *   1. Build the compact episode record from the immutable snapshot: goal, parent chromosome,
 *      server-computed per-candidate diffs (portraits/reflection.ts computeCandidateDiff — the
 *      model must never rediscover them from composed prompts), the human's
 *      ratings/notes/rationale/layer assessments, prior lesson ids (from the candidates' lesson_id
 *      provenance), and a bounded wiki context (visual_wiki_context_budget, never the entire wiki)
 *      with its revision ids.
 *   2. Call the gated LLM with the single forced submit_lesson tool (portraits/reflection.ts
 *      SUBMIT_LESSON_TOOL, taskId `visual-<subjectEntityId>-reflection`, kind 'system' — the same
 *      seam as the mutation call). No loop, no raw JSON.
 *   3. validateLessonCall is the strict gate: invalid output, provider errors, and timeouts become
 *      a failed attempt. The attempt is persisted to visual_episode_learning (immutable, one row
 *      per attempt) BEFORE the episode's learning state changes (plan §API step 4).
 *   4. conclusion → one visual_lessons row (state provisional) + a lesson_created event; the
 *      episode honestly reaches 'concluded'. insufficient_evidence → 'insufficient_evidence'
 *      without inventing a lesson. failure → 'failed', left visible and retryable.
 *
 * A no-winner submission still creates the episode in 'awaiting_feedback' and stores the supplied
 * ratings/notes/rationale; it does not trigger reflection (plan §State machine). An operator can
 * explicitly record "no acceptable candidate", which produces insufficient_evidence without an
 * LLM call. Retrying an episode (submitPortraitFeedback with episodeId) re-runs reflection as
 * attempt N+1 — a fresh immutable learning row per attempt, idempotent against prior attempts.
 *
 * Fail-open end to end: the episode + entity update are the feedback's primary write (they happen
 * first); a reflection failure is logged, persisted as a failed attempt, and surfaced in the
 * result as reflection: { action: 'failed', reason } — never a silently successful round.
 *
 * @api-declaration
 * PortraitFeedbackDeps — db, settings
 * submitPortraitFeedback(deps, llm, userId, input) -> Promise<PortraitFeedbackResult>
 *   — fail-open; { ok, episodeId?, reflection?, error? }
 * PortraitFeedbackInput — { episodeId? (retry an existing episode), entityIds?, goal?,
 *   candidateIds?, winnerId?, noAcceptableCandidate?, ratings?, notes?, rationale?,
 *   layerAssessments? }
 * ReflectionOutcome — { action: 'concluded' | 'insufficient_evidence' | 'failed' |
 *   'awaiting_feedback', lessonId?, reason? }
 * LayerAssessmentInput — { layer, assessment: 'improved' | 'unchanged' | 'regressed' }
 * DEFAULT_REFLECTION_SYSTEM_PROMPT — re-exported from portraits/reflection.ts (adminServer.ts's
 *   Settings fieldset renders the default, §17)
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, settings read, one bounded LLM tool call, lesson writes)
 *     state_ownership: []
 *     external_io:     [Postgres (visual_episodes/visual_candidates/visual_entities/
 *                       visual_episode_learning/visual_lessons/visual_episode_events/
 *                       visual_wiki_entries via db.withUserScope), orchestrator_settings (read),
 *                       the LLM via the injected provider]
 *     never:           throws. Every failure path logs and folds into the structured result.
 */

import { log } from '../io/logger.js';
import { runWithCallContext, withCallLabel, withRoundId } from '../io/llm/callContext.js';
import type { LlmMessage, LlmProvider, LlmTurn } from '../io/llm/types.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import type { PostgresClient } from '../io/postgres.js';
import { loadLayerManifest } from '../portraits/layerStack.js';
import type { CandidateChromosome } from '../portraits/reconcile.js';
import { formatLessonIndex, type LessonIndexRow } from '../portraits/wiki.js';
import {
  buildReflectionUserPrompt,
  computeCandidateDiff,
  DEFAULT_REFLECTION_SYSTEM_PROMPT,
  SUBMIT_LESSON_TOOL,
  validateLessonCall,
  type LessonConclusion,
  type LessonOutput,
  type ReflectionSnapshot,
} from '../portraits/reflection.js';
import { DEFAULT_WIKI_CONTEXT_BUDGET, loadAllWikiEntries, selectBoundedWikiContext } from './portraitGeneration.js';

export { DEFAULT_REFLECTION_SYSTEM_PROMPT } from '../portraits/reflection.js';

export interface PortraitFeedbackDeps {
  db: PostgresClient;
  settings: OrchestratorSettingsStore;
}

export interface LayerAssessmentInput {
  layer: string;
  assessment: 'improved' | 'unchanged' | 'regressed';
}

export interface PortraitFeedbackInput {
  /** Retry/complete feedback on an existing episode — re-runs reflection as attempt N+1 (its own
   *  immutable visual_episode_learning row). When set, entityIds/goal/candidateIds are not needed;
   *  the episode provides them. */
  episodeId?: string;
  /** The generation round this feedback evaluates (docs/plans/portrait-studio-telemetry-plan.md).
   *  Stored on the episode and used to correlate Reflection (+ retries) to the round's llm_calls.
   *  Optional for a fresh round (a historical generation has no round); always null for a retry —
   *  the episode's own round_id governs. */
  roundId?: string;
  /** The round's entity map — the episode's entity_ids record. Required for a fresh round. */
  entityIds?: Record<string, string>;
  /** The round's goal. Required for a fresh round. */
  goal?: string;
  /** Every candidate in the round, in grid order. Required for a fresh round. */
  candidateIds?: string[];
  /** The human-picked winner — must be one of the round's candidates. Optional: a no-winner
   *  submission stays awaiting_feedback and does not trigger reflection (plan §State machine). */
  winnerId?: string;
  /** The operator explicitly records "no acceptable candidate" — produces insufficient_evidence
   *  without an LLM call (plan §State machine). */
  noAcceptableCandidate?: boolean;
  /** Per-candidate 1-5 ratings, { [candidateId]: rating }. */
  ratings?: Record<string, number>;
  /** Per-candidate notes, { [candidateId]: note }. */
  notes?: Record<string, string>;
  /** The human's overall rationale — required when marking a winner (a rating without an
   *  explanation is preference data, not a completed lesson). */
  rationale?: string;
  /** Optional per-layer assessments (improved/unchanged/regressed); when omitted, the reflection
   *  prompt tells the model they were not supplied. */
  layerAssessments?: LayerAssessmentInput[];
}

export interface ReflectionOutcome {
  action: 'concluded' | 'insufficient_evidence' | 'failed' | 'awaiting_feedback';
  /** The created lesson id, when a conclusion landed. */
  lessonId?: string;
  /** The human-readable lesson title/statement for UI receipts; the id remains the durable key. */
  lessonTitle?: string;
  /** Set when this conclusion amended an existing lesson (docs/plans/
   *  portrait-studio-lesson-amend-plan.md) rather than creating a new one — the old lesson's id,
   *  now state='superseded'. */
  supersedesLessonId?: string;
  /** Why the pass failed (LLM error, undecodable/ invalid conclusion) — always logged. */
  reason?: string;
}

export interface PortraitFeedbackResult {
  ok: boolean;
  episodeId?: string;
  /** The round this episode evaluates, when it has one — echoes what the reflection calls rode
   *  on so the Studio can fetch the round's telemetry after feedback lands. */
  roundId?: string;
  reflection?: ReflectionOutcome;
  error?: string;
}

interface EpisodeRow {
  episode_id: string;
  entity_ids: Record<string, string>;
  goal: string;
  rationale: string | null;
  selected_candidate_id: string | null;
  candidate_ids: string[];
  reflection_status: string;
  round_id: string | null;
}

interface CandidateRow {
  candidate_id: string;
  entity_ids: Record<string, string>;
  image_url: string | null;
  chromosome: CandidateChromosome;
  parent_chromosome: CandidateChromosome | null;
  composed_prompt: string | null;
  render_metadata: Record<string, unknown> | null;
  wiki_revision_ids: string[] | null;
  lesson_id: string | null;
  rating: number | null;
  note: string | null;
}

interface ReflectionPassContext {
  subjectEntityId: string;
  episodeId: string;
  episodeEntityIds: Record<string, string>;
  goal: string;
  rationale: string;
  candidates: CandidateRow[];
  /** Undefined = no acceptable candidate (the "no winner" record). */
  winnerId?: string;
  ratings: Record<string, number>;
  notes: Record<string, string>;
  layerAssessments: LayerAssessmentInput[];
  /** The generation round this reflection belongs to — rides withRoundId onto the call's
   *  llm_calls.round_id. Null on a historical episode with no linked round (plan: "do not invent
   *  telemetry"). */
  roundId: string | null;
}

// ---- DB seams ------------------------------------------------------------------

async function loadEpisode(db: PostgresClient, userId: string, episodeId: string): Promise<EpisodeRow | undefined> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<EpisodeRow>(
      `select episode_id, entity_ids, goal, rationale, selected_candidate_id, candidate_ids, reflection_status, round_id
       from visual_episodes where episode_id = $1 and user_id = $2`,
      [episodeId, userId],
    ),
  );
  return rows[0];
}

async function loadCandidates(db: PostgresClient, userId: string, candidateIds: string[]): Promise<CandidateRow[]> {
  return db.withUserScope(userId, (session) =>
    session.query<CandidateRow>(
      `select candidate_id, entity_ids, image_url, chromosome, parent_chromosome, composed_prompt,
              render_metadata, wiki_revision_ids, lesson_id, rating, note
       from visual_candidates where user_id = $1 and candidate_id = any($2::uuid[])
       order by array_position($2::uuid[], candidate_id)`,
      [userId, candidateIds],
    ),
  );
}

async function nextAttempt(db: PostgresClient, userId: string, episodeId: string): Promise<number> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<{ n: string }>(
      'select count(*)::text as n from visual_episode_learning where user_id = $1 and episode_id = $2',
      [userId, episodeId],
    ),
  );
  const n = Number(rows[0]?.n ?? '0');
  return Number.isFinite(n) ? n + 1 : 1;
}

async function storeRatingsAndNotes(
  deps: PortraitFeedbackDeps,
  userId: string,
  ratings: Record<string, number> | undefined,
  notes: Record<string, string> | undefined,
): Promise<void> {
  for (const [candidateId, rating] of Object.entries(ratings ?? {})) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      log.warn('portraitFeedback: skipping out-of-range rating', { candidateId, rating });
      continue;
    }
    await deps.db.withUserScope(userId, (session) =>
      session.query('update visual_candidates set rating = $2 where candidate_id = $1 and user_id = $3', [candidateId, rating, userId]),
    );
  }
  for (const [candidateId, note] of Object.entries(notes ?? {})) {
    if (typeof note !== 'string') continue;
    await deps.db.withUserScope(userId, (session) =>
      session.query('update visual_candidates set note = $2 where candidate_id = $1 and user_id = $3', [candidateId, note, userId]),
    );
  }
}

/** Winner promotion — per-entity, per-layer: each [layerId, entityId] pair in the winning
 *  candidate's entity_ids (the round's authoritative record) gets its own layer's values from the
 *  winning chromosome written onto its `slots` column — never another layer's values, never the
 *  whole chromosome, and a layer absent from the chromosome leaves that entity's slots untouched
 *  rather than overwriting hand-tuned values with an empty object. The winning shape becomes the
 *  entity's durable state, so the next round's parent chromosome refines it instead of the original
 *  placeholder. The promotion is recorded as its own winner_applied event: changing slots is not
 *  evidence that learning occurred (plan §State machine). Fail-open (§11): an entity deleted
 *  mid-round simply affects zero rows. */
async function applyWinner(deps: PortraitFeedbackDeps, userId: string, episodeId: string, winner: CandidateRow): Promise<void> {
  const winnerSlots = winner.chromosome?.slots ?? {};
  for (const [layerId, entityId] of Object.entries(winner.entity_ids ?? {})) {
    const layerSlots = winnerSlots[layerId];
    await deps.db.withUserScope(userId, (session) =>
      session.query(
        layerSlots !== undefined
          ? `update visual_entities set last_image_url = $1, current_best_candidate_id = $2, slots = $3::jsonb, updated_at = now()
             where user_id = $4 and entity_id = $5`
          : `update visual_entities set last_image_url = $1, current_best_candidate_id = $2, updated_at = now()
             where user_id = $3 and entity_id = $4`,
        layerSlots !== undefined
          ? [winner.image_url, winner.candidate_id, JSON.stringify(layerSlots), userId, entityId]
          : [winner.image_url, winner.candidate_id, userId, entityId],
      ),
    );
  }
  await deps.db.withUserScope(userId, (session) =>
    session.query(
      `insert into visual_episode_events (user_id, episode_id, event_type, payload)
       values ($1, $2, 'winner_applied', $3::jsonb)`,
      [userId, episodeId, JSON.stringify({ candidateId: winner.candidate_id, appliedChromosome: winner.chromosome })],
    ),
  );
}

/** The visual_wiki_context_budget cap, same "default + bespoke" numeric shape as every numeric
 *  setting — unset/corrupt falls back to the built-in, never "unlimited" (never the entire wiki). */
async function wikiBudget(deps: PortraitFeedbackDeps): Promise<number> {
  const raw = await deps.settings.get('visual_wiki_context_budget');
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_WIKI_CONTEXT_BUDGET;
}

// ---- Reflection -----------------------------------------------------------------

/** Every non-terminal (provisional/supported) lesson the user owns, joined to its wiki entry's
 *  subscriptions — formatLessonIndex's raw input (docs/plans/portrait-studio-lesson-amend-plan.md).
 *  A lesson with no linked wiki entry (a legacy row predating migration 0120's lesson_id column,
 *  or a genuine data gap) is excluded — it has no subscription reach to test and would otherwise
 *  need an invented one. */
async function loadExistingLessonsIndexRows(db: PostgresClient, userId: string): Promise<LessonIndexRow[]> {
  return db.withUserScope(userId, (session) =>
    session.query<LessonIndexRow>(
      `select l.lesson_id, l.statement, l.next_change ->> 'layer' as layer, l.state, w.subscriptions
       from visual_lessons l
       join visual_wiki_entries w on w.lesson_id = l.lesson_id and w.user_id = l.user_id
       where l.user_id = $1 and l.state in ('provisional', 'supported')`,
      [userId],
    ),
  );
}

/** The compact episode record as the immutable input snapshot: goal, parent chromosome,
 *  server-computed diffs, the human's evaluation, prior lesson ids (from the candidates' lesson_id
 *  provenance), the bounded wiki context with the revision ids that back it, and the existing-
 *  lesson index reflection can amend from instead of duplicating. */
async function buildReflectionSnapshot(
  deps: PortraitFeedbackDeps,
  userId: string,
  ctx: ReflectionPassContext,
): Promise<ReflectionSnapshot> {
  const manifest = await loadLayerManifest({ settings: deps.settings });
  const allWikiEntries = await loadAllWikiEntries(deps.db, userId);
  const activeEntityIds = [...new Set(Object.values(ctx.episodeEntityIds ?? {}))];
  const activeLayerTypes = manifest.layers.map((l) => l.id);
  const bounded = selectBoundedWikiContext(allWikiEntries, activeEntityIds, activeLayerTypes, await wikiBudget(deps));
  const existingLessons = await loadExistingLessonsIndexRows(deps.db, userId);
  const parentSlots = ctx.candidates[0]?.parent_chromosome?.slots ?? {};
  const priorLessonIds = [...new Set(ctx.candidates.map((c) => c.lesson_id).filter((v): v is string => v !== null))];
  return {
    goal: ctx.goal,
    parentSlots,
    candidates: ctx.candidates.map((c) => ({
      candidateId: c.candidate_id,
      isWinner: ctx.winnerId !== undefined && c.candidate_id === ctx.winnerId,
      rating: ctx.ratings[c.candidate_id] ?? c.rating ?? undefined,
      note: ctx.notes[c.candidate_id] ?? c.note ?? undefined,
      diff: computeCandidateDiff(parentSlots, c.chromosome?.slots ?? {}),
    })),
    rationale: ctx.rationale,
    layerAssessments: ctx.layerAssessments,
    priorLessonIds,
    wikiContext: bounded.text,
    wikiRevisionIds: bounded.revisionIds,
    existingLessonsIndex: formatLessonIndex(existingLessons, activeEntityIds, activeLayerTypes),
  };
}

/** Persist the immutable attempt row BEFORE any learning state changes (plan §API step 4). status
 *  is the truthful outcome ('concluded' | 'insufficient_evidence' | 'failed'); output_snapshot is
 *  the validated lesson or the provider/validation error (jsonb — any truthful snapshot shape). */
async function persistAttempt(
  deps: PortraitFeedbackDeps,
  userId: string,
  episodeId: string,
  attempt: number,
  status: 'concluded' | 'insufficient_evidence' | 'failed',
  snapshot: ReflectionSnapshot,
  output: LessonOutput | { error: string } | { status: 'insufficient_evidence'; operatorRecorded: boolean },
  connection: string | null = null,
): Promise<string> {
  const rows = await deps.db.withUserScope(userId, (session) =>
    session.query<{ learning_id: string }>(
      `insert into visual_episode_learning (user_id, episode_id, attempt, status, input_snapshot, output_snapshot, connection)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) returning learning_id`,
      [userId, episodeId, attempt, status, JSON.stringify(snapshot), JSON.stringify(output), connection],
    ),
  );
  return rows[0].learning_id;
}

async function setEpisodeStatus(deps: PortraitFeedbackDeps, userId: string, episodeId: string, status: string): Promise<void> {
  await deps.db.withUserScope(userId, (session) =>
    session.query('update visual_episodes set reflection_status = $2 where episode_id = $1 and user_id = $3', [episodeId, status, userId]),
  );
}

/** A failed attempt: persisted (immutable, retryable), a reflection_failed event, and the episode
 *  honestly marked 'failed'. */
async function persistFailedAttempt(
  deps: PortraitFeedbackDeps,
  userId: string,
  episodeId: string,
  attempt: number,
  snapshot: ReflectionSnapshot,
  err: unknown,
  connection: string | null = null,
): Promise<ReflectionOutcome> {
  const reason = err instanceof Error ? err.message : String(err);
  const learningId = await persistAttempt(deps, userId, episodeId, attempt, 'failed', snapshot, { error: reason }, connection);
  await deps.db.withUserScope(userId, (session) =>
    session.query(
      `insert into visual_episode_events (user_id, episode_id, event_type, payload)
       values ($1, $2, 'reflection_failed', $3::jsonb)`,
      [userId, episodeId, JSON.stringify({ learningId, reason })],
    ),
  );
  await setEpisodeStatus(deps, userId, episodeId, 'failed');
  log.error('portraitFeedback: reflection failed', { episodeId, attempt, reason });
  return { action: 'failed', reason };
}

/** Only a validated conclusion creates a lesson (plan §Data model / §Wiki policy) — state
 *  provisional until repeated supporting episodes or explicit operator approval promote it.
 *
 *  When output.supersedesLessonId names an existing owned provisional/supported lesson (shown to
 *  the model via the Existing lessons index — docs/plans/portrait-studio-lesson-amend-plan.md),
 *  that lesson is marked superseded and its wiki entry is amended in place (a new
 *  visual_wiki_revisions row, kind='amended') instead of a near-duplicate entry being written. An
 *  id that doesn't resolve — wrong user, already terminal, or simply invented — is a caller
 *  (model) mistake, not a hard failure: it's logged and the round falls back to a plain create,
 *  never silently drops the new lesson (bi_principles.md §11). The plain create path now also
 *  writes its own visual_wiki_revisions row (kind='created') — previously only the legacy backfill
 *  in migration 0118 ever populated that table, so reflection-created entries had no history at
 *  all until their first amendment. */
async function insertLesson(
  deps: PortraitFeedbackDeps,
  userId: string,
  episodeId: string,
  learningId: string,
  episodeEntityIds: Record<string, string>,
  output: LessonConclusion,
): Promise<{ lessonId: string; lessonTitle: string; supersedesLessonId?: string }> {
  const lessonTitle = output.lesson.slice(0, 100);
  const body = `${output.lesson}\n\nEvidence: ${output.evidence}`;
  const result = await deps.db.withUserScope(userId, async (session) => {
    const lessonRows = await session.query<{ lesson_id: string }>(
      `insert into visual_lessons (user_id, source_episode_id, source_learning_id, statement, evidence, next_change, preserve, confidence, state)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::text[], $8, 'provisional') returning lesson_id`,
      [userId, episodeId, learningId, output.lesson, output.evidence, JSON.stringify(output.nextChange), output.preserve ?? [], output.confidence],
    );
    const newLessonId = lessonRows[0].lesson_id;

    const layerType = output.nextChange.layer;
    const layerEntityId = episodeEntityIds[layerType] ?? null;
    const entityRows = layerEntityId
      ? await session.query<{ name: string }>(
          `select name from visual_entities where entity_id = $1 and user_id = $2`,
          [layerEntityId, userId],
        )
      : [];
    const slug = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const tags = [...new Set([
      slug(layerType),
      ...(entityRows[0]?.name ? [slug(entityRows[0].name)] : []),
    ].filter(Boolean))];
    const subscriptions = [{ layerType, layerEntityId }];

    const target = output.supersedesLessonId
      ? await session.query<{ lesson_id: string }>(
          `select lesson_id from visual_lessons where lesson_id = $1 and user_id = $2 and state in ('provisional', 'supported')`,
          [output.supersedesLessonId, userId],
        )
      : [];
    if (output.supersedesLessonId && target.length === 0) {
      log.warn('portraitFeedback: supersedes_lesson_id did not resolve to an amendable lesson, falling back to create', {
        supersedesLessonId: output.supersedesLessonId,
      });
    }

    if (target.length > 0) {
      const supersededId = output.supersedesLessonId as string;
      await session.query(`update visual_lessons set state = 'superseded' where lesson_id = $1 and user_id = $2`, [supersededId, userId]);
      const entryRows = await session.query<{ entry_id: string }>(
        `select entry_id from visual_wiki_entries where lesson_id = $1 and user_id = $2`,
        [supersededId, userId],
      );
      if (entryRows[0]) {
        const entryId = entryRows[0].entry_id;
        await session.query(
          `update visual_wiki_entries set title = $2, body = $3, tags = $4::text[], subscriptions = $5::jsonb, lesson_id = $6, updated_at = now()
           where entry_id = $1 and user_id = $7`,
          [entryId, lessonTitle, body, tags, JSON.stringify(subscriptions), newLessonId, userId],
        );
        const revRows = await session.query<{ n: number }>(
          `select coalesce(max(revision_number), 0) + 1 as n from visual_wiki_revisions where entry_id = $1 and user_id = $2`,
          [entryId, userId],
        );
        await session.query(
          `insert into visual_wiki_revisions (user_id, entry_id, revision_number, content, kind, lesson_ids, episode_ids, source)
           values ($1, $2, $3, $4::jsonb, 'amended', $5::uuid[], $6::uuid[], 'reflection')`,
          [userId, entryId, revRows[0].n, JSON.stringify({ title: lessonTitle, body, tags, subscriptions }), [supersededId, newLessonId], [episodeId]],
        );
        return { lessonId: newLessonId, supersededId };
      }
      // The superseded lesson had no linked wiki entry (a gap the migration 0120 backfill
      // couldn't close) — the old lesson is still correctly marked superseded above; fall through
      // to write a fresh entry for the new lesson, same as a plain create.
    }

    const entryRows = await session.query<{ entry_id: string }>(
      `insert into visual_wiki_entries (user_id, title, body, tags, subscriptions, origin_episode_id, lesson_id)
       values ($1, $2, $3, $4::text[], $5::jsonb, $6, $7) returning entry_id`,
      [userId, lessonTitle, body, tags, JSON.stringify(subscriptions), episodeId, newLessonId],
    );
    await session.query(
      `insert into visual_wiki_revisions (user_id, entry_id, revision_number, content, kind, lesson_ids, episode_ids, source)
       values ($1, $2, 1, $3::jsonb, 'created', $4::uuid[], $5::uuid[], 'reflection')`,
      [userId, entryRows[0].entry_id, JSON.stringify({ title: lessonTitle, body, tags, subscriptions }), [newLessonId], [episodeId]],
    );
    return { lessonId: newLessonId, supersededId: undefined as string | undefined };
  });
  return { lessonId: result.lessonId, lessonTitle, ...(result.supersededId ? { supersedesLessonId: result.supersededId } : {}) };
}

/** The one bounded reflection call (plan §Reflection contract) — forced submit_lesson, no loop.
 *  The attempt is persisted before the episode's state changes; the episode reaches its truthful
 *  terminal state ('concluded' | 'insufficient_evidence' | 'failed') only after that. */
async function runReflectionCall(
  deps: PortraitFeedbackDeps,
  llm: LlmProvider,
  userId: string,
  ctx: ReflectionPassContext,
  snapshot: ReflectionSnapshot,
  attempt: number,
  connection: string | null = null,
): Promise<ReflectionOutcome> {
  const override = await deps.settings.get('visual_reflection_system_prompt_override');
  const system = (override ?? '').trim() || DEFAULT_REFLECTION_SYSTEM_PROMPT;
  const messages: LlmMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: buildReflectionUserPrompt(snapshot) },
  ];
  const runCall = () => llm.complete(messages, [SUBMIT_LESSON_TOOL], { forceTool: 'submit_lesson' });
  const turn: LlmTurn = await runWithCallContext(
    { taskId: `visual-${ctx.subjectEntityId}-reflection`, kind: 'system', userId },
    // The reflection call (and every retry) rides the episode's round_id so it correlates to the
    // round's llm_calls on round_id (plan §Round lifecycle). A historical episode with no round
    // makes the plain, un-correlated call — nothing invented.
    () => withCallLabel('portrait:reflection', () => (ctx.roundId ? withRoundId(ctx.roundId, runCall) : runCall())),
  );

  const submitLesson = turn.toolCalls.find((c) => c.name === 'submit_lesson');
  if (!submitLesson) {
    return persistFailedAttempt(deps, userId, ctx.episodeId, attempt, snapshot, new Error('no submit_lesson tool call in reply'), connection);
  }
  const validated = validateLessonCall(submitLesson);
  if (!validated.ok) {
    return persistFailedAttempt(deps, userId, ctx.episodeId, attempt, snapshot, new Error(validated.reason), connection);
  }
  const output = validated.output;
  const status = output.status === 'conclusion' ? 'concluded' : 'insufficient_evidence';
  const learningId = await persistAttempt(deps, userId, ctx.episodeId, attempt, status, snapshot, output, connection);

  if (output.status === 'insufficient_evidence') {
    await deps.db.withUserScope(userId, (session) =>
      session.query(
        `insert into visual_episode_events (user_id, episode_id, event_type, payload)
         values ($1, $2, 'insufficient_evidence', $3::jsonb)`,
        [userId, ctx.episodeId, JSON.stringify({ learningId })],
      ),
    );
    await setEpisodeStatus(deps, userId, ctx.episodeId, 'insufficient_evidence');
    log.info('portraitFeedback: reflection concluded insufficient_evidence', { episodeId: ctx.episodeId, attempt });
    return { action: 'insufficient_evidence' };
  }

  const lesson = await insertLesson(deps, userId, ctx.episodeId, learningId, ctx.episodeEntityIds, output);
  await deps.db.withUserScope(userId, (session) =>
    session.query(
      `insert into visual_episode_events (user_id, episode_id, event_type, payload)
       values ($1, $2, 'lesson_created', $3::jsonb)`,
      [
        userId,
        ctx.episodeId,
        JSON.stringify({
          learningId,
          lessonId: lesson.lessonId,
          statement: output.lesson,
          nextChange: output.nextChange,
          preserve: output.preserve ?? [],
          confidence: output.confidence,
          ...(lesson.supersedesLessonId ? { supersedesLessonId: lesson.supersedesLessonId } : {}),
        }),
      ],
    ),
  );
  await setEpisodeStatus(deps, userId, ctx.episodeId, 'concluded');
  log.info('portraitFeedback: reflection concluded a lesson', {
    episodeId: ctx.episodeId,
    attempt,
    lessonId: lesson.lessonId,
    supersedesLessonId: lesson.supersedesLessonId ?? null,
  });
  return {
    action: 'concluded',
    lessonId: lesson.lessonId,
    lessonTitle: lesson.lessonTitle,
    ...(lesson.supersedesLessonId ? { supersedesLessonId: lesson.supersedesLessonId } : {}),
  };
}

/** The reflection pass: persist nothing about learning until the snapshot is built; mark
 *  reflection_started; run the one call; every failure folds into a persisted failed attempt. */
async function runReflectionPass(
  deps: PortraitFeedbackDeps,
  llm: LlmProvider,
  userId: string,
  ctx: ReflectionPassContext,
): Promise<ReflectionOutcome> {
  const attempt = await nextAttempt(deps.db, userId, ctx.episodeId);
  const connection = (await deps.settings.get('portrait_llm_connection'))?.trim() || null;
  let snapshot: ReflectionSnapshot;
  try {
    snapshot = await buildReflectionSnapshot(deps, userId, ctx);
  } catch (err) {
    log.error('portraitFeedback: reflection snapshot build failed', { episodeId: ctx.episodeId, attempt, err });
    const emptySnapshot: ReflectionSnapshot = { goal: ctx.goal, parentSlots: {}, candidates: [], rationale: ctx.rationale, layerAssessments: ctx.layerAssessments, priorLessonIds: [], wikiContext: '', wikiRevisionIds: [], existingLessonsIndex: '' };
    return persistFailedAttempt(deps, userId, ctx.episodeId, attempt, emptySnapshot, err, connection);
  }
  await deps.db.withUserScope(userId, (session) =>
    session.query(
      `insert into visual_episode_events (user_id, episode_id, event_type, payload)
       values ($1, $2, 'reflection_started', $3::jsonb)`,
      [userId, ctx.episodeId, JSON.stringify({ attempt, wikiRevisionIds: snapshot.wikiRevisionIds })],
    ),
  );
  try {
    return await runReflectionCall(deps, llm, userId, ctx, snapshot, attempt, connection);
  } catch (err) {
    return persistFailedAttempt(deps, userId, ctx.episodeId, attempt, snapshot, err, connection);
  }
}

/** The operator's explicit "no acceptable candidate" — insufficient_evidence without an LLM call
 *  (plan §State machine). The attempt row + event keep the ledger honest. */
async function recordNoAcceptableCandidate(
  deps: PortraitFeedbackDeps,
  userId: string,
  ctx: ReflectionPassContext,
): Promise<ReflectionOutcome> {
  const attempt = await nextAttempt(deps.db, userId, ctx.episodeId);
  let snapshot: ReflectionSnapshot;
  try {
    snapshot = await buildReflectionSnapshot(deps, userId, ctx);
  } catch (err) {
    log.error('portraitFeedback: no-acceptable-candidate snapshot build failed', { episodeId: ctx.episodeId, attempt, err });
    return { action: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  const learningId = await persistAttempt(deps, userId, ctx.episodeId, attempt, 'insufficient_evidence', snapshot, {
    status: 'insufficient_evidence',
    operatorRecorded: true,
  });
  await deps.db.withUserScope(userId, (session) =>
    session.query(
      `insert into visual_episode_events (user_id, episode_id, event_type, payload)
       values ($1, $2, 'insufficient_evidence', $3::jsonb)`,
      [userId, ctx.episodeId, JSON.stringify({ learningId, operatorRecorded: true })],
    ),
  );
  await setEpisodeStatus(deps, userId, ctx.episodeId, 'insufficient_evidence');
  log.info('portraitFeedback: operator recorded no acceptable candidate', { episodeId: ctx.episodeId, attempt });
  return { action: 'insufficient_evidence' };
}

// ---- Orchestration -----------------------------------------------------------------

/** A fresh round's feedback: episode row first (the primary write), then ratings/notes, then — on
 *  an explicit winner — winner promotion + reflection. A no-winner submission stays awaiting_
 *  feedback and never triggers reflection. */
async function submitFreshRound(
  deps: PortraitFeedbackDeps,
  llm: LlmProvider,
  userId: string,
  input: PortraitFeedbackInput,
): Promise<PortraitFeedbackResult> {
  const goal = (input.goal ?? '').trim();
  const entityIds = input.entityIds;
  const candidateIds = input.candidateIds;
  if (!entityIds || !goal || !candidateIds?.length) {
    return { ok: false, error: 'missing_required_fields' };
  }
  if (input.winnerId) {
    if (!candidateIds.includes(input.winnerId)) return { ok: false, error: 'winner_not_in_candidates' };
    if (!input.rationale?.trim()) return { ok: false, error: 'rationale_required_for_winner' };
  }

  const candidates = await loadCandidates(deps.db, userId, candidateIds);
  if (candidates.length !== candidateIds.length) {
    return { ok: false, error: 'unknown_candidate_id' };
  }

  const status = input.winnerId || input.noAcceptableCandidate ? 'reflecting' : 'awaiting_feedback';
  const roundId = input.roundId ?? null;
  const episode = await deps.db.withUserScope(userId, (session) =>
    session.query<EpisodeRow>(
      `insert into visual_episodes (user_id, entity_ids, goal, rationale, selected_candidate_id, candidate_ids, reflection_status, round_id)
       values ($1, $2::jsonb, $3, $4, $5, $6::uuid[], $7, $8) returning episode_id`,
      [userId, JSON.stringify(entityIds), goal, input.rationale?.trim() ?? null, input.winnerId ?? null, candidateIds, status, roundId],
    ),
  );
  const episodeId = episode[0].episode_id;

  await storeRatingsAndNotes(deps, userId, input.ratings, input.notes);

  const ctx: ReflectionPassContext = {
    subjectEntityId: entityIds['subject'] ?? '',
    episodeId,
    episodeEntityIds: entityIds,
    goal,
    rationale: input.rationale?.trim() ?? '',
    candidates,
    winnerId: input.winnerId,
    ratings: input.ratings ?? {},
    notes: input.notes ?? {},
    layerAssessments: input.layerAssessments ?? [],
    roundId,
  };

  if (input.winnerId) {
    const winner = candidates.find((c) => c.candidate_id === input.winnerId)!;
    await applyWinner(deps, userId, episodeId, winner);
    const reflection = await runReflectionPass(deps, llm, userId, ctx);
    return { ok: true, episodeId, ...(roundId ? { roundId } : {}), reflection };
  }

  if (input.noAcceptableCandidate) {
    const reflection = await recordNoAcceptableCandidate(deps, userId, ctx);
    return { ok: true, episodeId, ...(roundId ? { roundId } : {}), reflection };
  }

  log.info('portraitFeedback: episode recorded awaiting_feedback', { episodeId });
  return { ok: true, episodeId, ...(roundId ? { roundId } : {}), reflection: { action: 'awaiting_feedback' } };
}

/** Retry/complete an existing episode (plan §UI — failed reflection offers retry instead of
 *  silently closing the round): update ratings/notes/rationale if supplied, (re)select a winner,
 *  then re-run reflection as attempt N+1. Idempotent: each attempt is its own immutable row. */
async function submitEpisodeRetry(
  deps: PortraitFeedbackDeps,
  llm: LlmProvider,
  userId: string,
  input: PortraitFeedbackInput,
): Promise<PortraitFeedbackResult> {
  const episode = await loadEpisode(deps.db, userId, input.episodeId!);
  if (!episode) return { ok: false, error: 'unknown_episode' };
  const candidates = await loadCandidates(deps.db, userId, episode.candidate_ids);
  if (candidates.length !== episode.candidate_ids.length) return { ok: false, error: 'unknown_candidate_id' };

  await storeRatingsAndNotes(deps, userId, input.ratings, input.notes);
  const rationale = typeof input.rationale === 'string' && input.rationale.trim() !== '' ? input.rationale.trim() : undefined;
  if (rationale && rationale !== (episode.rationale ?? '')) {
    await deps.db.withUserScope(userId, (session) =>
      session.query('update visual_episodes set rationale = $2 where episode_id = $1 and user_id = $3', [episode.episode_id, rationale, userId]),
    );
    episode.rationale = rationale;
  }

  const winnerId = input.winnerId ?? episode.selected_candidate_id;
  const roundId = episode.round_id;
  const ctx: ReflectionPassContext = {
    subjectEntityId: episode.entity_ids['subject'] ?? '',
    episodeId: episode.episode_id,
    episodeEntityIds: episode.entity_ids,
    goal: episode.goal,
    rationale: episode.rationale ?? '',
    candidates,
    winnerId: winnerId ?? undefined,
    ratings: input.ratings ?? {},
    notes: input.notes ?? {},
    layerAssessments: input.layerAssessments ?? [],
    roundId,
  };

  if (winnerId) {
    if (!candidates.some((c) => c.candidate_id === winnerId)) return { ok: false, error: 'winner_not_in_candidates' };
    if (!episode.rationale?.trim()) return { ok: false, error: 'rationale_required_for_winner' };
    if (winnerId !== episode.selected_candidate_id) {
      await deps.db.withUserScope(userId, (session) =>
        session.query('update visual_episodes set selected_candidate_id = $2 where episode_id = $1 and user_id = $3', [episode.episode_id, winnerId, userId]),
      );
      const winner = candidates.find((c) => c.candidate_id === winnerId)!;
      await applyWinner(deps, userId, episode.episode_id, winner);
    }
    const reflection = await runReflectionPass(deps, llm, userId, ctx);
    return { ok: true, episodeId: episode.episode_id, ...(roundId ? { roundId } : {}), reflection };
  }

  if (input.noAcceptableCandidate) {
    const reflection = await recordNoAcceptableCandidate(deps, userId, ctx);
    return { ok: true, episodeId: episode.episode_id, ...(roundId ? { roundId } : {}), reflection };
  }

  log.info('portraitFeedback: episode still awaiting_feedback', { episodeId: episode.episode_id });
  return { ok: true, episodeId: episode.episode_id, ...(roundId ? { roundId } : {}), reflection: { action: 'awaiting_feedback' } };
}

export async function submitPortraitFeedback(
  deps: PortraitFeedbackDeps,
  llm: LlmProvider,
  userId: string,
  input: PortraitFeedbackInput,
): Promise<PortraitFeedbackResult> {
  try {
    if (input.episodeId) return await submitEpisodeRetry(deps, llm, userId, input);
    return await submitFreshRound(deps, llm, userId, input);
  } catch (err) {
    log.error('portraitFeedback: feedback failed', { userId, winnerId: input.winnerId, err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
