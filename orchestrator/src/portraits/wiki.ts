/**
 * @file orchestrator/src/portraits/wiki.ts
 * @stamp 2026-08-16
 * @architectural-role Pure Function — subscribed-entry injection + title/tag index formatting
 *   (bi_principles.md §8)
 * @description
 * The wiki's two pure read-side formatters (plan §Reflection Investigation):
 *
 * - `formatSubscribedEntries` is Path 1 — what the *mutation* prompt sees. It selects every
 *   `visual_wiki_entries` row whose subscriptions include any of the round's active entity ids,
 *   or the active layer types at the whole-layer-type level (a subscription with a null
 *   `layerEntityId` reaches every entity of that layer type, not just the ones named), and
 *   formats the full title+body, uncapped (this function remains the full-form path; the
 *   mutation/reflection callers bound it via `formatBoundedSubscribedEntries`) — the same
 *   flat-inclusion posture playground's §23.4 settled on. Empty when nothing matches.
 *
 * - `buildWikiIndex` is Path 2 — what the *reflection* loop's first call sees. A title+tags-only
 *   index of every entry, grouped by the layer type each of its subscriptions names, across the
 *   *whole* active manifest's layers (not just the layers the current round touched — reflection
 *   already sees every entity's full record, so scoping its wiki visibility narrower than that
 *   would be the actual inconsistency; plan §Reflection Investigation step 1). Deterministic:
 *   manifest layer order, then title order within a group.
 *
 * - `formatUnsubscribedTagIndex` is Path 1c — the mutation call's catch-all for entries Path 1
 *   (a/b) didn't already hand over full-body: title + tags + id, flat, for every entry NOT
 *   subscribed to any active entity id or active whole-layer type. A lesson can be genuinely
 *   relevant to a round's goal without ever having been subscribed to this entity or this layer
 *   (the subscription model is structural, not semantic), so the mutation call gets to see what
 *   exists and pull one on demand (evoprompt.ts's PULL_WIKI_ENTRY_TOOL) rather than staying blind
 *   to everything outside its structural subscriptions. Ids are shown here (unlike Path 2's
 *   buildWikiIndex) because this index exists specifically to be pulled from by id.
 *
 * `subscriptionsFor` is the pure constructor for the subscriptions jsonb a `create` conclusion
 *   writes: entity-specific when the model named an entity, whole-layer-type when it didn't.
 *
 * - `formatLessonIndex` (docs/plans/portrait-studio-lesson-amend-plan.md) is reflection's
 *   existing-lesson index: id + statement + target layer + maturity for every non-terminal
 *   (provisional/supported) lesson whose wiki entry reaches this round — same subscription-reach
 *   rule as every other formatter here (entity-scoped only when scoped to one of this round's
 *   active entities; not-entity-scoped always reaches). Shown unconditionally every round,
 *   uncapped (id+statement is compact by construction, unlike full-body Path 1) — so reflection
 *   can choose to amend an existing lesson (submit_lesson's supersedes_lesson_id) instead of
 *   writing a near-duplicate.
 *
 * Pure by construction: identical inputs always produce identical output — no IO, no state, no
 * randomness.
 *
 * @api-declaration
 * WikiSubscription — { layerType, layerEntityId: string | null }
 * WikiEntryRow — the row fields the two formatters read
 * formatSubscribedEntries(entries, activeEntityIds, activeLayerTypes) -> string — pure, '' when
 *   nothing matches
 * buildWikiIndex(entries, layers) -> string — pure, title+tags grouped by layer type
 * formatUnsubscribedTagIndex(entries, activeEntityIds, activeLayerTypes) -> string — pure,
 *   title+tags+id for entries Path 1 (a/b) didn't already surface, '' when nothing qualifies
 * formatBoundedSubscribedEntries(entries, activeEntityIds, activeLayerTypes, budgetChars) ->
 *   { text, entryIds } — pure, Path 1 under a character budget (never the entire wiki)
 * subscriptionsFor(layerId, entityId) -> WikiSubscription[] — pure
 * LessonIndexRow — { lesson_id, statement, layer, state, subscriptions }
 * formatLessonIndex(lessons, activeEntityIds, activeLayerTypes) -> string — pure, '' when nothing
 *   reaches
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO, no state, no randomness)
 *     state_ownership: []
 *     external_io:     []
 */

import type { LayerDefinition } from './layerStack.js';

export interface WikiSubscription {
  layerType: string;
  layerEntityId: string | null;
}

/** The visual_wiki_entries row fields the formatters read — the IO wrapper (portraitRoutes.ts)
 *  shapes its rows to this before calling. */
export interface WikiEntryRow {
  entry_id: string;
  title: string;
  body: string;
  tags: string[];
  subscriptions: WikiSubscription[];
}

/** Pure: does any of these subscriptions reach the round — an active entity id (entity-specific)
 *  or a whole-layer-type subscription (null layerEntityId) matching an active layer type? Shared
 *  by every formatter below that gates on subscription reach. */
function subscriptionReaches(subscriptions: WikiSubscription[], activeEntityIds: string[], activeLayerTypes: string[]): boolean {
  return subscriptions.some(
    (sub) =>
      (sub.layerEntityId !== null && sub.layerEntityId !== undefined && activeEntityIds.includes(sub.layerEntityId)) ||
      (sub.layerEntityId === null && activeLayerTypes.includes(sub.layerType)),
  );
}

/** Pure: an entry is subscribed to a round when any subscription names an active entity id
 *  (entity-specific) or a whole-layer-type subscription matches an active layer type. */
function isSubscribed(entry: WikiEntryRow, activeEntityIds: string[], activeLayerTypes: string[]): boolean {
  return subscriptionReaches(entry.subscriptions, activeEntityIds, activeLayerTypes);
}

/** Pure: Path 1 — the subscribed entries' full title+body, flat and uncapped, in row order.
 *  Deduplicated (an entry subscribed both ways appears once). '' when nothing matches. */
export function formatSubscribedEntries(entries: WikiEntryRow[], activeEntityIds: string[], activeLayerTypes: string[]): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.entry_id)) continue;
    if (!isSubscribed(entry, activeEntityIds, activeLayerTypes)) continue;
    seen.add(entry.entry_id);
    blocks.push(`## ${entry.title}\n${entry.body}`);
  }
  return blocks.join('\n\n');
}

/** Pure: Path 2 — every entry's title + tags, grouped by layer type, in manifest layer order.
 *  An entry subscribed to several layer types appears under each of them. Layers with no
 *  subscribed entries are omitted (the reflection call sees the manifest's scope implicitly via
 *  the layer definitions it is also given). */
export function buildWikiIndex(entries: WikiEntryRow[], layers: LayerDefinition[]): string {
  const lines: string[] = [];
  for (const layer of layers) {
    const subscribed = entries
      .filter((entry) => entry.subscriptions.some((sub) => sub.layerType === layer.id))
      .sort((a, b) => a.title.localeCompare(b.title));
    if (subscribed.length === 0) continue;
    lines.push(`## ${layer.label} (${layer.id})`);
    for (const entry of subscribed) {
      const tagSuffix = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
      lines.push(`- ${entry.title}${tagSuffix}`);
    }
  }
  return lines.join('\n');
}

/** Pure: Path 1 under a character budget (docs/plans/portrait-studio-vision-review-harness-plan.md
 *  §Wiki policy — "Send mutation a bounded selected set of current revisions, never the entire
 *  wiki", bi_principles.md §16). Full title+body for subscribed entries in row order, accumulating
 *  until the next block would exceed budgetChars; the first block alone is truncated to the budget
 *  rather than dropped, so a single oversized lesson still reaches the call in some form. Returns
 *  the entry ids included (the caller maps them to current revision ids for provenance). */
export function formatBoundedSubscribedEntries(
  entries: WikiEntryRow[],
  activeEntityIds: string[],
  activeLayerTypes: string[],
  budgetChars: number,
): { text: string; entryIds: string[] } {
  const budget = Number.isInteger(budgetChars) && budgetChars > 0 ? budgetChars : 0;
  const blocks: string[] = [];
  const entryIds: string[] = [];
  let used = 0;
  for (const entry of entries) {
    if (!isSubscribed(entry, activeEntityIds, activeLayerTypes)) continue;
    const block = `## ${entry.title}\n${entry.body}`;
    if (blocks.length === 0 && block.length > budget) {
      blocks.push(block.slice(0, budget));
      entryIds.push(entry.entry_id);
      break;
    }
    if (used + block.length > budget) break;
    blocks.push(block);
    entryIds.push(entry.entry_id);
    used += block.length;
  }
  return { text: blocks.join('\n\n'), entryIds };
}

/** Pure: Path 1c — every entry Path 1's a/b subscription match (isSubscribed) does NOT already
 *  reach, title + tags + id, flat, title order. '' when every entry is already subscribed or the
 *  wiki is empty. Ids are shown (unlike buildWikiIndex) because this index is meant to be pulled
 *  from by id via PULL_WIKI_ENTRY_TOOL, not just read. */
export function formatUnsubscribedTagIndex(entries: WikiEntryRow[], activeEntityIds: string[], activeLayerTypes: string[]): string {
  return entries
    .filter((entry) => !isSubscribed(entry, activeEntityIds, activeLayerTypes))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((entry) => {
      const tagSuffix = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
      return `- ${entry.entry_id}: ${entry.title}${tagSuffix}`;
    })
    .join('\n');
}

/** Pure: the subscriptions jsonb for a created entry — entity-specific when the reflection
 *  model named one entity, whole-layer-type when it named a layer only (plan §Reflection
 *  Investigation step 4). */
export function subscriptionsFor(layerId: string, entityId: string | null): WikiSubscription[] {
  return [{ layerType: layerId, layerEntityId: entityId ?? null }];
}

/** A visual_lessons row joined to its wiki entry's subscriptions (portraitFeedback.ts's
 *  buildReflectionSnapshot query) — the fields formatLessonIndex needs to decide reach and
 *  render one line. */
export interface LessonIndexRow {
  lesson_id: string;
  statement: string;
  layer: string;
  state: string;
  subscriptions: WikiSubscription[];
}

/** Pure: reflection's existing-lesson index (docs/plans/portrait-studio-lesson-amend-plan.md) —
 *  id + target layer + maturity + statement for every lesson whose wiki-entry subscription
 *  reaches this round, sorted by statement. Never full evidence — this is meant to be read
 *  whole, every round, so reflection can name an id to amend via submit_lesson's
 *  supersedes_lesson_id instead of writing a near-duplicate. '' when nothing reaches. */
export function formatLessonIndex(lessons: LessonIndexRow[], activeEntityIds: string[], activeLayerTypes: string[]): string {
  return lessons
    .filter((l) => subscriptionReaches(l.subscriptions, activeEntityIds, activeLayerTypes))
    .sort((a, b) => a.statement.localeCompare(b.statement))
    .map((l) => `- ${l.lesson_id} [${l.layer}, ${l.state}]: ${l.statement}`)
    .join('\n');
}
