/**
 * @file plugins/canonize/src/getCanonFactProposalsTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — lists proposed canon facts awaiting approval
 * @description
 * The approval queue's reader (canonize-plan.md §5/§9, bi_principles.md §15): lists
 * status = 'proposed' rows only — recall_canon_facts filters status = 'approved' by design, so it
 * can never double as this listing. Newest first, so the person reviewing sees what was just
 * proposed at the top. No focusHint, same reasoning as propose_canon_fact: the queue is a
 * deliberate, separate visit, not something a Canvas jumps to mid-conversation.
 *
 * @api-declaration
 * createGetCanonFactProposalsTool() — returns the get_canon_fact_proposals RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { isCanonCategory, type CanonCategory } from './categories.js';

interface CanonFactProposalRow {
  fact_id: string;
  category: CanonCategory;
  arc_tag: string | null;
  summary: string;
  detail: string;
  linked_character_ids: string[];
  linked_location_id: string | null;
  scene_id: string | null;
  proposed_at: string;
}

function isGetCanonFactProposalsArgs(value: unknown): value is { category?: CanonCategory } {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null) return false;
  if (v.category !== undefined && !isCanonCategory(v.category)) return false;
  return true;
}

export function createGetCanonFactProposalsTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_canon_fact_proposals',
      description: 'List canon fact proposals still awaiting approval, newest first. Optionally filter by category.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['place', 'thing', 'concept', 'person', 'plot'],
            description: 'Optional. Only list proposals of this category.',
          },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isGetCanonFactProposalsArgs(args)) {
        throw new Error('get_canon_fact_proposals: category, if given, must be one of place|thing|concept|person|plot');
      }
      const rows = await ctx.db.query<CanonFactProposalRow>(
        `select fact_id, category, arc_tag, summary, detail, linked_character_ids, linked_location_id, scene_id, proposed_at
         from canon_facts
         where user_id = $1 and status = 'proposed' and ($2::text is null or category = $2)
         order by proposed_at desc`,
        [ctx.userId, args.category ?? null],
      );
      return rows.map((r) => ({
        factId: r.fact_id,
        category: r.category,
        arcTag: r.arc_tag,
        summary: r.summary,
        detail: r.detail,
        linkedCharacterIds: r.linked_character_ids,
        linkedLocationId: r.linked_location_id,
        sceneId: r.scene_id,
        proposedAt: r.proposed_at,
      }));
    },
  };
}
