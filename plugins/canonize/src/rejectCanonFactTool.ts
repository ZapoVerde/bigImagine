/**
 * @file plugins/canonize/src/rejectCanonFactTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — rejects a proposed canon fact
 * @description
 * The human-in-the-loop rejection step (bi_principles.md §15, canonize-plan.md §5): flips a
 * 'proposed' or already-'approved' row to 'rejected'. Facts now auto-approve at the chat's next
 * chat-memory sync tick (chatMemorySync.ts) rather than waiting on a human click, so this is the
 * undo path for both "still pending" and "already live" facts, not just the pending ones — a
 * fact that auto-approved before anyone looked at it must still be rejectable. Rejected rows are
 * kept, never deleted — a permanent, auditable record of what was proposed and turned down, so
 * the extraction step's own behavior stays reviewable. A rejected fact is never selectable into a
 * prompt. Scoped via the surrounding RLS session — a fact belonging to another user (or a missing
 * id) matches zero rows, so the update reports not-found rather than throwing.
 *
 * @api-declaration
 * createRejectCanonFactTool() — returns the reject_canon_fact RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

function isRejectCanonFactArgs(value: unknown): value is { fact_id: string } {
  const v = value as Record<string, unknown>;
  return typeof value === 'object' && value !== null && typeof v.fact_id === 'string' && v.fact_id.length > 0;
}

export function createRejectCanonFactTool(): RegisteredTool {
  return {
    definition: {
      name: 'reject_canon_fact',
      description:
        'Reject a canon fact (proposed or already-approved). The record stays on file as rejected (never deleted) but is never treated as canon again.',
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
      if (!isRejectCanonFactArgs(args)) {
        throw new Error('reject_canon_fact requires fact_id: string argument');
      }
      const [row] = await ctx.db.query<{ fact_id: string; status: string }>(
        `update canon_facts
         set status = 'rejected'
         where fact_id = $1 and status in ('proposed', 'approved')
         returning fact_id, status`,
        [args.fact_id],
      );
      return row ? { factId: row.fact_id, status: row.status } : { notFound: true };
    },
  };
}
