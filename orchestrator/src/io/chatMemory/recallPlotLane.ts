/**
 * @file orchestrator/src/io/chatMemory/recallPlotLane.ts
 * @stamp 2026-08-17
 * @architectural-role IO Wrapper — the ranked, bounded canon_facts plot-arc lane behind
 * buildAutoRecallParts's silent auto-recall (recallForPrompt.ts), sibling to
 * recallChunkLane.ts/recallFactLane.ts (same directory, same bi_principles.md §10 split).
 * @description
 * The plot-recall lane of docs/plans/plot-arc-recall-plan.md. Replaces the old unconditional
 * `plot_threads` read (buildChatMemorySystemPrompt's rp branch: an unranked, unbounded dump of
 * every open arc's latest row) with a ranked, bounded retrieval that treats plot beats the way
 * Canonize's own Plot RAG lane does: every beat is a permanent, individually-embedded record;
 * each turn surfaces only the arcs relevant to *this* turn, each rendered as a first-entry +
 * last-three-entries card.
 *
 * Pipeline, per the plan's Logic section:
 *  1. Fetch a candidate pool of *individual* `category = 'plot'`, `status <> 'rejected'` rows
 *     for this chat, ranked by vector distance to the query — deliberately NOT deduped to one
 *     row per arc first, unlike recallFactLane's existing dedup. An older beat of a still-open
 *     arc must be able to win on relevance even when that arc's latest beat doesn't match the
 *     current query well — that is what makes an arc "come back into focus" when the story
 *     circles back to it. The ranked pool is then reduced to one entry per `arc_tag` by keeping
 *     each arc's best-scoring row (`distinct on (arc_tag) ... order by arc_tag, distance` —
 *     first occurrence in rank order), preserving that best score as the arc's representative
 *     score.
 *  2. Apply recallCutoff.ts's `applyCutoff` to the arc-level representative scores (same
 *     min/max/cutoffMode knobs, new setting values — see Contracts in the plan).
 *  3. Recency floor: separately identify arcs with at least one row belonging to the chat's
 *     most recent `recencyFloorSyncs` sync ticks (by chat_sync_points.ordinal recency, not
 *     wall-clock time — sync ticks are the natural "how long ago" unit here). These arcs are
 *     unioned into the selected set regardless of whether they cleared the semantic cutoff, so
 *     a thread that's clearly active right now can't drop out purely because its wording didn't
 *     embed close to the query (Canonize's "supplemented by recency-based filler").
 *  4. Cap the final selected-arc count at the Max setting (selection-cutoff arcs and
 *     recency-floor arcs combined, deduplicated) — the floor is a genuine guarantee of
 *     inclusion (up to Max, never past it): floor-only arcs claim their slots first, and the
 *     weakest scored arcs are trimmed to make room, not the floor arcs.
 *  5. For each selected arc_tag, fetch this chat's full row history for that arc (`status <>
 *     'rejected'`, ordered by `proposed_at`) and reduce to first entry + last three entries,
 *     deduplicated when the arc has four or fewer total entries — direct port of Canonize's
 *     buildExistingThreads (SillyTavern-Canonize core/sync.js:63-101).
 *  6. Return the selected arcs as an ordered list of `{ arc_tag, entries }` cards: scored arcs
 *     in representative-score order (deterministic tie-break on arc_tag), recency-floor-only
 *     arcs appended after them in arc_tag order — deterministic for identical inputs.
 *
 * Status filter `<> 'rejected'` and the fail-open `{ arcs: [] }` contract are shared with
 * recallFactLane.ts (see that file's own comment): a `proposed` row is already live per
 * bi_principles.md §15, so this lane and every other silent-injection path read "not rejected",
 * never "approved".
 *
 * @api-declaration
 * recallPlotLane(session, userId, chatId, vector, opts) -> Promise<{ arcs: PlotArcCard[] }> —
 *   mirrors recallFactLane's signature shape exactly, plus the one new recencyFloorSyncs
 *   option. Logs one telemetry line per call (bi_principles.md §11).
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the caller's session, logs)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { DbSession } from '../postgres.js';
import { toPgVectorLiteral } from '../../util/pgvector.js';
import { applyCutoff, poolSize, type CutoffMode } from './recallCutoff.js';
import type { PlotArcCard } from './memoryInjection.js';
import { log } from '../logger.js';

/** Sanity cap on the candidate pool — same value and reasoning as recallFactLane's own cap;
 *  kept as its own local constant rather than a shared import (see that file's note on why). */
const MAX_POOL_SIZE = 40;

/** Per-arc card size — first entry + the last three, hardcoded exactly the way Canonize's own
 *  buildExistingThreads never made it configurable (the plan's Contracts: a structural constant
 *  closer in kind to AUTO_RECALL_PAIRS's hardcoded-default treatment than to a §17 prompt). */
export const PLOT_ARC_CARD_SIZE = 3;

export interface PlotLaneOptions {
  min: number;
  max: number;
  poolMultiple: number;
  cutoffMode: CutoffMode;
  /** How many of the chat's most recent sync ticks (chat_sync_points.ordinal recency) an arc
   *  must have been touched in to qualify for the recency floor. */
  recencyFloorSyncs: number;
}

interface PlotPoolRow {
  arc_tag: string;
  summary: string;
  detail: string;
  /** Raw L2 distance to the query vector (`vector_embed <-> $query`) — the arc's
   *  representative score after the per-arc best-row reduction (step 1). */
  distance: number;
}

/** The first-entry + last-`PLOT_ARC_CARD_SIZE` reducer, ported verbatim from Canonize's
 *  buildExistingThreads (core/sync.js): `entries.length <= 4` keeps everything (the last-three
 *  selection would otherwise double-count a 4-entry arc's first item — the plan's Edge Cases
 *  explicitly warns against re-deriving this as `>= 4`). Pure; exported for the verify script. */
export function reduceArcEntries<T>(entries: T[]): T[] {
  return entries.length <= PLOT_ARC_CARD_SIZE + 1 ? entries : [entries[0]!, ...entries.slice(-PLOT_ARC_CARD_SIZE)];
}

/** Fetch this chat's plot beats, rank them per arc, cut the pool by the dynamic cutoff, add the
 *  recency floor, cap at Max, and render each selected arc as a first+last-N card. `vector` is
 *  the caller's already-embedded recall query — the same one buildAutoRecallParts embeds once
 *  and shares with the chunk/fact lanes (one embedding-provider round trip per turn). */
export async function recallPlotLane(
  session: DbSession,
  userId: string,
  chatId: string,
  vector: number[],
  opts: PlotLaneOptions,
): Promise<{ arcs: PlotArcCard[] }> {
  const { min, max, poolMultiple, cutoffMode, recencyFloorSyncs } = opts;
  try {
    const pool = Math.min(poolSize(max, poolMultiple), MAX_POOL_SIZE);

    // Step 1: the candidate pool of INDIVIDUAL plot beats (no per-arc dedup first), reduced to
    // one best-scoring row per arc_tag. `distinct on (arc_tag) ... order by arc_tag,
    // vector_embed <-> $3` keeps each arc's lowest-distance (best-relevance) row — an older
    // beat can win over the arc's latest beat when it matches the query better. Outer order is
    // `distance, arc_tag` — deterministic, arc_tag as the tie-break so
    // equal scores never fall back to insertion-order-dependent Postgres output.
    const poolRows = await session.query<PlotPoolRow>(
      `with candidates as (
         select f.arc_tag, f.summary, f.detail, f.vector_embed
         from canon_facts f
         where f.user_id = $1 and f.chat_id = $2 and f.category = 'plot' and f.status <> 'rejected'
       ),
       ranked as (
         select distinct on (arc_tag) arc_tag, summary, detail, vector_embed
         from candidates
         order by arc_tag, vector_embed <-> $3
       )
       select arc_tag, summary, detail, vector_embed <-> $3 as distance
       from ranked
       order by vector_embed <-> $3, arc_tag
       limit $4`,
      [userId, chatId, toPgVectorLiteral(vector), pool],
    );

    // Step 2: the dynamic cutoff over the arc-level representative scores (the same pure
    // function both sibling lanes use; lower distance is better).
    const { keepCount, stats } = applyCutoff(poolRows.map((r) => r.distance), { min, max, cutoffMode });
    const scoredArcs = poolRows.slice(0, keepCount);

    // Step 3: the recency floor — arcs touched in the chat's most recent N sync ticks
    // (chat_sync_points.ordinal recency, not wall-clock time). A row whose sync_id is null (its
    // originating sync was later deleted — canon_facts_sync_id_fkey ON DELETE SET NULL) can't
    // count toward the floor, but the semantic path above never filtered on sync_id, so it
    // stays rankable — only the floor excludes it, per the plan's Edge Cases.
    const floorArcs = await session.query<{ arc_tag: string }>(
      `select distinct f.arc_tag
       from canon_facts f
       where f.user_id = $1 and f.chat_id = $2 and f.category = 'plot' and f.status <> 'rejected'
         and f.sync_id in (
           select sync_id from chat_sync_points
           where user_id = $1 and chat_id = $2
           order by ordinal desc
           limit $3
         )`,
      [userId, chatId, recencyFloorSyncs],
    );

    // Steps 3-4: union scored arcs with floor arcs (deduped), then cap the combined set at Max.
    // The floor is a genuine GUARANTEE of inclusion (up to Max, never past it) — so floor-only
    // arcs claim their slots first and the weakest scored arcs are the ones trimmed to make
    // room, not the other way around. Reserving scored slots first (i.e. capping scoredArcs at
    // Max before ever looking at floorOnlyTags) would silently drop the floor arcs whenever the
    // scored set alone already reaches Max — exactly the busy-chat case the recency floor exists
    // for, since that's precisely when a dormant-but-recently-touched arc most needs the floor to
    // keep it visible.
    const scoredTags = new Set(scoredArcs.map((r) => r.arc_tag));
    const floorOnlyTags = [...new Set(floorArcs.map((r) => r.arc_tag))]
      .filter((t) => !scoredTags.has(t))
      .sort();
    const floorBudget = Math.min(floorOnlyTags.length, max);
    const combined = [
      ...scoredArcs.slice(0, max - floorBudget).map((r) => r.arc_tag),
      ...floorOnlyTags.slice(0, floorBudget),
    ];

    // Step 5: per-arc card history — this chat's full row history for the arc, first + last N.
    const arcs: PlotArcCard[] = [];
    for (const arcTag of combined) {
      const history = await session.query<{ summary: string; detail: string }>(
        `select summary, detail
         from canon_facts
         where user_id = $1 and chat_id = $2 and category = 'plot' and arc_tag = $3 and status <> 'rejected'
         order by proposed_at, fact_id`,
        [userId, chatId, arcTag],
      );
      const entries = reduceArcEntries(history.map((r) => ({ summary: r.summary, detail: r.detail })));
      if (entries.length) arcs.push({ arc_tag: arcTag, entries });
    }

    log.info('recallPlotLane: cutoff applied', {
      userId,
      chatId,
      min,
      max,
      keepCount,
      recencyFloorSyncs,
      floorOnlyArcs: floorOnlyTags.length,
      returnedArcs: arcs.length,
      ...stats,
    });
    return { arcs };
  } catch (err) {
    // Fail-open, same contract as every sibling lane: a retrieval error must never break or
    // stall the turn. Caught internally, unlike recallFactLane/recallChunkLane (which rely on
    // buildAutoRecallParts's own outer try/catch and so take the whole turn's recall down
    // together on error) — this lane catches its own errors specifically so a plot-lane failure
    // can't reject the caller's Promise.all and drag bridgeRows/chunks/facts down with it.
    log.warn('recallPlotLane: retrieval failed, continuing without plot arcs', { userId, chatId, err });
    return { arcs: [] };
  }
}
