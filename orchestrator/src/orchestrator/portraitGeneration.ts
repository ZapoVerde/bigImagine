/**
 * @file orchestrator/src/orchestrator/portraitGeneration.ts
 * @stamp 2026-08-19
 * @architectural-role Orchestrator — one Portrait Studio generation round
 *   (docs/plans/completed/portrait-studio-plan.md §Generation round)
 * @description
 * The generation round of Portrait Studio: manifest + entity resolution, Path-1 wiki injection,
 * the marker-text mutation LLM call, slot-key reconciliation, and the parallel per-candidate
 * image-gen dispatch — then one visual_candidates row per candidate, returned to the Studio
 * grid. Mirrors generateLocationImage.ts's shape/header conventions (plan §New files): fail-open
 * structured result, never throws, every failure mode logged at the seam (bi_principles.md §11),
 * everything that can be read live from orchestrator_settings read live (plan §Principles §13).
 *
 * Flow (plan §Generation round):
 *   1. Load the active layer manifest (layerStack.ts — seeds the default on first read).
 *   2. Resolve one entity per promptable layer. A layer named in `entityIds` must exist and be
 *      the caller's — a named-but-missing entity is a caller bug and fails the round with a
 *      structured error. An *unspecified* layer falls back to that layer's most-recently-used
 *      entity, or a fresh placeholder entity (empty slots, name = the layer's label) when the
 *      user has none yet — playground's seed-on-first-use behavior (plan §Generation round step 1).
 *   3. Load the whole wiki (loadAllWikiEntries, with each entry's current revision id) and split it
 *      two ways (wiki.ts's three-path model, 2026-08-17): (a)/(b) formatBoundedSubscribedEntries
 *      under the visual_wiki_context_budget character cap — every entry subscribed to an active
 *      entity id or an active whole-layer type, full body, but never the entire wiki — and the
 *      revision ids of exactly the entries that made the cut are recorded as the round's
 *      attributable provenance; (c) formatUnsubscribedTagIndex — every other entry, title+tags+id
 *      only, pullable on demand (step 4) when relevant despite carrying no structural subscription
 *      to this round.
 *   4. Build the mutation prompt (evoprompt.ts buildMutationPrompt) and run it: PULL_WIKI_ENTRY_TOOL
 *      is offered (never forced) whenever (c) is non-empty, for up to MAX_WIKI_PULLS round-trips;
 *      the final call always drops the tool, forcing a plain-text reply. Parse that reply
 *      (evoprompt.ts parseCandidateResponse) into visual_mutation_candidate_count (default 3)
 *      candidate chromosomes. When the round is lesson-driven (input.lessonId resolves to a
 *      provisional/supported visual_lessons row), the lesson is injected as a hard requirement
 *      (evoprompt.ts guidingLesson) and recorded in visual_lesson_uses.
 *   5. enforceSlotKeys reconciles every parsed chromosome against the parent — the entities'
 *      own slots (the mutation LLM's "current candidate" is exactly that union, so parent
 *      fidelity means the round can neither hallucinate a slot key no entity owns nor drop one
 *      an entity does own).
 *   6. Resolve the active `purpose = 'portrait'` image_connections row; dispatch each candidate's
 *      composed prompt in parallel through createImageGenProvider(...).generate() (reused as-is).
 *      A single candidate's provider failure is logged and that candidate comes back with
 *      imageUrl null — omitted from the grid, never an aborted round (plan §Edge Cases).
 *   7. Write one visual_candidates row per candidate (chromosome + generation preserved even
 *      when its render failed — the training record is the round, not just the successful grid),
 *      each with its immutable provenance: parent chromosome, composed prompt, render metadata,
 *      the bounded wiki revision ids shown, and the lesson_id that drove the round. Return them
 *      plus the applied lesson (null = exploratory).
 *
 * Two deliberate ordering/scope decisions, disclosed:
 * - The portrait connection is resolved *before* the mutation LLM call, not at plan step 6.
 *   Nothing in the mutation prompt depends on it, and a round with no portrait connection
 *   configured is a guaranteed failure — resolving it first short-circuits with
 *   'no_active_connection' before a single mutation token is spent, the same
 *   "don't spend on a doomed render" posture generateLocationImage.ts takes (§5.1.3-4).
 * - The connection's master_positive_style_prefix is deliberately NOT folded into the composed
 *   prompt. For locations the style prefix is the only art direction there is; a portrait's art
 *   direction is the trained `style` layer entity, and letting a connection-level prefix fight
 *   the trained style would defeat the whole training loop. master_negative_prompt still applies
 *   (as the base negative, candidate fragments appended) — negative direction doesn't conflict
 *   with trained style the way a positive style override would.
 *
 * task-id attribution follows the plan's disclosed `subject`-anchor exception
 * (plan §Layer manifest): `visual-<subjectEntityId>-<attempt>`, kind 'system', via the existing
 * gate (runWithCallContext, plan §Principles §14) — no new LLM-calling machinery. `attempt` is
 * the per-subject round counter derived from visual_candidates.generation.
 *
 * @api-declaration
 * PortraitGenerationDeps — db, settings, imageConnections (the same three generateLocationImage
 *   needs)
 * runPortraitGenerationRound(deps, llm, userId, input) -> Promise<PortraitGenerationRoundResult>
 *   — fail-open; { ok, candidates?: PortraitCandidateResult[], lesson?: { lessonId, statement } |
 *   null, error? } (lesson null = exploratory round)
 * PortraitCandidateResult — candidateId, chromosome, composedPrompt, imageUrl (null = provider
 *   failure), failed? (the provider error, when present)
 * loadAllWikiEntries(db, userId) -> Promise<WikiEntryRowWithRevision[]> — every owned entry plus
 *   its current revision id (needed by portraitFeedback.ts's bounded reflection context too)
 * selectBoundedWikiContext(entries, activeEntityIds, activeLayerTypes, budgetChars) ->
 *   BoundedWikiContext — pure budget-capped Path-1 selection with attributable revision ids
 * DEFAULT_WIKI_CONTEXT_BUDGET — the visual_wiki_context_budget fallback (2400)
 * retryPortraitCandidateRender(deps, userId, candidateId) -> Promise<PortraitCandidateRetryResult>
 *   — re-renders one already-written candidate's stored chromosome (no mutation call, same
 *   candidate_id) when its original render failed; fail-open, same imageUrl/failed shape
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, settings read, LLM call, provider network calls)
 *     state_ownership: []
 *     external_io:     [Postgres (visual_entities/visual_candidates/visual_wiki_entries via
 *                       db.withUserScope), orchestrator_settings (read), the LLM via the injected
 *                       provider, the active portrait image provider]
 *     never:           throws. Errors are logged and folded into the result per the fail-open
 *                      contract above.
 */

import { log } from '../io/logger.js';
import { runWithCallContext, withCallLabel, withRoundId } from '../io/llm/callContext.js';
import type { LlmMessage, LlmProvider, LlmTurn } from '../io/llm/types.js';
import type { ImageConnectionProfile, ImageConnectionStore } from '../io/imageConnections.js';
import { createImageGenProvider } from '../io/imageGen/index.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import type { PostgresClient } from '../io/postgres.js';
import { compileTemplate, type DetailsMap, type SlotMap } from '../portraits/composer.js';
import { buildMutationPrompt, parseCandidateResponse, parsePullWikiEntryId, PULL_WIKI_ENTRY_TOOL } from '../portraits/evoprompt.js';
import { loadLayerManifest, getPromptableLayers, formatLayerDefinitions, type LayerDefinition } from '../portraits/layerStack.js';
import { enforceSlotKeys, type CandidateChromosome } from '../portraits/reconcile.js';
import { formatBoundedSubscribedEntries, formatUnsubscribedTagIndex, type WikiEntryRow, type WikiSubscription } from '../portraits/wiki.js';

export interface PortraitGenerationDeps {
  db: PostgresClient;
  settings: OrchestratorSettingsStore;
  imageConnections: ImageConnectionStore;
}

export interface PortraitGenerationInput {
  /** The round's entity map: { [layerId]: entityId }. May omit layers — an omitted promptable
   *  layer falls back to its most-recently-used entity or a fresh placeholder (step 2). */
  entityIds: Record<string, string>;
  /** The round's goal, fed to the mutation prompt. */
  goal: string;
  /** Human rationale/notes from the last episode, fed back into this round's mutation, if any. */
  pendingFeedback?: string;
  /** A concluded lesson to drive this round with (docs/plans/portrait-studio-vision-review-
   *  harness-plan.md §API step 6). Absent → the round is explicitly exploratory. The lesson is
   *  loaded, injected as a hard requirement, and recorded in visual_lesson_uses. */
  lessonId?: string;
}

export interface PortraitCandidateResult {
  candidateId: string;
  chromosome: CandidateChromosome;
  /** The composed image prompt — re-compilable from chromosome + manifest, stored for the
   *  winner/episode record and the grid's prompt display. */
  composedPrompt: string;
  /** The provider's CDN URL; null when this candidate's render failed (it is omitted from the
   *  grid — plan §Edge Cases) while the visual_candidates row is still written. */
  imageUrl: string | null;
  /** The provider error message when this candidate's render failed — the grid omits the
   *  candidate but the row keeps the chromosome for the training record. */
  failed?: string;
}

export interface PortraitGenerationRoundResult {
  ok: boolean;
  candidates?: PortraitCandidateResult[];
  /** The concluded lesson this round was driven by, when one was supplied and usable — lets the
   *  Studio mark the round lesson-driven (null = exploratory). */
  lesson?: { lessonId: string; statement: string } | null;
  /** The round's correlation id (docs/plans/portrait-studio-telemetry-plan.md) — set whenever
   *  the round reached the mutation phase (the visual_rounds row exists); undefined on
   *  pre-mutation failures like a missing connection or entity. */
  roundId?: string;
  error?: string;
}

interface EntityRow {
  entity_id: string;
  layer_id: string;
  slots: Record<string, string>;
  template: string | null;
  details: string;
}

/** The fallback entity created when a promptable layer has no entity yet (playground's
 *  seed-on-first-use): empty slots, name = the layer's label. The mutation LLM invents the
 *  layer's content from the goal; the empty parent means reconcile has nothing to backfill, so
 *  every slot key the model proposes survives — exactly the bootstrap semantics a fresh entity
 *  needs. */
async function ensureEntityForLayer(
  db: PostgresClient,
  userId: string,
  layer: LayerDefinition,
  namedId: string | undefined,
): Promise<EntityRow> {
  if (namedId) {
    // A *named* entity is a hard contract: it must exist and be the caller's. Missing is a
    // caller bug, not a seed case — fail loudly with a structured error rather than silently
    // substituting a placeholder the round would then train on as if it were the named one.
    const rows = await db.withUserScope(userId, (session) =>
      session.query<EntityRow>(
        `select entity_id, layer_id, slots, template, details
         from visual_entities where entity_id = $1 and user_id = $2`,
        [namedId, userId],
      ),
    );
    const row = rows[0];
    if (!row) throw new EntityResolutionError(`entity ${namedId} not found`, layer.id, 'entity_not_found');
    if (row.layer_id !== layer.id) {
      throw new EntityResolutionError(`entity ${namedId} is a ${row.layer_id} entity, not ${layer.id}`, layer.id, 'entity_layer_mismatch');
    }
    return row;
  }
  const rows = await db.withUserScope(userId, (session) =>
    session.query<EntityRow>(
      `select entity_id, layer_id, slots, template, details
       from visual_entities where user_id = $1 and layer_id = $2 order by updated_at desc limit 1`,
      [userId, layer.id],
    ),
  );
  if (rows[0]) return rows[0];
  const created = await db.withUserScope(userId, (session) =>
    session.query<EntityRow>(
      `insert into visual_entities (user_id, layer_id, name) values ($1, $2, $3)
       returning entity_id, layer_id, slots, template, details`,
      [userId, layer.id, layer.label],
    ),
  );
  log.info('portraitGeneration: seeded placeholder entity for layer', { layerId: layer.id, entityId: created[0].entity_id });
  return created[0];
}

/** The mutation LLM must never see a slot key the layer's entity doesn't own, and never lose
 *  one it does — parentSlots is the entities' own slots unioned per layer, which is exactly what
 *  the prompt shows as "Current candidate", so reconcile's parent and the prompt's parent are
 *  the same object (plan step 5). */
function buildParentChromosome(entities: Map<string, EntityRow>, layers: LayerDefinition[]): CandidateChromosome {
  const slots: SlotMap = {};
  for (const layer of layers) {
    const entity = entities.get(layer.id);
    if (entity && entity.slots && typeof entity.slots === 'object') slots[layer.id] = entity.slots;
  }
  return { slots };
}

/** The round's authored per-layer prose (docs/plans/portrait-studio-layer-details-plan.md), keyed
 *  by layer id — the text `{{<layerId>_details}}` template tokens resolve to. Computed once per
 *  round alongside buildParentChromosome: details don't vary per-candidate (same as `name`), so
 *  this is not part of the evoprompt mutation loop — every candidate compiles with the same map. */
function buildParentDetails(entities: Map<string, EntityRow>, layers: LayerDefinition[]): DetailsMap {
  const details: DetailsMap = {};
  for (const layer of layers) {
    const entity = entities.get(layer.id);
    if (entity?.details) details[layer.id] = entity.details;
  }
  return details;
}

/** The round's whole wiki universe — every visual_wiki_entries row the user owns, same
 *  unconditional full-table shape portraitFeedback.ts's reflection index query already uses.
 *  Fetched once and handed to both formatSubscribedEntries (Path 1 a/b, full body) and
 *  formatUnsubscribedTagIndex (Path 1c, title+tags+id) — each does its own pure filtering over
 *  the same set, and Path 1c's pull loop looks entries up from this in-memory array by id rather
 *  than a second query. Also carries each entry's current revision id (the latest
 *  visual_wiki_revisions row) so the round can record exactly which revisions it was shown —
 *  bounded, attributable context (bi_principles.md §16). */
export interface WikiEntryRowWithRevision extends WikiEntryRow {
  current_revision_id: string | null;
}

export async function loadAllWikiEntries(db: PostgresClient, userId: string): Promise<WikiEntryRowWithRevision[]> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<{ entry_id: string; title: string; body: string; tags: string[]; subscriptions: unknown }>(
      `select entry_id, title, body, tags, subscriptions from visual_wiki_entries where user_id = $1 order by created_at`,
      [userId],
    ),
  );
  const revisionRows = await db.withUserScope(userId, (session) =>
    session.query<{ entry_id: string; revision_id: string }>(
      `select distinct on (entry_id) entry_id, revision_id
       from visual_wiki_revisions where user_id = $1 order by entry_id, revision_number desc`,
      [userId],
    ),
  );
  const revisionByEntry = new Map(revisionRows.map((r) => [r.entry_id, r.revision_id]));
  return rows.map((r) => ({
    entry_id: r.entry_id,
    title: r.title,
    body: r.body,
    tags: r.tags ?? [],
    subscriptions: (Array.isArray(r.subscriptions) ? r.subscriptions : []) as WikiSubscription[],
    current_revision_id: revisionByEntry.get(r.entry_id) ?? null,
  }));
}

export interface BoundedWikiContext {
  /** The bounded full-body text Path 1 sends (never the entire wiki). */
  text: string;
  /** The entry ids that made the cut, in order. */
  entryIds: string[];
  /** The current revision ids of those entries — the attributable provenance. */
  revisionIds: string[];
}

/** Pure selection of the bounded Path-1 context over already-loaded entries, with the revision ids
 *  that back it. budgetChars <= 0 means "no full-body wiki context at all". */
export function selectBoundedWikiContext(
  entries: WikiEntryRowWithRevision[],
  activeEntityIds: string[],
  activeLayerTypes: string[],
  budgetChars: number,
): BoundedWikiContext {
  const budget = Number.isInteger(budgetChars) && budgetChars > 0 ? budgetChars : 0;
  const { text, entryIds } = formatBoundedSubscribedEntries(entries, activeEntityIds, activeLayerTypes, budget);
  const revisionIds = entries
    .filter((e) => entryIds.includes(e.entry_id) && e.current_revision_id !== null)
    .map((e) => e.current_revision_id as string);
  return { text, entryIds, revisionIds };
}

/** The per-subject round counter the task-id `attempt` derives from (plan §Layer manifest):
 *  one higher than the subject's best prior generation, 1 for a subject with no rounds yet. */
async function nextAttempt(db: PostgresClient, userId: string, subjectEntityId: string): Promise<number> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<{ attempt: number }>(
      `select coalesce(max(generation), 0) + 1 as attempt
       from visual_candidates where user_id = $1 and entity_ids->>'subject' = $2`,
      [userId, subjectEntityId],
    ),
  );
  return rows[0]?.attempt ?? 1;
}

/** The built-in cap on Path-1 full-body wiki text sent to a mutation or reflection call
 *  (visual_wiki_context_budget, default). Same "default + bespoke" numeric shape as every other
 *  setting — unset/corrupt falls back here, never "unlimited". */
export const DEFAULT_WIKI_CONTEXT_BUDGET = 2400;

interface LessonRow {
  lesson_id: string;
  statement: string;
  evidence: string;
  next_change: { layer: string; instruction: string };
  preserve: string[];
  confidence: string;
  state: string;
}

/** Load a concluded lesson for use by a mutation round. Only provisional/supported lessons are
 *  usable — rejected and superseded ones come back undefined (the round stays exploratory). */
async function loadLessonForUse(db: PostgresClient, userId: string, lessonId: string): Promise<LessonRow | undefined> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<LessonRow>(
      `select lesson_id, statement, evidence, next_change, preserve, confidence, state
       from visual_lessons where lesson_id = $1 and user_id = $2`,
      [lessonId, userId],
    ),
  );
  const row = rows[0];
  if (!row) {
    log.warn('portraitGeneration: lesson not found, round stays exploratory', { lessonId });
    return undefined;
  }
  if (row.state !== 'provisional' && row.state !== 'supported') {
    log.info('portraitGeneration: lesson not usable in its current state, round stays exploratory', { lessonId, state: row.state });
    return undefined;
  }
  return row;
}

/** A structured, non-throwing entity-resolution failure — thrown internally, caught at the top
 *  of runPortraitGenerationRound and folded into the fail-open result with a stable code. */
class EntityResolutionError extends Error {
  readonly code: string;
  readonly layerId: string;
  constructor(message: string, layerId: string, code: string) {
    super(message);
    this.layerId = layerId;
    this.code = code;
  }
}

// ---- Round telemetry seams (docs/plans/portrait-studio-telemetry-plan.md) ----------------
// visual_rounds / visual_round_image_calls (migration 0119) are the Portrait round's correlation
// ledger: the visual_rounds row is created before the first mutation call and reaches a terminal
// status exactly once; visual_round_image_calls rows are written around every
// createImageGenProvider(...).generate() call. Every write here is best-effort by design — a
// telemetry write failure must never make generation fail (plan §Edge Cases), so call sites
// swallow/log failures rather than propagating them.

type VisualRoundStatus = 'running' | 'succeeded' | 'failed' | 'partial';

async function createRound(db: PostgresClient, userId: string, goal: string): Promise<string> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<{ round_id: string }>(
      `insert into visual_rounds (user_id, goal) values ($1, $2) returning round_id`,
      [userId, goal],
    ),
  );
  return rows[0].round_id;
}

/** Terminal write only — status moves running → succeeded/failed/partial exactly once, with
 *  completed_at set at the same instant (the plan's "never append or rewrite the round"). */
async function setRoundStatus(db: PostgresClient, userId: string, roundId: string, status: Exclude<VisualRoundStatus, 'running'>): Promise<void> {
  await db.withUserScope(userId, (session) =>
    session.query(
      `update visual_rounds set status = $2, completed_at = now() where round_id = $1 and user_id = $3`,
      [roundId, status, userId],
    ),
  );
}

async function beginImageCall(db: PostgresClient, userId: string, roundId: string, profile: ImageConnectionProfile): Promise<string> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<{ call_id: string }>(
      `insert into visual_round_image_calls (user_id, round_id, status, provider_kind, model, started_at)
       values ($1, $2, 'running', $3, $4, now()) returning call_id`,
      [userId, roundId, profile.kind, profile.model],
    ),
  );
  return rows[0].call_id;
}

async function finishImageCall(
  db: PostgresClient,
  userId: string,
  callId: string,
  fields: { status: 'succeeded' | 'failed'; durationMs: number; errorMessage?: string },
): Promise<void> {
  await db.withUserScope(userId, (session) =>
    session.query(
      `update visual_round_image_calls
       set status = $2, duration_ms = $3, error_message = $4, completed_at = now()
       where call_id = $1 and user_id = $5`,
      [callId, fields.status, fields.durationMs, fields.errorMessage ?? null, userId],
    ),
  );
}

/** Backfills candidate_id once the visual_candidates row exists — null at render time (plan
 *  §Image calls). */
async function linkImageCallToCandidate(db: PostgresClient, userId: string, callId: string, candidateId: string): Promise<void> {
  await db.withUserScope(userId, (session) =>
    session.query(
      `update visual_round_image_calls set candidate_id = $2 where call_id = $1 and user_id = $3`,
      [callId, candidateId, userId],
    ),
  );
}

/** The round a candidate was born into, via its original render's image-call row — used by
 *  retryPortraitCandidateRender so a retry's image call joins the same round (plan §Image calls:
 *  "a retry is a new call row and the same round ID; never overwrite history"). */
async function roundIdForCandidate(db: PostgresClient, userId: string, candidateId: string): Promise<string | null> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<{ round_id: string }>(
      `select round_id from visual_round_image_calls where candidate_id = $1 and user_id = $2 limit 1`,
      [candidateId, userId],
    ),
  );
  return rows[0]?.round_id ?? null;
}

export async function runPortraitGenerationRound(
  deps: PortraitGenerationDeps,
  llm: LlmProvider,
  userId: string,
  input: PortraitGenerationInput,
): Promise<PortraitGenerationRoundResult> {
  // The round's correlation ledger row is created just before the first mutation call (plan
  // §Round lifecycle); the variable is hoisted out of the try so the top-level catch can mark
  // the round failed too.
  let roundId: string | null = null;
  try {
    // 1. Active manifest — seeds the default on first read; a corrupt stored value degrades to
    //    the built-in default (layerStack.ts), never an error.
    const manifest = await loadLayerManifest({ settings: deps.settings });
    const layers = getPromptableLayers(manifest);

    // 2. One entity per promptable layer; named entities are a hard contract, unspecified
    //    layers fall back to most-recently-used or a fresh placeholder.
    const entities = new Map<string, EntityRow>();
    try {
      for (const layer of layers) {
        entities.set(layer.id, await ensureEntityForLayer(deps.db, userId, layer, input.entityIds[layer.id]));
      }
    } catch (err) {
      if (err instanceof EntityResolutionError) {
        log.warn('portraitGeneration: entity resolution failed, aborting round', { layerId: err.layerId, error: err.message });
        return { ok: false, error: err.code };
      }
      throw err;
    }
    const subjectEntityId = entities.get('subject')?.entity_id;
    if (!subjectEntityId) return { ok: false, error: 'subject_layer_missing' };

    // The resolved map — the round's entity_ids (including any placeholder fallbacks), the
    // authoritative record visual_candidates/visual_episodes carry.
    const resolvedEntityIds: Record<string, string> = {};
    for (const [layerId, entity] of entities) resolvedEntityIds[layerId] = entity.entity_id;

// 3. Path-1 wiki: (a)/(b) rows subscribed to an active entity id or an active whole-layer
    //    type, full body, UNDER the visual_wiki_context_budget character cap (docs/plans/
    //    portrait-studio-vision-review-harness-plan.md §Wiki policy — "never the entire wiki");
    //    the revision ids of exactly those entries are recorded as the round's attributable
    //    provenance. (c) every other entry, title+tags+id only (wiki.ts
    //    formatUnsubscribedTagIndex) — a lesson can be relevant to this round's goal without ever
    //    having been subscribed to this entity or layer, so the mutation call gets to pull one on
    //    demand (PULL_WIKI_ENTRY_TOOL below) instead of staying blind to everything outside its
    //    structural (a)/(b) subscriptions.
    const activeEntityIds = [...entities.values()].map((e) => e.entity_id);
    const activeLayerTypes = layers.map((l) => l.id);
    const [budgetRaw] = await Promise.all([deps.settings.get('visual_wiki_context_budget')]);
    const budgetChars = budgetRaw ? Number(budgetRaw) : NaN;
    const wikiBudget = Number.isInteger(budgetChars) && budgetChars > 0 ? budgetChars : DEFAULT_WIKI_CONTEXT_BUDGET;
    const allWikiEntries = await loadAllWikiEntries(deps.db, userId);
    const boundedWiki = selectBoundedWikiContext(allWikiEntries, activeEntityIds, activeLayerTypes, wikiBudget);
    const wikiText = boundedWiki.text;
    const wikiRevisionIds = boundedWiki.revisionIds;
    const unsubscribedWikiTagIndex = formatUnsubscribedTagIndex(allWikiEntries, activeEntityIds, activeLayerTypes);

    // The lesson driving this round, when one was supplied (docs/plans/portrait-studio-vision-
    // review-harness-plan.md §API step 6). Rejected/superseded lessons are ignored with a log —
    // the round stays exploratory rather than silently applying a dead lesson.
    let usedLesson: LessonRow | undefined;
    let guidingLesson: string | undefined;
    if (input.lessonId) {
      usedLesson = await loadLessonForUse(deps.db, userId, input.lessonId);
      if (usedLesson) {
        guidingLesson =
          `"${usedLesson.statement}" — next change: ${usedLesson.next_change.layer}: ${usedLesson.next_change.instruction}` +
          (usedLesson.preserve.length > 0 ? ` (keep unchanged: ${usedLesson.preserve.join(', ')})` : '');
      }
    }

    // 6 (deliberately early — see header): the portrait connection gates the round before a
    //    single mutation token is spent.
    const profile = await deps.imageConnections.resolveActive('portrait');
    if (!profile) {
      log.warn('portraitGeneration: no active portrait image connection configured, aborting round', { subjectEntityId });
      return { ok: false, error: 'no_active_connection' };
    }

    const parent = buildParentChromosome(entities, layers);
    const parentDetails = buildParentDetails(entities, layers);

    const [candidateCountRaw, mutationOverride] = await Promise.all([
      deps.settings.get('visual_mutation_candidate_count'),
      deps.settings.get('visual_mutation_system_prompt_override'),
    ]);
    const candidateCount = candidateCountRaw ? Number(candidateCountRaw) : NaN;
    const count = Number.isInteger(candidateCount) && candidateCount > 0 ? candidateCount : 3;

    // 4. The mutation call, through the existing gate with the plan's task-id attribution.
    //    Plain marker-text reply, not a forced tool call (2026-08-17: forced tool_choice both
    //    made OpenRouter filter out otherwise-healthy pinned providers entirely, and made the
    //    providers that did accept it return malformed JSON for a schema this nested — see
    //    evoprompt.ts's file header) — a reply with no parseable "### Candidate N" block is
    //    still a genuine provider anomaly, and parseCandidateResponse throws for that case.
    //    When wiki path (c) has entries to offer, PULL_WIKI_ENTRY_TOOL is available (auto, never
    //    forced) for up to MAX_WIKI_PULLS round-trips before the final call drops it, forcing a
    //    plain-text answer — bounds the round's worst-case cost to one extra LLM call per pull.
    const { messages } = buildMutationPrompt(
      {
        goal: input.goal,
        parentSlots: parent.slots,
        wikiEntries: wikiText,
        unsubscribedWikiTagIndex,
        layerDefinitions: formatLayerDefinitions(manifest),
        pendingFeedback: input.pendingFeedback,
        guidingLesson,
      },
      count,
      mutationOverride,
    );
    const attempt = await nextAttempt(deps.db, userId, subjectEntityId);
    // The round's correlation ledger row, created before the first mutation call
    // (portrait-studio-telemetry-plan.md §Round lifecycle). A telemetry create failure is not a
    // generation failure (plan §Edge Cases), but at this point nothing has been spent yet, so
    // failing the round loudly is the honest call rather than running un-correlated.
    roundId = await createRound(deps.db, userId, input.goal);
    let chromosomes: CandidateChromosome[];
    try {
      const MAX_WIKI_PULLS = 2;
      const conversation: LlmMessage[] = [...messages];
      let pulls = 0;
      let turn: LlmTurn;
      for (;;) {
        const offerPullTool = unsubscribedWikiTagIndex.trim() !== '' && pulls < MAX_WIKI_PULLS;
        // The first mutation call of the round is 'portrait:mutation'; every call after a
        // pull_wiki_entry round-trip is 'portrait:wiki-pull' — the plan's one real behavior
        // change to this loop (today every round-trip shares one label). Both ride withRoundId
        // so the round correlates its calls on llm_calls.round_id.
        const label = pulls === 0 ? 'portrait:mutation' : 'portrait:wiki-pull';
        turn = await runWithCallContext({ taskId: `visual-${subjectEntityId}-${attempt}`, kind: 'system', userId }, () =>
          withCallLabel(label, () => withRoundId(roundId, () => llm.complete(conversation, offerPullTool ? [PULL_WIKI_ENTRY_TOOL] : []))),
        );
        conversation.push({ role: 'assistant', content: turn.message.content, toolCalls: turn.toolCalls });
        // A provider may return several pull_wiki_entry calls in one turn (parallel tool calling —
        // GPT/Azure-class models do this routinely). Every tool_call_id the assistant message just
        // declared needs its own 'tool' response before the next complete() call, or the provider
        // 400s with "No tool output found for function call <id>" — resolving only the first call
        // and leaving the rest unanswered caused exactly that in production. pulls still counts one
        // round-trip, not one entry, preserving MAX_WIKI_PULLS as a bound on extra LLM calls.
        const pullCalls = turn.toolCalls.filter((c) => c.name === 'pull_wiki_entry');
        if (pullCalls.length === 0) break;
        pulls++;
        for (const pullCall of pullCalls) {
          const entryId = parsePullWikiEntryId(pullCall);
          const entry = entryId ? allWikiEntries.find((e) => e.entry_id === entryId) : undefined;
          conversation.push({
            role: 'tool',
            toolCallId: pullCall.id,
            content: entry ? `## ${entry.title}\n${entry.body}` : `No wiki entry with id ${entryId ?? '(missing id)'} — proceed without it.`,
          });
        }
      }
      chromosomes = parseCandidateResponse(turn);
    } catch (err) {
      await setRoundStatus(deps.db, userId, roundId, 'failed').catch((w) =>
        log.warn('portraitGeneration: failed to mark mutation-failed round terminal', { roundId, err: w }),
      );
      log.error('portraitGeneration: mutation call failed, aborting round', { subjectEntityId, attempt, err });
      return { ok: false, error: `mutation_failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    // 5. Reconcile every chromosome against the parent — drops hallucinated keys, backfills
    //    omitted ones, per layer, unconditionally (reconcile.ts, never throws).
    const reconciled = chromosomes.map((child) => enforceSlotKeys(parent, child, layers));

    // The per-entity template override (only meaningful for style-layer entities, layerStack.ts)
    // is the round's composition template; every candidate compiles with whichever applies.
    const template = entities.get('style')?.template ?? manifest.template;

    // 6. Parallel per-candidate dispatch. One candidate's failure is logged and that candidate
    //    comes back imageUrl null — the round continues with whatever succeeded (§11). Each
    //    render also records its own visual_round_image_calls row (running → succeeded/failed,
    //    candidate_id backfilled in step 7). Image telemetry is best-effort: a write failure is
    //    logged and the render proceeds — telemetry must never make generation fail (plan §Edge
    //    Cases).
    const dispatched = await Promise.all(
      reconciled.map(async (chromosome) => {
        const composedPrompt = compileTemplate(template, chromosome.slots, manifest.layers, parentDetails);
        const renderStartedAt = Date.now();
        let imageCallId: string | null = null;
        try {
          imageCallId = await beginImageCall(deps.db, userId, roundId!, profile).catch((w) => {
            log.warn('portraitGeneration: failed to begin image telemetry', { error: w });
            return null;
          });
          const imageUrl = await createImageGenProvider(profile).generate({
            prompt: composedPrompt,
            negativePrompt: [profile.masterNegativePrompt ?? '', chromosome.negative_prompt ?? ''].filter((s) => s !== '').join(', '),
            model: profile.model,
            apiKey: profile.apiKey,
            baseUrl: profile.baseUrl,
            width: profile.width,
            height: profile.height,
            // candidate variety comes from the chromosome; a null connection seed leaves the
            // provider's own random seed in place (the long-standing default). A non-null
            // connection.seed (migration 0123) pins every candidate in the round to the same
            // seed instead — an admin's deliberate opt-in, not this round's own choice.
            seed: profile.seed,
            steps: profile.samplingSteps,
            cfgScale: profile.cfgScale,
            samplerName: profile.samplerName,
            workflowParameters: profile.workflowParameters,
          });
          if (imageCallId) {
            await finishImageCall(deps.db, userId, imageCallId, {
              status: 'succeeded',
              durationMs: Date.now() - renderStartedAt,
            }).catch((w) => log.warn('portraitGeneration: failed to record image telemetry', { error: w }));
          }
          return { chromosome, composedPrompt, imageUrl: imageUrl as string, failed: undefined, imageCallId };
        } catch (err) {
          const failed = err instanceof Error ? err.message : String(err);
          log.warn('portraitGeneration: candidate render failed, omitting from grid', {
            subjectEntityId,
            attempt,
            error: failed,
          });
          if (imageCallId) {
            await finishImageCall(deps.db, userId, imageCallId, {
              status: 'failed',
              durationMs: Date.now() - renderStartedAt,
              errorMessage: failed,
            }).catch((w) => log.warn('portraitGeneration: failed to record failed image telemetry', { error: w }));
          }
          return { chromosome, composedPrompt, imageUrl: null, failed, imageCallId };
        }
      }),
    );

    // 7. One visual_candidates row per candidate — the chromosome + generation survive even a
    //    failed render (the row is the training record; the grid filters on image_url). Every row
    //    now also persists the immutable provenance that lets the episode be replayed later:
    //    parent chromosome, composed prompt, render metadata, the bounded wiki revision ids that
    //    were shown to the mutation call, and the lesson_id that drove the round.
    const renderMetadata = {
      model: profile.model,
      width: profile.width,
      height: profile.height,
      steps: profile.samplingSteps,
      cfgScale: profile.cfgScale,
      samplerName: profile.samplerName,
    };
    const candidateIds: string[] = [];
    const candidates: PortraitCandidateResult[] = [];
    for (const result of dispatched) {
      const rows = await deps.db.withUserScope(userId, (session) =>
        session.query<{ candidate_id: string }>(
          `insert into visual_candidates
             (user_id, entity_ids, generation, chromosome, image_url,
              parent_chromosome, composed_prompt, render_metadata, wiki_revision_ids, lesson_id)
           values ($1, $2::jsonb, $3, $4::jsonb, $5, $6::jsonb, $7, $8::jsonb, $9::uuid[], $10)
           returning candidate_id`,
          [
            userId,
            JSON.stringify(resolvedEntityIds),
            attempt,
            JSON.stringify(result.chromosome),
            result.imageUrl,
            JSON.stringify(parent),
            result.composedPrompt,
            JSON.stringify(renderMetadata),
            wikiRevisionIds.length > 0 ? wikiRevisionIds : null,
            usedLesson?.lesson_id ?? null,
          ],
        ),
      );
      candidateIds.push(rows[0].candidate_id);
      candidates.push({
        candidateId: rows[0].candidate_id,
        chromosome: result.chromosome,
        composedPrompt: result.composedPrompt,
        imageUrl: result.imageUrl,
        ...(result.failed !== undefined ? { failed: result.failed } : {}),
      });
      // The render's image-call row predates the candidate row — backfill the candidate_id now
      // that it exists (plan §Image calls). Best-effort like every other telemetry write.
      if (result.imageCallId) {
        await linkImageCallToCandidate(deps.db, userId, result.imageCallId, rows[0].candidate_id).catch((w) =>
          log.warn('portraitGeneration: failed to link image telemetry to candidate', { error: w }),
        );
      }
    }

    // The round reaches its terminal status exactly once (plan §Round lifecycle) — the same
    // three-way outcome this orchestrator's own result already distinguishes: all candidates
    // rendered → succeeded; some rendered → partial; none rendered → failed.
    const renderedCount = candidates.filter((c) => c.imageUrl).length;
    const terminalStatus = renderedCount === candidates.length ? 'succeeded' : renderedCount === 0 ? 'failed' : 'partial';
    await setRoundStatus(deps.db, userId, roundId, terminalStatus).catch((w) =>
      log.warn('portraitGeneration: failed to mark round terminal', { roundId, status: terminalStatus, err: w }),
    );

    // The lesson-use record: a lesson-driven round is explicitly attributable; without a lesson
    // the round is exploratory and writes nothing here. The episode_id fills in when the round's
    // feedback lands.
    if (usedLesson) {
      await deps.db.withUserScope(userId, (session) =>
        session.query(
          `insert into visual_lesson_uses (user_id, lesson_id, episode_id, mutation_call, applied_change, result_candidates)
           values ($1, $2, null, $3::jsonb, $4::jsonb, $5::jsonb)`,
          [
            userId,
            usedLesson.lesson_id,
            JSON.stringify({ goal: input.goal, attempt, wikiRevisionIds }),
            JSON.stringify({ next_change: usedLesson.next_change, preserve: usedLesson.preserve }),
            JSON.stringify({ candidateIds }),
          ],
        ),
      );
      log.info('portraitGeneration: lesson-driven round recorded', { subjectEntityId, attempt, lessonId: usedLesson.lesson_id });
    }

    log.info('portraitGeneration: round complete', {
      subjectEntityId,
      attempt,
      roundId,
      goal: input.goal,
      candidates: candidates.length,
      rendered: renderedCount,
      lessonDriven: usedLesson?.lesson_id ?? null,
    });
    return { ok: true, candidates, roundId, lesson: usedLesson ? { lessonId: usedLesson.lesson_id, statement: usedLesson.statement } : null };
  } catch (err) {
    // bi_principles.md §11: log the seam. A failed round is a missing grid, never a broken
    // orchestrator — the operator retries from the Studio.
    if (roundId) {
      await setRoundStatus(deps.db, userId, roundId, 'failed').catch((w) =>
        log.warn('portraitGeneration: failed to mark errored round terminal', { roundId, err: w }),
      );
    }
    log.error('portraitGeneration: round failed', { userId, goal: input.goal, err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface PortraitCandidateRetryResult {
  ok: boolean;
  imageUrl?: string | null;
  composedPrompt?: string;
  /** The round the retried candidate was born into (plan §Image calls — the retry's call row
   *  joins that same round). Set when the round is found; the telemetry panel uses it to refresh
   *  its receipt. */
  roundId?: string;
  /** The provider error message on a repeat failure — same meaning as
   *  PortraitCandidateResult.failed, distinct from `error` (a retry-itself failure: candidate
   *  not found, no active connection). */
  failed?: string;
  error?: string;
}

interface CandidateRetryRow {
  entity_ids: Record<string, string>;
  chromosome: CandidateChromosome;
}

/** Re-renders a single candidate's already-stored chromosome through the active portrait
 *  connection, without spending a new mutation call — the Studio grid's per-candidate "Retry"
 *  action (plan §Edge Cases: a transient provider failure on 1-of-N candidates shouldn't cost a
 *  fresh round). The candidate_id is preserved on success (image_url updated in place), so a
 *  retried candidate becomes eligible for winner-pick under the same round it was born into.
 *  composedPrompt is recompiled against the *current* manifest/style template and the *current*
 *  per-entity authored details (the same current-state guarantee the template resolution makes)
 *  rather than reusing whatever was live at the original round, so a template fix or a details
 *  edit made between attempts benefits a retry immediately. */
export async function retryPortraitCandidateRender(
  deps: PortraitGenerationDeps,
  userId: string,
  candidateId: string,
): Promise<PortraitCandidateRetryResult> {
  try {
    const rows = await deps.db.withUserScope(userId, (session) =>
      session.query<CandidateRetryRow>(
        `select entity_ids, chromosome from visual_candidates where candidate_id = $1 and user_id = $2`,
        [candidateId, userId],
      ),
    );
    const row = rows[0];
    if (!row) return { ok: false, error: 'candidate_not_found' };

    const profile = await deps.imageConnections.resolveActive('portrait');
    if (!profile) return { ok: false, error: 'no_active_connection' };

    const manifest = await loadLayerManifest({ settings: deps.settings });
    const styleEntityId = row.entity_ids?.style;
    let template = manifest.template;
    if (styleEntityId) {
      const styleRows = await deps.db.withUserScope(userId, (session) =>
        session.query<{ template: string | null }>(
          `select template from visual_entities where entity_id = $1 and user_id = $2`,
          [styleEntityId, userId],
        ),
      );
      if (styleRows[0]?.template) template = styleRows[0].template;
    }
    // The retry has only the candidate's stored entity_ids, not the live entities Map — one
    // batched query fetches every layer's current details, then the compile call below resolves
    // the `_details` tokens against that map (same current-state recompile guarantee as the
    // style template above).
    const entityIdList = Object.values(row.entity_ids ?? {}).filter((id): id is string => typeof id === 'string');
    let detailsByLayer: DetailsMap = {};
    if (entityIdList.length > 0) {
      const detailRows = await deps.db.withUserScope(userId, (session) =>
        session.query<{ layer_id: string; details: string }>(
          `select layer_id, details from visual_entities where entity_id = any($1::uuid[]) and user_id = $2`,
          [entityIdList, userId],
        ),
      );
      for (const r of detailRows) if (r.details) detailsByLayer[r.layer_id] = r.details;
    }
    const composedPrompt = compileTemplate(template, row.chromosome.slots ?? {}, manifest.layers, detailsByLayer);

    // A retry's image call joins the round the candidate was born into (plan §Image calls: a
    // retry is a new call row and the same round ID, never overwrite history). Best-effort —
    // a round lookup or telemetry write failure must not block the re-render itself.
    const roundId = await roundIdForCandidate(deps.db, userId, candidateId);
    let imageCallId: string | null = null;
    if (roundId) {
      imageCallId = await beginImageCall(deps.db, userId, roundId, profile).catch((w) => {
        log.warn('portraitGeneration: failed to begin retry image telemetry', { candidateId, error: w });
        return null;
      });
    }
    const renderStartedAt = Date.now();

    try {
      const imageUrl = await createImageGenProvider(profile).generate({
        prompt: composedPrompt,
        negativePrompt: [profile.masterNegativePrompt ?? '', row.chromosome.negative_prompt ?? ''].filter((s) => s !== '').join(', '),
        model: profile.model,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        width: profile.width,
        height: profile.height,
        seed: profile.seed, // same connection-level seed the original render used (migration 0123)
        steps: profile.samplingSteps,
        cfgScale: profile.cfgScale,
        samplerName: profile.samplerName,
        workflowParameters: profile.workflowParameters,
      });
      await deps.db.withUserScope(userId, (session) =>
        session.query(`update visual_candidates set image_url = $1 where candidate_id = $2 and user_id = $3`, [imageUrl, candidateId, userId]),
      );
      if (imageCallId) {
        await finishImageCall(deps.db, userId, imageCallId, { status: 'succeeded', durationMs: Date.now() - renderStartedAt }).catch((w) =>
          log.warn('portraitGeneration: failed to record retry image telemetry', { candidateId, error: w }),
        );
      }
      log.info('portraitGeneration: candidate retry succeeded', { candidateId });
      return { ok: true, imageUrl: imageUrl as string, composedPrompt, ...(roundId ? { roundId } : {}) };
    } catch (err) {
      const failed = err instanceof Error ? err.message : String(err);
      if (imageCallId) {
        await finishImageCall(deps.db, userId, imageCallId, { status: 'failed', durationMs: Date.now() - renderStartedAt, errorMessage: failed }).catch((w) =>
          log.warn('portraitGeneration: failed to record failed retry image telemetry', { candidateId, error: w }),
        );
      }
      log.warn('portraitGeneration: candidate retry failed', { candidateId, error: failed });
      return { ok: true, imageUrl: null, composedPrompt, failed, ...(roundId ? { roundId } : {}) };
    }
  } catch (err) {
    log.error('portraitGeneration: candidate retry errored', { userId, candidateId, err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
