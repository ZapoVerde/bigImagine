-- Freeform notes (Notes tab prerequisite) — applied by hand, same as 0009:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0011_notes.sql
-- (bigbrain_admin, not bigbrain_app — CREATE TABLE needs owner/superuser privileges bigbrain_app
-- was deliberately never granted.)
--
-- One row per note: a title and a freeform content blob, nothing structured. Deliberately not
-- reusing chat_messages' shape — a note isn't a sequence of anything, it's a single piece of text
-- a user or the LLM wrote and may come back to edit. tags is informational only, never triggers
-- a side effect.

create table notes (
  note_id    uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(user_id),
  title      text not null default 'Untitled note',
  content    text not null default '',
  tags       text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notes_by_user_updated on notes (user_id, updated_at desc);

alter table notes enable row level security;
alter table notes force row level security;
create policy user_scoped on notes using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on notes to bigbrain_app;
