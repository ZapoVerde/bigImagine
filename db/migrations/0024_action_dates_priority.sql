-- Action dates & priority (docs/spec.md's "Addition — action dates & priority on list_items;
-- reminder timestamps & lifecycle state on notes"). Applied by hand, same as 0003-0023:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0024_action_dates_priority.sql
--
-- All four columns are nullable (state excepted, which defaults to the no-op 'active') so an
-- existing list item or note that never opts into a due date/priority/reminder/pin behaves
-- exactly as it did before this migration.

alter table list_items add column due_at timestamptz;
alter table list_items add column priority text check (priority in ('P1', 'P2', 'P3'));

alter table notes add column reminder_at timestamptz;
alter table notes add column state text not null default 'active' check (state in ('active', 'pinned', 'archived'));
