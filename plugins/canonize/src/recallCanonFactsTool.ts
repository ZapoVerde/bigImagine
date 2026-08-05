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
 * as_of_message_id (db/migrations/0053_canon_facts_chat_anchor.sql) is point-in-time recall: "what
 * did canon look like as of this point in the story," not just "what does it look like now." A
 * fact only counts toward an as-of query if it's chat-scoped to the same chat as the anchor and its
 * own anchor_message_id is at or before the anchor (by the same (created_at, message_id) tuple
 * ordering io/chatSessions.ts already uses for "position in this chat") — a global fact (no
 * chat_id) is always visible regardless of as-of, same as it is for the default/live query.
 * Omitting as_of_message_id is exactly today's behavior: unfiltered, always "current."
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
  as_of_message_id?: string;
}

function isRecallCanonFactsArgs(value: unknown): value is RecallCanonFactsArgs {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null) return false;
  if (typeof v.query !== 'string' || v.query.trim().length === 0) return false;
  if (typeof v.scene_id !== 'string' || v.scene_id.length === 0) return false;
  if (v.top_k !== undefined && (typeof v.top_k !== 'number' || v.top_k <= 0)) return false;
  if (v.as_of_message_id !== undefined && (typeof v.as_of_message_id !== 'string' || v.as_of_message_id.length === 0)) return false;
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
          as_of_message_id: {
            type: 'string',
            description:
              "Optional. Recall canon as it stood as of this chat message, not as it stands now — for point-in-time lookups (e.g. \"what did we know back then\"). Omit for the current/live state.",
          },
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

      let asOfCreatedAt: string | null = null;
      let asOfMessageId: string | null = null;
      let asOfChatId: string | null = null;
      if (args.as_of_message_id) {
        const [anchorRow] = await ctx.db.query<{ chat_id: string; created_at: string }>(
          `select chat_id, created_at from chat_messages where message_id = $1 and user_id = $2`,
          [args.as_of_message_id, ctx.userId],
        );
        if (!anchorRow) {
          throw new Error('recall_canon_facts: as_of_message_id does not reference an existing message');
        }
        asOfCreatedAt = anchorRow.created_at;
        asOfMessageId = args.as_of_message_id;
        asOfChatId = anchorRow.chat_id;
      }

      const rows = await ctx.db.query<CanonFactRankedRow>(
        `with anchor as (
           select $7::timestamptz as as_of_created_at, $8::uuid as as_of_message_id, $9::uuid as as_of_chat_id
         ),
         candidates as (
           select f.fact_id, f.category, f.summary, f.detail, f.arc_tag, f.approved_at, f.vector_embed
           from canon_facts f
           left join chat_messages cm on cm.message_id = f.anchor_message_id
           cross join anchor a
           where f.user_id = $1
             and f.status = 'approved'
             and (
               f.linked_character_ids && $2::uuid[]
               or f.linked_location_id = $3
               or (f.scene_id = $4 and f.linked_character_ids = '{}' and f.linked_location_id is null)
               or (f.scene_id is null and f.linked_character_ids = '{}' and f.linked_location_id is null)
             )
             and (
               a.as_of_message_id is null
               or f.chat_id is null
               or (f.chat_id = a.as_of_chat_id and (cm.created_at, f.anchor_message_id) <= (a.as_of_created_at, a.as_of_message_id))
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
        [
          ctx.userId,
          presentCharacterIds,
          activeLocationId,
          args.scene_id,
          toPgVectorLiteral(vector!),
          topK,
          asOfCreatedAt,
          asOfMessageId,
          asOfChatId,
        ],
      );

      return rows.map((r) => ({ factId: r.fact_id, category: r.category, summary: r.summary, detail: r.detail }));
    },
  };
}
