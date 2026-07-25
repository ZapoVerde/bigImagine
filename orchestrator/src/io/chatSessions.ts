/**
 * @file orchestrator/src/io/chatSessions.ts
 * @stamp 2026-07-24
 * @architectural-role IO Wrapper — persisted chat sessions, messages, and folders
 * @description
 * The Postgres-backed store behind the frontend Chat tab's history sidebar
 * (db/migrations/0009_chat_sessions.sql). Normalized rows from day one — deliberately NOT the
 * one-JSON-blob-per-chat shape the Open WebUI reference uses (that project is itself mid-migration
 * away from it; we skip straight to the destination). Every query runs inside
 * db.withUserScope(userId, ...) so RLS scopes everything — a chat_id belonging to another user is
 * simply invisible, not "forbidden."
 *
 * Search is plain ILIKE over the session title OR any of its messages' content — the same
 * approach the reference uses (no vectors anywhere in its chat search either), just against
 * normalized rows instead of a JSON blob.
 *
 * params carries defined keys only (system, temperature, top_p, max_tokens, model), merged over
 * provider defaults at request time by httpServer.ts's chat_id handling. toolNames: null = all
 * registered tools (pre-existing behavior), [] = none, else an allow-list applied via
 * toolRegistry.ts's filterToolRegistry.
 *
 * @api-declaration
 * createChatSessionStore(db) -> ChatSessionStore
 *   .listChats(userId, {search?, folderId?}) — summaries, updated_at desc
 *   .createChat(userId, {title?, folderId?}) — full new session row
 *   .getChat(userId, chatId) — {session, messages} or undefined
 *   .updateChat(userId, chatId, patch) — updated row or undefined; bumps updated_at
 *   .deleteChat(userId, chatId) — true if a row was deleted
 *   .appendMessages(userId, chatId, messages) — inserts + bumps session updated_at
 *   .deleteMessage(userId, chatId, messageId) — removes exactly one message, false if not found
 *   .truncateMessagesFrom(userId, chatId, messageId) — removes that message and everything
 *     chronologically after it (edit/rerun's shared primitive), false if not found
 *   .listFolders / .createFolder / .updateFolder / .deleteFolder — folder CRUD; deleting a
 *     folder cascades to child folders, chats fall back to no-folder (on delete set null)
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via db.withUserScope)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { DbSession, PostgresClient } from './postgres.js';

export interface ChatParams {
  system?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  model?: string;
}

export interface ChatSessionRow {
  chatId: string;
  title: string;
  folderId: string | null;
  params: ChatParams;
  toolNames: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSummary {
  chatId: string;
  title: string;
  folderId: string | null;
  updatedAt: string;
}

export interface StoredChatMessage {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface ChatDetail {
  session: ChatSessionRow;
  messages: StoredChatMessage[];
}

export interface FolderRow {
  folderId: string;
  name: string;
  parentId: string | null;
}

export interface ChatSessionStore {
  listChats(userId: string, opts?: { search?: string; folderId?: string }): Promise<ChatSummary[]>;
  createChat(userId: string, init?: { title?: string; folderId?: string }): Promise<ChatSessionRow>;
  getChat(userId: string, chatId: string): Promise<ChatDetail | undefined>;
  updateChat(
    userId: string,
    chatId: string,
    patch: { title?: string; folderId?: string | null; params?: ChatParams; toolNames?: string[] | null },
  ): Promise<ChatSessionRow | undefined>;
  deleteChat(userId: string, chatId: string): Promise<boolean>;
  appendMessages(userId: string, chatId: string, messages: { role: 'user' | 'assistant'; content: string }[]): Promise<void>;
  /** Removes exactly one message, wherever it falls in the conversation — safe because only
   *  clean user/assistant turns are ever persisted (tool_use/tool_result blocks live only inside
   *  one runTurn round and are never written to chat_messages), so there's no structural pairing
   *  to break. Used by the Chat tab's standalone delete action. */
  deleteMessage(userId: string, chatId: string, messageId: string): Promise<boolean>;
  /** Removes the given message and every message chronologically after it — the shared primitive
   *  behind both "edit" (truncate at the edited user message, then resend with new content) and
   *  "rerun" (truncate at the assistant reply being regenerated, then resend unchanged). Returns
   *  false if messageId doesn't exist in this chat (nothing to truncate from). */
  truncateMessagesFrom(userId: string, chatId: string, messageId: string): Promise<boolean>;
  listFolders(userId: string): Promise<FolderRow[]>;
  createFolder(userId: string, init: { name: string; parentId?: string }): Promise<FolderRow>;
  updateFolder(userId: string, folderId: string, patch: { name?: string; parentId?: string | null }): Promise<FolderRow | undefined>;
  deleteFolder(userId: string, folderId: string): Promise<boolean>;
}

interface SessionDbRow {
  chat_id: string;
  title: string;
  folder_id: string | null;
  params: ChatParams;
  tool_names: string[] | null;
  created_at: string;
  updated_at: string;
}

function toSessionRow(row: SessionDbRow): ChatSessionRow {
  return {
    chatId: row.chat_id,
    title: row.title,
    folderId: row.folder_id,
    params: row.params ?? {},
    toolNames: row.tool_names,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SESSION_COLUMNS = 'chat_id, title, folder_id, params, tool_names, created_at, updated_at';

export function createChatSessionStore(db: PostgresClient): ChatSessionStore {
  return {
    async listChats(userId, opts = {}) {
      return db.withUserScope(userId, async (session) => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (opts.search) {
          params.push(`%${opts.search}%`);
          const q = `$${params.length}`;
          clauses.push(
            `(title ilike ${q} or exists (
               select 1 from chat_messages m where m.chat_id = chat_sessions.chat_id and m.content ilike ${q}
             ))`,
          );
        }
        if (opts.folderId) {
          params.push(opts.folderId);
          clauses.push(`folder_id = $${params.length}`);
        }
        const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';
        const rows = await session.query<{ chat_id: string; title: string; folder_id: string | null; updated_at: string }>(
          `select chat_id, title, folder_id, updated_at from chat_sessions ${where} order by updated_at desc`,
          params,
        );
        return rows.map((r) => ({ chatId: r.chat_id, title: r.title, folderId: r.folder_id, updatedAt: r.updated_at }));
      });
    },

    async createChat(userId, init = {}) {
      return db.withUserScope(userId, async (session) => {
        const rows = await session.query<SessionDbRow>(
          `insert into chat_sessions (user_id, title, folder_id) values ($1, coalesce($2, 'New chat'), $3)
           returning ${SESSION_COLUMNS}`,
          [userId, init.title ?? null, init.folderId ?? null],
        );
        return toSessionRow(rows[0]!);
      });
    },

    async getChat(userId, chatId) {
      return db.withUserScope(userId, async (session) => {
        const sessions = await session.query<SessionDbRow>(
          `select ${SESSION_COLUMNS} from chat_sessions where chat_id = $1`,
          [chatId],
        );
        if (!sessions[0]) return undefined;
        const messages = await session.query<{ message_id: string; role: 'user' | 'assistant'; content: string; created_at: string }>(
          'select message_id, role, content, created_at from chat_messages where chat_id = $1 order by created_at, message_id',
          [chatId],
        );
        return {
          session: toSessionRow(sessions[0]),
          messages: messages.map((m) => ({
            messageId: m.message_id,
            role: m.role,
            content: m.content,
            createdAt: m.created_at,
          })),
        };
      });
    },

    async updateChat(userId, chatId, patch) {
      return db.withUserScope(userId, async (session) => {
        const sets: string[] = ['updated_at = now()'];
        const params: unknown[] = [chatId];
        if (patch.title !== undefined) {
          params.push(patch.title);
          sets.push(`title = $${params.length}`);
        }
        if (patch.folderId !== undefined) {
          params.push(patch.folderId);
          sets.push(`folder_id = $${params.length}`);
        }
        if (patch.params !== undefined) {
          params.push(JSON.stringify(patch.params));
          sets.push(`params = $${params.length}::jsonb`);
        }
        if (patch.toolNames !== undefined) {
          params.push(patch.toolNames);
          sets.push(`tool_names = $${params.length}`);
        }
        const rows = await session.query<SessionDbRow>(
          `update chat_sessions set ${sets.join(', ')} where chat_id = $1 returning ${SESSION_COLUMNS}`,
          params,
        );
        return rows[0] ? toSessionRow(rows[0]) : undefined;
      });
    },

    async deleteChat(userId, chatId) {
      return db.withUserScope(userId, async (session) => {
        const rows = await session.query<{ chat_id: string }>(
          'delete from chat_sessions where chat_id = $1 returning chat_id',
          [chatId],
        );
        return rows.length > 0;
      });
    },

    async appendMessages(userId, chatId, messages) {
      if (messages.length === 0) return;
      await db.withUserScope(userId, async (session) => {
        for (const message of messages) {
          // clock_timestamp(), not the column's `default now()` — now() is frozen for the whole
          // transaction, so a multi-message insert (one user + one assistant turn) would give
          // every row the identical created_at and leave ordering to an arbitrary UUID tiebreak.
          // clock_timestamp() actually advances between statements, keeping messages in order.
          await session.query(
            'insert into chat_messages (chat_id, user_id, role, content, created_at) values ($1, $2, $3, $4, clock_timestamp())',
            [chatId, userId, message.role, message.content],
          );
        }
        await session.query('update chat_sessions set updated_at = now() where chat_id = $1', [chatId]);
      });
    },

    async deleteMessage(userId, chatId, messageId) {
      return db.withUserScope(userId, async (session) => {
        const rows = await session.query<{ message_id: string }>(
          'delete from chat_messages where message_id = $1 and chat_id = $2 returning message_id',
          [messageId, chatId],
        );
        if (rows.length === 0) return false;
        await session.query('update chat_sessions set updated_at = now() where chat_id = $1', [chatId]);
        return true;
      });
    },

    async truncateMessagesFrom(userId, chatId, messageId) {
      return db.withUserScope(userId, async (session) => {
        // Row-value comparison against the target's own (created_at, message_id) — the exact same
        // tiebreak getChat's `order by created_at, message_id` uses, so "everything from here on"
        // means precisely what the UI displayed as "from here on".
        const rows = await session.query<{ message_id: string }>(
          `delete from chat_messages where chat_id = $1 and (created_at, message_id) >= (
             select created_at, message_id from chat_messages where message_id = $2 and chat_id = $1
           ) returning message_id`,
          [chatId, messageId],
        );
        if (rows.length === 0) return false;
        await session.query('update chat_sessions set updated_at = now() where chat_id = $1', [chatId]);
        return true;
      });
    },

    async listFolders(userId) {
      return db.withUserScope(userId, listFoldersQuery);
    },

    async createFolder(userId, init) {
      return db.withUserScope(userId, async (session) => {
        const rows = await session.query<{ folder_id: string; name: string; parent_id: string | null }>(
          'insert into folders (user_id, name, parent_id) values ($1, $2, $3) returning folder_id, name, parent_id',
          [userId, init.name, init.parentId ?? null],
        );
        return { folderId: rows[0]!.folder_id, name: rows[0]!.name, parentId: rows[0]!.parent_id };
      });
    },

    async updateFolder(userId, folderId, patch) {
      return db.withUserScope(userId, async (session) => {
        const sets: string[] = [];
        const params: unknown[] = [folderId];
        if (patch.name !== undefined) {
          params.push(patch.name);
          sets.push(`name = $${params.length}`);
        }
        if (patch.parentId !== undefined) {
          params.push(patch.parentId);
          sets.push(`parent_id = $${params.length}`);
        }
        if (sets.length === 0) {
          const rows = await session.query<{ folder_id: string; name: string; parent_id: string | null }>(
            'select folder_id, name, parent_id from folders where folder_id = $1',
            [folderId],
          );
          return rows[0] ? { folderId: rows[0].folder_id, name: rows[0].name, parentId: rows[0].parent_id } : undefined;
        }
        const rows = await session.query<{ folder_id: string; name: string; parent_id: string | null }>(
          `update folders set ${sets.join(', ')} where folder_id = $1 returning folder_id, name, parent_id`,
          params,
        );
        return rows[0] ? { folderId: rows[0].folder_id, name: rows[0].name, parentId: rows[0].parent_id } : undefined;
      });
    },

    async deleteFolder(userId, folderId) {
      return db.withUserScope(userId, async (session) => {
        const rows = await session.query<{ folder_id: string }>(
          'delete from folders where folder_id = $1 returning folder_id',
          [folderId],
        );
        return rows.length > 0;
      });
    },
  };
}

async function listFoldersQuery(session: DbSession): Promise<FolderRow[]> {
  const rows = await session.query<{ folder_id: string; name: string; parent_id: string | null }>(
    'select folder_id, name, parent_id from folders order by name',
  );
  return rows.map((r) => ({ folderId: r.folder_id, name: r.name, parentId: r.parent_id }));
}
