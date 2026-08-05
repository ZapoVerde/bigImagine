-- Lorebooks — storage only, for traditional SillyTavern-style keyword-triggered world info in case
-- it's ever used, separate from Canonize's canon_facts/semantic-recall path (docs/spec.md's "no
-- keyword-match fallback" describes the *active* recall mechanism, not a ban on holding the data).
-- All books' entries live in one lorebook_entries table (lorebook_id distinguishes the book), not
-- one table per book.
--
-- Field shape is taken from ST's real entry definition (stacks/sillytavern/st-source/public/scripts/
-- world-info.js newWorldInfoEntryDefinition, ~35 fields) and its on-disk format
-- (src/endpoints/worldinfo.js: `{ name, entries: { [uid]: entryObject } }`, no rich book-level
-- settings). Columns cover the fields worth browsing/filtering/toggling in a UI; source_json holds
-- the complete original entry verbatim (same convention as characters.source_json) so nothing is
-- lost even though most of ST's rarer fields — recursion flags, character filters, sticky/cooldown,
-- automation triggers — aren't modeled as columns here.
--
-- TODO: no read/write plumbing exists yet — no import/export routes, no UI, nothing in the prompt
-- stack. This migration only creates a place to land the data. Wiring it up (starting with an
-- import route that parses an ST world-info JSON export into these tables) is a later, separate
-- task.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0051_lorebooks.sql

create table lorebooks (
  lorebook_id  uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(user_id),
  name         text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index lorebooks_by_user_name on lorebooks (user_id, name);

alter table lorebooks enable row level security;
alter table lorebooks force row level security;
create policy user_scoped on lorebooks using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on lorebooks to bigimagine_app;

create table lorebook_entries (
  entry_id      uuid primary key default gen_random_uuid(),
  lorebook_id   uuid not null references lorebooks(lorebook_id) on delete cascade,
  user_id       uuid not null references users(user_id),
  uid           integer not null,
  key           text[] not null default '{}',
  keysecondary  text[] not null default '{}',
  comment       text not null default '',
  content       text not null default '',
  constant      boolean not null default false,
  selective     boolean not null default true,
  disable       boolean not null default false,
  order_value   integer not null default 100,
  position      smallint not null default 0,
  probability   smallint not null default 100,
  depth         integer,
  group_name    text not null default '',
  source_json   jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (lorebook_id, uid)
);
create index lorebook_entries_by_lorebook on lorebook_entries (lorebook_id);

alter table lorebook_entries enable row level security;
alter table lorebook_entries force row level security;
create policy user_scoped on lorebook_entries using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on lorebook_entries to bigimagine_app;
