/**
 * @file orchestrator/src/server/admin/lorebookEntries.ts
 * @stamp 2026-08-20
 * @architectural-role IO Wrapper — lorebook-entry CRUD over Postgres (with import-time embedding)
 * @description
 * The Lorebooks page's entry editor CRUD (docs/lorebook-plan.md §8a, step 5) — the
 * create/update/delete surface for lorebook_entries, split out of admin/lorebooks.ts along the
 * genuine book-vs-entry fault line so each file stays inside the 300-line budget. Entries are
 * user-scoped, RLS-forced rows (0051), so every write takes the owning userId explicitly and runs
 * under that user's scope. vector_embed is populated at create/update time by embedding
 * `${bookName}\n${content}` (the §3c/chatMemorySync shape); an embedding failure fails open to a
 * null vector — the entry still works, it just can't be ranked. Book-level CRUD and the lorebook
 * settings panel live in admin/lorebooks.ts; the ST world-info import/export lives in
 * admin/lorebookInterchange.ts.
 *
 * @api-declaration
 * createLorebookEntryAdmin(db, embeddings, userId, input) — inserts one entry (uid auto-incremented
 *   per book) and returns its admin row; undefined when the book isn't visible to the user
 * updateLorebookEntryAdmin(db, embeddings, userId, entryId, patch) — patches one entry's modeled
 *   columns (re-embedding on content/key change); false when the row isn't visible to the user
 * deleteLorebookEntryAdmin(db, userId, entryId) — deletes one entry; false when no row existed
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads/writes Postgres; entry create/update embed via the injected
 *                      EmbeddingProvider)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected PostgresClient), EmbeddingProvider (via the
 *                       injected provider)]
 */

import type { PostgresClient } from '../../io/postgres.js';
import type { EmbeddingProvider } from '../../io/embeddings/types.js';
import { toPgVectorLiteral } from '../../util/pgvector.js';

export interface LorebookEntryAdminRow {
  entryId: string;
  uid: number;
  key: string[];
  comment: string;
  content: string;
  constant: boolean;
  disable: boolean;
  orderValue: number;
  probability: number;
  useProbability: boolean;
  groupName: string;
  groupWeight: number;
  groupOverride: boolean;
  sticky: number;
  cooldown: number;
  delay: number;
  updatedAt: string;
}

export interface LorebookEntryInput {
  lorebookId: string;
  content: string;
  key?: string[];
  comment?: string;
  constant?: boolean;
  disable?: boolean;
  orderValue?: number;
  probability?: number;
  useProbability?: boolean;
  groupName?: string;
  groupWeight?: number;
  groupOverride?: boolean;
  sticky?: number;
  cooldown?: number;
  delay?: number;
}

export type LorebookEntryPatch = Omit<LorebookEntryInput, 'lorebookId' | 'content'> & { content?: string };

export interface LorebookEntryRowShape {
  entry_id: string;
  uid: number;
  key: string[];
  comment: string;
  content: string;
  constant: boolean;
  disable: boolean;
  order_value: number;
  probability: number;
  use_probability: boolean;
  group_name: string;
  group_weight: number;
  group_override: boolean;
  sticky: number;
  cooldown: number;
  delay: number;
  updated_at: string;
}

export function toLorebookEntryAdminRow(r: LorebookEntryRowShape): LorebookEntryAdminRow {
  return {
    entryId: r.entry_id,
    uid: r.uid,
    key: r.key,
    comment: r.comment,
    content: r.content,
    constant: r.constant,
    disable: r.disable,
    orderValue: r.order_value,
    probability: r.probability,
    useProbability: r.use_probability,
    groupName: r.group_name,
    groupWeight: r.group_weight,
    groupOverride: r.group_override,
    sticky: r.sticky,
    cooldown: r.cooldown,
    delay: r.delay,
    updatedAt: r.updated_at,
  };
}

async function embedEntryText(embeddings: EmbeddingProvider, bookName: string, content: string): Promise<string | null> {
  try {
    const [vector] = await embeddings.embed([`${bookName}\n${content}`]);
    return vector ? toPgVectorLiteral(vector) : null;
  } catch {
    return null; // fail-open, same posture as every other embed path
  }
}

export async function createLorebookEntryAdmin(
  db: PostgresClient,
  embeddings: EmbeddingProvider,
  userId: string,
  input: LorebookEntryInput,
): Promise<LorebookEntryAdminRow | undefined> {
  return db.withUserScope(userId, async (session) => {
    const [book] = await session.query<{ name: string }>('select name from lorebooks where lorebook_id = $1', [input.lorebookId]);
    if (!book) return undefined; // book not found under this user's scope
    const vectorLiteral = await embedEntryText(embeddings, book.name, input.content);
    const [row] = await session.query<LorebookEntryRowShape>(
      `insert into lorebook_entries
         (lorebook_id, user_id, uid, key, comment, content, constant, disable, order_value, probability,
          use_probability, group_name, group_weight, group_override, sticky, cooldown, delay, source_json, vector_embed)
       values
         ($1, $2, (select coalesce(max(uid), 0) + 1 from lorebook_entries where lorebook_id = $1),
          $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, '{}'::jsonb, $17::vector)
       returning entry_id, uid, key, comment, content, constant, disable, order_value, probability,
                 use_probability, group_name, group_weight, group_override, sticky, cooldown, delay, updated_at`,
      [
        input.lorebookId,
        userId,
        input.key ?? [],
        input.comment ?? '',
        input.content,
        input.constant ?? false,
        input.disable ?? false,
        input.orderValue ?? 100,
        input.probability ?? 100,
        input.useProbability ?? false,
        input.groupName ?? '',
        input.groupWeight ?? 1,
        input.groupOverride ?? false,
        input.sticky ?? 0,
        input.cooldown ?? 0,
        input.delay ?? 0,
        vectorLiteral,
      ],
    );
    return row ? toLorebookEntryAdminRow(row) : undefined;
  });
}

export async function updateLorebookEntryAdmin(
  db: PostgresClient,
  embeddings: EmbeddingProvider,
  userId: string,
  entryId: string,
  patch: LorebookEntryPatch,
): Promise<boolean> {
  return db.withUserScope(userId, async (session) => {
    const [existing] = await session.query<{ lorebook_id: string; content: string }>(
      'select lorebook_id, content from lorebook_entries where entry_id = $1',
      [entryId],
    );
    if (!existing) return false;
    const content = patch.content ?? existing.content;
    const [book] = await session.query<{ name: string }>('select name from lorebooks where lorebook_id = $1', [existing.lorebook_id]);
    const vectorLiteral = await embedEntryText(embeddings, book?.name ?? '', content);

    const sets: string[] = [];
    const params: unknown[] = [entryId, userId];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.key !== undefined) push('key', patch.key);
    if (patch.comment !== undefined) push('comment', patch.comment);
    if (patch.content !== undefined) push('content', patch.content);
    if (patch.constant !== undefined) push('constant', patch.constant);
    if (patch.disable !== undefined) push('disable', patch.disable);
    if (patch.orderValue !== undefined) push('order_value', patch.orderValue);
    if (patch.probability !== undefined) push('probability', patch.probability);
    if (patch.useProbability !== undefined) push('use_probability', patch.useProbability);
    if (patch.groupName !== undefined) push('group_name', patch.groupName);
    if (patch.groupWeight !== undefined) push('group_weight', patch.groupWeight);
    if (patch.groupOverride !== undefined) push('group_override', patch.groupOverride);
    if (patch.sticky !== undefined) push('sticky', patch.sticky);
    if (patch.cooldown !== undefined) push('cooldown', patch.cooldown);
    if (patch.delay !== undefined) push('delay', patch.delay);
    if (patch.content !== undefined || patch.key !== undefined) push('vector_embed', vectorLiteral ? `${vectorLiteral}::vector` : null);
    if (sets.length === 0) return true;
    await session.query(`update lorebook_entries set ${sets.join(', ')} where entry_id = $1 and user_id = $2`, params);
    // The update touched whatever row exists in this user's scope; the probe tells the caller
    // whether that row was really there (a foreign row is invisible under RLS, so the update
    // would have silently no-op'd — this is the honest "was anything updated" signal).
    const [exists] = await session.query<{ n: number }>('select 1 as n from lorebook_entries where entry_id = $1', [entryId]);
    return exists !== undefined;
  });
}

export async function deleteLorebookEntryAdmin(db: PostgresClient, userId: string, entryId: string): Promise<boolean> {
  return db.withUserScope(userId, async (session) => {
    await session.query('delete from lorebook_entries where entry_id = $1 and user_id = $2', [entryId, userId]);
    const [exists] = await session.query<{ n: number }>('select 1 as n from lorebook_entries where entry_id = $1', [entryId]);
    return exists === undefined;
  });
}