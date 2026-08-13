/**
 * @file plugins/canonize/src/approveCanonFactTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — approves a proposed canon fact
 * @description
 * The approval step (canonize-plan.md §5): flips a 'proposed' row to 'approved' and stamps
 * approved_at = now(). Per bi_principles.md §15 the fact was already live before this — approval
 * is a maturity marker, not a truth gate — but this is the moment it becomes selectable by the
 * explicit recall_canon_facts tool call, which filters status = 'approved' (see that file's own
 * comment). Scoped via the surrounding RLS session — a fact belonging
 * to another user (or a missing id) matches zero rows, so the update reports not-found rather
 * than throwing.
 *
 * @api-declaration
 * createApproveCanonFactTool() — returns the approve_canon_fact RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

function isApproveCanonFactArgs(value: unknown): value is { fact_id: string } {
  const v = value as Record<string, unknown>;
  return typeof value === 'object' && value !== null && typeof v.fact_id === 'string' && v.fact_id.length > 0;
}

export function createApproveCanonFactTool(): RegisteredTool {
  return {
    definition: {
      name: 'approve_canon_fact',
      description:
        'Approve a proposed canon fact. The fact is already in use; this marks it as reviewed and makes it eligible for recall_canon_facts, which only returns approved facts.',
      parameters: {
        type: 'object',
        properties: {
          fact_id: { type: 'string', description: "The proposed fact's id." },
        },
        required: ['fact_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isApproveCanonFactArgs(args)) {
        throw new Error('approve_canon_fact requires fact_id: string argument');
      }
      const [row] = await ctx.db.query<{ fact_id: string; status: string }>(
        `update canon_facts
         set status = 'approved', approved_at = now()
         where fact_id = $1 and status = 'proposed'
         returning fact_id, status`,
        [args.fact_id],
      );
      return row ? { factId: row.fact_id, status: row.status } : { notFound: true };
    },
  };
}
