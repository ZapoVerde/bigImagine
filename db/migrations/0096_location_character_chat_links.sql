-- Chat-scope auto-registered locations and people (docs/bi_principles.md's canonical-record
-- principle, applied the same way 0058 already applied it to canon_facts: "there shouldn't be
-- any [auto-registered row] that doesn't belong to a chat"). Applied by hand against the
-- dedicated BigImagine database, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0096_location_character_chat_links.sql
--
-- The bug this fixes: locations/characters were user_id-scoped only, with a nullable
-- anchor_chat_id (`on delete set null`, not cascade) and a single anchor_swipe_id that
-- chatMemorySync.ts's promote step explicitly nulled out the moment a row settled to
-- status='permanent'. Once promoted, a row had no live FK path back to any chat or message at
-- all — nothing could ever cascade-delete it, and get_locations/get_characters/the scraper's own
-- name-lookup all treated it as globally visible across every chat. That's the reported symptom:
-- locations outliving every chat they came from.
--
-- The fix: move the anchor off a single nullable column and onto a proper chat-membership link
-- table, so ordinary FK cascade (not app code) does the work. Only status IS NOT NULL rows
-- (auto-registered by the scraper) ever get a link row — manually-authored rows (status is null,
-- create_location/create_character's own convention) never appear here and are structurally
-- exempt from everything below; they remain the deliberate, reusable, cross-chat library they
-- already are.
--
-- Deletion is "self-healing via FK, not app code" (0054's own phrase): a chat_id row deletes on
-- whole-chat delete; an anchor_swipe_id row deletes when that specific message is
-- edited/truncated/regenerated away (chat_messages -> chat_message_swipes already cascades that
-- far). Standard FK cascade only deletes children when a parent goes, so the reverse direction —
-- delete the location/character once its last link is gone — needs one small trigger per link
-- table; that's the only piece FK alone can't express.
--
-- forkChat (io/chatSessions.ts) switches from cloning fresh rows to inserting new link rows
-- pointing at the *same* location_id/character_id, so both branches see later refinements
-- (the describer pass, etc.) instead of silently diverging.

create table location_chat_links (
  location_id     uuid not null references locations(location_id) on delete cascade,
  chat_id         uuid not null references chat_sessions(chat_id) on delete cascade,
  anchor_swipe_id uuid references chat_message_swipes(swipe_id) on delete cascade,
  primary key (location_id, chat_id)
);
create index location_chat_links_by_chat on location_chat_links (chat_id);

create table character_chat_links (
  character_id    uuid not null references characters(character_id) on delete cascade,
  chat_id         uuid not null references chat_sessions(chat_id) on delete cascade,
  anchor_swipe_id uuid references chat_message_swipes(swipe_id) on delete cascade,
  primary key (character_id, chat_id)
);
create index character_chat_links_by_chat on character_chat_links (chat_id);

alter table location_chat_links enable row level security;
alter table location_chat_links force row level security;
create policy user_scoped on location_chat_links using (
  exists (select 1 from locations l where l.location_id = location_chat_links.location_id and l.user_id = app_current_user_id())
) with check (
  exists (select 1 from locations l where l.location_id = location_chat_links.location_id and l.user_id = app_current_user_id())
);

alter table character_chat_links enable row level security;
alter table character_chat_links force row level security;
create policy user_scoped on character_chat_links using (
  exists (select 1 from characters c where c.character_id = character_chat_links.character_id and c.user_id = app_current_user_id())
) with check (
  exists (select 1 from characters c where c.character_id = character_chat_links.character_id and c.user_id = app_current_user_id())
);

grant select, insert, update, delete on location_chat_links, character_chat_links to bigimagine_app;

-- Orphan cleanup: standard cascade only removes children when a parent goes; this is the reverse
-- ("the parent goes once its last child is gone"), so it needs an explicit trigger. Runs as the
-- table owner (not through RLS), same as any other trigger function here.
create function cleanup_orphaned_location() returns trigger as $$
begin
  delete from locations where location_id = old.location_id
    and not exists (select 1 from location_chat_links where location_id = old.location_id);
  return null;
end;
$$ language plpgsql;
create trigger location_chat_links_cleanup after delete on location_chat_links
  for each row execute function cleanup_orphaned_location();

create function cleanup_orphaned_character() returns trigger as $$
begin
  delete from characters where character_id = old.character_id
    and not exists (select 1 from character_chat_links where character_id = old.character_id);
  return null;
end;
$$ language plpgsql;
create trigger character_chat_links_cleanup after delete on character_chat_links
  for each row execute function cleanup_orphaned_character();

-- locations.status was `not null default 'transient'` since 0067 (characters.status was always
-- nullable — createLocationTool.ts's own status=null convention for manually-authored rows was
-- never actually reachable on locations until this line: every insert prior either explicitly
-- passed 'transient'/'permanent' or fell back to the column default, so the constraint's absence
-- of a null case was silently unenforced dead code, not a deliberate invariant). The corrected
-- model needs status=null to mean "manually-authored, exempt" on both tables identically, so the
-- constraint must go before the backfill below can reclassify any row to null.
alter table locations alter column status drop not null;

-- Backfill: every currently-anchored auto-registered row gets one link row carrying its existing
-- anchor. NOTE: rows that already lost their anchor_chat_id under the pre-fix bug (status is not
-- null, anchor_chat_id is null — orphaned by promotion nulling anchor_swipe_id, then the chat
-- being deleted and set-null firing on anchor_chat_id too) are, at this point, INDISTINGUISHABLE
-- from a manually-authored row: create_location never set anchor_chat_id/anchor_swipe_id in the
-- first place, so both land on the identical (status='permanent', anchor_chat_id null,
-- anchor_swipe_id null) signature. Deleting on that signature risks deleting real,
-- deliberately-authored library entries, so this migration never does — it's conservative and
-- reclassifies every such row to status=null (the same bucket manually-authored rows already
-- live in) rather than guessing which ones are orphaned junk. That reclassification is exactly
-- what create_location's own historical status='permanent' bug (see below) would have produced
-- for a genuine manually-authored row anyway, so it's a correct outcome either way — it just
-- means the *pre-existing* orphaned rows the user is currently seeing don't get auto-deleted by
-- this migration; they're left as ordinary library entries for manual review/deletion via the
-- admin Locations page (which after this change will show no chat for them, distinguishing them
-- from rows that do have a live chat link). Every row created *after* this migration is exempt
-- from this ambiguity, since create_location no longer writes status='permanent' at all (see
-- createLocationTool.ts).
insert into location_chat_links (location_id, chat_id, anchor_swipe_id)
select location_id, anchor_chat_id, anchor_swipe_id from locations
where status is not null and anchor_chat_id is not null;

update locations set status = null where status is not null and anchor_chat_id is null;

insert into character_chat_links (character_id, chat_id, anchor_swipe_id)
select character_id, anchor_chat_id, anchor_swipe_id from characters
where status is not null and anchor_chat_id is not null;

update characters set status = null where status is not null and anchor_chat_id is null;

alter table locations drop column anchor_chat_id;
alter table locations drop column anchor_swipe_id;
alter table characters drop column anchor_chat_id;
alter table characters drop column anchor_swipe_id;
