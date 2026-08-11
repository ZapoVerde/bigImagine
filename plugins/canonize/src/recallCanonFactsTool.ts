/**
 * @file plugins/canonize/src/recallCanonFactsTool.ts
 * @stamp 2026-08-06
 * @architectural-role IO Wrapper — semantic search over a chat's approved canon
 * @description
 * The read side of the canon gate (bi_principles.md §15/§16): only status = 'approved' rows are
 * ever candidates — a proposal or a rejection is never selectable into a prompt. Scoping is
 * trusted chat identity, never message content (bi_principles.md §4): every canon fact now
 * belongs to exactly one chat (db/migrations/0058_canon_facts_chat_scoped.sql), so recall is
 * scoped to ctx.chatId, not to args.
 *
 * scene_id/scene_presence/active_location_id scoping (the original design) has been deliberately
 * dropped, not replaced: nothing populates scene_presence today (no chat/scene link exists — see
 * httpServer.ts's narrator-assembly notes), and it didn't generalize to 'plot' facts anyway —
 * linked_character_ids on a plot fact is freeform (proposeCanonFactTool.ts places no constraint
 * on it), and {{user}} is present in nearly every scene, so character-scoping a plot fact was
 * close to meaningless. Left as a real idea for later, once active-location tracking is wired for
 * real (per the user: modeled on SillyTavern-Triggeryze's location-tracker ruleset — a per-turn
 * header the model emits, extracted and diffed against a persisted "current location," not
 * silent scene-presence inference) — not built now.
 *
 * For 'plot' facts, a continuing arc_tag thread's every proposal is its own row — recall must
 * collapse that to only the most-recently-approved row per arc_tag before ranking, or a stale,
 * superseded plot beat would sit in the prompt stack alongside its own replacement.
 * person/place/thing/concept facts have the same shape for the same reason, but a different group
 * key: entity_key (db/migrations/0064_canon_facts_entity_key.sql), populated by the periodic
 * lorebook/people curators (io/chatMemory/curateWorldMemory.ts, curatePeople.ts) — a continuing
 * dictionary entry's every UPDATE is its own row too, most-recent-approved wins. arc_tag and
 * entity_key are deliberately separate columns (one is plot-arc identity, the other is
 * dictionary-entry identity) that happen to want the same dedup shape, so
 * `coalesce(arc_tag, entity_key, fact_id::text)` tries both before falling back to the row's own
 * id — a fact with neither (today's turn-time propose_canon_fact notes) gets its own dedup group.
 *
 * as_of_message_id (db/migrations/0054_canon_facts_chat_anchor.sql) is point-in-time recall: "what
 * did canon look like as of this point in the story," not just "what does it look like now." A
 * fact only counts toward an as-of query if its own anchor_message_id is at or before the anchor
 * (by the same (created_at, message_id) tuple ordering io/chatSessions.ts already uses for
 * "position in this chat") — a fact with no anchor (chat-wide, not turn-pinned) is always visible
 * regardless of as-of. Omitting as_of_message_id is exactly today's behavior: unfiltered, always
 * "current."
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
  top_k?: number;
  as_of_message_id?: string;
}

function isRecallCanonFactsArgs(value: unknown): value is RecallCanonFactsArgs {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null) return false;
  if (typeof v.query !== 'string' || v.query.trim().length === 0) return false;
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
      description: 'Semantic search over this chat\'s approved canon facts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search canon for.' },
          top_k: { type: 'number', description: 'Optional. Max facts to return. Defaults to the canon_recall_top_k setting (8).' },
          as_of_message_id: {
            type: 'string',
            description:
              "Optional. Recall canon as it stood as of this chat message, not as it stands now — for point-in-time lookups (e.g. \"what did we know back then\"). Omit for the current/live state.",
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isRecallCanonFactsArgs(args)) {
        throw new Error('recall_canon_facts requires query: string; top_k (if given) must be a positive number');
      }
      if (!ctx.chatId) {
        throw new Error('recall_canon_facts requires an active chat context');
      }

      const [vector] = await embeddings.embed([args.query]);

      let topK = args.top_k;
      if (topK === undefined) {
        const setting = settings ? await settings.get('canon_recall_top_k') : undefined;
        topK = setting ? parseInt(setting, 10) : DEFAULT_TOP_K;
      }

      let asOfCreatedAt: string | null = null;
      let asOfMessageId: string | null = null;
      if (args.as_of_message_id) {
        const [anchorRow] = await ctx.db.query<{ chat_id: string; created_at: string }>(
          `select chat_id, created_at from chat_messages where message_id = $1 and user_id = $2`,
          [args.as_of_message_id, ctx.userId],
        );
        if (!anchorRow) {
          throw new Error('recall_canon_facts: as_of_message_id does not reference an existing message');
        }
        if (anchorRow.chat_id !== ctx.chatId) {
          throw new Error('recall_canon_facts: as_of_message_id does not belong to this chat');
        }
        asOfCreatedAt = anchorRow.created_at;
        asOfMessageId = args.as_of_message_id;
      }

      const rows = await ctx.db.query<CanonFactRankedRow>(
        `with anchor as (
           select $5::timestamptz as as_of_created_at, $6::uuid as as_of_message_id
         ),
         candidates as (
           select f.fact_id, f.category, f.summary, f.detail, f.arc_tag, f.entity_key, f.approved_at, f.vector_embed
           from canon_facts f
           left join chat_messages cm on cm.message_id = f.anchor_message_id
           cross join anchor a
           where f.user_id = $1
             and f.chat_id = $2
             and f.status = 'approved'
             and (
               a.as_of_message_id is null
               or f.anchor_message_id is null
               or (cm.created_at, f.anchor_message_id) <= (a.as_of_created_at, a.as_of_message_id)
             )
         ),
         ranked as (
           select distinct on (coalesce(arc_tag, entity_key, fact_id::text)) fact_id, category, summary, detail, vector_embed
           from candidates
           order by coalesce(arc_tag, entity_key, fact_id::text), approved_at desc
         )
         select fact_id, category, summary, detail
         from ranked
         order by vector_embed <-> $3
         limit $4`,
        [ctx.userId, ctx.chatId, toPgVectorLiteral(vector!), topK, asOfCreatedAt, asOfMessageId],
      );

      return rows.map((r) => ({ factId: r.fact_id, category: r.category, summary: r.summary, detail: r.detail }));
    },
  };
}
