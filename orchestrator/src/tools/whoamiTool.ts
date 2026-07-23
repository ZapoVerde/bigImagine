/**
 * @file orchestrator/src/tools/whoamiTool.ts
 * @stamp 2026-07-21
 * @architectural-role IO Wrapper — stub tool, verification-only
 * @description
 * Exists solely to prove request-scoped DB access end to end through the orchestrator
 * (bb_principles.md §4) before any real plugin exists, per the Phase 2 build-order gate. Reports
 * both what user_id the orchestrator believes the request is for and what Postgres's own
 * app_current_user_id() resolves to inside the same transaction — the two are expected to
 * always match; a mismatch means the scoping wiring is broken. Not registered once real plugins
 * land in Phase 3+.
 *
 * @api-declaration
 * whoamiTool: RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (queries Postgres via the session it's given)
 *     state_ownership: []
 *     external_io:     [Postgres, via the DbSession passed in]
 */

import type { RegisteredTool } from '../orchestrator/toolRegistry.js';

export const whoamiTool: RegisteredTool = {
  definition: {
    name: 'whoami',
    description: 'Returns the user_id the current request is scoped to.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  handler: async (_args, ctx) => {
    const rows = await ctx.db.query<{ app_current_user_id: string }>(
      'select app_current_user_id()',
    );
    return {
      requestUserId: ctx.userId,
      dbScopedUserId: rows[0]?.app_current_user_id,
    };
  },
};
