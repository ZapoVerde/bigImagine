/**
 * @file plugins/canonize/src/proposeCanonFactTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — proposes a canon fact
 * @description
 * The write side of the canon gate (bi_principles.md §15, canonize-plan.md §5): embeds
 * summary + detail via the injected embeddings provider and inserts a 'proposed' row. A proposal
 * is inert — never selectable into a prompt, never returned by recall_canon_facts (which filters
 * status = 'approved'); its only consumer is the approval queue. No focusHint: proposals aren't
 * the kind of thing a Canvas should jump to mid-conversation; the queue is a deliberate,
 * separate visit.
 *
 * category is the MECE tag (canonize-plan.md §3.2) routing each fact to the right curator;
 * arc_tag is required exactly when category = 'plot' — a continuing plot thread reuses an
 * existing arc_tag, and a missing one on a plot proposal is rejected here before it ever reaches
 * SQL, mirroring isCreateNoteArgs-style arg validation.
 *
 * chat_id/anchor_message_id (db/migrations/0054_canon_facts_chat_anchor.sql, tightened by
 * 0058_canon_facts_chat_scoped.sql) stamp which chat and message this fact was proposed at, from
 * ctx (never args) — the anchor recall_canon_facts's as_of_message_id filters against for
 * point-in-time recall. Every fact must belong to a chat now (the user's explicit call — no more
 * platform-global facts), so a proposal made outside a chat turn (ctx.chatId unset, e.g. an
 * agent_routine dispatch with no chat context) is rejected before it ever reaches SQL, same as the
 * plot/arc_tag check below. anchor_message_id can still be null — a fact can belong to the chat as
 * a whole without pinning to one specific turn.
 *
 * @api-declaration
 * createProposeCanonFactTool(embeddings) — returns the propose_canon_fact RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (embeddings provider call, Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [embeddings provider, Postgres (via the DbSession it's given)]
 */

import type { EmbeddingProvider } from '@bigbrain/orchestrator/embeddings';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { toPgVectorLiteral } from '@bigbrain/orchestrator/pgvector';
import { isCanonCategory, type CanonCategory } from './categories.js';

interface ProposeCanonFactArgs {
  category: CanonCategory;
  summary: string;
  detail?: string;
  scene_id?: string;
  linked_character_ids?: string[];
  linked_location_id?: string;
  arc_tag?: string;
}

function isProposeCanonFactArgs(value: unknown): value is ProposeCanonFactArgs {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null) return false;
  if (!isCanonCategory(v.category)) return false;
  if (typeof v.summary !== 'string' || v.summary.trim().length === 0) return false;
  if (v.detail !== undefined && typeof v.detail !== 'string') return false;
  if (v.scene_id !== undefined && typeof v.scene_id !== 'string') return false;
  if (v.linked_location_id !== undefined && typeof v.linked_location_id !== 'string') return false;
  if (
    v.linked_character_ids !== undefined &&
    (!Array.isArray(v.linked_character_ids) || v.linked_character_ids.some((id) => typeof id !== 'string'))
  ) {
    return false;
  }
  if (v.arc_tag !== undefined && typeof v.arc_tag !== 'string') return false;
  return true;
}

export function createProposeCanonFactTool(embeddings: EmbeddingProvider): RegisteredTool {
  return {
    definition: {
      name: 'propose_canon_fact',
      description:
        'Propose a canon fact for human approval. Writes a "proposed" row; nothing proposed is ever treated as canon until explicitly approved.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['place', 'thing', 'concept', 'person', 'plot'],
            description: "What kind of fact this is. 'plot' requires arc_tag.",
          },
          summary: { type: 'string', description: 'The fact, as a concise statement.' },
          detail: { type: 'string', description: 'Optional. Supporting detail/context for the fact.' },
          scene_id: { type: 'string', description: 'Optional. The scene this fact belongs to (scope limit).' },
          linked_character_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional. Character ids this fact is about (present in the scene).',
          },
          linked_location_id: { type: 'string', description: 'Optional. Location id this fact is about.' },
          arc_tag: {
            type: 'string',
            description: "Required when category is 'plot'. Reuse an existing tag to continue a plot thread; a new tag only for genuinely new stakes.",
          },
        },
        required: ['category', 'summary'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isProposeCanonFactArgs(args)) {
        throw new Error('propose_canon_fact requires category (place|thing|concept|person|plot) and a non-empty summary: string');
      }
      if (args.category === 'plot' && !args.arc_tag?.trim()) {
        throw new Error('propose_canon_fact: category "plot" requires a non-empty arc_tag');
      }
      if (!ctx.chatId) {
        throw new Error('propose_canon_fact requires an active chat context — canon facts cannot be proposed outside a chat');
      }

      const text = args.detail ? `${args.summary}\n${args.detail}` : args.summary;
      const [vector] = await embeddings.embed([text]);

      const [row] = await ctx.db.query<{ fact_id: string }>(
        `insert into canon_facts
           (user_id, scene_id, category, arc_tag, summary, detail, vector_embed, linked_character_ids, linked_location_id, chat_id, anchor_message_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning fact_id`,
        [
          ctx.userId,
          args.scene_id ?? null,
          args.category,
          args.arc_tag?.trim() ?? null,
          args.summary.trim(),
          args.detail ?? '',
          toPgVectorLiteral(vector!),
          args.linked_character_ids ?? [],
          args.linked_location_id ?? null,
          // Never from args — chat/anchor identity is trusted context, the same boundary user_id
          // already uses, not something the model gets to assert (db/migrations/
          // 0054_canon_facts_chat_anchor.sql). ctx.chatId is checked non-null above.
          ctx.chatId,
          ctx.anchorMessageId ?? null,
        ],
      );
      // Never returns anything selectable into a prompt — the proposal is inert until approved.
      return { factId: row!.fact_id, status: 'proposed' };
    },
  };
}