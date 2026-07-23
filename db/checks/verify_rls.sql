-- Proves RLS actually denies cross-user access, per bb_principles.md §4 and the Phase 1
-- build-order requirement ("must be provably correct before anything is built on top of it").
--
-- Run against the running stack, as the app role (NOT the superuser — RLS doesn't apply to
-- superusers, so testing as bigbrain_admin would prove nothing):
--   psql -h localhost -U bigbrain_app -d bigbrain -f db/checks/verify_rls.sql
--
-- Everything happens inside one rolled-back transaction, so it's safe to run against a real
-- database with no cleanup step and no risk of leaving test rows behind.

begin;

insert into users (user_id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'Bob')
on conflict do nothing;

set local app.current_user_id = '11111111-1111-1111-1111-111111111111';
insert into unstructured_notes (user_id, raw_text)
  values ('11111111-1111-1111-1111-111111111111', 'Alice''s private note');

set local app.current_user_id = '22222222-2222-2222-2222-222222222222';
insert into unstructured_notes (user_id, raw_text)
  values ('22222222-2222-2222-2222-222222222222', 'Bob''s private note');

-- As Bob: Alice's row must be invisible to a plain SELECT.
do $$
declare
  leaked_count int;
begin
  select count(*) into leaked_count from unstructured_notes where raw_text like 'Alice%';
  if leaked_count > 0 then
    raise exception 'RLS FAILURE: Bob''s session can see % of Alice''s row(s)', leaked_count;
  end if;
  raise notice 'RLS OK: cross-user read returned 0 rows';
end $$;

-- As Bob: inserting a row that claims to be Alice's must be rejected by the WITH CHECK clause.
do $$
declare
  did_insert boolean := false;
begin
  begin
    insert into unstructured_notes (user_id, raw_text)
      values ('11111111-1111-1111-1111-111111111111', 'Bob spoofing Alice');
    did_insert := true;
  exception
    when others then
      did_insert := false;
  end;

  if did_insert then
    raise exception 'RLS FAILURE: Bob was able to insert a row claiming to be Alice''s';
  end if;
  raise notice 'RLS OK: cross-user write correctly rejected';
end $$;

rollback;
