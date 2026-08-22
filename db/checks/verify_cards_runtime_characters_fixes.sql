-- Verifies fixes for 4_ISSUES.md after 0135 is applied.
-- Run as the application role against the deployed database; all assertions are rolled back:
--   docker exec -i bigimagine-postgres psql -U bigimagine_app -d bigimagine -f db/checks/verify_cards_runtime_characters_fixes.sql

begin;

select set_config('app.current_user_id', user_id::text, true)
from users
order by user_id
limit 1;

do $$
begin
  if current_setting('app.current_user_id', true) is null then
    raise exception 'Fixes check requires at least one user row';
  end if;
end $$;

-- Issue 1: cards.card_id must have DB-side default gen_random_uuid()
do $$
declare
  def text;
begin
  select column_default into def
  from information_schema.columns
  where table_schema = 'public' and table_name = 'cards' and column_name = 'card_id';
  if def is null or def not ilike '%gen_random_uuid()%' then
    raise exception 'cards.card_id default gen_random_uuid() is missing (got %)', coalesce(def, 'null');
  end if;
end $$;

-- Issue 1: exercise the default with a real insert (rolled back) — this is the path the fake-pool
-- in plugins/cards/scripts/verify-cards.mjs was masking.
do $$
declare
  inserted_id uuid;
begin
  insert into cards (user_id, name) values (current_setting('app.current_user_id')::uuid, 'fixes check card')
  returning card_id into inserted_id;
  if inserted_id is null then
    raise exception 'cards insert without card_id did not generate an id';
  end if;
end $$;

-- Issue 2: rp chats must carry a card_id; plain chat-kind chats may stay null.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_sessions_rp_requires_card') then
    raise exception 'chat_sessions_rp_requires_card check is missing';
  end if;
  if exists (select 1 from chat_sessions where kind = 'rp' and card_id is null) then
    raise exception 'rp chat exists with null card_id';
  end if;
end $$;

-- Issue 3 is a doc-comment fix; no DB assertion. Confirm the stale string is gone from the source
-- is covered by the plugin build, but we assert no runtime shape regression here.

rollback;
