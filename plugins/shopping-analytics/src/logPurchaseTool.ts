/**
 * @file plugins/shopping-analytics/src/logPurchaseTool.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — writes one row to shopping_logs
 * @description
 * docs/spec.md §6.2's analytics engine is only as good as the log it reads, so this is the write
 * side that populates it. No LLM/embeddings call here — unlike ingest_note, there's no
 * unstructured text to classify; item_name and is_staple are exactly what the model already
 * extracted from the user's message via ordinary tool-call argument parsing.
 *
 * item_name stays plaintext (not run through io/fieldCipher.ts like unstructured_notes.raw_text
 * is): the analytics query GROUP BYs on it, and our cipher's random-IV-per-call design means the
 * same plaintext never produces the same ciphertext twice — encrypting this column would make
 * grouping by item impossible, the same tension documented for vector_embed in spec.md's
 * Correction 4.
 *
 * @api-declaration
 * createLogPurchaseTool() — returns the log_purchase RegisteredTool; takes no constructor
 *   dependencies, since it only needs ctx.db/ctx.userId, both supplied per-call
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

function isLogPurchaseArgs(value: unknown): value is { item_name: string; is_staple?: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).item_name === 'string' &&
    (value as Record<string, unknown>).item_name !== ''
  );
}

export function createLogPurchaseTool(): RegisteredTool {
  return {
    definition: {
      name: 'log_purchase',
      description:
        'Log a shopping purchase (e.g. "bought milk") so the chronological shopping analytics engine can track repurchase patterns over time.',
      parameters: {
        type: 'object',
        properties: {
          item_name: { type: 'string', description: 'The name of the item purchased.' },
          is_staple: {
            type: 'boolean',
            description: 'Whether this is a recurring staple (e.g. milk, chicken feed) vs a one-off purchase.',
          },
        },
        required: ['item_name'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isLogPurchaseArgs(args)) {
        throw new Error('log_purchase requires a non-empty item_name: string argument');
      }
      const isStaple = args.is_staple ?? false;

      const rows = await ctx.db.query<{ log_id: string }>(
        `insert into shopping_logs (user_id, item_name, is_staple) values ($1, $2, $3) returning log_id`,
        [ctx.userId, args.item_name, isStaple],
      );

      return { logId: rows[0]?.log_id, itemName: args.item_name, isStaple };
    },
  };
}
