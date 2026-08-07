-- Transient -> permanent/inactive lifecycle for locations and characters, plus the scene
-- identity everything depends on (docs/vistalyze_integration/segway.md §2.2-2.4, generalizing
-- docs/vistalyze_integration/location_status.md's already-agreed lifecycle to people).
-- Applied by hand against the dedicated BigImagine database, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0067_transient_location_and_people.sql
--
-- 1. scenes pin to (chat, location), not one mutable row per chat. A scene row is a per-chat
--    visit record (segway.md §2.2): scenes.chat_id is `on delete cascade` (a scene has no
--    independent existence once its owning chat is gone — deleting a chat is a full-teardown
--    action elsewhere, unlike locations/characters whose promoted rows must survive it), and the
--    unique (chat_id, active_location_id) pair is the identity key — revisiting a location this
--    chat has been to reuses the scene row (and its accumulated scene_presence / linked canon
--    facts) instead of duplicating it. NULLs stay distinct, so the pre-existing scenes-plugin
--    rows (chat_id null) and the no-location scenes both keep working untouched. The circular FK
--    (scenes.chat_id -> chat_sessions, chat_sessions.scene_id -> scenes) is safe because both
--    columns are nullable and the cycle is only ever a chat row pointing at its own scene — PG
--    short-circuits the cascade against a row already being deleted.
--
-- 2. chat_sessions.scene_id is a *cache*, not the source of truth (segway.md §2.2): the real
--    identity is the (chat_id, active_location_id) pair on scenes. Stage 2 of the turn pipeline
--    keeps it pointed at the chat's most recently resolved scene so future readers
--    (buildNarratorStackItems, recall_canon_facts) get a cheap current-scene read without
--    re-deriving it from the location on every access. `on delete set null`, not cascade — the
--    cache pointer must never take the chat down with it (same reasoning as prompt_stack_preset_id).
--
-- 3. locations lifecycle columns (segway.md §2.3): status defaults 'transient' per the spec.
--    A location created through the normal Locations UI is the user's explicit canon signal, so
--    plugins/locations/src/createLocationTool.ts writes 'permanent' explicitly — the migration
--    backfills any pre-existing rows the same way (status='transient' with no anchors can only
--    be pre-lifecycle/user-authored rows; a scraper-created row always carries both anchors).
--    anchor_chat_id is `on delete set null`, never cascade — deleting a chat must not destroy
--    locations that chat promoted to permanent canon (the same invariant canon_facts.chat_id,
--    migration 0054, already protects). anchor_swipe_id is `on delete cascade` — deleting the
--    turn that originated a still-transient-or-inactive location takes it with it
--    (location_status.md §3 Step 4), per the spec.
--
-- 4. characters lifecycle columns (segway.md §2.4), mirroring locations exactly — except the
--    column default: ordinary user-authored characters are neither transient nor inactive, so
--    status stays null (meaning "not part of the lifecycle") and is only ever set by the
--    auto-registration path (§4.4 of the spec). Everything else — anchor FK semantics, the
--    promote/demote/exclude/resurrect lifecycle — is identical to locations.

alter table scenes add column chat_id uuid references chat_sessions(chat_id) on delete cascade;
create unique index scenes_chat_location_idx on scenes (chat_id, active_location_id);

alter table chat_sessions add column scene_id uuid references scenes(scene_id) on delete set null;

alter table locations add column status text not null default 'transient'
  check (status in ('transient', 'permanent', 'inactive'));
alter table locations add column anchor_chat_id uuid references chat_sessions(chat_id) on delete set null;
alter table locations add column anchor_swipe_id uuid references chat_message_swipes(swipe_id) on delete cascade;
create index locations_lifecycle_idx on locations (status, anchor_swipe_id);

alter table characters add column status text
  check (status in ('transient', 'permanent', 'inactive'));
alter table characters add column anchor_chat_id uuid references chat_sessions(chat_id) on delete set null;
alter table characters add column anchor_swipe_id uuid references chat_message_swipes(swipe_id) on delete cascade;
create index characters_lifecycle_idx on characters (status, anchor_swipe_id);

-- Pre-existing, user-authored rows (never anchored to a swipe) are canon by the same rule
-- createLocationTool.ts now encodes explicitly. Idempotent and scoped so a scraper-created
-- transient row (which always has both anchors) can never be swept up by this.
update locations set status = 'permanent'
 where status = 'transient' and anchor_swipe_id is null and anchor_chat_id is null;
