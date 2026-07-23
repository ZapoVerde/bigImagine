/**
 * @file plugins/lists/src/createListTool.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — creates (or returns) a named list
 * @description
 * Domain-agnostic on purpose: "Grocery List", "Home Depot Run", "Books to Read" are all just a
 * lists row with a name and optional tags, not separate tables or tools per domain. tags is
 * informational only (e.g. lets a future Notion sync target "everything tagged shopping") — it
 * never triggers any side effect; deliberately not wiring this into shopping_logs or any
 * inventory concept, see docs/spec.md's discussion for why.
 *
 * @api-declaration
 * createCreateListTool() — returns the create_list RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { findOrCreateList } from './listLookup.js';

function isCreateListArgs(value: unknown): value is { name: string; tags?: string[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    (value as Record<string, unknown>).name !== ''
  );
}

export function createCreateListTool(): RegisteredTool {
  return {
    definition: {
      name: 'create_list',
      description:
        'Create a new named list (e.g. "Grocery List", "Home Depot Run", "Books to Read"). If a list with this name already exists for the user, returns that one instead of making a duplicate.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The name of the list.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional informational tags (e.g. ["shopping", "grocery"]).',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isCreateListArgs(args)) {
        throw new Error('create_list requires a non-empty name: string argument');
      }
      const { listId, created } = await findOrCreateList(ctx.db, ctx.userId, args.name, args.tags ?? []);
      return { listId, name: args.name, created };
    },
  };
}
