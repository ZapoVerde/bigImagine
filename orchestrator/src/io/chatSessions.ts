/**
 * @file orchestrator/src/io/chatSessions.ts
 * @stamp 2026-07-25
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
 * params carries defined keys only (system, temperature, top_p, max_tokens, model, profile), merged
 * over provider defaults at request time by httpServer.ts's chat_id handling. profile names one of
 * BIGBRAIN_LLM_PROFILES (io/llm/profiles.ts) to run this chat's turns through instead of the
 * household's active connection (io/orchestratorSettings.ts's active_llm_profile) — unlike that
 * household-wide setting, picking a different profile per chat needs no restart, since httpServer.ts
 * builds a throwaway provider for it the same way the Settings tab's model-catalog preview already
 * does (server/adminServer.ts's listModelsForProfile). toolNames: null = all
 * registered tools (pre-existing behavior), [] = none, else an allow-list applied via
 * toolRegistry.ts's filterToolRegistry. canvasNoteId (Canvas): which note this chat's document
 * panel is focused on, if any — written by httpServer.ts from runTurn's focusedNoteId, or cleared
 * by the frontend's own close action; this store just persists whatever it's given.
 *
 * forkChat/archiveChat (db/migrations/0040_chat_branching.sql, docs/chat-memory.md): a fork is a
 * new chat_sessions row, constructed correct from birth rather than detected-and-healed —
 * messages up to and including forkFromMessageId are copied under fresh message_ids (message_id
 * is a global PK, so the parent's own rows can't be reused), and only the chat_sync_points/
 * chat_chunks/chat_memory_entries rows whose sync point falls at-or-before the fork point come
 * along too, so the new branch never inherits a "key idea" digest describing something that
 * happened after the point it branched from. (One known imprecision, accepted for simplicity, same
 * spirit as Canonize's own wholesale-snapshot-restore: chat_memory_entries stores current content
 * per topic_key, not a full version history, so an entry last touched by a post-fork-point sync is
 * skipped entirely rather than copied in its pre-fork-point form.) canon_facts is the one exception
 * to fork-point filtering: every fact belonging to the parent chat is duplicated in full (the
 * user's explicit call — a fork always gets its own chat_id and a full content dup, not a
 * point-in-time slice), status/proposed_at/approved_at preserved as-is; anchor_message_id remaps
 * through the same idMap as the copied messages, or nulls out if that turn wasn't copied
 * (db/migrations/0058_canon_facts_chat_scoped.sql). archiveChat only stamps
 * archived_at — orchestrator/src/orchestrator/chatMemorySync.ts's archiveChatMemory (triggered by
 * server/httpServer.ts right after) is what actually runs the end-of-chat long-term-memory
 * extraction; this store has no LLM/embeddings access to do that itself.
 *
 * @api-declaration
 * createChatSessionStore(db) -> ChatSessionStore
 *   .listChats(userId, {search?, folderId?, kind?}) — summaries, updated_at desc
 *   .createChat(userId, {title?, folderId?, kind?, toolNames?}) — full new session row; kind
 *     defaults to 'chat', and an 'rp' chat defaults toolNames to [] unless overridden
 *   .getChat(userId, chatId) — {session, messages} or undefined; each message carries a `swipes`
 *     {index, count} whenever it's ever been regenerated (see recordSwipe/cycleSwipe below),
 *     undefined otherwise
 *   .updateChat(userId, chatId, patch) — updated row or undefined; bumps updated_at
 *   .deleteChat(userId, chatId) — true if a row was deleted
 *   .appendMessages(userId, chatId, messages) — inserts + bumps session updated_at
 *   .deleteMessage(userId, chatId, messageId) — removes exactly one message, false if not found
 *   .truncateMessagesFrom(userId, chatId, messageId) — removes that message and everything
 *     chronologically after it (edit/rerun's shared primitive), false if not found
 *   .recordSwipe(userId, chatId, messageId, newContent) — regenerates messageId in place (same
 *     message_id/created_at): stashes its current content as a swipe the first time it's ever
 *     regenerated, stashes newContent as a fresh swipe, makes newContent active. Returns the
 *     updated message or undefined if messageId isn't in this chat.
 *   .cycleSwipe(userId, chatId, messageId, direction) — pure content swap to an existing sibling
 *     swipe, no LLM call (db/migrations/0059_chat_message_swipes.sql). See ChatSessionStore's own
 *     doc on the shape of the result.
 *   .forkChat(userId, chatId, forkFromMessageId, title?) — new session row branched from this
 *     chat at that message, or undefined if forkFromMessageId doesn't belong to it. Swipe history
 *     is deliberately not carried into the fork — same accepted-imprecision trade this file's
 *     preamble already documents for chat_memory_entries; only the active content comes along.
 *   .archiveChat(userId, chatId) — stamps archived_at (now), or undefined if not found
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
  /** Which BIGBRAIN_LLM_PROFILES connection to use for this chat, overriding the household's
   *  active one. Unset means "use whichever connection is active" (the pre-existing behavior). */
  profile?: string;
}

export interface ChatSessionRow {
  chatId: string;
  title: string;
  folderId: string | null;
  params: ChatParams;
  toolNames: string[] | null;
  /** Canvas: the note this chat's document panel is currently focused on, if any. Set by
   *  httpServer.ts at the end of a turn whose tool call(s) surfaced one via focusHint
   *  (toolRegistry.ts), or cleared by the frontend's own close action. */
  canvasNoteId: string | null;
  /** Set only on a forked chat — the chat it branched from (docs/chat-memory.md). Null for an
   *  ordinary chat and for a fork whose parent has since been deleted (on delete set null). */
  parentChatId: string | null;
  /** Set only on a forked chat — the parent's own message_id the fork branched from, kept for
   *  provenance/display ("forked from {parent title} at this point"). Never one of this chat's
   *  own message ids (those are freshly generated at fork time). */
  forkMessageId: string | null;
  /** Set once, explicitly, via archiveChat — the "this chat is done" signal
   *  (docs/bb_principles.md §3) that triggers chatMemorySync.ts's end-of-chat long-term-memory
   *  extraction. Null means still ongoing (eligible for rolling sync). */
  archivedAt: string | null;
  /** Set once at creation, never patched afterward (db/migrations/0049_chat_kind.sql) — 'rp' chats
   *  get no household_memory read/write (httpServer.ts's buildChatMemorySystemPrompt and archive
   *  route) and start with empty tool_names, keeping roleplay isolated from household assistant
   *  behavior by construction rather than by a checkbox someone has to remember to set. */
  kind: 'chat' | 'rp';
  /** Which character this chat is playing, if any — set by applyCharacterToChatTool.ts. Lets a
   *  later apply_prompt_stack_to_chat pull that character's fields without the caller re-passing
   *  characterId. Null for a chat never applied to a character. */
  characterId: string | null;
  /** The last context_stack_presets row applied to this chat via apply_prompt_stack_to_chat, so
   *  the settings panel can show the current selection on reload. Null until first applied. */
  promptStackPresetId: string | null;
  /** Which context_stack_presets row (if any) server/httpServer.ts's post-runTurn cleanup pass
   *  runs for this chat (docs/turn-loop-plan.md §4, migration 0057) — resolved via {{message}}
   *  (util/interpolateMacros.ts), not the narrator's own field set. Null (the default) means
   *  cleanup is off; nothing sets this yet (no dedicated tool/UI in this pass — settable today
   *  only via updateChat's patch, same as any other session field). */
  cleanupPresetId: string | null;
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
  /** Present only once this message has been regenerated at least once (docs/bi_principles.md:
   *  swipe capability on the last LLM response). index is this message's current position among
   *  its own stored variants (0-based); count is how many variants exist. Undefined means the
   *  message has never been swiped — content is its only version. */
  swipes?: { index: number; count: number };
}

/** Result of ChatSessionStore.cycleSwipe — a discriminated union rather than a single optional
 *  return, since 'not found', 'nothing to move to', and 'move to a stored variant' are three
 *  meaningfully different outcomes the caller (server/httpServer.ts) responds to differently. */
export type CycleSwipeResult =
  | { status: 'switched'; message: StoredChatMessage }
  /** direction 'next' with nothing stored ahead of the active variant — caller must regenerate
   *  via the LLM and persist the result with recordSwipe. */
  | { status: 'needs_regenerate' }
  /** direction 'prev' with nothing stored before the active variant. */
  | { status: 'no_earlier_swipe' }
  | { status: 'not_found' };

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
  listChats(userId: string, opts?: { search?: string; folderId?: string; kind?: 'chat' | 'rp' }): Promise<ChatSummary[]>;
  /** kind defaults to 'chat'. When init.kind === 'rp' and toolNames isn't explicitly given, tool_names
   *  defaults to [] (no tools) rather than null (all tools) — see this file's own preamble. */
  createChat(
    userId: string,
    init?: { title?: string; folderId?: string; kind?: 'chat' | 'rp'; toolNames?: string[] | null },
  ): Promise<ChatSessionRow>;
  getChat(userId: string, chatId: string): Promise<ChatDetail | undefined>;
  updateChat(
    userId: string,
    chatId: string,
    patch: {
      title?: string;
      folderId?: string | null;
      params?: ChatParams;
      toolNames?: string[] | null;
      canvasNoteId?: string | null;
      cleanupPresetId?: string | null;
    },
  ): Promise<ChatSessionRow | undefined>;
  deleteChat(userId: string, chatId: string): Promise<boolean>;
  /** Returns the inserted rows' message_ids (same order as the input) — server/httpServer.ts uses
   *  the user message's id as the anchor it threads into runTurn for point-in-time canon recall
   *  (db/migrations/0053_canon_facts_chat_anchor.sql), so mid-turn tool calls anchor to the message
   *  that actually triggered them rather than one turn stale. */
  appendMessages(
    userId: string,
    chatId: string,
    messages: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<{ messageId: string; role: 'user' | 'assistant' }[]>;
  /** Removes exactly one message, wherever it falls in the conversation — safe because only
   *  clean user/assistant turns are ever persisted (tool_use/tool_result blocks live only inside
   *  one runTurn round and are never written to chat_messages), so there's no structural pairing
   *  to break. Used by the Chat tab's standalone delete action. */
  deleteMessage(userId: string, chatId: string, messageId: string): Promise<boolean>;
  /** Removes the given message and every message chronologically after it — "edit"'s primitive
   *  (truncate at the edited user message, then resend with new content). Rerun/swipe no longer
   *  uses this (see recordSwipe below) — it regenerates the existing message in place instead of
   *  truncating it, so prior replies survive as swipe history. Returns false if messageId doesn't
   *  exist in this chat (nothing to truncate from). */
  truncateMessagesFrom(userId: string, chatId: string, messageId: string): Promise<boolean>;
  /** Regenerates messageId in place — same message_id and created_at, content replaced. The
   *  message's prior content is preserved as a swipe the first time this is ever called for it
   *  (so 'prev' can always return to the original reply), and newContent becomes both the row's
   *  content and a fresh swipe of its own. Returns undefined if messageId isn't in this chat. */
  recordSwipe(userId: string, chatId: string, messageId: string, newContent: string): Promise<StoredChatMessage | undefined>;
  /** Cycles messageId's active content to an existing sibling swipe — a pure content swap, no LLM
   *  call. See CycleSwipeResult's own doc for what each outcome means. */
  cycleSwipe(userId: string, chatId: string, messageId: string, direction: 'prev' | 'next'): Promise<CycleSwipeResult>;
  /** Branches a new chat from this one at forkFromMessageId (inclusive) — see this file's own
   *  preamble for exactly what does and doesn't come along. Undefined if forkFromMessageId isn't a
   *  message in this chat. */
  forkChat(userId: string, chatId: string, forkFromMessageId: string, title?: string): Promise<ChatSessionRow | undefined>;
  /** Stamps archived_at (now) — the explicit end-of-chat signal. Undefined if not found. Does not
   *  itself run the long-term-memory extraction; the caller (server/httpServer.ts) does that via
   *  orchestrator/src/orchestrator/chatMemorySync.ts's archiveChatMemory once this returns. */
  archiveChat(userId: string, chatId: string): Promise<ChatSessionRow | undefined>;
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
  canvas_note_id: string | null;
  parent_chat_id: string | null;
  fork_message_id: string | null;
  archived_at: string | null;
  kind: 'chat' | 'rp';
  character_id: string | null;
  prompt_stack_preset_id: string | null;
  cleanup_preset_id: string | null;
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
    canvasNoteId: row.canvas_note_id,
    parentChatId: row.parent_chat_id,
    forkMessageId: row.fork_message_id,
    archivedAt: row.archived_at,
    kind: row.kind,
    characterId: row.character_id,
    promptStackPresetId: row.prompt_stack_preset_id,
    cleanupPresetId: row.cleanup_preset_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SESSION_COLUMNS =
  'chat_id, title, folder_id, params, tool_names, canvas_note_id, parent_chat_id, fork_message_id, archived_at, kind, character_id, prompt_stack_preset_id, cleanup_preset_id, created_at, updated_at';

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
        if (opts.kind) {
          params.push(opts.kind);
          clauses.push(`kind = $${params.length}`);
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
        const kind = init.kind ?? 'chat';
        // RP starts with no tool access by default (empty array, not null) — enforced here so
        // every RP-creating call site gets the guarantee for free, rather than each one having to
        // remember to pass it (see this file's own preamble).
        const toolNames = init.toolNames !== undefined ? init.toolNames : kind === 'rp' ? [] : null;
        const rows = await session.query<SessionDbRow>(
          `insert into chat_sessions (user_id, title, folder_id, kind, tool_names) values ($1, coalesce($2, 'New chat'), $3, $4, $5)
           returning ${SESSION_COLUMNS}`,
          [userId, init.title ?? null, init.folderId ?? null, kind, toolNames],
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
        const messages = await session.query<{
          message_id: string;
          role: 'user' | 'assistant';
          content: string;
          created_at: string;
          active_swipe_id: string | null;
        }>(
          'select message_id, role, content, created_at, active_swipe_id from chat_messages where chat_id = $1 order by created_at, message_id',
          [chatId],
        );
        // Swipe metadata per message (docs/bi_principles.md: swipe capability on the last LLM
        // response) — a message only ever has rows here once it's been regenerated at least once
        // (recordSwipe below), so this is empty for the common case of an unswiped chat. Fetched
        // as one extra query and joined in JS rather than a per-message subquery — chat sizes here
        // are household-scale, not worth a lateral join for.
        const swipesByMessage = new Map<string, { swipe_id: string }[]>();
        if (messages.length > 0) {
          const swipeRows = await session.query<{ message_id: string; swipe_id: string }>(
            'select message_id, swipe_id from chat_message_swipes where message_id = any($1) order by message_id, created_at',
            [messages.map((m) => m.message_id)],
          );
          for (const row of swipeRows) {
            const list = swipesByMessage.get(row.message_id) ?? [];
            list.push({ swipe_id: row.swipe_id });
            swipesByMessage.set(row.message_id, list);
          }
        }
        return {
          session: toSessionRow(sessions[0]),
          messages: messages.map((m) => {
            const swipeRows = swipesByMessage.get(m.message_id);
            return {
              messageId: m.message_id,
              role: m.role,
              content: m.content,
              createdAt: m.created_at,
              swipes: swipeRows
                ? { index: swipeRows.findIndex((s) => s.swipe_id === m.active_swipe_id), count: swipeRows.length }
                : undefined,
            };
          }),
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
        if (patch.canvasNoteId !== undefined) {
          params.push(patch.canvasNoteId);
          sets.push(`canvas_note_id = $${params.length}`);
        }
        if (patch.cleanupPresetId !== undefined) {
          params.push(patch.cleanupPresetId);
          sets.push(`cleanup_preset_id = $${params.length}`);
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
      if (messages.length === 0) return [];
      return db.withUserScope(userId, async (session) => {
        const inserted: { messageId: string; role: 'user' | 'assistant' }[] = [];
        for (const message of messages) {
          // clock_timestamp(), not the column's `default now()` — now() is frozen for the whole
          // transaction, so a multi-message insert (one user + one assistant turn) would give
          // every row the identical created_at and leave ordering to an arbitrary UUID tiebreak.
          // clock_timestamp() actually advances between statements, keeping messages in order.
          const [row] = await session.query<{ message_id: string }>(
            'insert into chat_messages (chat_id, user_id, role, content, created_at) values ($1, $2, $3, $4, clock_timestamp()) returning message_id',
            [chatId, userId, message.role, message.content],
          );
          inserted.push({ messageId: row!.message_id, role: message.role });
        }
        await session.query('update chat_sessions set updated_at = now() where chat_id = $1', [chatId]);
        return inserted;
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

    async recordSwipe(userId, chatId, messageId, newContent) {
      return db.withUserScope(userId, async (session) => {
        const rows = await session.query<{ role: 'user' | 'assistant'; content: string; created_at: string; active_swipe_id: string | null }>(
          'select role, content, created_at, active_swipe_id from chat_messages where message_id = $1 and chat_id = $2',
          [messageId, chatId],
        );
        const current = rows[0];
        if (!current) return undefined;

        // First-ever regeneration of this message: stash the original content as swipe #0 before
        // the new reply takes over, so 'prev' can always cycle back to what was there originally.
        let originalSwipeId = current.active_swipe_id;
        if (!originalSwipeId) {
          const [inserted] = await session.query<{ swipe_id: string }>(
            'insert into chat_message_swipes (message_id, content, created_at) values ($1, $2, clock_timestamp()) returning swipe_id',
            [messageId, current.content],
          );
          originalSwipeId = inserted!.swipe_id;
        }

        const [newSwipe] = await session.query<{ swipe_id: string }>(
          'insert into chat_message_swipes (message_id, content, created_at) values ($1, $2, clock_timestamp()) returning swipe_id',
          [messageId, newContent],
        );
        await session.query('update chat_messages set content = $1, active_swipe_id = $2 where message_id = $3', [
          newContent,
          newSwipe!.swipe_id,
          messageId,
        ]);
        await session.query('update chat_sessions set updated_at = now() where chat_id = $1', [chatId]);

        const swipeRows = await session.query<{ swipe_id: string }>(
          'select swipe_id from chat_message_swipes where message_id = $1 order by created_at',
          [messageId],
        );
        return {
          messageId,
          role: current.role,
          content: newContent,
          createdAt: current.created_at,
          swipes: { index: swipeRows.findIndex((s) => s.swipe_id === newSwipe!.swipe_id), count: swipeRows.length },
        };
      });
    },

    async cycleSwipe(userId, chatId, messageId, direction) {
      return db.withUserScope(userId, async (session) => {
        const rows = await session.query<{ role: 'user' | 'assistant'; created_at: string; active_swipe_id: string | null }>(
          'select role, created_at, active_swipe_id from chat_messages where message_id = $1 and chat_id = $2',
          [messageId, chatId],
        );
        const current = rows[0];
        if (!current) return { status: 'not_found' as const };

        const swipeRows = await session.query<{ swipe_id: string; content: string }>(
          'select swipe_id, content from chat_message_swipes where message_id = $1 order by created_at',
          [messageId],
        );
        // Invariant: a message has either zero swipe rows (never regenerated) or two-plus (the
        // original stashed alongside every regeneration since) — see recordSwipe above. Zero rows
        // means there's nothing stored to move to in either direction; 'next' from there is what
        // tells the caller to actually regenerate.
        if (swipeRows.length === 0) {
          return direction === 'next' ? { status: 'needs_regenerate' as const } : { status: 'no_earlier_swipe' as const };
        }

        const idx = swipeRows.findIndex((s) => s.swipe_id === current.active_swipe_id);
        const targetIdx = direction === 'prev' ? idx - 1 : idx + 1;
        if (targetIdx < 0) return { status: 'no_earlier_swipe' as const };
        if (targetIdx >= swipeRows.length) return { status: 'needs_regenerate' as const };

        const target = swipeRows[targetIdx]!;
        await session.query('update chat_messages set content = $1, active_swipe_id = $2 where message_id = $3', [
          target.content,
          target.swipe_id,
          messageId,
        ]);
        await session.query('update chat_sessions set updated_at = now() where chat_id = $1', [chatId]);

        return {
          status: 'switched' as const,
          message: {
            messageId,
            role: current.role,
            content: target.content,
            createdAt: current.created_at,
            swipes: { index: targetIdx, count: swipeRows.length },
          },
        };
      });
    },

    async forkChat(userId, chatId, forkFromMessageId, title) {
      return db.withUserScope(userId, async (session) => {
        const parentRows = await session.query<SessionDbRow>(
          `select ${SESSION_COLUMNS} from chat_sessions where chat_id = $1`,
          [chatId],
        );
        if (!parentRows[0]) return undefined;
        const parent = toSessionRow(parentRows[0]);

        const messages = await session.query<{ message_id: string; role: 'user' | 'assistant'; content: string; created_at: string }>(
          'select message_id, role, content, created_at from chat_messages where chat_id = $1 order by created_at, message_id',
          [chatId],
        );
        const forkIdx = messages.findIndex((m) => m.message_id === forkFromMessageId);
        if (forkIdx === -1) return undefined;
        const toCopy = messages.slice(0, forkIdx + 1);

        const newRows = await session.query<SessionDbRow>(
          `insert into chat_sessions
             (user_id, title, params, tool_names, parent_chat_id, fork_message_id, kind, character_id, prompt_stack_preset_id, cleanup_preset_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           returning ${SESSION_COLUMNS}`,
          [
            userId,
            title ?? `Fork of ${parent.title}`,
            JSON.stringify(parent.params),
            parent.toolNames,
            chatId,
            forkFromMessageId,
            parent.kind,
            parent.characterId,
            parent.promptStackPresetId,
            parent.cleanupPresetId,
          ],
        );
        const newChatId = newRows[0]!.chat_id;

        // Fresh message_ids under the new chat_id (message_id is a global PK — the parent's own
        // rows can't be reused) — original created_at is preserved for provenance/ordering.
        const idMap = new Map<string, string>();
        for (const m of toCopy) {
          const [inserted] = await session.query<{ message_id: string }>(
            `insert into chat_messages (chat_id, user_id, role, content, created_at) values ($1, $2, $3, $4, $5)
             returning message_id`,
            [newChatId, userId, m.role, m.content, m.created_at],
          );
          idMap.set(m.message_id, inserted!.message_id);
        }

        // Only sync points whose restore-point message was actually copied come along — this is
        // what keeps the new branch from inheriting a "key idea" digest describing something that
        // happened after the point it branched from.
        const copiedIds = new Set(toCopy.map((m) => m.message_id));
        const syncPoints = await session.query<{ sync_id: string; ordinal: number; last_message_id: string }>(
          'select sync_id, ordinal, last_message_id from chat_sync_points where chat_id = $1 order by ordinal',
          [chatId],
        );
        const eligible = syncPoints.filter((sp) => copiedIds.has(sp.last_message_id));

        const syncIdMap = new Map<string, string>();
        for (const sp of eligible) {
          const [inserted] = await session.query<{ sync_id: string }>(
            `insert into chat_sync_points (chat_id, user_id, ordinal, last_message_id) values ($1, $2, $3, $4)
             returning sync_id`,
            [newChatId, userId, sp.ordinal, idMap.get(sp.last_message_id)],
          );
          syncIdMap.set(sp.sync_id, inserted!.sync_id);
        }

        if (eligible.length > 0) {
          const oldSyncIds = eligible.map((sp) => sp.sync_id);
          const chunks = await session.query<{
            sync_id: string;
            ordinal: number;
            content: string;
            summary: string;
            vector_embed: string | null;
          }>(
            'select sync_id, ordinal, content, summary, vector_embed::text as vector_embed from chat_chunks where sync_id = any($1)',
            [oldSyncIds],
          );
          for (const c of chunks) {
            await session.query(
              `insert into chat_chunks (chat_id, sync_id, user_id, ordinal, content, summary, vector_embed)
               values ($1, $2, $3, $4, $5, $6, $7)`,
              [newChatId, syncIdMap.get(c.sync_id), userId, c.ordinal, c.content, c.summary, c.vector_embed],
            );
          }

          const entries = await session.query<{ sync_id: string; topic_key: string; content: string }>(
            'select sync_id, topic_key, content from chat_memory_entries where chat_id = $1 and sync_id = any($2)',
            [chatId, oldSyncIds],
          );
          for (const e of entries) {
            await session.query(
              `insert into chat_memory_entries (chat_id, sync_id, user_id, topic_key, content) values ($1, $2, $3, $4, $5)`,
              [newChatId, syncIdMap.get(e.sync_id), userId, e.topic_key, e.content],
            );
          }
        }

        // canon_facts: full-content duplication, not fork-point-filtered like sync_points/chunks/
        // entries above — the user's explicit call ("every fork gets its own chat id and full
        // content dup"). Every parent-chat canon fact comes along regardless of when it was
        // proposed relative to forkFromMessageId, preserving status/proposed_at/approved_at exactly
        // (not reset to a fresh proposal) — the fork inherits the parent's canon as of now, not as
        // of the fork point. anchor_message_id remaps through the same idMap used for messages
        // above where the anchor was among the copied messages; otherwise it's nulled (the anchored
        // turn itself didn't come along, but the fact still belongs to this chat per
        // db/migrations/0058_canon_facts_chat_scoped.sql's chat_id-mandatory rule).
        const canonFacts = await session.query<{
          scene_id: string | null;
          category: string;
          arc_tag: string | null;
          summary: string;
          detail: string;
          vector_embed: string | null;
          status: string;
          linked_character_ids: string[];
          linked_location_id: string | null;
          anchor_message_id: string | null;
          proposed_at: string;
          approved_at: string | null;
        }>(
          `select scene_id, category, arc_tag, summary, detail, vector_embed::text as vector_embed,
                  status, linked_character_ids, linked_location_id, anchor_message_id, proposed_at, approved_at
           from canon_facts where chat_id = $1`,
          [chatId],
        );
        for (const f of canonFacts) {
          await session.query(
            `insert into canon_facts
               (user_id, scene_id, category, arc_tag, summary, detail, vector_embed, status,
                linked_character_ids, linked_location_id, chat_id, anchor_message_id, proposed_at, approved_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
              userId,
              f.scene_id,
              f.category,
              f.arc_tag,
              f.summary,
              f.detail,
              f.vector_embed,
              f.status,
              f.linked_character_ids,
              f.linked_location_id,
              newChatId,
              f.anchor_message_id ? (idMap.get(f.anchor_message_id) ?? null) : null,
              f.proposed_at,
              f.approved_at,
            ],
          );
        }

        return toSessionRow(newRows[0]!);
      });
    },

    async archiveChat(userId, chatId) {
      return db.withUserScope(userId, async (session) => {
        const rows = await session.query<SessionDbRow>(
          `update chat_sessions set archived_at = now(), updated_at = now() where chat_id = $1
           returning ${SESSION_COLUMNS}`,
          [chatId],
        );
        return rows[0] ? toSessionRow(rows[0]) : undefined;
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
