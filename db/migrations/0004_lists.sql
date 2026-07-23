-- Generic lists (Phase 8 prerequisite) — applied by hand, same as 0003:
--   psql -U bigbrain_admin -d bigbrain -f /docker-entrypoint-initdb.d/0004_lists.sql
-- (bigbrain_admin, not bigbrain_app — CREATE TABLE needs owner/superuser privileges bigbrain_app
-- was deliberately never granted.)
--
-- A todo-list primitive, deliberately domain-agnostic: "Grocery List", "Home Depot Run", "Books
-- to Read" are all just a `lists` row with a name and optional tags, not separate tables. tags is
-- informational only (e.g. lets Notion sync target "everything tagged shopping") — it does not
-- trigger any side effect. Marking an item done is just recorded as an event (status +
-- completed_at); it deliberately does NOT feed shopping_logs or any inventory/pantry concept —
-- decided against building that until there's an actual use for it (see spec.md discussion).
-- shopping_logs (Phase 6) stays fed only by the explicit log_purchase tool, entirely independent
-- of this table.

create table lists (
  list_id    uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(user_id),
  name       text not null,
  tags       text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table list_items (
  item_id      uuid primary key default gen_random_uuid(),
  list_id      uuid not null references lists(list_id),
  user_id      uuid not null references users(user_id), -- denormalized so RLS applies directly, no join needed
  item_name    text not null,
  status       text not null default 'pending', -- 'pending' | 'done'
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

do $$
declare
  t text;
begin
  foreach t in array array['lists', 'list_items']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy user_scoped on %I using (user_id = app_current_user_id()) with check (user_id = app_current_user_id())',
      t
    );
  end loop;
end $$;

grant select, insert, update, delete on lists, list_items to bigbrain_app;
