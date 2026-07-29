-- Per-list opt-in for the priority/due-date controls (docs/spec.md's "Addition — per-list
-- show_priority/show_due_dates"). Applied by hand, same as 0003-0040:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0041_list_display_flags.sql
--
-- Both default false: an existing list (or a brand-new one) shows neither control until someone
-- opts in from the specialist Lists view, same "off unless explicitly turned on" shape as
-- section_order (db/migrations/0007_list_sections.sql). This governs UI visibility only —
-- list_items.priority/due_at (0024_action_dates_priority.sql) stay settable via update_list_item
-- regardless, e.g. from a conversational "remind me to do X by Friday" on a list with the due-date
-- control switched off.

alter table lists add column show_priority boolean not null default false;
alter table lists add column show_due_dates boolean not null default false;
