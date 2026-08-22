-- Verifies the additive Cards/runtime Characters foundation after 0133 is applied.
-- Run as the application role against the deployed database; all assertions are rolled back:
--   psql -h localhost -U bigimagine_app -d bigimagine -f db/checks/verify_cards_runtime_characters_foundation.sql

begin;

select set_config('app.current_user_id', user_id::text, true)
from users
order by user_id
limit 1;

do $$
begin
  if current_setting('app.current_user_id', true) is null then
    raise exception 'Cards foundation check requires at least one user row';
  end if;
end $$;

do $$
begin
  if to_regclass('public.cards') is null
     or to_regclass('public.lorebook_card_links') is null then
    raise exception 'Cards foundation tables are missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'chat_sessions' and column_name = 'card_id'
  ) then
    raise exception 'chat_sessions.card_id is missing';
  end if;
  if not (
    has_table_privilege(current_user, 'cards', 'select,insert,update,delete')
    and has_table_privilege(current_user, 'lorebook_card_links', 'select,insert,update,delete')
  ) then
    raise exception 'Cards foundation grants are incomplete';
  end if;
  if not exists (
    select 1 from pg_class r
    join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public' and r.relname = 'cards'
      and r.relrowsecurity and r.relforcerowsecurity
  ) then
    raise exception 'Cards RLS is not enabled and forced';
  end if;
  if not exists (
    select 1 from pg_class r
    join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public' and r.relname = 'lorebook_card_links'
      and r.relrowsecurity and r.relforcerowsecurity
  ) then
    raise exception 'Card-lorebook RLS is not enabled and forced';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'cards_by_user_name')
     or not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'chat_sessions_by_card')
     or not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'lorebook_card_links_by_card') then
    raise exception 'Cards foundation indexes are incomplete';
  end if;
end $$;

do $$
declare
  card_fk_action "char";
begin
  select confdeltype into card_fk_action
  from pg_constraint
  where conrelid = 'chat_sessions'::regclass
    and contype = 'f'
    and conkey = array[
      (select attnum from pg_attribute where attrelid = 'chat_sessions'::regclass and attname = 'card_id'),
      (select attnum from pg_attribute where attrelid = 'chat_sessions'::regclass and attname = 'user_id')
    ]::smallint[];
  if card_fk_action is distinct from 'a' then
    raise exception 'chat_sessions.card_id must not delete chats via SET NULL';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'lorebook_card_links'::regclass
      and contype = 'p'
      and conkey = array[
        (select attnum from pg_attribute where attrelid = 'lorebook_card_links'::regclass and attname = 'lorebook_id'),
        (select attnum from pg_attribute where attrelid = 'lorebook_card_links'::regclass and attname = 'card_id')
      ]::smallint[]
  ) then
    raise exception 'Card-lorebook association primary key is incomplete';
  end if;
end $$;

-- The complete reusable/source payload must match exactly between the legacy Card bucket and the
-- additive canonical table. EXCEPT ALL also catches duplicate or missing rows.
do $$
begin
  if exists (
    (select character_id, user_id, name, persona, appearance, scenario, system_prompt, example_dialogue,
            greetings, avatar_path, spec_version, source_json, created_at, updated_at
     from characters where status is null)
    except all
    (select card_id, user_id, name, persona, appearance, scenario, system_prompt, example_dialogue,
            greetings, avatar_path, spec_version, source_json, created_at, updated_at
     from cards)
  ) or exists (
    (select card_id, user_id, name, persona, appearance, scenario, system_prompt, example_dialogue,
            greetings, avatar_path, spec_version, source_json, created_at, updated_at
     from cards)
    except all
    (select character_id, user_id, name, persona, appearance, scenario, system_prompt, example_dialogue,
            greetings, avatar_path, spec_version, source_json, created_at, updated_at
     from characters where status is null)
  ) then
    raise exception 'Cards foundation does not exactly preserve legacy Card rows';
  end if;
end $$;

-- Exercise the additive relationship shape with two independent chats from one Card, one fork,
-- two same-named runtime Characters, and a Card-owned lorebook. Everything is rolled back below.
create temporary table cards_foundation_fixture (
  card_id uuid not null,
  root_a uuid not null,
  fork_a uuid not null,
  root_b uuid not null,
  character_a uuid not null,
  character_b uuid not null,
  lorebook_id uuid not null
) on commit drop;

with ids as (
  select gen_random_uuid() as card_id, gen_random_uuid() as root_a, gen_random_uuid() as fork_a,
         gen_random_uuid() as root_b, gen_random_uuid() as character_a, gen_random_uuid() as character_b,
         gen_random_uuid() as lorebook_id
)
insert into cards_foundation_fixture
select * from ids;

insert into cards (card_id, user_id, name)
select card_id, current_setting('app.current_user_id')::uuid, 'Foundation fixture card'
from cards_foundation_fixture;
insert into characters (character_id, user_id, name, status)
select character_a, current_setting('app.current_user_id')::uuid, 'Sydney', 'transient'
from cards_foundation_fixture
union all
select character_b, current_setting('app.current_user_id')::uuid, 'Sydney', 'transient'
from cards_foundation_fixture;
insert into chat_sessions (chat_id, user_id, title, kind, card_id)
select root_a, current_setting('app.current_user_id')::uuid, 'Foundation A', 'rp', card_id
from cards_foundation_fixture
union all
select fork_a, current_setting('app.current_user_id')::uuid, 'Foundation A fork', 'rp', card_id
from cards_foundation_fixture
union all
select root_b, current_setting('app.current_user_id')::uuid, 'Foundation B', 'rp', card_id
from cards_foundation_fixture;
update chat_sessions s
set parent_chat_id = f.root_a
from cards_foundation_fixture f
where s.chat_id = f.fork_a;
insert into character_chat_links (character_id, chat_id)
select character_a, root_a from cards_foundation_fixture
union all
select character_a, fork_a from cards_foundation_fixture
union all
select character_b, root_b from cards_foundation_fixture;
insert into lorebooks (lorebook_id, user_id, name)
select lorebook_id, current_setting('app.current_user_id')::uuid, 'Foundation fixture lorebook'
from cards_foundation_fixture;
insert into lorebook_card_links (lorebook_id, card_id, user_id)
select lorebook_id, card_id, current_setting('app.current_user_id')::uuid
from cards_foundation_fixture;

do $$
begin
  if (select count(*) from chat_sessions s join cards_foundation_fixture f on s.card_id = f.card_id) <> 3 then
    raise exception 'Fixture did not create three Card-linked chats';
  end if;
  if exists (
    select 1 from character_chat_links a
    join character_chat_links b on a.character_id = b.character_id
    join cards_foundation_fixture f on a.character_id = f.character_a
    where a.chat_id = f.root_a and b.chat_id = f.root_b
  ) then
    raise exception 'Independent fixture chats share a runtime Character';
  end if;
  if (select count(*) from character_chat_links l join cards_foundation_fixture f on l.character_id = f.character_a) <> 2
     or (select count(*) from character_chat_links l join cards_foundation_fixture f on l.character_id = f.character_b) <> 1 then
    raise exception 'Fork/runtime Character membership fixture is incorrect';
  end if;
  if (select count(*) from lorebook_card_links l join cards_foundation_fixture f on l.card_id = f.card_id) <> 1 then
    raise exception 'Card-owned lorebook fixture is missing';
  end if;
end $$;

do $$
begin
  if exists (select 1 from characters c join cards x on x.card_id = c.character_id where c.status is not null) then
    raise exception 'Runtime Character row was copied into cards';
  end if;
  if exists (
    select 1
    from chat_sessions s
    join characters c on c.character_id = s.character_id
    where c.status is null and s.card_id is distinct from c.character_id
  ) then
    raise exception 'A legacy Card-backed chat has an incorrect card_id';
  end if;
  if exists (
    select 1
    from chat_sessions child
    join chat_sessions parent on parent.chat_id = child.parent_chat_id
    where child.card_id is distinct from parent.card_id
  ) then
    raise exception 'A fork does not preserve its parent card_id';
  end if;
end $$;

do $$
begin
  if exists (
    (select distinct lcl.lorebook_id, c.character_id, c.user_id
     from lorebook_character_links lcl
     join characters c on c.character_id = lcl.character_id
     where c.status is null)
    except
    (select lorebook_id, card_id, user_id from lorebook_card_links)
  ) or exists (
    (select lorebook_id, card_id, user_id from lorebook_card_links)
    except
    (select distinct lcl.lorebook_id, c.character_id, c.user_id
     from lorebook_character_links lcl
     join characters c on c.character_id = lcl.character_id
     where c.status is null)
  ) then
    raise exception 'Card-owned lorebook associations were not migrated exactly';
  end if;
end $$;

-- The foundation has no write path to runtime membership. Every existing link remains attached to
-- a real runtime character row and its chat; the later destructive cutover owns any cleanup.
do $$
begin
  if exists (
    select 1
    from character_chat_links l
    left join characters c on c.character_id = l.character_id
    left join chat_sessions s on s.chat_id = l.chat_id
    where c.character_id is null or s.chat_id is null
  ) then
    raise exception 'Runtime Character membership links were damaged';
  end if;
end $$;

rollback;
