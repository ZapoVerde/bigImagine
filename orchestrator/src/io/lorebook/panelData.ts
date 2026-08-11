/**
 * @file orchestrator/src/io/lorebook/panelData.ts
 * @stamp 2026-08-11
 * @architectural-role IO Wrapper — per-chat panel reads + quick toggles/quick-add (plan §8b)
 * @description
 * The user-scoped backend for the chat-sidebar Lorebook panel (docs/lorebook-plan.md §8b). The
 * step-5 management page is admin-gated and cross-user; this module is the same data, scoped to
 * one chat and one user, read/written over the regular authenticated chat routes (no admin key —
 * a user's own chat's lorebook state is no more sensitive than the chat itself).
 *
 * Reads (§8b's "active-books accordion" + "live activation badges"):
 *   - books in scope for the chat, using the exact §3b scope rules recallLorebookEntries.ts
 *     resolves in SQL: global_scope, character links to the chat's active character, or an
 *     enabled lorebook_chat_overrides row; an explicit `enabled = false` chat override beats
 *     every in-scope path.
 *   - all entries of those books (not just the top-K recalled set — the panel browses the whole
 *     book, and a non-constant entry with a NULL vector_embed is still visible here even though
 *     it can never be recalled until embedded).
 *   - per-entry chat override state (`lorebook_entry_overrides`) and the live activation badge:
 *     whether the entry appears in `lorebook_activation_log` for the chat's latest assistant
 *     message — "reads lorebook_activation_log for the latest message_id", exactly §8b.
 *   - the resolved `lorebook_mode` (global §3d setting; modeIsDefault = unset) so the panel can
 *     swap to its mode-off one-liner.
 *
 * Writes:
 *   - setLorebookChatOverride / setLorebookEntryOverride: upsert the override rows (§3b) the
 *     panel's quick toggles drive. Both probe the target row first so a foreign/hidden id gets a
 *     clean false instead of an FK violation surfacing as a 500.
 *   - quickAddLorebookEntry: the §8b quick-add — inserts a `lorebook_entries` row into a
 *     lazily-created chat-scoped book. The chat-scoped book is identified deterministically: a
 *     book whose ONLY link is one enabled `lorebook_chat_overrides` row for this chat (no
 *     global_scope, no character links, exactly one chat override) — created on first quick-add
 *     named after the chat, then reused. The new entry is embedded as `${bookName}\n${content}`,
 *     the same convention createLorebookEntryAdmin (step 5) uses.
 *
 * @api-declaration
 * getLorebookPanelData(db, settings, { userId, chatId, characterId, latestAssistantMessageId })
 *   -> Promise<LorebookPanelData> — never rejects; a DB error logs and returns an empty panel.
 * setLorebookChatOverride(db, userId, chatId, lorebookId, enabled) -> Promise<boolean> — false
 *   when no visible book with that id exists.
 * setLorebookEntryOverride(db, userId, chatId, entryId, enabled) -> Promise<boolean> — false when
 *   no visible entry with that id exists.
 * quickAddLorebookEntry(db, embeddings, userId, chatId, chatTitle, content)
 *   -> Promise<{ bookId, entryId } | undefined> — undefined on a blank content.
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO; embeddings call in quickAdd)
 *     state_ownership: []
 *     external_io:     [Postgres, embeddings provider (quickAdd only)]
 */

import type { EmbeddingProvider } from '../embeddings/types.js';
import type { PostgresClient } from '../postgres.js';
import type { OrchestratorSettingsStore } from '../orchestratorSettings.js';
import { toPgVectorLiteral } from '../../util/pgvector.js';
import { log } from '../logger.js';

/** One book in scope for the chat (§3b), with the override/link state the panel's accordion
 *  shows. chatOverrideEnabled null = no override row (book in scope via global/character). */
export interface LorebookPanelBook {
  lorebookId: string;
  name: string;
  globalScope: boolean;
  characterLinked: boolean;
  chatOverrideEnabled: boolean | null;
  entries: LorebookPanelEntry[];
}

/** One entry of an in-scope book. entryOverrideEnabled null = no per-entry chat override.
 *  activatedInLatestTurn = the entry appears in lorebook_activation_log for the chat's latest
 *  assistant message (§8b's live activation badge). */
export interface LorebookPanelEntry {
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
  entryOverrideEnabled: boolean | null;
  activatedInLatestTurn: boolean;
}

export interface LorebookPanelData {
  mode: 'on' | 'off';
  modeIsDefault: boolean;
  books: LorebookPanelBook[];
}

interface BookScopeRow {
  lorebook_id: string;
  name: string;
  global_scope: boolean;
  character_linked: boolean;
  chat_override_enabled: boolean | null;
}

interface EntryRow {
  entry_id: string;
  lorebook_id: string;
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
}

export async function getLorebookPanelData(
  db: PostgresClient,
  settings: OrchestratorSettingsStore,
  input: { userId: string; chatId: string; characterId: string | null; latestAssistantMessageId: string | null },
): Promise<LorebookPanelData> {
  const modeRaw = await settings.get('lorebook_mode');
  const mode = modeRaw === 'on' ? 'on' : 'off';
  const modeIsDefault = modeRaw === undefined;

  try {
    return await db.withUserScope(input.userId, async (session) => {
      // A null characterId (no active character) must not short-circuit the character link into
      // an invalid uuid comparison — same all-zero literal recallLorebookEntries.ts uses.
      const scopedCharacterId = input.characterId ?? '00000000-0000-0000-0000-000000000000';

      const bookRows = await session.query<BookScopeRow>(
        `select b.lorebook_id, b.name, b.global_scope,
                exists (select 1 from lorebook_character_links lcl
                        where lcl.lorebook_id = b.lorebook_id and lcl.character_id = $2) as character_linked,
                lco.enabled as chat_override_enabled
         from lorebooks b
         left join lorebook_chat_overrides lco
           on lco.lorebook_id = b.lorebook_id and lco.chat_id = $3
         where b.user_id = $1
           and (
             b.global_scope
             or exists (select 1 from lorebook_character_links lcl2
                        where lcl2.lorebook_id = b.lorebook_id and lcl2.character_id = $2)
             or lco.enabled
           )
           and coalesce(lco.enabled, true)
         order by b.name`,
        [input.userId, scopedCharacterId, input.chatId],
      );
      if (bookRows.length === 0) {
        return { mode, modeIsDefault, books: [] };
      }

      const bookIds = bookRows.map((r) => r.lorebook_id);
      const entryRows = await session.query<EntryRow>(
        `select entry_id, lorebook_id, uid, key, comment, content, constant, disable, order_value,
                probability, use_probability, group_name, group_weight, group_override,
                sticky, cooldown, delay
         from lorebook_entries
         where user_id = $1 and lorebook_id = any($2)
         order by lorebook_id, order_value, created_at`,
        [input.userId, bookIds],
      );

      const [overrideRows, activationRows] = await Promise.all([
        session.query<{ entry_id: string; enabled: boolean }>(
          'select entry_id, enabled from lorebook_entry_overrides where user_id = $1 and chat_id = $2',
          [input.userId, input.chatId],
        ),
        input.latestAssistantMessageId
          ? session.query<{ entry_id: string }>(
              'select entry_id from lorebook_activation_log where user_id = $1 and chat_id = $2 and message_id = $3',
              [input.userId, input.chatId, input.latestAssistantMessageId],
            )
          : Promise.resolve([] as { entry_id: string }[]),
      ]);
      const overrideByEntry = new Map(overrideRows.map((r) => [r.entry_id, r.enabled]));
      const activated = new Set(activationRows.map((r) => r.entry_id));

      const entriesByBook = new Map<string, LorebookPanelEntry[]>();
      for (const r of entryRows) {
        const list = entriesByBook.get(r.lorebook_id) ?? [];
        list.push({
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
          entryOverrideEnabled: overrideByEntry.has(r.entry_id) ? (overrideByEntry.get(r.entry_id) ?? null) : null,
          activatedInLatestTurn: activated.has(r.entry_id),
        });
        entriesByBook.set(r.lorebook_id, list);
      }

      return {
        mode,
        modeIsDefault,
        books: bookRows.map((b) => ({
          lorebookId: b.lorebook_id,
          name: b.name,
          globalScope: b.global_scope,
          characterLinked: b.character_linked,
          chatOverrideEnabled: b.chat_override_enabled,
          entries: entriesByBook.get(b.lorebook_id) ?? [],
        })),
      };
    });
  } catch (err) {
    // The panel must never break the chat view: log and return an empty (mode-correct) panel.
    log.warn('getLorebookPanelData: read failed, returning empty panel', { userId: input.userId, chatId: input.chatId, err });
    return { mode, modeIsDefault, books: [] };
  }
}

export async function setLorebookChatOverride(
  db: PostgresClient,
  userId: string,
  chatId: string,
  lorebookId: string,
  enabled: boolean,
): Promise<boolean> {
  return db.withUserScope(userId, async (session) => {
    const [visible] = await session.query<{ n: number }>('select 1 as n from lorebooks where lorebook_id = $1', [lorebookId]);
    if (!visible) return false;
    await session.query(
      `insert into lorebook_chat_overrides (user_id, chat_id, lorebook_id, enabled)
       values ($1, $2, $3, $4)
       on conflict (user_id, chat_id, lorebook_id)
       do update set enabled = excluded.enabled`,
      [userId, chatId, lorebookId, enabled],
    );
    return true;
  });
}

export async function setLorebookEntryOverride(
  db: PostgresClient,
  userId: string,
  chatId: string,
  entryId: string,
  enabled: boolean,
): Promise<boolean> {
  return db.withUserScope(userId, async (session) => {
    const [visible] = await session.query<{ n: number }>('select 1 as n from lorebook_entries where entry_id = $1', [entryId]);
    if (!visible) return false;
    await session.query(
      `insert into lorebook_entry_overrides (user_id, chat_id, entry_id, enabled)
       values ($1, $2, $3, $4)
       on conflict (user_id, chat_id, entry_id)
       do update set enabled = excluded.enabled`,
      [userId, chatId, entryId, enabled],
    );
    return true;
  });
}

export async function quickAddLorebookEntry(
  db: PostgresClient,
  embeddings: EmbeddingProvider,
  userId: string,
  chatId: string,
  chatTitle: string,
  content: string,
): Promise<{ bookId: string; entryId: string } | undefined> {
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  return db.withUserScope(userId, async (session) => {
    // The chat-scoped book: the one whose only link is a single enabled chat-override row for
    // this chat (no global_scope, no character links) — created lazily on the first quick-add.
    const existing = await session.query<{ lorebook_id: string; name: string }>(
      `select b.lorebook_id, b.name from lorebooks b
       join lorebook_chat_overrides lco on lco.lorebook_id = b.lorebook_id
       where lco.user_id = $1 and lco.chat_id = $2 and lco.enabled
         and not b.global_scope
         and not exists (select 1 from lorebook_character_links lcl where lcl.lorebook_id = b.lorebook_id)
         and (select count(*) from lorebook_chat_overrides l2 where l2.lorebook_id = b.lorebook_id and l2.user_id = $1) = 1
       order by b.created_at
       limit 1`,
      [userId, chatId],
    );

    let bookId: string;
    let bookName: string;
    if (existing[0]) {
      bookId = existing[0].lorebook_id;
      bookName = existing[0].name;
    } else {
      const name = (chatTitle.trim() || 'Chat lorebook').slice(0, 80);
      const [created] = await session.query<{ lorebook_id: string }>(
        'insert into lorebooks (user_id, name) values ($1, $2) returning lorebook_id',
        [userId, name],
      );
      if (!created) return undefined;
      bookId = created.lorebook_id;
      bookName = name;
      await session.query(
        `insert into lorebook_chat_overrides (user_id, chat_id, lorebook_id, enabled)
         values ($1, $2, $3, true)
         on conflict (user_id, chat_id, lorebook_id) do nothing`,
        [userId, chatId, bookId],
      );
    }

    // Embed as `${bookName}\n${content}` — the same convention createLorebookEntryAdmin uses,
    // so a quick-added entry is discoverable against the same book-title-anchored queries.
    let vectorLiteral: string | null = null;
    try {
      const [vector] = await embeddings.embed([`${bookName}\n${trimmed}`]);
      vectorLiteral = vector ? toPgVectorLiteral(vector) : null;
    } catch (err) {
      // Fail-open, same as the admin path: the row still exists (visible in the panel, and
      // embeddable later) — recall just can't rank it until it has a vector.
      log.warn('quickAddLorebookEntry: embed failed, inserting without vector', { userId, chatId, err });
    }

    const [entry] = await session.query<{ entry_id: string }>(
      `insert into lorebook_entries (lorebook_id, user_id, content, vector_embed)
       values ($1, $2, $3, $4)
       returning entry_id`,
      [bookId, userId, trimmed, vectorLiteral],
    );
    if (!entry) return undefined;
    return { bookId, entryId: entry.entry_id };
  });
}
