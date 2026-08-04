-- Reusable, ordered "prompt stack" presets — a saveable, named list of which slots (card fields +
-- BI additions) go into an assembled turn, and in what order — applied by hand, same as
-- 0009/0011/0012:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0042_context_stack_presets.sql
-- (bigbrain_admin, not bigbrain_app — CREATE TABLE needs owner privileges bigbrain_app was
-- deliberately never granted.)
--
-- This is the "Prompt Stack Assembler" spec.md §5 step 2 and bi_principles.md §17 already name —
-- today that assembly order is a hardcoded constant; this table makes it saveable, swappable data
-- instead, without touching §17's purity requirement: the assembler itself
-- (plugins/context-stack-presets's assemblePromptStack) stays a Pure Function taking a preset's
-- slots plus a plain scene/character `fields` object — it never queries this table itself. Whatever
-- resolves which preset applies to a turn (an Orchestrator, once scenes/characters exist per
-- docs/bootstrap.md) reads context_stack_slots and hands the array in.
--
-- marker_key's vocabulary deliberately mirrors the V2/V3 character card spec fields
-- (system/description/personality/scenario/mes_example/post_history_instructions) plus BI's own
-- narrative additions (global_rules/location/canon_facts/memory_recall/recent_history) — so a
-- character imported straight from a card, with zero BI-specific config, still assembles into a
-- coherent default stack immediately; no separate card-field-to-slot mapping layer needed.
--
-- context_stack_slots is a child table (not one jsonb array column on the preset) so slot rows can
-- be queried/ordered by SQL directly if a future admin surface needs that; the plugin layer
-- (plugins/context-stack-presets) still moves a whole preset's slots as one JSON array in/out of
-- its create/update tools, same "whole small object at a time" shape prompt_presets uses for its
-- own single content field.
--
-- Assignment (scenes.manager_context_stack_preset_id / characters.context_stack_preset_id, the
-- manager/client resolution: character override ?? scene default ?? builtin) is deliberately NOT
-- part of this migration — scenes/characters don't exist yet (docs/bootstrap.md), and presets are
-- independently useful (named, orderable slot lists) without anything to assign them to yet. See
-- docs/spec.md's Context Stack Presets section for the deferred assignment shape.

create table context_stack_presets (
  preset_id  uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(user_id),
  name       text not null,
  is_builtin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index context_stack_presets_by_user_updated on context_stack_presets (user_id, updated_at desc);

create table context_stack_slots (
  slot_id       uuid primary key default gen_random_uuid(),
  preset_id     uuid not null references context_stack_presets(preset_id) on delete cascade,
  position      integer not null,
  slot_type     text not null check (slot_type in ('marker', 'custom')),
  -- Required (and only meaningful) when slot_type = 'marker'; null for 'custom'. Kept as an open
  -- text column rather than its own CHECK-enforced closed vocabulary (unlike slot_type) since this
  -- list is expected to grow as the narrative engine (scenes/characters/canon_facts) actually
  -- lands — the assembler itself already treats an unrecognized/absent marker_key as "nothing to
  -- emit for this slot" rather than an error, so widening this list is additive, not breaking.
  marker_key    text,
  enabled       boolean not null default true,
  -- Required (and only meaningful) when slot_type = 'custom'; null for 'marker'.
  custom_role   text check (custom_role is null or custom_role in ('system', 'user', 'assistant')),
  custom_content text,
  constraint context_stack_slots_marker_shape check (
    (slot_type = 'marker' and marker_key is not null and custom_role is null and custom_content is null) or
    (slot_type = 'custom' and marker_key is null and custom_role is not null and custom_content is not null)
  )
);
create unique index context_stack_slots_preset_position on context_stack_slots (preset_id, position);

-- Deliberately four command-scoped policies here, not one ALL policy with an is_builtin bypass in
-- USING (unlike 0002/0009/0012's identical single-policy-per-table loop) — USING alone governs
-- DELETE (there's no WITH CHECK for delete), so a single USING clause wide enough to let everyone
-- *read* a builtin row would just as easily let anyone *delete* it. Splitting by command keeps the
-- bypass exactly where it's needed (read) and nowhere else (write): is_builtin rows are owned by a
-- fixed system user (see the seed block below), and user_id = app_current_user_id() alone would
-- hide them from every real user, not just other users' rows — a shipped default has to be
-- readable by everyone, but only bigbrain_admin (which bypasses RLS entirely as the migration
-- role) ever creates, edits, or removes one.
alter table context_stack_presets enable row level security;
alter table context_stack_presets force row level security;
create policy select_own_or_builtin on context_stack_presets
  for select using (user_id = app_current_user_id() or is_builtin = true);
create policy insert_own on context_stack_presets
  for insert with check (user_id = app_current_user_id());
create policy update_own on context_stack_presets
  for update using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
create policy delete_own on context_stack_presets
  for delete using (user_id = app_current_user_id());

-- context_stack_slots has no user_id or is_builtin of its own — it's scoped transitively through
-- its parent preset_id (same shape chat_messages' RLS predates before that table denormalized
-- user_id onto itself for query convenience; this table doesn't need that optimization since it's
-- always read alongside its parent preset, never searched independently). Same command-split
-- reasoning as the parent table applies here too: only the select policy's join checks
-- p.is_builtin, so a builtin preset's slots are readable by everyone but insertable/updatable/
-- deletable only through the owning user's own preset_id.
alter table context_stack_slots enable row level security;
alter table context_stack_slots force row level security;
create policy select_own_or_builtin on context_stack_slots
  for select using (
    exists (
      select 1 from context_stack_presets p
      where p.preset_id = context_stack_slots.preset_id
        and (p.user_id = app_current_user_id() or p.is_builtin = true)
    )
  );
create policy insert_own on context_stack_slots
  for insert with check (
    exists (select 1 from context_stack_presets p where p.preset_id = context_stack_slots.preset_id and p.user_id = app_current_user_id())
  );
create policy update_own on context_stack_slots
  for update
  using (
    exists (select 1 from context_stack_presets p where p.preset_id = context_stack_slots.preset_id and p.user_id = app_current_user_id())
  )
  with check (
    exists (select 1 from context_stack_presets p where p.preset_id = context_stack_slots.preset_id and p.user_id = app_current_user_id())
  );
create policy delete_own on context_stack_slots
  for delete using (
    exists (select 1 from context_stack_presets p where p.preset_id = context_stack_slots.preset_id and p.user_id = app_current_user_id())
  );

grant select, insert, update, delete on context_stack_presets, context_stack_slots to bigbrain_app;

-- Shipped built-ins (is_builtin = true) — owned by a fixed system user (never a real account) so
-- the read-side RLS bypass above has a concrete row to key off; bigbrain_admin inserts these
-- directly (this migration's own privilege level). bigbrain_app never writes is_builtin = true
-- rows in practice (enforced by application logic in the plugin, not a DB constraint — the
-- write-side `with check` above already blocks it from writing a row it doesn't own at all, so a
-- second, redundant is_builtin check here would just be belt-and-suspenders on top of that).
do $$
declare
  system_user_id uuid := '00000000-0000-0000-0000-000000000000';
  standard_preset_id uuid;
  minimal_preset_id uuid;
begin
  if not exists (select 1 from users where user_id = system_user_id) then
    insert into users (user_id, name) values (system_user_id, 'system');
  end if;

  insert into context_stack_presets (preset_id, user_id, name, is_builtin)
  values (gen_random_uuid(), system_user_id, 'Standard', true)
  returning preset_id into standard_preset_id;

  insert into context_stack_slots (preset_id, position, slot_type, marker_key, enabled)
  values
    (standard_preset_id, 0, 'marker', 'system', true),
    (standard_preset_id, 1, 'marker', 'global_rules', true),
    (standard_preset_id, 2, 'marker', 'description', true),
    (standard_preset_id, 3, 'marker', 'personality', true),
    (standard_preset_id, 4, 'marker', 'scenario', true),
    (standard_preset_id, 5, 'marker', 'location', true),
    (standard_preset_id, 6, 'marker', 'canon_facts', true),
    (standard_preset_id, 7, 'marker', 'mes_example', true),
    (standard_preset_id, 8, 'marker', 'memory_recall', true),
    (standard_preset_id, 9, 'marker', 'recent_history', true),
    (standard_preset_id, 10, 'marker', 'post_history_instructions', true);

  insert into context_stack_presets (preset_id, user_id, name, is_builtin)
  values (gen_random_uuid(), system_user_id, 'Minimal', true)
  returning preset_id into minimal_preset_id;

  insert into context_stack_slots (preset_id, position, slot_type, marker_key, enabled)
  values
    (minimal_preset_id, 0, 'marker', 'system', true),
    (minimal_preset_id, 1, 'marker', 'description', true),
    (minimal_preset_id, 2, 'marker', 'scenario', true),
    (minimal_preset_id, 3, 'marker', 'recent_history', true);
end $$;
