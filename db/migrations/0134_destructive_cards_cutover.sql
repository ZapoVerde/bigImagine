-- Destructive Cards / runtime Characters cutover (docs/plans/cards-runtime-characters/3_IMPLEMENTATION_PLAN.md §4.2).
-- Removes the legacy Card-as-Character representation after all consumers have moved to Cards.
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0134_destructive_cards_cutover.sql

begin;

-- Precondition: every status-null Card row must have a canonical Cards counterpart (0133 preserved IDs).
do $$
declare missing int;
begin
  select count(*) into missing from characters c left join cards card on card.card_id = c.character_id where c.status is null and card.card_id is null;
  if missing > 0 then
    raise exception 'precondition failed: % legacy Card rows in characters have no counterpart in cards', missing;
  end if;
end $$;

-- Remove Card-owned lorebook associations that were migrated to lorebook_card_links in 0133.
-- Keep runtime Character links intact.
delete from lorebook_character_links where character_id in (select character_id from characters where status is null);

-- Remove legacy Card rows from characters. Runtime Characters (status not null) are preserved.
delete from characters where status is null;

-- Drop the legacy source-Card reference on chats. All RP chats were backfilled to card_id in 0133.
alter table chat_sessions drop column if exists character_id;

-- Drop Card-only columns from runtime characters. Runtime Characters keep name/persona/appearance/status.
alter table characters drop column if exists avatar_path;
alter table characters drop column if exists spec_version;
alter table characters drop column if exists source_json;
alter table characters drop column if exists scenario;
alter table characters drop column if exists system_prompt;
alter table characters drop column if exists example_dialogue;
alter table characters drop column if exists greetings;

-- Tighten runtime lifecycle: status must be present and one of the known lifecycle values.
alter table characters alter column status set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'characters_status_check') then
    alter table characters add constraint characters_status_check check (status in ('transient','permanent','inactive'));
  end if;
end $$;

commit;
