/**
 * @file plugins/canonize/src/recallCanonFactsTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — semantic search over approved canon, scoped by scene state
 * @description
 * The read side of the canon gate (bi_principles.md §15/§16, canonize-plan.md §3.4/§5): only
 * status = 'approved' rows are ever candidates — a proposal or a rejection is never selectable
 * into a prompt, regardless of scope. Scoping is trusted scene state, never message content
 * (bi_principles.md §4): a fact is in scope when it's linked to a character present in the scene
 * (scene_presence), linked to the scene's active location (scenes.active_location_id), or has no
 * character/location link at all (a scene-global or platform-global fact, depending on whether
 * scene_id is set).
 *
 * For 'plot' facts, canonize-plan.md §3.2's arc_tag continuity means every proposal for a
 * continuing thread is its own row — recall must collapse that to only the most-recently-approved
 * row per arc_tag before ranking, or a stale, superseded plot beat would sit in the prompt stack
 * alongside its own replacement. Non-plot facts have no arc_tag, so `coalesce(arc_tag,
 * fact_id::text)` gives each of them its own dedup group — collapsing on a bare `arc_tag` would
 * fold every arc_tag-less fact together into a single arbitrary survivor, which is not what
 * canonize-plan.md §3.2 describes.
 *
 * @api-declaration
 * createRecallCanonFactsTool(embeddings, settings) — returns the recall_canon_facts RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (embeddings provider call, settings read, Postgres IO)
 *     state_ownership: []
 *     external_io:     [embeddings provider, orchestrator settings store, Postgres (via the DbSession it's given)]
 */

import type { EmbeddingProvider } from '@bigbrain/orchestrator/embeddings';
import type { OrchestratorSettingsStore } from '@bigbrain/orchestrator/settings';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { toPgVectorLiteral } from '@bigbrain/orchestrator/pgvector';
import type { CanonCategory } from './categories.js';

const DEFAULT_TOP_K = 8;

interface RecallCanonFactsArgs {
  query: string;
  scene_id: string;
  top_k?: number;
}

function isRecallCanonFactsArgs(value: unknown): value is RecallCanonFactsArgs {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null) return false;
  if (typeof v.query !== 'string' || v.query.trim().length === 0) return false;
  if (typeof v.scene_id !== 'string' || v.scene_id.length === 0) return false;
  if (v.top_k !== undefined && (typeof v.top_k !== 'number' || v.top_k <= 0)) return false;
  return true;
}

interface CanonFactRankedRow {
  fact_id: string;
  category: CanonCategory;
  summary: string;
  detail: string;
}

export function createRecallCanonFactsTool(
  embeddings: EmbeddingProvider,
  settings: OrchestratorSettingsStore | null,
): RegisteredTool {
  return {
    definition: {
      name: 'recall_canon_facts',
      description:
        'Semantic search over approved canon facts, scoped to the given scene\'s present characters and active location.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search canon for.' },
          scene_id: { type: 'string', description: 'The scene to scope the search to.' },
          top_k: { type: 'number', description: 'Optional. Max facts to return. Defaults to the canon_recall_top_k setting (8).' },
        },
        required: ['query', 'scene_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isRecallCanonFactsArgs(args)) {
        throw new Error('recall_canon_facts requires query: string and scene_id: string; top_k (if given) must be a positive number');
      }

      const presentRows = await ctx.db.query<{ character_id: string }>(
        `select character_id from scene_presence where scene_id = $1 and user_id = $2`,
        [args.scene_id, ctx.userId],
      );
      const presentCharacterIds = presentRows.map((r) => r.character_id);

      const [sceneRow] = await ctx.db.query<{ active_location_id: string | null }>(
        `select active_location_id from scenes where scene_id = $1 and user_id = $2`,
        [args.scene_id, ctx.userId],
      );
      const activeLocationId = sceneRow?.active_location_id ?? null;

      const [vector] = await embeddings.embed([args.query]);

      let topK = args.top_k;
      if (topK === undefined) {
        const setting = settings ? await settings.get('canon_recall_top_k') : undefined;
        topK = setting ? parseInt(setting, 10) : DEFAULT_TOP_K;
      }

      const rows = await ctx.db.query<CanonFactRankedRow>(
        `with candidates as (
           select fact_id, category, summary, detail, arc_tag, approved_at, vector_embed
           from canon_facts
           where user_id = $1
             and status = 'approved'
             and (
               linked_character_ids && $2::uuid[]
               or linked_location_id = $3
               or (scene_id = $4 and linked_character_ids = '{}' and linked_location_id is null)
               or (scene_id is null and linked_character_ids = '{}' and linked_location_id is null)
             )
         ),
         ranked as (
           select distinct on (coalesce(arc_tag, fact_id::text)) fact_id, category, summary, detail, vector_embed
           from candidates
           order by coalesce(arc_tag, fact_id::text), approved_at desc
         )
         select fact_id, category, summary, detail
         from ranked
         order by vector_embed <-> $5
         limit $6`,
        [ctx.userId, presentCharacterIds, activeLocationId, args.scene_id, toPgVectorLiteral(vector!), topK],
      );

      return rows.map((r) => ({ factId: r.fact_id, category: r.category, summary: r.summary, detail: r.detail }));
    },
  };
}
