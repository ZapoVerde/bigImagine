-- docs/chat-memory.md: the per-chat "key ideas" digest — a distilled, bounded-size log of what
-- has happened in this chat's rolled-off turns, always injected into that chat's own system
-- prompt (unlike chat_chunks, which is only reached via the recall_chat_history tool). Kept small
-- deliberately: unlike chat_chunks (grows every sync, fine since it's only reached on demand),
-- this table is read on *every* turn, so unbounded growth would be a real, recurring cost.
--
-- Bounded via topic_key: distillChatMemory.ts is given the chat's current entries and asked to
-- return the current set of ideas worth keeping, reusing an existing topic_key when it's a
-- continuation of the same thread and coining a new one only for a genuinely new topic — same
-- "arc tag" idea Canonize's plot lorebook uses to avoid appending a fresh row for every update to
-- the same ongoing thread. The upsert on (chat_id, topic_key) is what makes that bounded: updating
-- an existing topic replaces its row rather than piling on a new one.
create table chat_memory_entries (
  entry_id   uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references chat_sessions(chat_id) on delete cascade,
  sync_id    uuid not null references chat_sync_points(sync_id) on delete cascade,
  user_id    uuid not null references users(user_id),
  topic_key  text not null,
  content    text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chat_id, topic_key)
);

alter table chat_memory_entries enable row level security;
alter table chat_memory_entries force row level security;
create policy user_scoped on chat_memory_entries
  using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

create index chat_memory_entries_by_chat on chat_memory_entries (chat_id, updated_at);
