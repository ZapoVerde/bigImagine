-- Store-layout-ordered list sections. Applied by hand, same as 0003-0006:
--   psql -U bigbrain_admin -d bigbrain -f /docker-entrypoint-initdb.d/0007_list_sections.sql
--
-- A list can optionally define section_order (e.g. a grocery store's actual aisle sequence, in
-- the order you walk it) — plain text, no fixed enum, since store layouts are arbitrary and
-- change. Empty by default: a list with no section_order defined behaves exactly as before
-- (get_list_items falls back to created_at order). list_items.section is nullable and only ever
-- set for lists that have opted into an order, classified once at insert time (see
-- classifySection.ts in both plugins/lists and plugins/recipes) — not backfilled for items added
-- before an order existed.
alter table lists add column section_order text[] not null default '{}';
alter table list_items add column section text;
