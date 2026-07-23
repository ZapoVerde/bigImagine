/**
 * @file plugins/lists/src/listLookup.ts
 * @stamp 2026-07-23
 * @architectural-role Pure-ish IO Wrapper — shared find-or-create logic for named lists
 * @description
 * Lists are looked up by name, case-insensitively, per user — "grocery list" and "Grocery List"
 * are the same list. Both createListTool and addListItemTool go through this so "add milk to my
 * grocery list" works whether or not that list already exists, without the model ever needing to
 * call create_list first. tags only apply when a list is newly created; find-or-create never
 * overwrites an existing list's tags, so a later call can't accidentally wipe them.
 *
 * @api-declaration
 * findOrCreateList(db, userId, name, tags?) — returns the existing or newly-created list_id
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { DbSession } from '@bigbrain/orchestrator/postgres';

export async function findOrCreateList(
  db: DbSession,
  userId: string,
  name: string,
  tags: string[] = [],
): Promise<{ listId: string; created: boolean }> {
  const existing = await db.query<{ list_id: string }>(
    `select list_id from lists where user_id = $1 and lower(name) = lower($2) limit 1`,
    [userId, name],
  );
  if (existing[0]) {
    return { listId: existing[0].list_id, created: false };
  }

  const inserted = await db.query<{ list_id: string }>(
    `insert into lists (user_id, name, tags) values ($1, $2, $3) returning list_id`,
    [userId, name, tags],
  );
  return { listId: inserted[0]!.list_id, created: true };
}
