/**
 * @file plugins/canonize/src/getCanonFactProposalsTool.ts
 * @stamp 2026-08-06
 * @architectural-role IO Wrapper — lists recent canon facts for the review queue
 * @description
 * The review queue's reader (bi_principles.md §15). Facts now auto-approve at the chat's next
 * chat-memory sync tick rather than waiting on a human click (chatMemorySync.ts), so this is no
 * longer strictly an "awaiting approval" list — it lists both 'proposed' (still pending, a short
 * window before the next sync) and 'approved' (already live) rows, newest first, so a human can
 * still catch and reject something shortly after it went live, not just before. 'rejected' rows
 * are excluded — they're a permanent record, not something to keep re-surfacing in a working
 * queue. Capped at 50 to keep this a "what just happened" view, not an unbounded history browser.
 * No focusHint, same reasoning as propose_canon_fact: the queue is a deliberate, separate visit,
 * not something a Canvas jumps to mid-conversation.
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

const LIST_LIMIT = 50;

interface CanonFactProposalRow {
  fact_id: string;
  category: CanonCategory;
  arc_tag: string | null;
  summary: string;
  detail: string;
  linked_character_ids: string[];
  linked_location_id: string | null;
  scene_id: string | null;
  chat_id: string;
  status: string;
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
      description:
        'List recent canon facts (still-pending proposals and already-auto-approved facts), newest first, for review/undo. Optionally filter by category.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['place', 'thing', 'concept', 'person', 'plot'],
            description: 'Optional. Only list facts of this category.',
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
        `select fact_id, category, arc_tag, summary, detail, linked_character_ids, linked_location_id, scene_id, chat_id, status, proposed_at
         from canon_facts
         where user_id = $1 and status in ('proposed', 'approved') and ($2::text is null or category = $2)
         order by proposed_at desc
         limit ${LIST_LIMIT}`,
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
        chatId: r.chat_id,
        status: r.status,
        proposedAt: r.proposed_at,
      }));
    },
  };
}
