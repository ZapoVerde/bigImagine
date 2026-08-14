/**
 * @file orchestrator/src/io/chatSessions.ts
 * @stamp 2026-08-10
 * @architectural-role IO Wrapper — persisted chat sessions, messages, and folders
 * @description
 * The Postgres-backed store behind the frontend Chat tab's history sidebar
 * (db/migrations/0009_chat_sessions.sql). Normalized rows from day one — deliberately NOT the
 * one-JSON-blob-per-chat shape the Open WebUI reference uses (that project is itself mid-migration
 * away from it; we skip straight to the destination). Every query runs inside
 * db.withUserScope(userId, ...) so RLS scopes everything — a chat_id belonging to another user is
 * simply invisible, not "forbidden."
 *
 * Reasoning blocks (docs/plans/reasoning-blocks-plan.md) persist in their own `reasoning` column
 * (migration 0095), never spliced into content, so the prompt stack's recent_history — built from
 * content only — structurally never sees them. The row's reasoning mirrors the active swipe's:
 * appendMessages/recordSwipe/recordSwipeIfContent take an optional reasoning (undefined → NULL),
 * cycleSwipe/ensureActiveSwipe/forkChat carry it alongside content everywhere content goes, and
 * editMessageContent clears it (a user-typed edit has no reasoning behind it). Each swipe stores
 * its own reasoning, so cycling shows that variant's thought (or none) — the plan's swipe edge
 * case. Because the column is separate, "the LLM's thinking is never re-sent" is free: nothing
 * in the prompt-assembly path reads it.
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
 * An 'rp' chat's default tool_names is DEFAULT_RP_TOOLS = [] (no tools at all, 2026-08-10
 * user direction: the RP lane just executes its prompt stack — "no funny business"), not the
 * old recall pair and not null. The roleplay/household isolation principle is preserved by the
 * empty list itself: RP turns never carry a tool manifest, so the model can't call anything
 * (recall_chat_history/recall_canon_facts included). Auto-recall is unaffected — it's server-
 * side injection into the stack (io/chatMemory/recallForPrompt.ts), never a model tool call.
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
 *     defaults to 'chat', and an 'rp' chat defaults toolNames to DEFAULT_RP_TOOLS ([]) unless
 *     overridden
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
 *     resurrected against it — docs/plans/vistalyze_integration/segway.md §2.7).
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
   *  route) and start with DEFAULT_RP_TOOLS ([]) rather than null, keeping roleplay
   *  isolated from household assistant behavior by construction rather than by a checkbox someone
   *  has to remember to set — the empty list itself is the isolation (no tool calls at all). */
  kind: 'chat' | 'rp';
  /** Which character this chat is playing, if any — set by applyCharacterToChatTool.ts. Lets a
   *  later apply_prompt_stack_to_chat pull that character's fields without the caller re-passing
   *  characterId. Null for a chat never applied to a character. */
  characterId: string | null;
  /** The last context_stack_presets row applied to this chat via apply_prompt_stack_to_chat, so
   *  the settings panel can show the current selection on reload. Null until first applied. */
  promptStackPresetId: string | null;
  /** Which context_stack_presets row (if any) server/httpServer.ts's post-runTurn cleanup pass
   *  runs for this chat (docs/plans/turn-loop-plan.md §4, migration 0057) — resolved via {{message}}
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
  /** Cache pointer to the chat's current scene (db/migrations/0067, docs/plans/vistalyze_integration/
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
  /** Display-only macro-resolved copy of `content` (docs/plans/prompt-macros.md's Stage 1), attached by
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
  /** The reasoning block (docs/plans/reasoning-blocks-plan.md): the trimmed inner text of the
   *  `<think>…</think>`-style span the LLM emitted before its in-character reply — stored in its
   *  own column, never spliced into `content`, so the prompt stack's `recent_history` (built from
   *  `content`) structurally never sees it. Present only when this message's active content has a
   *  reasoning span (the active swipe's own reasoning, mirrored onto the row exactly like
   *  content is); absent (never empty-string) otherwise, matching the `resolvedContent?`/
   *  `swipes?` optional-field convention. A user-typed edit clears it (the text is the user's,
   *  not the LLM's). */
  reasoning?: string;
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
/** One sync point's summary row in the sync-status payload — enough to render the "click a sync"
 *  list without shipping the heavy detail (full bridge transcript, per-sync entries/facts) on the
 *  30s poll. The detail is fetched on demand via getChatSyncInspection when a row is expanded. */
export interface ChatSyncSummary {
  syncId: string;
  ordinal: number;
  createdAt: string;
  entryCount: number;
  factCount: number;
}

/** One sync point's inspection record (db/migrations/0079_sync_inspection.sql) — what that pass
 *  actually produced. `entries` are the chat_memory_entries rows whose sync_id points at this
 *  sync (the upsert re-points sync_id on every update, so this is exactly "created or changed in
 *  that sync"); `canonFacts` are the plot/lorebook/people proposals this sync wrote; `bridgePrompt`
 *  is the fully-rendered prompt the bridge sent the model (null for non-rp chats and pre-0079
 *  syncs). */
export interface ChatSyncInspection {
  syncId: string;
  ordinal: number;
  createdAt: string;
  lastMessageId: string;
  bridgePrompt: string | null;
  entries: { topicKey: string; content: string; updatedAt: string }[];
  canonFacts: {
    factId: string;
    category: string;
    arcTag: string | null;
    entityKey: string | null;
    summary: string;
    detail: string;
    status: string;
  }[];
}

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
  /** Every sync point this chat has produced, newest first — the panel's "click a sync and play
   *  it back" list. Summary-only; the per-sync detail (entries, canon facts, bridge prompt) is
   *  fetched on demand. */
  syncs: ChatSyncSummary[];
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
 *  an empty view, never an error. Empty since 2026-08-10 (user direction): the RP lane runs
 *  with no tool calls at all — the model just executes its prompt stack; httpServer.ts
 *  enforces the same on every rp-kind turn regardless of what a row stores. */
export const DEFAULT_RP_TOOLS: string[] = [];

export interface ChatSessionStore {
  listChats(userId: string, opts?: { search?: string; folderId?: string; kind?: 'chat' | 'rp' }): Promise<ChatSummary[]>;
  /** kind defaults to 'chat'. When init.kind === 'rp' and toolNames isn't explicitly given, tool_names
   *  defaults to DEFAULT_RP_TOOLS ([]) rather than null (all tools) — see this file's own preamble. */
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
  /** One sync point's full inspection record (0079) — the entries it created/changed, the
   *  canon-fact proposals it wrote, and the bridge prompt it sent. Fetched on demand when the
   *  Sync Status panel expands a sync row, so the 30s status poll never ships the heavy detail.
   *  Undefined if the sync doesn't exist or isn't this chat's. */
  getChatSyncInspection(userId: string, chatId: string, syncId: string): Promise<ChatSyncInspection | undefined>;
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
   *  that actually triggered them rather than one turn stale. An optional pre-set message_id is
   *  honored verbatim (used by the lorebook turn seed — the assistant message_id is generated
   *  before the LLM call so resolveLorebook's deterministic gate seed can reference the message
   *  being generated); absent, the column's gen_random_uuid() default applies. */
  appendMessages(
    userId: string,
    chatId: string,
    messages: { role: 'user' | 'assistant'; content: string; messageId?: string; reasoning?: string }[],
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
   *  content and a fresh swipe of its own. The prior reasoning (if any) rides the stashed swipe;
   *  the new swipe and row take the passed reasoning (undefined = none, written NULL — a turn
   *  with no reasoning span, or a user-typed edit via editMessageContent). Returns undefined if
   *  messageId isn't in this chat. */
  recordSwipe(userId: string, chatId: string, messageId: string, newContent: string, reasoning?: string): Promise<StoredChatMessage | undefined>;
  /** In-place content rewrite of an already-persisted message — the Chat tab's "edit an LLM
   *  reply" action. Same write path as recordSwipe (the message's prior content is preserved as
   *  a swipe the first time this is ever called, and newContent becomes both the row's content
   *  and a fresh swipe), but the content comes from the user typing, not an LLM regeneration —
   *  and unlike truncateMessagesFrom's user-message edit flow, nothing chronologically after the
   *  message is touched: the conversation simply continues from the rewritten reply. Returns
   *  undefined if messageId isn't in this chat. */
  editMessageContent(userId: string, chatId: string, messageId: string, newContent: string): Promise<StoredChatMessage | undefined>;
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
    reasoning?: string,
  ): Promise<{ message: StoredChatMessage; newSwipeId: string } | undefined>;
  /** Cycles messageId's active content to an existing sibling swipe — a pure content swap, no LLM
   *  call. See CycleSwipeResult's own doc for what each outcome means. */
  cycleSwipe(userId: string, chatId: string, messageId: string, direction: 'prev' | 'next'): Promise<CycleSwipeResult>;
  /** Returns the message's active swipe id, creating the message's own swipe row (containing its
   *  current content) and making it active when the message has none yet — the invariant the
   *  post-cleanup scraper (docs/plans/vistalyze_integration/segway.md §4) anchors its transient
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
        // RP defaults to no tools at all (DEFAULT_RP_TOOLS = []), never the recall pair and
        // never null (all tools) — enforced here so every RP-creating call site gets the
        // guarantee for free (see this file's own preamble; httpServer.ts re-enforces it per
        // turn so even a stale/widened row can't leak tools to the RP model).
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
          reasoning: string | null;
          created_at: string;
          active_swipe_id: string | null;
        }>(
          'select message_id, role, content, reasoning, created_at, active_swipe_id from chat_messages where chat_id = $1 order by created_at, message_id',
          [chatId],
        );
        // Swipe metadata per message (docs/bi_principles.md: swipe capability on the last LLM
        // response) — a message only ever has rows here once it's been regenerated at least once
        // (recordSwipe below), so this is empty for the common case of an unswiped chat. Fetched
        // as one extra query and joined in JS rather than a per-message subquery — chat sizes here
        // are household-scale, not worth a lateral join for.
        const swipesByMessage = new Map<string, { swipe_id: string; reasoning: string | null }[]>();
        if (messages.length > 0) {
          const swipeRows = await session.query<{ message_id: string; swipe_id: string; reasoning: string | null }>(
            'select message_id, swipe_id, reasoning from chat_message_swipes where message_id = any($1) order by message_id, created_at',
            [messages.map((m) => m.message_id)],
          );
          for (const row of swipeRows) {
            const list = swipesByMessage.get(row.message_id) ?? [];
            list.push({ swipe_id: row.swipe_id, reasoning: row.reasoning });
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
              // The row's reasoning mirrors the active swipe's reasoning (recordSwipe/cycleSwipe
              // keep them in sync the same way they sync content), so reading the row is correct
              // for swiped and unswiped messages alike. Absent (undefined) when null, matching
              // the never-empty-string contract.
              reasoning: m.reasoning ?? undefined,
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
        // the last *closed* sync point's anchor message — or all of them if never synced. count(*)
        // is bigint (string via pg), cast to text like the canon counts above. The closed-only
        // narrowing matters: an eagerly-opened sync point (closed_at null, docs/plans/
        // eager-chunk-sync-plan.md) is chunk-progress only, never a consolidation boundary — left
        // unfiltered, the panel's "unsynced messages" figure would disagree with the tick's own
        // due-check.
        const [counts] = await session.query<{ unsynced: string }>(
          `select count(*)::text as unsynced
           from chat_messages m
           left join chat_sync_points sp on sp.chat_id = m.chat_id
             and sp.ordinal = (select max(ordinal) from chat_sync_points where chat_id = m.chat_id and closed_at is not null)
           left join chat_messages anchor on anchor.message_id = sp.last_message_id
           where m.chat_id = $1
             and (anchor.created_at is null or m.created_at > anchor.created_at)`,
          [chatId],
        );

        // The per-sync summary list (0079): every *closed* sync point this chat has produced,
        // newest first, with aggregate entry/fact counts — one grouped query, so the 30s panel
        // poll stays cheap and never ships the heavy detail (full bridge transcripts live in the
        // on-demand getChatSyncInspection fetch). An open, chunk-only sync point (closed_at null)
        // has no entries/facts yet and would only show up as a zero-count noise row — it's
        // excluded, keeping the panel showing exactly the rows it showed before eager chunking
        // existed (docs/plans/eager-chunk-sync-plan.md). Capped at the 50 most recent — the panel
        // is an inspection surface, not an export.
        const syncRows = await session.query<{
          sync_id: string;
          ordinal: number;
          created_at: string;
          entry_count: string;
          fact_count: string;
        }>(
          `select sp.sync_id, sp.ordinal, sp.created_at,
                  count(distinct e.entry_id)::text as entry_count,
                  count(distinct f.fact_id)::text as fact_count
           from chat_sync_points sp
           left join chat_memory_entries e on e.sync_id = sp.sync_id
           left join canon_facts f on f.sync_id = sp.sync_id
           where sp.chat_id = $1 and sp.closed_at is not null
           group by sp.sync_id, sp.ordinal, sp.created_at
           order by sp.ordinal desc
           limit 50`,
          [chatId],
        );
        const syncs: ChatSyncSummary[] = syncRows.map((sp) => ({
          syncId: sp.sync_id,
          ordinal: sp.ordinal,
          createdAt: sp.created_at,
          entryCount: Number(sp.entry_count),
          factCount: Number(sp.fact_count),
        }));

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
          syncs,
        };
      });
    },

    async getChatSyncInspection(userId, chatId, syncId) {
      return db.withUserScope(userId, async (session) => {
        // The chat check first, so a sync id from another chat (or another user — RLS) reads as
        // a plain not-found rather than leaking its detail.
        const [syncRow] = await session.query<{
          sync_id: string;
          ordinal: number;
          last_message_id: string;
          created_at: string;
          bridge_prompt: string | null;
        }>(
          `select sync_id, ordinal, last_message_id, created_at, bridge_prompt from chat_sync_points where sync_id = $1 and chat_id = $2`,
          [syncId, chatId],
        );
        if (!syncRow) return undefined;

        const [entryRows, factRows] = await Promise.all([
          // chat_memory_entries re-points sync_id on every update (the upsert), so this is
          // exactly "created or changed in that sync".
          session.query<{ topic_key: string; content: string; updated_at: string }>(
            'select topic_key, content, updated_at from chat_memory_entries where sync_id = $1 order by updated_at',
            [syncId],
          ),
          session.query<{
            fact_id: string;
            category: string;
            arc_tag: string | null;
            entity_key: string | null;
            summary: string;
            detail: string;
            status: string;
          }>(
            `select fact_id, category, arc_tag, entity_key, summary, detail, status from canon_facts where sync_id = $1 order by proposed_at`,
            [syncId],
          ),
        ]);

        return {
          syncId: syncRow.sync_id,
          ordinal: syncRow.ordinal,
          createdAt: syncRow.created_at,
          lastMessageId: syncRow.last_message_id,
          bridgePrompt: syncRow.bridge_prompt ?? null,
          entries: entryRows.map((e) => ({ topicKey: e.topic_key, content: e.content, updatedAt: e.updated_at })),
          canonFacts: factRows.map((f) => ({
            factId: f.fact_id,
            category: f.category,
            arcTag: f.arc_tag,
            entityKey: f.entity_key,
            summary: f.summary,
            detail: f.detail,
            status: f.status,
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
            'insert into chat_messages (chat_id, user_id, role, content, reasoning, message_id, created_at) values ($1, $2, $3, $4, $5, coalesce($6, gen_random_uuid()), clock_timestamp()) returning message_id',
            [chatId, userId, message.role, message.content, message.reasoning ?? null, message.messageId ?? null],
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

    async recordSwipe(userId, chatId, messageId, newContent, reasoning) {
      const result = await this.recordSwipeIfContent(userId, chatId, messageId, undefined, newContent, reasoning);
      return result?.message;
    },

    async editMessageContent(userId, chatId, messageId, newContent) {
      // No reasoning is passed: a user-typed edit has no reasoning behind it, so the new content
      // (row + fresh swipe) gets reasoning NULL — the plan's "clears reasoning for that row"
      // edge case. The pre-edit text is stashed as a swipe WITH its original reasoning (it's the
      // LLM's text, and the LLM's reasoning belongs to it — cycling 'prev' shows both together).
      const result = await this.recordSwipeIfContent(userId, chatId, messageId, undefined, newContent);
      return result?.message;
    },

    async recordSwipeIfContent(userId, chatId, messageId, expectedContent, newContent, reasoning) {
      return db.withUserScope(userId, async (session) => {
        const rows = await session.query<{ role: 'user' | 'assistant'; content: string; reasoning: string | null; created_at: string; active_swipe_id: string | null }>(
          // FOR UPDATE: the guard + writeback must be atomic even under READ COMMITTED — without
          // the row lock, a user regeneration committing between this SELECT and the UPDATE below
          // still gets clobbered (this UPDATE would land second and silently replace the fresh
          // reply). Same claim-atomicity pattern as agentRoutineDispatch.ts's job claim.
          'select role, content, reasoning, created_at, active_swipe_id from chat_messages where message_id = $1 and chat_id = $2 for update',
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
        // The original reasoning rides along — that swipe is the LLM's own reply, and its
        // reasoning belongs to it (each swipe's reasoning is independent, matching content's own
        // per-swipe independence — the plan's swipe edge case).
        let originalSwipeId = current.active_swipe_id;
        if (!originalSwipeId) {
          const [inserted] = await session.query<{ swipe_id: string }>(
            'insert into chat_message_swipes (message_id, content, reasoning, created_at) values ($1, $2, $3, clock_timestamp()) returning swipe_id',
            [messageId, current.content, current.reasoning],
          );
          originalSwipeId = inserted!.swipe_id;
        }

        const [newSwipe] = await session.query<{ swipe_id: string }>(
          'insert into chat_message_swipes (message_id, content, reasoning, created_at) values ($1, $2, $3, clock_timestamp()) returning swipe_id',
          [messageId, newContent, reasoning ?? null],
        );
        await session.query('update chat_messages set content = $1, active_swipe_id = $2, reasoning = $3 where message_id = $4', [
          newContent,
          newSwipe!.swipe_id,
          reasoning ?? null,
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
            reasoning: reasoning ?? undefined,
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

        const swipeRows = await session.query<{ swipe_id: string; content: string; reasoning: string | null }>(
          'select swipe_id, content, reasoning from chat_message_swipes where message_id = $1 order by created_at',
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
        // content AND reasoning swap together: the row's reasoning mirrors the active swipe's,
        // exactly the way content already mirrors it — cycling to a variant shows that variant's
        // own reasoning (or none), never the previous swipe's (the plan's swipe edge case).
        await session.query('update chat_messages set content = $1, active_swipe_id = $2, reasoning = $3 where message_id = $4', [
          target.content,
          target.swipe_id,
          target.reasoning,
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
            reasoning: target.reasoning ?? undefined,
            swipes: { index: targetIdx, count: swipeRows.length },
          },
        };
      });
    },

    async ensureActiveSwipe(userId, chatId, messageId) {
      return db.withUserScope(userId, async (session) => {
        const rows = await session.query<{ content: string; reasoning: string | null; active_swipe_id: string | null }>(
          'select content, reasoning, active_swipe_id from chat_messages where message_id = $1 and chat_id = $2',
          [messageId, chatId],
        );
        const current = rows[0];
        if (!current) return undefined;
        if (current.active_swipe_id) return current.active_swipe_id;
        // A never-regenerated assistant message has no swipe row yet — create its own canonical
        // variant and make it active, so the scraper's transient rows can anchor to it. The
        // swipes metadata stays `{index: 0, count: 1}`, which cycleSwipe's bounds checks and the
        // frontend's count > 1 gating both treat exactly like the old zero-row state. The
        // message's own reasoning (if any) rides into the canonical swipe, keeping the row ↔
        // swipe reasoning mirror getChat/cycleSwipe rely on.
        const [inserted] = await session.query<{ swipe_id: string }>(
          'insert into chat_message_swipes (message_id, content, reasoning, created_at) values ($1, $2, $3, clock_timestamp()) returning swipe_id',
          [messageId, current.content, current.reasoning],
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
          reasoning: string | null;
          created_at: string;
          active_swipe_id: string | null;
        }>(
          'select message_id, role, content, reasoning, created_at, active_swipe_id from chat_messages where chat_id = $1 order by created_at, message_id',
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
        // Reasoning is copied verbatim with its content — the branch inherits the reply AND the
        // thought that produced it; they stay paired the way they were persisted (docs/plans/
        // reasoning-blocks-plan.md). Each copied assistant message also gets its own swipe row,
        // mirroring the parent's active swipe one-for-one (swipe_id is a global PK too):
        // alternates still don't come along (same accepted-imprecision trade this file's
        // preamble documents), but the branch's own messages need their own anchorable active
        // swipes — the transient location/character rows the scraper anchors to one of the
        // parent's swipes are resurrected against these (§2.7 below).
        const idMap = new Map<string, string>();
        const swipeIdMap = new Map<string, string>();
        for (const m of toCopy) {
          const [inserted] = await session.query<{ message_id: string }>(
            `insert into chat_messages (chat_id, user_id, role, content, reasoning, created_at) values ($1, $2, $3, $4, $5, $6)
             returning message_id`,
            [newChatId, userId, m.role, m.content, m.reasoning, m.created_at],
          );
          idMap.set(m.message_id, inserted!.message_id);
          if (m.role === 'assistant' && m.active_swipe_id) {
            const [swipe] = await session.query<{ swipe_id: string }>(
              'insert into chat_message_swipes (message_id, content, reasoning, created_at) values ($1, $2, $3, $4) returning swipe_id',
              [inserted!.message_id, m.content, m.reasoning, m.created_at],
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
        // closed_at is load-bearing now (docs/plans/eager-chunk-sync-plan.md): carry it over
        // verbatim, or a copied closed point would silently land open (closed_at null) on the
        // branch — and an open one (a normal state to fork from, given eager chunking can leave a
        // point open until its tick) must stay open with its already-copied chunks coherent
        // under it.
        const syncPoints = await session.query<{ sync_id: string; ordinal: number; last_message_id: string; closed_at: string | null }>(
          'select sync_id, ordinal, last_message_id, closed_at from chat_sync_points where chat_id = $1 order by ordinal',
          [chatId],
        );
        const eligible = syncPoints.filter((sp) => copiedIds.has(sp.last_message_id));

        const syncIdMap = new Map<string, string>();
        for (const sp of eligible) {
          const [inserted] = await session.query<{ sync_id: string }>(
            `insert into chat_sync_points (chat_id, user_id, ordinal, last_message_id, closed_at) values ($1, $2, $3, $4, $5)
             returning sync_id`,
            [newChatId, userId, sp.ordinal, idMap.get(sp.last_message_id), sp.closed_at],
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
            summary_vector_embed: string | null;
          }>(
            'select sync_id, ordinal, content, summary, vector_embed::text as vector_embed, summary_vector_embed::text as summary_vector_embed from chat_chunks where sync_id = any($1) order by ordinal',
            [oldSyncIds],
          );
          // Lead-in chain (docs/plans/chunk-lead-in-context-plan.md): the copied set is a
          // contiguous ordinal prefix (the eligible sync points form a prefix), so each new
          // chunk links to the previously copied row's fresh chunk_id — null for the first,
          // which becomes the branch's chain head. newChatId is brand-new, so no other writer
          // can touch it and no lock is needed; the read-then-insert shares one transaction.
          let parentChunkId: string | null = null;
          for (const c of chunks) {
            const [inserted]: { chunk_id: string }[] = await session.query<{ chunk_id: string }>(
              `insert into chat_chunks (chat_id, sync_id, user_id, ordinal, content, summary, vector_embed, summary_vector_embed, parent_chunk_id)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               returning chunk_id`,
              [newChatId, syncIdMap.get(c.sync_id), userId, c.ordinal, c.content, c.summary, c.vector_embed, c.summary_vector_embed, parentChunkId],
            );
            parentChunkId = inserted!.chunk_id;
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

        // docs/plans/vistalyze_integration/segway.md §2.7 / db/migrations/0096: LINK, don't clone,
        // the fork's referenced locations/characters into the new branch. Every location_chat_links/
        // character_chat_links row belonging to the parent chat whose anchor is among the *copied*
        // messages gets a sibling link row on the branch pointing at the SAME location_id/
        // character_id — not a fresh row. Both chats now reference the identical row, so a later
        // refinement (the describer pass, a promotion, etc.) is visible from both branches instead
        // of silently diverging, matching the user's explicit "duping or linking, you pick — link"
        // call. This applies uniformly regardless of status (transient/permanent/inactive): status
        // only tracks sync-tick progress now, not cross-chat visibility, so a promoted location
        // referenced before the fork point comes along exactly like a still-transient one. Rows
        // anchored to an uncopied (post-fork-point) message are correctly left unlinked in the new
        // branch, same as today.
        const copiedSwipeIds = [...swipeIdMap.keys()];
        if (copiedSwipeIds.length > 0) {
          const parentLocationLinks = await session.query<{ location_id: string; anchor_swipe_id: string | null }>(
            `select location_id, anchor_swipe_id from location_chat_links
             where chat_id = $1 and anchor_swipe_id = any($2::uuid[])`,
            [chatId, copiedSwipeIds],
          );
          for (const link of parentLocationLinks) {
            const branchAnchorSwipeId = link.anchor_swipe_id ? swipeIdMap.get(link.anchor_swipe_id) : undefined;
            if (!branchAnchorSwipeId) continue;
            await session.query(
              `insert into location_chat_links (location_id, chat_id, anchor_swipe_id) values ($1, $2, $3)
               on conflict (location_id, chat_id) do nothing`,
              [link.location_id, newChatId, branchAnchorSwipeId],
            );
          }

          const parentCharacterLinks = await session.query<{ character_id: string; anchor_swipe_id: string | null }>(
            `select character_id, anchor_swipe_id from character_chat_links
             where chat_id = $1 and anchor_swipe_id = any($2::uuid[])`,
            [chatId, copiedSwipeIds],
          );
          for (const link of parentCharacterLinks) {
            const branchAnchorSwipeId = link.anchor_swipe_id ? swipeIdMap.get(link.anchor_swipe_id) : undefined;
            if (!branchAnchorSwipeId) continue;
            await session.query(
              `insert into character_chat_links (character_id, chat_id, anchor_swipe_id) values ($1, $2, $3)
               on conflict (character_id, chat_id) do nothing`,
              [link.character_id, newChatId, branchAnchorSwipeId],
            );
          }

          // endpoint.md §5.1.8's per-swipe image associations for every copied swipe, re-keyed to
          // the branch's own chat/swipe ids — location_id rides along unchanged since the location
          // itself is shared, not cloned. A cycle-back inside the branch reuses the recorded URL
          // instead of re-generating, exactly like the parent.
          const swipeImageRows = await session.query<{
            swipe_id: string;
            location_id: string;
            image_url: string | null;
            render_hash: string | null;
            image_generated_at: string | null;
          }>(
            `select swipe_id, location_id, image_url, render_hash, image_generated_at from location_swipe_images
             where chat_id = $1 and swipe_id = any($2::uuid[])`,
            [chatId, copiedSwipeIds],
          );
          for (const si of swipeImageRows) {
            const branchSwipeId = swipeIdMap.get(si.swipe_id);
            if (!branchSwipeId) continue;
            await session.query(
              `insert into location_swipe_images (chat_id, swipe_id, location_id, image_url, render_hash, image_generated_at)
               values ($1, $2, $3, $4, $5, $6)
               on conflict (chat_id, swipe_id) do update set
                 location_id = excluded.location_id,
                 image_url = excluded.image_url,
                 render_hash = excluded.render_hash,
                 image_generated_at = excluded.image_generated_at`,
              [newChatId, branchSwipeId, si.location_id, si.image_url, si.render_hash, si.image_generated_at],
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
