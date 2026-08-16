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
 *   formats the full title+body, uncapped — the same flat-inclusion posture playground's §23.4
 *   settled on. Empty when nothing matches.
 *
 * - `buildWikiIndex` is Path 2 — what the *reflection* loop's first call sees. A title+tags-only
 *   index of every entry, grouped by the layer type each of its subscriptions names, across the
 *   *whole* active manifest's layers (not just the layers the current round touched — reflection
 *   already sees every entity's full record, so scoping its wiki visibility narrower than that
 *   would be the actual inconsistency; plan §Reflection Investigation step 1). Deterministic:
 *   manifest layer order, then title order within a group.
 *
 * `subscriptionsFor` is the pure constructor for the subscriptions jsonb a `create` conclusion
 *   writes: entity-specific when the model named an entity, whole-layer-type when it didn't.
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
 * subscriptionsFor(layerId, entityId) -> WikiSubscription[] — pure
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

/** Pure: an entry is subscribed to a round when any subscription names an active entity id
 *  (entity-specific) or a whole-layer-type subscription matches an active layer type. */
function isSubscribed(entry: WikiEntryRow, activeEntityIds: string[], activeLayerTypes: string[]): boolean {
  return entry.subscriptions.some(
    (sub) =>
      (sub.layerEntityId !== null && sub.layerEntityId !== undefined && activeEntityIds.includes(sub.layerEntityId)) ||
      (sub.layerEntityId === null && activeLayerTypes.includes(sub.layerType)),
  );
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

/** Pure: the subscriptions jsonb for a created entry — entity-specific when the reflection
 *  model named one entity, whole-layer-type when it named a layer only (plan §Reflection
 *  Investigation step 4). */
export function subscriptionsFor(layerId: string, entityId: string | null): WikiSubscription[] {
  return [{ layerType: layerId, layerEntityId: entityId ?? null }];
}
