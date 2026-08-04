-- Characters — the structured character-card table (Canonize plan §4, spec.md §4). Applied by hand,
-- same as 0009/0011:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0044_characters.sql
-- (bigbrain_admin, not bigbrain_app — CREATE TABLE needs owner/superuser privileges bigbrain_app
-- was deliberately never granted.)
--
-- The static half of a character's canonical record (bi_principles.md §1): persona/scenario/
-- system_prompt/example_dialogue/greetings are the fixed-at-creation fields, and source_json holds
-- the original imported V2/V3 card verbatim so export is a lossless round-trip rather than a lossy
-- reconstruction from the columns the platform happened to use (bi_principles.md §7). Evolving
-- detail (connections, relationship-with-user, goals) deliberately lives in canon_facts
-- (category='person'), never here — extraction writes proposals, only a human edits the Roster
-- (bi_principles.md §3, canonize-plan.md §3.3).

create table characters (
  character_id      uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(user_id),
  name              text not null,
  persona           text not null default '',
  scenario          text not null default '',
  system_prompt     text not null default '',
  example_dialogue  text not null default '',
  greetings         jsonb not null default '[]'::jsonb,
  avatar_path       text,
  spec_version      text not null default 'v2' check (spec_version in ('v2', 'v3')),
  source_json       jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index characters_by_user_name on characters (user_id, name);

alter table characters enable row level security;
alter table characters force row level security;
create policy user_scoped on characters using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on characters to bigbrain_app;