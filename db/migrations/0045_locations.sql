-- Locations — the visual/environmental anchor a scene's active_location_id points at (Canonize
-- plan §4, spec.md §4). Applied by hand, same as 0044:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0045_locations.sql
--
-- image_path/image_generated_at are cache only, never the source (spec.md §4, bi_principles.md
-- §1) — Vistalyze's image pipeline isn't built yet (canonize-plan.md §2's non-goals), so both stay
-- null until that plugin exists; visual_description/environment are what a future render is
-- generated from, not the other way around.

create table locations (
  location_id         uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(user_id),
  name                text not null,
  visual_description  text not null default '',
  environment         jsonb not null default '{}'::jsonb,
  seed                bigint,
  image_path          text,
  image_generated_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index locations_by_user_name on locations (user_id, name);

alter table locations enable row level security;
alter table locations force row level security;
create policy user_scoped on locations using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on locations to bigbrain_app;
