/**
 * @file plugins/temporal/src/cancelTimerTool.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — the cancel_timer RegisteredTool
 * @description
 * Only affects a timer still `status = 'running'` — cancelling an already-completed or
 * already-cancelled timer is a no-op (`found: false`), not an error, same soft-not-found shape
 * as get_recipe elsewhere in this codebase. RLS (db/migrations/0031_active_timers.sql) already
 * makes another user's timer invisible to this query; the explicit status filter on top of that
 * is what stops a stale UI action from "cancelling" a timer that already fired.
 *
 * @api-declaration
 * createCancelTimerTool() — returns the cancel_timer RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface CancelTimerArgs {
  timerId: string;
}

function isCancelTimerArgs(value: unknown): value is CancelTimerArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.timerId === 'string' && v.timerId !== '';
}

export function createCancelTimerTool(): RegisteredTool {
  return {
    definition: {
      name: 'cancel_timer',
      description: 'Cancel a running timer before it completes.',
      parameters: {
        type: 'object',
        properties: {
          timerId: { type: 'string', description: 'The timer to cancel (from set_timer or list_temporal_state).' },
        },
        required: ['timerId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isCancelTimerArgs(args)) {
        throw new Error('cancel_timer requires a non-empty timerId: string argument');
      }
      const rows = await ctx.db.query<{ timer_id: string }>(
        `update active_timers set status = 'cancelled', updated_at = now()
         where timer_id = $1 and status = 'running'
         returning timer_id`,
        [args.timerId],
      );
      return rows.length > 0 ? { found: true, timerId: rows[0]!.timer_id, status: 'cancelled' } : { found: false, timerId: args.timerId };
    },
  };
}
