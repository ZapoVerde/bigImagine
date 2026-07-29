-- docs/chat-memory.md: branching support. A fork is a new chat_sessions row (not a message tree
-- within one row) — parent_chat_id/fork_message_id are pure provenance ("this chat began as a
-- branch of that one, at that point"), never read by getChat/appendMessages/truncateMessagesFrom,
-- which stay untouched. io/chatSessions.ts's forkChat copies the parent's messages up to
-- fork_message_id, plus its most recent chat_memory_entries/chat_sync_points state, into the new
-- row at creation time — a branch is constructed correct from birth, so unlike an in-place
-- edit/truncate there is nothing to detect or heal here.
--
-- fork_message_id references the *parent's* chat_messages row (kept for provenance/display, e.g.
-- "forked from {parent title} at this point") — it is never the new chat's own message id, since
-- message_id is a global primary key and forking copies messages under fresh ids.
--
-- archived_at is the explicit "this chat is done" signal (docs/bb_principles.md §3) that triggers
-- classifyHouseholdMemory.ts's end-of-chat long-term-memory extraction — chosen over an inferred
-- idle-timeout specifically so the household, not a heuristic, decides when a conversation is over.
alter table chat_sessions add column parent_chat_id uuid references chat_sessions(chat_id) on delete set null;
alter table chat_sessions add column fork_message_id uuid references chat_messages(message_id) on delete set null;
alter table chat_sessions add column archived_at timestamptz;

create index chat_sessions_by_parent on chat_sessions (parent_chat_id);
