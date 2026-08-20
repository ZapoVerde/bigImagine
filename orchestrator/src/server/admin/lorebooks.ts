/**
 * @file orchestrator/src/server/admin/lorebooks.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (settings-store + Postgres IO) —
 * the same dual-role split the original adminServer.ts lorebook blocks used; moved here verbatim
 * as part of the adminServer domain split
 * @description
 * Normal lorebook administration: the Lorebooks page's settings panel (§3d knobs) and the
 * book-level CRUD surface. Books are user-scoped, RLS-forced tables (0051), so every write takes
 * the owning userId explicitly and runs under that user's scope. Entry-level CRUD is split out
 * along the genuine book-vs-entry fault line (admin/lorebookEntries.ts) to respect the 300-line
 * budget; the ST world-info import/export conversion logic lives separately
 * (admin/lorebookInterchange.ts).
 *
 * @api-declaration
 * getLorebookSettings(store) — { lorebookMode, lorebookModeIsDefault, lorebookTokenBudget,
 *   lorebookTokenBudgetIsDefault, lorebookRecallTopK, lorebookRecallTopKIsDefault,
 *   lorebookRecursionEnabled, lorebookRecursionEnabledIsDefault }
 * parseSetLorebookSettingsBody(raw) — validates { lorebook_mode?, lorebook_token_budget?,
 *   lorebook_recall_top_k?, lorebook_recursion_enabled? }, at least one present; undefined on any
 *   malformed shape (an explicit null budget clears back to unlimited)
 * setLorebookSettings(store, body) — upserts whichever fields the body names
 * getLorebooksAdmin(db) — the cross-user library roster: every book for every user with its
 *   entries, character links, and chat-override count
 * createLorebookAdmin(db, userId, name) — inserts one book; undefined when the user doesn't exist
 * updateLorebookAdmin(db, userId, lorebookId, patch) — patches name/globalScope and replaces the
 *   character-link set wholesale when given; false when the book isn't visible to the user
 * deleteLorebookAdmin(db, userId, lorebookId) — deletes one book (FKs cascade, 0051/0088);
 *   false when no row existed
 *
 * @contract
 *   assertions:
 *     purity:          parseSetLorebookSettingsBody is pure; the rest are impure (Postgres IO via
 *                      the injected settings store and db)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected OrchestratorSettingsStore and PostgresClient)]
 */

import type { OrchestratorSettingsStore } from '../../io/orchestratorSettings.js';
import type { PostgresClient } from '../../io/postgres.js';
import {
  toLorebookEntryAdminRow,
  type LorebookEntryAdminRow,
  type LorebookEntryRowShape,
} from './lorebookEntries.js';

// --- Lorebook settings (docs/lorebook-plan.md §3d/§8a, step 5) ---
// The §3d keys were registered in orchestratorSettings.ts at the same commit that widened the
// CHECK (0088); this trio is the admin read/write surface the Lorebooks page's settings panel
// drives. Defaults mirror what resolveLorebook.ts reads when a key is unset: mode off (§2),
// recall top-K 8 (canon_recall_top_k's default), token budget unlimited, recursion off (its row
// exists but is deliberately unread — §9).
export interface LorebookSettings {
  lorebookMode: 'on' | 'off';
  lorebookModeIsDefault: boolean;
  /** null = unlimited (the unset/infinite default). */
  lorebookTokenBudget: number | null;
  lorebookTokenBudgetIsDefault: boolean;
  lorebookRecallTopK: number;
  lorebookRecallTopKIsDefault: boolean;
  lorebookRecursionEnabled: boolean;
  lorebookRecursionEnabledIsDefault: boolean;
}

export async function getLorebookSettings(store: OrchestratorSettingsStore): Promise<LorebookSettings> {
  const [modeRaw, budgetRaw, topKRaw, recursionRaw] = await Promise.all([
    store.get('lorebook_mode'),
    store.get('lorebook_token_budget'),
    store.get('lorebook_recall_top_k'),
    store.get('lorebook_recursion_enabled'),
  ]);
  const parsedBudget = budgetRaw ? Number(budgetRaw) : NaN;
  const parsedTopK = topKRaw ? Number(topKRaw) : NaN;
  return {
    lorebookMode: modeRaw === 'on' ? 'on' : 'off',
    lorebookModeIsDefault: modeRaw === undefined,
    // 'Infinity' is the canonical stored spelling for "no budget" (setLorebookSettings writes it
    // when the panel clears the field); both it and an unset row map to null.
    lorebookTokenBudget:
      budgetRaw === undefined || budgetRaw === 'Infinity' || !Number.isFinite(parsedBudget) || parsedBudget <= 0 ? null : parsedBudget,
    lorebookTokenBudgetIsDefault: budgetRaw === undefined,
    lorebookRecallTopK: Number.isInteger(parsedTopK) && parsedTopK > 0 ? parsedTopK : 8,
    lorebookRecallTopKIsDefault: topKRaw === undefined,
    lorebookRecursionEnabled: recursionRaw === 'true',
    lorebookRecursionEnabledIsDefault: recursionRaw === undefined,
  };
}

export interface SetLorebookSettingsBody {
  lorebookMode?: 'on' | 'off';
  /** null clears the budget back to unlimited. */
  lorebookTokenBudget?: number | null;
  lorebookRecallTopK?: number;
  lorebookRecursionEnabled?: boolean;
}

// All four fields optional and independently settable; wire keys are snake_case, same convention
// as every other parseSet*Body in this file. An explicit null on lorebook_token_budget clears the
// override back to unlimited (the "reset to default" gesture for that field).
export function parseSetLorebookSettingsBody(raw: unknown): SetLorebookSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { lorebook_mode, lorebook_token_budget, lorebook_recall_top_k, lorebook_recursion_enabled } = raw as Record<string, unknown>;
  if (
    lorebook_mode === undefined &&
    lorebook_token_budget === undefined &&
    lorebook_recall_top_k === undefined &&
    lorebook_recursion_enabled === undefined
  ) {
    return undefined;
  }
  if (lorebook_mode !== undefined && lorebook_mode !== 'on' && lorebook_mode !== 'off') return undefined;
  if (
    lorebook_token_budget !== undefined &&
    lorebook_token_budget !== null &&
    (typeof lorebook_token_budget !== 'number' || !Number.isFinite(lorebook_token_budget) || lorebook_token_budget <= 0)
  ) {
    return undefined;
  }
  if (lorebook_recall_top_k !== undefined && (typeof lorebook_recall_top_k !== 'number' || !Number.isInteger(lorebook_recall_top_k) || lorebook_recall_top_k <= 0)) {
    return undefined;
  }
  if (lorebook_recursion_enabled !== undefined && typeof lorebook_recursion_enabled !== 'boolean') return undefined;
  return {
    lorebookMode: lorebook_mode as 'on' | 'off' | undefined,
    lorebookTokenBudget: lorebook_token_budget as number | null | undefined,
    lorebookRecallTopK: lorebook_recall_top_k as number | undefined,
    lorebookRecursionEnabled: lorebook_recursion_enabled as boolean | undefined,
  };
}

export async function setLorebookSettings(store: OrchestratorSettingsStore, body: SetLorebookSettingsBody): Promise<void> {
  if (body.lorebookMode !== undefined) await store.set('lorebook_mode', body.lorebookMode);
  if (body.lorebookTokenBudget !== undefined) {
    await store.set('lorebook_token_budget', body.lorebookTokenBudget === null ? 'Infinity' : String(body.lorebookTokenBudget));
  }
  if (body.lorebookRecallTopK !== undefined) await store.set('lorebook_recall_top_k', String(body.lorebookRecallTopK));
  if (body.lorebookRecursionEnabled !== undefined) await store.set('lorebook_recursion_enabled', String(body.lorebookRecursionEnabled));
}

// --- Lorebook management CRUD (docs/lorebook-plan.md §8a, step 5) ---
// The Lorebooks page's library list + entry editor. Books/entries are user-scoped, RLS-forced
// tables (0051), so every write takes the owning userId explicitly and runs under that user's
// scope — the admin key grants cross-user *reads* (roster + per-user scan, same shape as
// getLocationsAdmin), but Postgres still refuses a system-scope write into a forced-RLS table.
// All FKs cascade (0051/0088), so deletes are single-statement. vector_embed is populated at
// create/update time by embedding `${bookName}\n${content}` (the §3c/chatMemorySync shape); an
// embedding failure fails open to a null vector — the entry still works, it just can't be ranked.
export interface LorebookAdminRow {
  lorebookId: string;
  userId: string;
  name: string;
  globalScope: boolean;
  createdAt: string;
  updatedAt: string;
  characterIds: string[];
  chatOverrideCount: number;
  entries: LorebookEntryAdminRow[];
}

export async function getLorebooksAdmin(db: PostgresClient): Promise<LorebookAdminRow[]> {
  const users = await db.withSystemScope((session) => session.query<{ user_id: string }>('select user_id from users'));
  const rows: LorebookAdminRow[] = [];
  for (const { user_id: userId } of users) {
    const books = await db.withUserScope(userId, (session) =>
      session.query<{
        lorebook_id: string;
        name: string;
        global_scope: boolean;
        created_at: string;
        updated_at: string;
        chat_override_count: number;
        character_ids: string[] | null;
      }>(
        `select b.lorebook_id, b.name, b.global_scope, b.created_at, b.updated_at,
                (select count(*)::int from lorebook_chat_overrides co where co.lorebook_id = b.lorebook_id) as chat_override_count,
                (select coalesce(array_agg(cl.character_id order by cl.joined_at), '{}'::uuid[]) from lorebook_character_links cl
                 where cl.lorebook_id = b.lorebook_id) as character_ids
         from lorebooks b
         order by b.name`,
      ),
    );
    for (const b of books) {
      const entries = await db.withUserScope(userId, (session) =>
        session.query<LorebookEntryRowShape>(
          `select entry_id, uid, key, comment, content, constant, disable, order_value, probability,
                  use_probability, group_name, group_weight, group_override, sticky, cooldown, delay, updated_at
           from lorebook_entries where lorebook_id = $1
           order by order_value, uid`,
          [b.lorebook_id],
        ),
      );
      rows.push({
        lorebookId: b.lorebook_id,
        userId,
        name: b.name,
        globalScope: b.global_scope,
        createdAt: b.created_at,
        updatedAt: b.updated_at,
        characterIds: b.character_ids ?? [],
        chatOverrideCount: b.chat_override_count,
        entries: entries.map(toLorebookEntryAdminRow),
      });
    }
  }
  return rows;
}

export async function createLorebookAdmin(db: PostgresClient, userId: string, name: string): Promise<LorebookAdminRow | undefined> {
  return db.withUserScope(userId, async (session) => {
    const [row] = await session.query<{ lorebook_id: string; name: string; global_scope: boolean; created_at: string; updated_at: string }>(
      'insert into lorebooks (user_id, name) values ($1, $2) returning lorebook_id, name, global_scope, created_at, updated_at',
      [userId, name],
    );
    if (!row) return undefined;
    return {
      lorebookId: row.lorebook_id,
      userId,
      name: row.name,
      globalScope: row.global_scope,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      characterIds: [],
      chatOverrideCount: 0,
      entries: [],
    };
  });
}

export interface UpdateLorebookPatch {
  name?: string;
  globalScope?: boolean;
  /** Replaces the book's character-link set wholesale; omitted = leave links untouched. */
  characterIds?: string[];
}

export async function updateLorebookAdmin(
  db: PostgresClient,
  userId: string,
  lorebookId: string,
  patch: UpdateLorebookPatch,
): Promise<boolean> {
  return db.withUserScope(userId, async (session) => {
    if (patch.name !== undefined || patch.globalScope !== undefined) {
      const sets: string[] = [];
      const params: unknown[] = [lorebookId, userId];
      if (patch.name !== undefined) {
        params.push(patch.name);
        sets.push(`name = $${params.length}`);
      }
      if (patch.globalScope !== undefined) {
        params.push(patch.globalScope);
        sets.push(`global_scope = $${params.length}`);
      }
      await session.query(`update lorebooks set ${sets.join(', ')} where lorebook_id = $1 and user_id = $2`, params);
    }
    if (patch.characterIds !== undefined) {
      await session.query('delete from lorebook_character_links where lorebook_id = $1', [lorebookId]);
      for (const characterId of patch.characterIds) {
        await session.query(
          'insert into lorebook_character_links (lorebook_id, character_id, user_id) values ($1, $2, $3) on conflict do nothing',
          [lorebookId, characterId, userId],
        );
      }
    }
    // The book's user_id check above is what makes a foreign row a no-op: RLS hides it entirely.
    const [exists] = await session.query<{ n: number }>('select 1 as n from lorebooks where lorebook_id = $1', [lorebookId]);
    return exists !== undefined;
  });
}

export async function deleteLorebookAdmin(db: PostgresClient, userId: string, lorebookId: string): Promise<boolean> {
  return db.withUserScope(userId, async (session) => {
    await session.query('delete from lorebooks where lorebook_id = $1 and user_id = $2', [lorebookId, userId]);
    // session.query returns rows, not a pg result — detect "was there a row" with an exists probe.
    const [exists] = await session.query<{ n: number }>('select 1 as n from lorebooks where lorebook_id = $1', [lorebookId]);
    return exists === undefined;
  });
}