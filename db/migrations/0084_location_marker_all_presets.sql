-- 0084: location marker slot in EVERY preset (not just builtins)
--
-- 0083 seeded the 'location' marker slot only into is_builtin presets. The user's
-- working preset (Comfy 2, a custom preset) never got it, so the always-on
-- "Active Location" marker slot was invisible in the Prompt Stacks list there.
-- The marker must be available from every preset — the user can untick or delete
-- it per-preset, but it has to be there to begin with (location.md §5 "always on").
--
-- Same shape as 0083's seed: position after the core markers, skip presets that
-- already have the slot, shift later slots up. No is_builtin guard this time.
-- The shift runs in DESCENDING position order (unlike 0083's single UPDATE, which
-- collides on the unique (preset_id, position) index whenever a preset has a
-- contiguous run at/above the insertion point — Comfy 2 does).
--
-- Hand-apply one-shot:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0084_location_marker_all_presets.sql

do $$
declare
  p record;
  q record;
  slot_pos integer;
begin
  for p in select preset_id from context_stack_presets
  loop
    if not exists (select 1 from context_stack_slots where preset_id = p.preset_id and marker_key = 'location') then
      select coalesce(max(position), -1) + 1 into slot_pos
      from context_stack_slots
      where preset_id = p.preset_id
        and marker_key in ('system', 'global_rules', 'description', 'personality', 'scenario', 'persona');
      for q in
        select slot_id from context_stack_slots
        where preset_id = p.preset_id and position >= slot_pos
        order by position desc
      loop
        update context_stack_slots set position = position + 1 where slot_id = q.slot_id;
      end loop;
      insert into context_stack_slots (preset_id, position, slot_type, marker_key, enabled)
      values (p.preset_id, slot_pos, 'marker', 'location', true);
    end if;
  end loop;
end $$;
