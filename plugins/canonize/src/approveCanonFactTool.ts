/**
 * @file plugins/canonize/src/approveCanonFactTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — approves a proposed canon fact
 * @description
 * The human-in-the-loop approval step (bi_principles.md §15, canonize-plan.md §5): flips a
 * 'proposed' row to 'approved' and stamps approved_at = now(). This is the exact moment a
 * proposal becomes canon — from here on it's selectable into a prompt by recall_canon_facts and
 * treated as established world state. Scoped via the surrounding RLS session — a fact belonging
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
        'Approve a proposed canon fact, making it canon. Only approved canon facts are ever injected into a prompt or returned by recall_canon_facts.',
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
