/**
 * @file orchestrator/src/orchestrator/portraitFeedback.ts
 * @stamp 2026-08-16
 * @architectural-role Orchestrator — human evaluation, episode logging, and the Reflection
 *   Investigation wiki-writing loop (docs/plans/portrait-studio-plan.md §Human evaluation and
 *   episode logging / §Reflection Investigation)
 * @description
 * The feedback half of Portrait Studio: submitPortraitFeedback writes the visual_episodes row,
 * promotes the winner (entities' last_image_url + current_best_candidate_id), persists
 * per-candidate ratings/notes, then runs the Reflection Investigation — the plan's genuinely new
 * loop: build a Path-2 title+tags wiki index (wiki.ts buildWikiIndex), let the model pull full
 * entries and conclude with a two-tool schema, capped at visual_wiki_investigation_max_turns
 * (default 6) with a forced final submit_conclusion so a round never silently drops its lesson.
 *
 * The loop's mechanics (plan §Reflection Investigation):
 *   1. Build the index across the *whole* active manifest's layers (not just the round's) —
 *      reflection already sees every entity's full record, so narrower wiki visibility would be
 *      the actual inconsistency.
 *   2. Call the gated LLM (taskId `visual-<subjectEntityId>-reflection`, kind 'system' — same
 *      seam as the mutation call) with that index, the winning and losing candidates' composed
 *      prompts/slot values, and the human's rationale + per-candidate ratings/notes. Tools:
 *      pull_wiki_entry(id) and submit_conclusion({action, id?, title, body, tags[], layerId,
 *      entityId?}).
 *   3. Loop: pull_wiki_entry → feed the full entry back and call again; submit_conclusion →
 *      stop; a text-only reply (no tool call) counts toward the cap and the loop continues. On
 *      reaching the cap without a conclusion, the final call is made with submit_conclusion as
 *      the only available tool and forceTool (plan §Edge Cases).
 *   4. create → insert a visual_wiki_entries row with subscriptions built by wiki.ts's
 *      subscriptionsFor (entity-specific when the model named an entity, whole-layer-type when
 *      it named a layer only). amend → look up by id; a missing entry falls back to create and
 *      logs the mismatch (fail-open, never silently discarded — playground §14.2's posture).
 *
 * Fail-open end to end, same contract as generateLocationImage.ts: the episode + entity update
 * are the feedback's primary write (they happen first); a Reflection failure is logged and
 * surfaced in the result as `reflection: { action: 'failed', reason }` — a lesson is never worth
 * losing the round's evaluation record.
 *
 * @api-declaration
 * PortraitFeedbackDeps — db, settings (the reflection needs the manifest for index grouping)
 * submitPortraitFeedback(deps, llm, userId, input) -> Promise<PortraitFeedbackResult>
 *   — fail-open; { ok, episodeId?, reflection?, error? }
 * ReflectionOutcome — { action: 'created' | 'amended' | 'failed', entryId?, reason? }
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, settings read, LLM tool-calling loop, wiki writes)
 *     state_ownership: []
 *     external_io:     [Postgres (visual_episodes/visual_candidates/visual_entities/
 *                       visual_wiki_entries via db.withUserScope), orchestrator_settings (read),
 *                       the LLM via the injected provider]
 *     never:           throws. Every failure path logs and folds into the structured result.
 */

import { log } from '../io/logger.js';
import { runWithCallContext, withCallLabel } from '../io/llm/callContext.js';
import type { LlmMessage, LlmProvider, LlmTurn, ToolCall, ToolDefinition } from '../io/llm/types.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import type { PostgresClient } from '../io/postgres.js';
import { compileTemplate } from '../portraits/composer.js';
import { loadLayerManifest, type LayerManifest } from '../portraits/layerStack.js';
import type { CandidateChromosome } from '../portraits/reconcile.js';
import { buildWikiIndex, subscriptionsFor, type WikiEntryRow, type WikiSubscription } from '../portraits/wiki.js';

export interface PortraitFeedbackDeps {
  db: PostgresClient;
  settings: OrchestratorSettingsStore;
}

export interface PortraitFeedbackInput {
  /** The round's entity map — the episode's entity_ids record. */
  entityIds: Record<string, string>;
  /** The round's goal, recorded on the episode and given to reflection. */
  goal: string;
  /** Every candidate in the round, in grid order. */
  candidateIds: string[];
  /** The human-picked winner — must be one of candidateIds. */
  winnerId: string;
  /** Per-candidate 1-5 ratings, { [candidateId]: rating }. */
  ratings?: Record<string, number>;
  /** Per-candidate notes, { [candidateId]: note }. */
  notes?: Record<string, string>;
  /** The human's overall rationale, recorded on the episode and given to reflection. */
  rationale?: string;
}

export interface ReflectionOutcome {
  action: 'created' | 'amended' | 'failed';
  /** The written/amended entry, when a conclusion landed. */
  entryId?: string;
  /** Why the pass failed (LLM error, undecodable conclusion, empty lesson) — always logged. */
  reason?: string;
}

export interface PortraitFeedbackResult {
  ok: boolean;
  episodeId?: string;
  reflection?: ReflectionOutcome;
  error?: string;
}

interface EpisodeRow {
  episode_id: string;
}

interface CandidateRow {
  candidate_id: string;
  entity_ids: Record<string, string>;
  image_url: string | null;
  chromosome: CandidateChromosome;
}

interface WikiEntryRowFull extends WikiEntryRow {
  entry_id: string;
  title: string;
  body: string;
  tags: string[];
  subscriptions: WikiSubscription[];
}

/** The built-in reflection system prompt — the same "default + bespoke" shape as every prompt
 *  key (bi_principles.md §17): empty visual_reflection_system_prompt_override → this; non-empty
 *  → the override verbatim. */
export const DEFAULT_REFLECTION_SYSTEM_PROMPT =
  'You are the Portrait Studio reflection engine. You evaluate one human-evaluated portrait ' +
  'generation round and decide whether to write or amend a lesson in the studio\'s wiki, which ' +
  'future generation rounds read as guidance. You are given the round\'s goal, the winning and ' +
  'losing candidates, the human\'s ratings and rationale, and an index of existing wiki entries ' +
  'grouped by layer. Pull a full entry before amending it. When you have decided, call ' +
  'submit_conclusion: action "create" for a new lesson, "amend" for an existing one (with its ' +
  'id). Prefer a precise, actionable lesson over a vague one, and name an entity only when the ' +
  'lesson is genuinely specific to that entity rather than its whole layer.';

/** The reflection loop's two tools. submit_conclusion carries the whole conclusion in one call —
 *  the loop terminates on it, so everything the wiki write needs (action, lesson, subscription
 *  scope) must arrive in that single call. */
export const REFLECTION_TOOLS: ToolDefinition[] = [
  {
    name: 'pull_wiki_entry',
    description: 'Fetch the full title and body of one wiki entry from the index above, by its id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The entry id shown in the index.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_conclusion',
    description:
      'Write the round\'s lesson to the wiki: action "create" for a new entry, "amend" for an ' +
      'existing one. layerId is the layer type the lesson applies to; entityId scopes the lesson ' +
      'to one entity of that layer when given (omit to reach the whole layer type).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'amend'], description: '"create" for a new entry, "amend" for an existing one.' },
        id: { type: 'string', description: 'The entry id, required when action is "amend".' },
        title: { type: 'string', description: 'The lesson\'s title.' },
        body: { type: 'string', description: 'The lesson\'s full body.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Open-vocabulary tags.' },
        layerId: { type: 'string', description: 'The layer type this lesson applies to (subject, outfit, style, expression, ...).' },
        entityId: { type: 'string', description: 'Optional: scope the lesson to one entity of layerId.' },
      },
      required: ['action', 'title', 'body', 'layerId'],
      additionalProperties: false,
    },
  },
];

/** The tool set the forced final call sees — submit_conclusion only (plan §Edge Cases: a round
 *  that hits the cap without concluding gets one last call it cannot dodge). */
const FINAL_TOOL = REFLECTION_TOOLS.filter((t) => t.name === 'submit_conclusion');

/** The built-in cap on the investigation loop's tool-calling turns. */
const DEFAULT_INVESTIGATION_MAX_TURNS = 6;

interface ReflectionConclusion {
  action: 'create' | 'amend';
  id?: string;
  title: string;
  body: string;
  tags: string[];
  layerId: string;
  entityId: string | null;
}

/** Decode a tool call's arguments — adapters may hand back an object or a JSON string (the same
 *  tolerance evoprompt.ts's decoder has). Throws on undecodable input; the caller folds it into
 *  a failed reflection outcome. */
function decodeArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('submit_conclusion arguments were not valid JSON');
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('submit_conclusion arguments were not an object');
  }
  return raw as Record<string, unknown>;
}

/** Lenient parse of a submit_conclusion call — every field optional at the shape level; the
 *  apply step is the strict gate (an empty title/body logs and fails rather than writing an
 *  empty lesson). */
function parseConclusion(call: ToolCall): ReflectionConclusion {
  const args = decodeArguments(call.arguments);
  const action = args.action === 'amend' ? 'amend' : 'create';
  const tags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === 'string') : [];
  return {
    action,
    id: typeof args.id === 'string' && args.id !== '' ? args.id : undefined,
    title: typeof args.title === 'string' ? args.title.trim() : '',
    body: typeof args.body === 'string' ? args.body.trim() : '',
    tags,
    layerId: typeof args.layerId === 'string' ? args.layerId : '',
    entityId: typeof args.entityId === 'string' && args.entityId !== '' ? args.entityId : null,
  };
}

function parsePullId(call: ToolCall): string | undefined {
  try {
    const args = decodeArguments(call.arguments);
    return typeof args.id === 'string' && args.id !== '' ? args.id : undefined;
  } catch {
    return undefined;
  }
}

/** The round's candidates as reflection context — composed prompts recomputed from each
 *  candidate's stored chromosome (the same template resolution the generation round used), with
 *  the human's rating/note attached. */
function formatCandidateForReflection(candidate: CandidateRow, rating: number | undefined, note: string | undefined, template: string, manifest: LayerManifest): string {
  const composed = compileTemplate(template, candidate.chromosome.slots ?? {}, manifest.layers);
  const ratingText = rating !== undefined ? ` rating ${rating}/5` : '';
  const noteText = note && note !== '' ? ` note: ${note}` : '';
  return `- ${candidate.candidate_id}${ratingText}${noteText}\n  prompt: ${composed}`;
}

/** The reflection call's user content — Path-2 index, winner, losers, human evaluation. */
function buildReflectionUserPrompt(ctx: {
  goal: string;
  rationale?: string;
  index: string;
  winner: CandidateRow;
  winnerRating?: number;
  winnerNote?: string;
  losers: CandidateRow[];
  loserRatings: Record<string, number>;
  loserNotes: Record<string, string>;
  template: string;
  manifest: LayerManifest;
}): string {
  const parts = [`Round goal: ${ctx.goal}`];
  if (ctx.rationale && ctx.rationale !== '') parts.push(`Human rationale: ${ctx.rationale}`);
  parts.push(
    'Winning candidate:',
    formatCandidateForReflection(ctx.winner, ctx.winnerRating, ctx.winnerNote, ctx.template, ctx.manifest),
  );
  if (ctx.losers.length > 0) {
    parts.push(
      'Losing candidates:',
      ctx.losers.map((c) => formatCandidateForReflection(c, ctx.loserRatings[c.candidate_id], ctx.loserNotes[c.candidate_id], ctx.template, ctx.manifest)).join('\n'),
    );
  }
  if (ctx.index.trim() !== '') {
    parts.push('Existing wiki entries (title + tags only — pull an entry for its full body):', ctx.index);
  } else {
    parts.push('The wiki is empty — any lesson you write will be the first entry.');
  }
  parts.push('Call pull_wiki_entry to read a full entry before amending it, then submit_conclusion when you have decided.');
  return parts.join('\n\n');
}

/** Load one wiki entry by id for the pull_wiki_entry feedback message; undefined → the
 *  "not found" reply (the model is told, and can create instead). */
async function loadWikiEntry(db: PostgresClient, userId: string, entryId: string): Promise<WikiEntryRowFull | undefined> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<WikiEntryRowFull>(
      `select entry_id, title, body, tags, subscriptions
       from visual_wiki_entries where entry_id = $1 and user_id = $2`,
      [entryId, userId],
    ),
  );
  return rows[0];
}

/** Apply a concluded lesson: create inserts; amend looks up by id and falls back to create when
 *  the id doesn't match anything (plan §Edge Cases — fail-open, logged). Returns the applied
 *  entry id. */
async function applyConclusion(
  db: PostgresClient,
  userId: string,
  episodeId: string,
  conclusion: ReflectionConclusion,
): Promise<{ entryId: string; action: 'created' | 'amended' }> {
  if (conclusion.title === '' || conclusion.body === '' || conclusion.layerId === '') {
    throw new Error('submit_conclusion returned an empty lesson (title/body/layerId missing)');
  }
  const subscriptions = JSON.stringify(subscriptionsFor(conclusion.layerId, conclusion.entityId));
  if (conclusion.action === 'amend' && conclusion.id) {
    const existing = await db.withUserScope(userId, (session) =>
      session.query<{ entry_id: string }>(
        'select entry_id from visual_wiki_entries where entry_id = $1 and user_id = $2',
        [conclusion.id, userId],
      ),
    );
    if (existing[0]) {
      await db.withUserScope(userId, (session) =>
        session.query(
          `update visual_wiki_entries set title = $2, body = $3, tags = $4::text[], subscriptions = $5::jsonb, updated_at = now()
           where entry_id = $1 and user_id = $6`,
          [conclusion.id, conclusion.title, conclusion.body, conclusion.tags, subscriptions, userId],
        ),
      );
      return { entryId: conclusion.id, action: 'amended' };
    }
    log.warn('portraitFeedback: amend target not found, falling back to create', { entryId: conclusion.id });
  }
  const rows = await db.withUserScope(userId, (session) =>
    session.query<{ entry_id: string }>(
      `insert into visual_wiki_entries (user_id, title, body, tags, subscriptions, origin_episode_id)
       values ($1, $2, $3, $4::text[], $5::jsonb, $6) returning entry_id`,
      [userId, conclusion.title, conclusion.body, conclusion.tags, subscriptions, episodeId],
    ),
  );
  return { entryId: rows[0].entry_id, action: 'created' };
}

/** The Reflection Investigation loop itself (plan §Reflection Investigation steps 1-4) — the
 *  part verify-visual-wiki.mjs drives with a fake gate. Fail-open: every failure mode logs and
 *  resolves to a 'failed' outcome; the episode write that precedes this is never rolled back. */
async function runReflectionInvestigation(
  deps: PortraitFeedbackDeps,
  llm: LlmProvider,
  userId: string,
  ctx: {
    subjectEntityId: string;
    episodeId: string;
    goal: string;
    rationale?: string;
    candidates: CandidateRow[];
    winnerId: string;
    ratings: Record<string, number>;
    notes: Record<string, string>;
    template: string;
    manifest: LayerManifest;
  },
): Promise<ReflectionOutcome> {
  try {
    const [maxTurnsRaw, reflectionOverride] = await Promise.all([
      deps.settings.get('visual_wiki_investigation_max_turns'),
      deps.settings.get('visual_reflection_system_prompt_override'),
    ]);
    const maxTurns = maxTurnsRaw ? Number(maxTurnsRaw) : NaN;
    const cap = Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : DEFAULT_INVESTIGATION_MAX_TURNS;

    const entries = await deps.db.withUserScope(userId, (session) =>
      session.query<WikiEntryRowFull>(
        `select entry_id, title, body, tags, subscriptions
         from visual_wiki_entries where user_id = $1 order by created_at`,
        [userId],
      ),
    );
    const index = buildWikiIndex(entries, ctx.manifest.layers);

    const winner = ctx.candidates.find((c) => c.candidate_id === ctx.winnerId);
    if (!winner) throw new Error(`winner ${ctx.winnerId} not among the round's candidates`);
    const losers = ctx.candidates.filter((c) => c.candidate_id !== ctx.winnerId);
    const system = (reflectionOverride ?? '').trim() || DEFAULT_REFLECTION_SYSTEM_PROMPT;
    const userPrompt = buildReflectionUserPrompt({
      goal: ctx.goal,
      rationale: ctx.rationale,
      index,
      winner,
      winnerRating: ctx.ratings[ctx.winnerId],
      winnerNote: ctx.notes[ctx.winnerId],
      losers,
      loserRatings: ctx.ratings,
      loserNotes: ctx.notes,
      template: ctx.template,
      manifest: ctx.manifest,
    });

    const messages: LlmMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ];

    for (let turn = 0; turn < cap; turn++) {
      const isFinal = turn === cap - 1;
      const result: LlmTurn = await runWithCallContext(
        { taskId: `visual-${ctx.subjectEntityId}-reflection`, kind: 'system', userId },
        () =>
          withCallLabel('portrait:reflection', () =>
            llm.complete(messages, isFinal ? FINAL_TOOL : REFLECTION_TOOLS, isFinal ? { forceTool: 'submit_conclusion' } : undefined),
          ),
      );
      // The assistant message is always appended (toolCalls may be empty) so the conversation
      // stays well-formed for the next complete() call — LlmMessage.toolCalls is required to
      // trace a 'tool' message back to a preceding assistant tool call.
      messages.push({ role: 'assistant', content: result.message.content, toolCalls: result.toolCalls });

      const conclusionCall = result.toolCalls.find((c) => c.name === 'submit_conclusion');
      if (conclusionCall) {
        const conclusion = parseConclusion(conclusionCall);
        const applied = await applyConclusion(deps.db, userId, ctx.episodeId, conclusion);
        log.info('portraitFeedback: reflection conclusion applied', {
          episodeId: ctx.episodeId,
          action: applied.action,
          entryId: applied.entryId,
          turns: turn + 1,
        });
        return { action: applied.action, entryId: applied.entryId };
      }

      const pullCall = result.toolCalls.find((c) => c.name === 'pull_wiki_entry');
      if (pullCall) {
        const entryId = parsePullId(pullCall);
        const entry = entryId ? await loadWikiEntry(deps.db, userId, entryId) : undefined;
        messages.push({
          role: 'tool',
          toolCallId: pullCall.id,
          content: entry ? `## ${entry.title}\n${entry.body}` : `No wiki entry with id ${entryId ?? '(missing id)'} — you may create one instead.`,
        });
        continue;
      }

      // A text-only reply (no tool call) — not a conclusion, and there is nothing to feed back;
      // the turn counts toward the cap and the next call sees the model's own prose. The cap is
      // the bound; the forced final call guarantees a conclusion before the loop can exhaust.
      log.debug('portraitFeedback: reflection turn had no tool call, continuing', { episodeId: ctx.episodeId, turn: turn + 1 });
    }

    // Unreachable by construction (the final iteration forces submit_conclusion), but the guard
    // costs nothing and keeps the fail-open contract total even if a provider ignores forceTool.
    log.warn('portraitFeedback: investigation cap reached without a conclusion', { episodeId: ctx.episodeId, cap });
    return { action: 'failed', reason: 'cap_reached_without_conclusion' };
  } catch (err) {
    log.error('portraitFeedback: reflection investigation failed', { err });
    return { action: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function submitPortraitFeedback(
  deps: PortraitFeedbackDeps,
  llm: LlmProvider,
  userId: string,
  input: PortraitFeedbackInput,
): Promise<PortraitFeedbackResult> {
  try {
    if (!input.candidateIds.includes(input.winnerId)) {
      return { ok: false, error: 'winner_not_in_candidates' };
    }

    // Load every candidate in the round — the episode write, the entity promotion, and the
    // reflection context all need the stored rows (chromosome + image_url + entity_ids).
    const candidates = await deps.db.withUserScope(userId, (session) =>
      session.query<CandidateRow>(
        `select candidate_id, entity_ids, image_url, chromosome
         from visual_candidates where user_id = $1 and candidate_id = any($2::uuid[])
         order by array_position($2::uuid[], candidate_id)`,
        [userId, input.candidateIds],
      ),
    );
    if (candidates.length !== input.candidateIds.length) {
      return { ok: false, error: 'unknown_candidate_id' };
    }

    // Primary write first: the episode row — the round's reconstructible evaluation record.
    const episode = await deps.db.withUserScope(userId, (session) =>
      session.query<EpisodeRow>(
        `insert into visual_episodes (user_id, entity_ids, goal, rationale, selected_candidate_id, candidate_ids)
         values ($1, $2::jsonb, $3, $4, $5, $6::uuid[]) returning episode_id`,
        [userId, JSON.stringify(input.entityIds), input.goal, input.rationale ?? null, input.winnerId, input.candidateIds],
      ),
    );
    const episodeId = episode[0].episode_id;

    // Winner promotion — last write wins, same posture as generateLocationImage.ts for
    // non-critical convenience fields (plan §Edge Cases): the winner's own entity_ids (the
    // round's authoritative record) are the entities promoted.
    const winner = candidates.find((c) => c.candidate_id === input.winnerId)!;
    const winnerEntityIds = Object.values(winner.entity_ids ?? {});
    if (winnerEntityIds.length > 0) {
      await deps.db.withUserScope(userId, (session) =>
        session.query(
          `update visual_entities set last_image_url = $2, current_best_candidate_id = $3, updated_at = now()
           where user_id = $4 and entity_id = any($5::uuid[])`,
          [userId, winner.image_url, winner.candidate_id, userId, winnerEntityIds],
        ),
      );
    }

    // Per-candidate ratings/notes — pass through; the 1-5 range is the migration's CHECK, and a
    // malformed value is skipped with a log, not an aborted feedback (fail-open).
    for (const [candidateId, rating] of Object.entries(input.ratings ?? {})) {
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        log.warn('portraitFeedback: skipping out-of-range rating', { candidateId, rating });
        continue;
      }
      await deps.db.withUserScope(userId, (session) =>
        session.query('update visual_candidates set rating = $2 where candidate_id = $1 and user_id = $3', [candidateId, rating, userId]),
      );
    }
    for (const [candidateId, note] of Object.entries(input.notes ?? {})) {
      if (typeof note !== 'string') continue;
      await deps.db.withUserScope(userId, (session) =>
        session.query('update visual_candidates set note = $2 where candidate_id = $1 and user_id = $3', [candidateId, note, userId]),
      );
    }

    // Reflection: manifest for index grouping + the style template override resolution the
    // generation round used (the composed prompts recomputed here must match what was
    // rendered). The style entity is read off the winner's entity_ids — the round's *resolved*
    // map (a placeholder fallback for an unspecified layer is recorded there, not in the
    // feedback input), and it is authoritative for which entities actually rendered.
    const manifest = await loadLayerManifest({ settings: deps.settings });
    const styleEntityId = winner.entity_ids?.['style'];
    let template = manifest.template;
    if (styleEntityId) {
      const styleRows = await deps.db.withUserScope(userId, (session) =>
        session.query<{ template: string | null }>(
          `select template from visual_entities where user_id = $1 and entity_id = $2`,
          [userId, styleEntityId],
        ),
      );
      if (styleRows[0]?.template) template = styleRows[0].template;
    }

    const reflection = await runReflectionInvestigation(deps, llm, userId, {
      subjectEntityId: input.entityIds['subject'] ?? '',
      episodeId,
      goal: input.goal,
      rationale: input.rationale,
      candidates,
      winnerId: input.winnerId,
      ratings: input.ratings ?? {},
      notes: input.notes ?? {},
      template,
      manifest,
    });

    log.info('portraitFeedback: episode recorded', { episodeId, winnerId: input.winnerId, reflection: reflection.action });
    return { ok: true, episodeId, reflection };
  } catch (err) {
    log.error('portraitFeedback: feedback failed', { userId, winnerId: input.winnerId, err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
