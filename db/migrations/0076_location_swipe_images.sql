-- Prompt-hash render cache key, per-chat previous-location state, and per-swipe location-image
-- associations. Applied by hand against the dedicated BigImagine database, same as every
-- post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0076_location_swipe_images.sql
--
-- 1. locations.image_render_hash — the cache-first contract (endpoint.md §5.1.2) re-keyed from
--    the image_rendered_input snapshot (row inputs only) to a hash of the *actual synthesized
--    prompt* plus the other output-affecting provider inputs (template, style prefix, negative
--    prompt, seed, model, dims, steps...). The prompt is the variant: same hash -> the existing
--    URL is reused (zero provider calls); a changed hash (the user varied the bg description,
--    or eventually a mood/time slot) -> a new render. A plain column, never part of any unique
--    key — the row's image_url + image_render_hash are the cache record.
--
-- 2. chat_sessions.previous_scene_id — the "last-turn location state": the scene that was
--    current before the current one, maintained by the post-turn scraper (segway.md §4) so a
--    swipe that replaces the last turn can revert the chat background to the previous location
--    until the new turn settles. `on delete set null`, same reasoning as scene_id itself — the
--    pointer must never take the chat down with it.
--
-- 3. location_swipe_images — the per-swipe association that makes a rendered background
--    reusable instead of re-generated (endpoint.md §5): which location each swipe used, and the
--    image URL + render hash recorded for it. A swipe's image is valid iff its stored render
--    hash equals the location's *current* prompt hash — the "save that image url association
--    with that location and swipe, but stays inactive" rule: when the swipe becomes active
--    again (prev/next cycling), the URL is reused without spending a provider call, even if the
--    location row itself was since re-anchored to a newer swipe. One row per (chat, swipe) — a
--    swipe has exactly one location. FKs cascade: the association dies with its swipe (message
--    truncation), its chat, or its location.

alter table locations add column image_render_hash text;

alter table chat_sessions add column previous_scene_id uuid references scenes(scene_id) on delete set null;

create table location_swipe_images (
  chat_id             uuid not null references chat_sessions(chat_id) on delete cascade,
  swipe_id            uuid not null references chat_message_swipes(swipe_id) on delete cascade,
  location_id         uuid not null references locations(location_id) on delete cascade,
  image_url           text,
  render_hash         text,
  image_generated_at  timestamptz,
  primary key (chat_id, swipe_id)
);
create index location_swipe_images_by_location on location_swipe_images (location_id);

-- RLS scoped the same way chat_message_swipes' own policy is (0059): through the swipe -> its
-- message's denormalized user_id, no user_id column of our own.
alter table location_swipe_images enable row level security;
alter table location_swipe_images force row level security;
create policy user_scoped on location_swipe_images using (
  exists (select 1 from chat_message_swipes s
          join chat_messages m on m.message_id = s.message_id
          where s.swipe_id = location_swipe_images.swipe_id and m.user_id = app_current_user_id())
) with check (
  exists (select 1 from chat_message_swipes s
          join chat_messages m on m.message_id = s.message_id
          where s.swipe_id = location_swipe_images.swipe_id and m.user_id = app_current_user_id())
);

grant select, insert, update, delete on location_swipe_images to bigimagine_app;
