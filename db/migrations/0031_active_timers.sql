-- Focus timers (docs/spec.md's Landing Deck / temporal-primitives addition) — applied by hand,
-- same as 0004/0009/0011/0013/0025/etc:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0031_active_timers.sql
--
-- end_at is an absolute timestamp (start_at + duration), not "seconds remaining" — this is what
-- makes surviving an orchestrator container restart trivial: the row alone is enough to recover
-- the correct remaining time, no in-memory countdown state to lose. No 'paused' status yet
-- (plugins/temporal's Stage 1 tool surface is set_timer/cancel_timer/list_temporal_state only) —
-- the vocabulary stays closed to what's actually implemented, same reasoning as
-- calendar_events.source's closed CHECK list.
--
-- linked_list_item_id/linked_note_id/linked_chat_id follow the same one-directional,
-- set-once-at-creation, on-delete-set-null pattern as calendar_events' linked_list_item_id/
-- linked_note_id (0025_calendar_links_visibility.sql) — a timer can point at the task/note/chat it
-- was started from, but that source never needs to know the timer exists.

create table active_timers (
  timer_id           uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(user_id),
  label              text not null,
  duration_seconds   integer not null check (duration_seconds > 0),
  end_at             timestamptz not null,
  status             text not null default 'running' check (status in ('running', 'completed', 'cancelled')),
  linked_list_item_id uuid references list_items(item_id) on delete set null,
  linked_note_id     uuid references notes(note_id) on delete set null,
  linked_chat_id     uuid references chat_sessions(chat_id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index active_timers_due on active_timers (end_at) where status = 'running';

alter table active_timers enable row level security;
alter table active_timers force row level security;
create policy user_scoped on active_timers using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on active_timers to bigbrain_app;
