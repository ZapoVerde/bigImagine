-- docs/chat-memory.md: the restore-point marker behind rolling chat summarization. Every sync
-- pass (chat-memory background job) writes one row here recording the last message it covered.
-- Deliberately a bookkeeping table separate from the content it produces (chat_chunks,
-- chat_memory_entries both FK to sync_id, on delete cascade) — this table only answers "how far
-- have we synced," the content tables answer "what did we learn."
--
-- last_message_id references chat_messages(message_id) on delete cascade: this is what makes
-- truncateMessagesFrom's existing single DELETE (io/chatSessions.ts) self-healing for free. When
-- a message that was some sync point's restore point gets deleted (an edit/rerun truncating back
-- past it), Postgres cascades the delete to this row, which cascades again to every chat_chunks/
-- chat_memory_entries row that sync produced — no application code needed to detect or repair the
-- divergence. A sync point whose last_message_id survives the truncate is untouched, exactly as
-- it should be: that sync's derived state is still valid.
create table chat_sync_points (
  sync_id         uuid primary key default gen_random_uuid(),
  chat_id         uuid not null references chat_sessions(chat_id) on delete cascade,
  user_id         uuid not null references users(user_id),
  ordinal         int not null,
  last_message_id uuid not null references chat_messages(message_id) on delete cascade,
  created_at      timestamptz not null default now(),
  unique (chat_id, ordinal),
  unique (chat_id, last_message_id)
);

alter table chat_sync_points enable row level security;
alter table chat_sync_points force row level security;
create policy user_scoped on chat_sync_points
  using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

create index chat_sync_points_by_chat on chat_sync_points (chat_id, ordinal desc);
