-- Read surface for the rolling chat-memory sync loop's own existing failure logging
-- (orchestrator/src/orchestrator/chatMemorySync.ts, bi_principles.md §11 — "Observability is Not
-- an Afterthought"). Today a failed sync is caught once at the outer tick loop, logged, and its
-- whole per-chat transaction rolls back — so a chat that's been silently failing for days looks
-- identical from outside to one with nothing to sync. One row per chat, upserted on every attempt
-- (ok/skipped/error), through a *separate* transaction from the sync work itself so the record
-- survives even when that work rolled back.
--
-- Deliberately `on delete cascade` (unlike canon_facts's `set null`): this is derived, point-in-
-- time health data, not a record that must never be erased — deleting the chat should delete its
-- status row. A single current-status row per chat, not a history table: this is a "is it healthy
-- right now" dashboard, not an audit log.
--
-- Applied by hand against the dedicated BigImagine database, same as 0053/0054:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0055_chat_memory_sync_status.sql

create table chat_memory_sync_status (
  chat_id uuid primary key references chat_sessions(chat_id) on delete cascade,
  user_id uuid not null references users(user_id) on delete cascade,
  last_attempt_at timestamptz not null,
  last_status text not null check (last_status in ('ok', 'skipped', 'error')),
  last_step text,
  last_error text,
  last_success_at timestamptz,
  last_chunks_added integer,
  last_entries_updated integer,
  consecutive_errors integer not null default 0
);

alter table chat_memory_sync_status enable row level security;
alter table chat_memory_sync_status force row level security;
create policy user_scoped on chat_memory_sync_status
  using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

create index chat_memory_sync_status_by_user on chat_memory_sync_status (user_id);
