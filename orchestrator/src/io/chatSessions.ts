/**
 * @file orchestrator/src/io/chatSessions.ts
 * @stamp 2026-08-07
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
 * the admin-managed connections (io/llmConnections.ts, db/migrations/0062_llm_connections.sql) to
 * run this chat's turns through instead of the household's active one (that row's own is_active
 * flag) — unlike the household-wide active connection, picking a different one per chat needs no
 * restart, since httpServer.ts builds a throwaway provider for it the same way the Connections
 * tab's own model-catalog preview does (server/adminServer.ts's listModelsForConnection).
 * toolNames: null = all
 * registered tools (pre-existing behavior), [] = none, else an allow-list applied via
 * toolRegistry.ts's filterToolRegistry. canvasNoteId (Canvas): which note this chat's document
 * panel is focused on, if any — written by httpServer.ts from runTurn's focusedNoteId, or cleared
 * by the frontend's own close action; this store just persists whatever it's given.
 *
 * An 'rp' chat's default tool_names is DEFAULT_RP_TOOLS (the recall pair, see below), not []
 * and not null: the user's read-path decision for the RP lane (docs/chat-memory.md §2, and
 * io/chatMemory/recallForPrompt.ts's own preamble) is CNZ-shaped — silent per-turn auto-recall
 * *plus* the still-enabled recall tools, so the model can dig deeper mid-turn than the
 * auto-injected block reaches. The roleplay/household isolation principle is preserved by the
 * allow-list itself: RP chats only ever see the recall tools unless explicitly widened, never
 * the household-assistant toolset, by construction.
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
 *     defaults to 'chat', and an 'rp' chat defaults toolNames to DEFAULT_RP_TOOLS unless overridden
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
 *     chat at that message, or undefined if forkFromMessageId doesn't belong to it. Alternate
 *     swipe history is deliberately not carried into the fork — same accepted-imprecision trade
 *     this file's preamble already documents for chat_memory_entries; only the active content
 *     comes along (each copied assistant message does get its own canonical swipe row, mirroring
 *     the parent's active swipe, so the branch's transient location/character records can be
 *     resurrected against it — docs/vistalyze_integration/segway.md §2.7).
 *   .getChatSyncStatus(userId, chatId, dueAfterMessages) — this chat's slice of the rolling
 *     sync loop's status record (chat_memory_sync_status, bi_principles.md §11): last
 *     attempt/status/error, last success, chunks/entries added, canon counts, and
 *     unsynced-vs-due message counts. Undefined only if the chat doesn't exist.
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
   *  route) and start with DEFAULT_RP_TOOLS (the recall pair) rather than null, keeping roleplay
   *  isolated from household assistant behavior by construction rather than by a checkbox someone
   *  has to remember to set — the allow-list itself is the isolation. */
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
   *  only via updateChat's patch, same as any other session field).
   *  @deprecated retirement in progress (plan v2): the preset-based inline cleanup pass is being
   *  replaced by the async heuristic subloop (migration 0072). Nothing new writes this column;
   *  the field stays until the inline pass's call sites are removed, then it is dropped. */
  cleanupPresetId: string | null;
  /** When this chat opted into the async heuristic cleanup subloop (migration 0072, plan v2) —
   *  the RP-only background pass that strips antislop and repairs the header/footer regex shapes
   *  after a reply lands. A timestamp, not a bool: the subloop only processes messages created
   *  after this stamp, so enabling cleanup never retro-actively re-processes an old history.
   *  Null = cleanup off. Set by CharactersView's startRp for every new RP chat, and by the
   *  ChatView Chat Settings toggle. */
  cleanupEnabledAt: string | null;
  /** Cache pointer to the chat's current scene (db/migrations/0067, docs/vistalyze_integration/
   *  segway.md §2.2) — kept stamped by the post-cleanup scraper (orchestrator/
   *  locationAndPresenceScraper.ts). A *cache*, not the source of truth: the real scene identity
   *  is the (chat_id, active_location_id) pair on scenes itself. Null until the first turn whose
   *  header block resolves a scene. */
  sceneId: string | null;
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
  /** Display-only macro-resolved copy of `content` (docs/prompt-macros.md's Stage 1), attached by
   *  server/httpServer.ts's GET /v1/chats/:id (and the swipe routes) for 'rp' chats whose stored
   *  text contains `{{...}}` tokens — chiefly a character's seeded greeting, which
   *  apply_character_to_chat/apply_prompt_stack_to_chat insert verbatim. The canonical `content`
   *  stays verbatim: this is derived working state (bi_principles.md §1), never persisted, and
   *  clients must keep re-sending `content`, not this, so the per-turn resolution pass keeps
   *  re-resolving against the live persona (a persona edit shows up on the very next read). */
  resolvedContent?: string;
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

/** One chat's view of the rolling sync loop (orchestrator/chatMemorySync.ts) — the per-chat slice
 *  of server/adminServer.ts's getChatMemorySyncStatus, read under the chat owner's own RLS scope,
 *  so an RP chat's header menu can show it without an admin key (the cross-user Review Panel
 *  table stays admin-gated; a single user's own chat row is no more sensitive than the chat
 *  itself). `lastStatus` is null until the chat has had its first sync attempt (a fresh chat has
 *  no chat_memory_sync_status row yet). `unsyncedMessages`/`dueAfterMessages` mirror
 *  findDueChats' own arithmetic — messages past the last sync point's anchor message, vs. the
 *  liveWindow+syncEvery message threshold — so the UI can say whether the next tick will actually
 *  do something. */
export interface ChatSyncStatus {
  lastAttemptAt: string | null;
  lastStatus: 'ok' | 'skipped' | 'error' | null;
  lastStep: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastChunksAdded: number | null;
  lastEntriesUpdated: number | null;
  consecutiveErrors: number;
  canonProposedCount: number;
  canonApprovedCount: number;
  canonLastProposedAt: string | null;
  unsyncedMessages: number;
  dueAfterMessages: number;
}

export interface FolderRow {
  folderId: string;
  name: string;
  parentId: string | null;
}

/** One node in a fork family tree — getLineage's return shape, the Branch Map panel's data
 *  source. Deliberately narrower than ChatSessionRow (no params/toolNames/etc.) since the panel
 *  only ever renders title/status/relationships, never a chat's actual settings. */
export interface ChatLineageNode {
  chatId: string;
  title: string;
  folderId: string | null;
  parentChatId: string | null;
  forkMessageId: string | null;
  archivedAt: string | null;
  kind: 'chat' | 'rp';
  createdAt: string;
  updatedAt: string;
}

/** An 'rp' chat's default tool_names (see this file's preamble and docs/chat-memory.md): the two
 *  recall tools the RP-lane read path is built on — recall_chat_history (full archived turns,
 *  plugins/chat-memory) and recall_canon_facts (approved canon facts, plugins/canonize). The
 *  CNZ-style auto-recall (io/chatMemory/recallForPrompt.ts) injects both silently every turn;
 *  keeping the tools themselves enabled lets the model reach deeper mid-turn than the
 *  auto-injected block covers. Names are matched against the registered tool registry at
 *  turn time (httpServer.ts's filterToolRegistry), so a plugin not being loaded simply yields
 *  an empty view, never an error. */
export const DEFAULT_RP_TOOLS: string[] = ['recall_chat_history', 'recall_canon_facts'];

export interface ChatSessionStore {
  listChats(userId: string, opts?: { search?: string; folderId?: string; kind?: 'chat' | 'rp' }): Promise<ChatSummary[]>;
  /** kind defaults to 'chat'. When init.kind === 'rp' and toolNames isn't explicitly given, tool_names
   *  defaults to DEFAULT_RP_TOOLS (the RP-lane recall pair) rather than null (all tools) — see this
   *  file's own preamble. */
  createChat(
    userId: string,
    init?: { title?: string; folderId?: string; kind?: 'chat' | 'rp'; toolNames?: string[] | null },
  ): Promise<ChatSessionRow>;
  getChat(userId: string, chatId: string): Promise<ChatDetail | undefined>;
  /** This chat's slice of the rolling sync loop's status record — same read surface as the admin
   *  Review Panel, but user-scoped and single-chat, so the RP chat's header menu can show it
   *  without an admin key (bi_principles.md §11's read surface, per-chat). dueAfterMessages is the
   *  liveWindow+syncEvery message threshold the loop's own due-check uses — computed by the caller
   *  from DB-backed settings, since this store reads no settings. Undefined only if chatId doesn't
   *  exist. */
  getChatSyncStatus(userId: string, chatId: string, dueAfterMessages: number): Promise<ChatSyncStatus | undefined>;
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
      /** Toggle the async heuristic cleanup subloop (migration 0072). The value is the enable
       *  stamp the loop filters messages against (see ChatSessionRow.cleanupEnabledAt); null/''
       *  turns cleanup off. Sending a fresh timestamp re-stamps (restarts the window). */
      cleanupEnabledAt?: string | null;
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
  /** The cleanup subloop's writeback (orchestrator/cleanupLoop.ts): recordSwipe with a
   *  mid-flight guard. Reads the message's current content in the SAME transaction as the
   *  writeback, and returns undefined (writing nothing) when it no longer equals expectedContent
   *  — i.e. the user regenerated or swiped while the repair LLM was running, and this writeback
   *  must not clobber it (the new content carries no job, so the next tick picks it up instead).
   *  The returned newSwipeId is the swipe that now holds newContent — the exact (message, swipe)
   *  pair the caller should key its cleanup_jobs row to, so dedup covers the content this call
   *  produced even if the user cycles to a different swipe immediately after (that alternate
   *  swipe then legitimately starts its own job, per migration 0072's own comment). Undefined
   *  when the message is gone or its content changed mid-flight. */
  recordSwipeIfContent(
    userId: string,
    chatId: string,
    messageId: string,
    expectedContent: string | undefined,
    newContent: string,
  ): Promise<{ message: StoredChatMessage; newSwipeId: string } | undefined>;
  /** Cycles messageId's active content to an existing sibling swipe — a pure content swap, no LLM
   *  call. See CycleSwipeResult's own doc for what each outcome means. */
  cycleSwipe(userId: string, chatId: string, messageId: string, direction: 'prev' | 'next'): Promise<CycleSwipeResult>;
  /** Returns the message's active swipe id, creating the message's own swipe row (containing its
   *  current content) and making it active when the message has none yet — the invariant the
   *  post-cleanup scraper (docs/vistalyze_integration/segway.md §4) anchors its transient
   *  location/character rows to: every persisted assistant message it processes must have an
   *  attributable active swipe for the sync tick to promote/demote against (§2.5). recordSwipe's
   *  regenerations always have one already, so this is a no-op there. Undefined when messageId
   *  isn't in this chat. */
  ensureActiveSwipe(userId: string, chatId: string, messageId: string): Promise<string | undefined>;
  /** Branches a new chat from this one at forkFromMessageId (inclusive) — see this file's own
   *  preamble for exactly what does and doesn't come along. Undefined if forkFromMessageId isn't a
   *  message in this chat. Transient/inactive locations and characters anchored to the fork
   *  point's active swipe are resurrected onto the branch as fresh transient rows (segway.md §2.7). */
  forkChat(userId: string, chatId: string, forkFromMessageId: string, title?: string): Promise<ChatSessionRow | undefined>;
  /** The whole fork family a chat belongs to — every chat reachable by walking parent_chat_id up
   *  to the root and back down through every descendant, root first. A chat that was never forked
   *  and has no forks of its own still returns its single-node family (nothing to distinguish that
   *  from "loading" otherwise). Undefined only if chatId itself doesn't exist. */
  getLineage(userId: string, chatId: string): Promise<ChatLineageNode[] | undefined>;
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
  cleanup_enabled_at: string | null;
  scene_id: string | null;
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
    cleanupEnabledAt: row.cleanup_enabled_at,
    sceneId: row.scene_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SESSION_COLUMNS =
  'chat_id, title, folder_id, params, tool_names, canvas_note_id, parent_chat_id, fork_message_id, archived_at, kind, character_id, prompt_stack_preset_id, cleanup_preset_id, cleanup_enabled_at, scene_id, created_at, updated_at';

interface LineageDbRow {
  chat_id: string;
  title: string;
  folder_id: string | null;
  parent_chat_id: string | null;
  fork_message_id: string | null;
  archived_at: string | null;
  kind: 'chat' | 'rp';
  created_at: string;
  updated_at: string;
}

const LINEAGE_COLUMNS = 'chat_id, title, folder_id, parent_chat_id, fork_message_id, archived_at, kind, created_at, updated_at';

function toLineageNode(row: LineageDbRow): ChatLineageNode {
  return {
    chatId: row.chat_id,
    title: row.title,
    folderId: row.folder_id,
    parentChatId: row.parent_chat_id,
    forkMessageId: row.fork_message_id,
    archivedAt: row.archived_at,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
        // RP defaults to the recall-tool allow-list (DEFAULT_RP_TOOLS), not [] and not null —
        // enforced here so every RP-creating call site gets the guarantee for free, rather than
        // each one having to remember to pass it (see this file's own preamble).
        const toolNames = init.toolNames !== undefined ? init.toolNames : kind === 'rp' ? DEFAULT_RP_TOOLS : null;
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

    async getChatSyncStatus(userId, chatId, dueAfterMessages) {
      return db.withUserScope(userId, async (session) => {
        const exists = await session.query<{ chat_id: string }>('select chat_id from chat_sessions where chat_id = $1', [chatId]);
        if (!exists[0]) return undefined;

        // The chat's chat_memory_sync_status row (bi_principles.md §11) plus its canon-fact counts
        // — same columns/aggregates as server/adminServer.ts's cross-user getChatMemorySyncStatus,
        // narrowed to this one chat and scoped by the owner's RLS.
        const [status] = await session.query<{
          last_attempt_at: string | null;
          last_status: 'ok' | 'skipped' | 'error' | null;
          last_step: string | null;
          last_error: string | null;
          last_success_at: string | null;
          last_chunks_added: number | null;
          last_entries_updated: number | null;
          consecutive_errors: number;
          canon_proposed_count: string;
          canon_approved_count: string;
          canon_last_proposed_at: string | null;
        }>(
          `select s.last_attempt_at, s.last_status, s.last_step, s.last_error, s.last_success_at,
                  s.last_chunks_added, s.last_entries_updated, s.consecutive_errors,
                  coalesce(cf.proposed_count, 0)::text as canon_proposed_count,
                  coalesce(cf.approved_count, 0)::text as canon_approved_count,
                  cf.last_proposed_at as canon_last_proposed_at
           from chat_memory_sync_status s
           left join (
             select chat_id,
                    count(*) filter (where status = 'proposed') as proposed_count,
                    count(*) filter (where status = 'approved') as approved_count,
                    max(proposed_at) as last_proposed_at
             from canon_facts
             where chat_id = $1
             group by chat_id
           ) cf on cf.chat_id = s.chat_id
           where s.chat_id = $1`,
          [chatId],
        );

        // Mirrors findDueChats' candidate filter (orchestrator/chatMemorySync.ts): messages past
        // the last sync point's anchor message — or all of them if never synced. count(*) is
        // bigint (string via pg), cast to text like the canon counts above.
        const [counts] = await session.query<{ unsynced: string }>(
          `select count(*)::text as unsynced
           from chat_messages m
           left join chat_sync_points sp on sp.chat_id = m.chat_id
             and sp.ordinal = (select max(ordinal) from chat_sync_points where chat_id = m.chat_id)
           left join chat_messages anchor on anchor.message_id = sp.last_message_id
           where m.chat_id = $1
             and (anchor.created_at is null or m.created_at > anchor.created_at)`,
          [chatId],
        );

        return {
          lastAttemptAt: status?.last_attempt_at ?? null,
          lastStatus: status?.last_status ?? null,
          lastStep: status?.last_step ?? null,
          lastError: status?.last_error ?? null,
          lastSuccessAt: status?.last_success_at ?? null,
          lastChunksAdded: status?.last_chunks_added ?? null,
          lastEntriesUpdated: status?.last_entries_updated ?? null,
          consecutiveErrors: status?.consecutive_errors ?? 0,
          canonProposedCount: Number(status?.canon_proposed_count ?? 0),
          canonApprovedCount: Number(status?.canon_approved_count ?? 0),
          canonLastProposedAt: status?.canon_last_proposed_at ?? null,
          unsyncedMessages: Number(counts?.unsynced ?? 0),
          dueAfterMessages,
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
        if (patch.cleanupEnabledAt !== undefined) {
          params.push(patch.cleanupEnabledAt);
          sets.push(`cleanup_enabled_at = $${params.length}`);
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
      const result = await this.recordSwipeIfContent(userId, chatId, messageId, undefined, newContent);
      return result?.message;
    },

    async recordSwipeIfContent(userId, chatId, messageId, expectedContent, newContent) {
      return db.withUserScope(userId, async (session) => {
        const rows = await session.query<{ role: 'user' | 'assistant'; content: string; created_at: string; active_swipe_id: string | null }>(
          // FOR UPDATE: the guard + writeback must be atomic even under READ COMMITTED — without
          // the row lock, a user regeneration committing between this SELECT and the UPDATE below
          // still gets clobbered (this UPDATE would land second and silently replace the fresh
          // reply). Same claim-atomicity pattern as agentRoutineDispatch.ts's job claim.
          'select role, content, created_at, active_swipe_id from chat_messages where message_id = $1 and chat_id = $2 for update',
          [messageId, chatId],
        );
        const current = rows[0];
        if (!current) return undefined;
        // Mid-flight guard: the caller (cleanupLoop.ts's processDueMessage) planned against
        // expectedContent; if the message has since been regenerated or swiped, this writeback
        // would clobber the user's new content — refuse instead, same transaction, so nothing
        // was partially written. The new content has no cleanup_jobs row, so the next tick picks
        // it up on its own.
        if (expectedContent !== undefined && current.content !== expectedContent) return undefined;

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
          newSwipeId: newSwipe!.swipe_id,
          message: {
            messageId,
            role: current.role,
            content: newContent,
            createdAt: current.created_at,
            swipes: { index: swipeRows.findIndex((s) => s.swipe_id === newSwipe!.swipe_id), count: swipeRows.length },
          },
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

    async ensureActiveSwipe(userId, chatId, messageId) {
      return db.withUserScope(userId, async (session) => {
        const rows = await session.query<{ content: string; active_swipe_id: string | null }>(
          'select content, active_swipe_id from chat_messages where message_id = $1 and chat_id = $2',
          [messageId, chatId],
        );
        const current = rows[0];
        if (!current) return undefined;
        if (current.active_swipe_id) return current.active_swipe_id;
        // A never-regenerated assistant message has no swipe row yet — create its own canonical
        // variant and make it active, so the scraper's transient rows can anchor to it. The
        // swipes metadata stays `{index: 0, count: 1}`, which cycleSwipe's bounds checks and the
        // frontend's count > 1 gating both treat exactly like the old zero-row state.
        const [inserted] = await session.query<{ swipe_id: string }>(
          'insert into chat_message_swipes (message_id, content, created_at) values ($1, $2, clock_timestamp()) returning swipe_id',
          [messageId, current.content],
        );
        await session.query('update chat_messages set active_swipe_id = $1 where message_id = $2', [
          inserted!.swipe_id,
          messageId,
        ]);
        return inserted!.swipe_id;
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
        const forkIdx = messages.findIndex((m) => m.message_id === forkFromMessageId);
        if (forkIdx === -1) return undefined;
        const toCopy = messages.slice(0, forkIdx + 1);

        const newRows = await session.query<SessionDbRow>(
          `insert into chat_sessions
             (user_id, title, folder_id, params, tool_names, parent_chat_id, fork_message_id, kind, character_id, prompt_stack_preset_id, cleanup_preset_id, cleanup_enabled_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           returning ${SESSION_COLUMNS}`,
          [
            userId,
            title ?? `Fork of ${parent.title}`,
            parent.folderId,
            JSON.stringify(parent.params),
            parent.toolNames,
            chatId,
            forkFromMessageId,
            parent.kind,
            parent.characterId,
            parent.promptStackPresetId,
            parent.cleanupPresetId,
            parent.cleanupEnabledAt,
          ],
        );
        const newChatId = newRows[0]!.chat_id;

        // Fresh message_ids under the new chat_id (message_id is a global PK — the parent's own
        // rows can't be reused) — original created_at is preserved for provenance/ordering.
        // Each copied assistant message also gets its own swipe row, mirroring the parent's
        // active swipe one-for-one (swipe_id is a global PK too): alternates still don't come
        // along (same accepted-imprecision trade this file's preamble documents), but the
        // branch's own messages need their own anchorable active swipes — the transient
        // location/character rows the scraper anchors to one of the parent's swipes are
        // resurrected against these (§2.7 below).
        const idMap = new Map<string, string>();
        const swipeIdMap = new Map<string, string>();
        for (const m of toCopy) {
          const [inserted] = await session.query<{ message_id: string }>(
            `insert into chat_messages (chat_id, user_id, role, content, created_at) values ($1, $2, $3, $4, $5)
             returning message_id`,
            [newChatId, userId, m.role, m.content, m.created_at],
          );
          idMap.set(m.message_id, inserted!.message_id);
          if (m.role === 'assistant' && m.active_swipe_id) {
            const [swipe] = await session.query<{ swipe_id: string }>(
              'insert into chat_message_swipes (message_id, content, created_at) values ($1, $2, $3) returning swipe_id',
              [inserted!.message_id, m.content, m.created_at],
            );
            await session.query('update chat_messages set active_swipe_id = $1 where message_id = $2', [
              swipe!.swipe_id,
              inserted!.message_id,
            ]);
            swipeIdMap.set(m.active_swipe_id, swipe!.swipe_id);
          }
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

        // docs/vistalyze_integration/segway.md §2.7 / location_status.md §3 Step 3: resurrect the
        // fork point's transient-or-inactive locations/characters into the new branch. Only rows
        // anchored to the fork point's *active* swipe come along (that's the variant the fork
        // actually copies — its alternate swipes stay behind with the parent), cloned as fresh
        // transient rows anchored to the branch's own corresponding swipe (created in the message
        // copy loop above), so the branch's own sync ticks promote/demote them independently from
        // that point on. Never cloned: promoted/permanent rows (they're world canon, not branch
        // state) and rows anchored to other messages' swipes.
        const [forkMessage] = await session.query<{ active_swipe_id: string | null }>(
          'select active_swipe_id from chat_messages where message_id = $1 and chat_id = $2',
          [forkFromMessageId, chatId],
        );
        const forkSwipeId = forkMessage?.active_swipe_id;
        const branchForkSwipeId = forkSwipeId ? swipeIdMap.get(forkSwipeId) : undefined;
        if (branchForkSwipeId) {
          const resurrectionLocations = await session.query<{
            name: string;
            visual_description: string;
            environment: string;
            seed: number | null;
            image_url: string | null;
            image_generated_at: string | null;
            image_rendered_input: string | null;
            image_render_hash: string | null;
          }>(
            `select name, visual_description, environment::text as environment, seed, image_url, image_generated_at, image_rendered_input::text as image_rendered_input, image_render_hash from locations
             where user_id = $1 and anchor_swipe_id = $2 and status in ('transient', 'inactive')`,
            [userId, forkSwipeId],
          );
          for (const loc of resurrectionLocations) {
            // docs/vistalyze_integration/endpoint.md §6.2: carry seed/image_url/image_generated_at
            // forward too — without them every fork forces a fresh render for a resurrected
            // location even when nothing about it visually changed, silently defeating §1.3's
            // cache-first commitment on the one path that most needs it (forking is exactly when
            // a stale/expensive re-render is most wasteful). The image_rendered_input snapshot
            // and image_render_hash must come along as well: cache validation (endpoint.md
            // §5.1.2) compares the render hash (migration 0076) first, so a clone without it
            // would never hit the cache even though its inputs are byte-identical to the
            // parent's. Character resurrection is unaffected — characters carry no visual fields.
            await session.query(
              `insert into locations (user_id, name, visual_description, environment, seed, image_url, image_generated_at, image_rendered_input, image_render_hash, status, anchor_chat_id, anchor_swipe_id)
               values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9, 'transient', $10, $11)`,
              [userId, loc.name, loc.visual_description, loc.environment, loc.seed, loc.image_url, loc.image_generated_at, loc.image_rendered_input, loc.image_render_hash, newChatId, branchForkSwipeId],
            );
          }
          const resurrectionCharacters = await session.query<{ name: string }>(
            `select name from characters
             where user_id = $1 and anchor_swipe_id = $2 and status in ('transient', 'inactive')`,
            [userId, forkSwipeId],
          );
          for (const c of resurrectionCharacters) {
            await session.query(
              `insert into characters (user_id, name, status, anchor_chat_id, anchor_swipe_id)
               values ($1, $2, 'transient', $3, $4)`,
              [userId, c.name, newChatId, branchForkSwipeId],
            );
          }
        }

        return toSessionRow(newRows[0]!);
      });
    },

    async getLineage(userId, chatId) {
      return db.withUserScope(userId, async (session) => {
        // Walk parent_chat_id up from chatId; the deepest row reached is the family's root. A
        // depth column (rather than relying on result order) makes "furthest ancestor" an explicit
        // pick instead of an assumption about recursive CTE row ordering.
        const rootRows = await session.query<{ chat_id: string }>(
          `with recursive up as (
             select chat_id, parent_chat_id, 0 as depth from chat_sessions where chat_id = $1
             union all
             select cs.chat_id, cs.parent_chat_id, up.depth + 1
             from chat_sessions cs join up on cs.chat_id = up.parent_chat_id
           )
           select chat_id from up order by depth desc limit 1`,
          [chatId],
        );
        const rootId = rootRows[0]?.chat_id;
        if (!rootId) return undefined;

        const rows = await session.query<LineageDbRow>(
          `with recursive down as (
             select ${LINEAGE_COLUMNS} from chat_sessions where chat_id = $1
             union all
             select cs.chat_id, cs.title, cs.folder_id, cs.parent_chat_id, cs.fork_message_id, cs.archived_at, cs.kind, cs.created_at, cs.updated_at
             from chat_sessions cs join down d on cs.parent_chat_id = d.chat_id
           )
           select * from down order by created_at`,
          [rootId],
        );
        return rows.map(toLineageNode);
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
