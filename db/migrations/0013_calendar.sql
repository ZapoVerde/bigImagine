-- Household calendar (docs/spec.md §6.7) — applied by hand, same as 0004/0009/0011:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0013_calendar.sql
-- (bigbrain_admin, not bigbrain_app — CREATE TABLE needs owner/superuser privileges bigbrain_app
-- was deliberately never granted.)
--
-- One row per event, aggregating read-only external feeds (Cozi, Outlook) and native
-- AI/user-created events into a single table. `source` is `text` + a closed CHECK vocabulary
-- rather than a native Postgres enum, same choice as provider_credentials.name/
-- orchestrator_settings.key — a typo fails loudly at insert time instead of silently, and
-- widening the vocabulary later (adding 'google', phase 2) is an ALTER ... DROP/ADD CONSTRAINT,
-- not an enum migration. `external_id` is the feed's own UID for 'cozi'/'outlook' (one row per
-- RRULE-expanded occurrence, external_id disambiguated by icsSync.ts), and a fresh gen_random_uuid()
-- text for 'native' rows, where there's no external feed to key against.
--
-- Deliberately no color_code/is_read_only columns: both are pure functions of `source`
-- (plugins/calendar/src/sourceMeta.ts) — storing them would let a row disagree with what its own
-- source means, which is exactly the kind of derived-not-canonical state docs/bb_principles.md §1
-- warns against.

create table calendar_events (
  event_id         uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(user_id),
  source           text not null check (source in ('cozi', 'outlook', 'native')),
  external_id      text not null,
  title            text not null,
  description      text,
  location         text,
  start_time       timestamptz not null,
  end_time         timestamptz not null,
  all_day          boolean not null default false,
  assigned_members text[] not null default '{}', -- informational tags only, e.g. lists.tags — never a security boundary
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint unique_source_external_id unique (source, external_id)
);

create index calendar_events_by_range on calendar_events (start_time, end_time);

alter table calendar_events enable row level security;
alter table calendar_events force row level security;
create policy user_scoped on calendar_events using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on calendar_events to bigbrain_app;
