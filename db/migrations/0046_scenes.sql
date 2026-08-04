-- Scenes and their presence junction — "who's in the room right now" (Canonize plan §4, spec.md §4).
-- Applied by hand, same as 0044/0045:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0046_scenes.sql
--
-- scene_presence is the many-to-many "who's in the scene" table the Director Pass and
-- recall_canon_facts's scope filter both read. user_id is denormalized onto the junction itself,
-- the same way chat_messages.user_id is (db/migrations/README.md's 0004 precedent), rather than
-- relying on a join to scenes for RLS — every table carries the standard user_scoped policy.

create table scenes (
  scene_id            uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(user_id),
  name                text not null,
  active_location_id  uuid references locations(location_id) on delete set null,
  created_at          timestamptz not null default now(),
  last_active_at       timestamptz not null default now(),
  archived_at          timestamptz
);
create index scenes_by_user_name on scenes (user_id, name);

create table scene_presence (
  scene_id      uuid not null references scenes(scene_id) on delete cascade,
  character_id  uuid not null references characters(character_id) on delete cascade,
  user_id       uuid not null references users(user_id),  -- denormalized, RLS precedent
  joined_at     timestamptz not null default now(),
  primary key (scene_id, character_id)
);
create index scene_presence_character_idx on scene_presence (character_id);

alter table scenes enable row level security;
alter table scenes force row level security;
create policy user_scoped on scenes using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

alter table scene_presence enable row level security;
alter table scene_presence force row level security;
create policy user_scoped on scene_presence using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on scenes, scene_presence to bigbrain_app;