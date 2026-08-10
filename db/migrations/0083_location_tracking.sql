-- The Location Tracker (docs/vistalyze_integration/location.md) — the parent/sub "places ↔
-- locations" model plus the tracker's settings keys, built on Triggeryze's Location Tracker
-- pattern (stacks/sillytavern/st-extensions/SillyTavern-Triggeryze/docs/examples/location-tracker.json).
-- Applied by hand against the dedicated BigImagine database, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0083_location_tracking.sql
--
-- 1. locations.parent_location_id — the parent/sub link (location.md §2.1). A "place" (area,
--    e.g. "The Tavern") is a parent row; a "location" (specific room, e.g. "The Tavern - Kitchen")
--    is a sub row pointing at it. locations.name stays the full header string verbatim — the
--    parent name is derived by split (splitLocationName in the scraper) and the parent row's name
--    is that derived portion. on delete set null, not cascade: deleting a parent row leaves the
--    sub a standalone location (its full name still carries the parent prefix). Parent rows are
--    plain transient rows anchored to the same swipe as their first sub, so the existing lifecycle
--    applies unchanged: demoted to 'inactive' on swipe replace (chatMemorySync's tick), deleted on
--    chat delete via anchor_swipe_id's cascade (location.md §2.2).
--
-- 2. One-shot backfill (location.md §2.3) — legacy rows predate the split (the scraper stored
--    full "X - Y" names with no parent). For every row whose name contains " - " and whose
--    parent_location_id is null, resolve-or-create the parent row (name = the portion before the
--    first " - ", trimmed; reuse an existing same-named row of any status, else insert with
--    visual_description = parent_name — the never-described sentinel describer.md §2 uses — and
--    status/anchors/environment copied from the first sub processed). Deterministic order
--    (location_id) and the "parent_location_id is null" guard make repeated runs idempotent.
--
-- 3. Three new orchestrator_settings keys (location.md §2.4), same "empty override means built-in
--    default" shape as location_describer_prompt (bi_principles.md §18):
--      location_split_enabled      'true' — the scraper splits the header location into
--                                   parent/sub and sets parent_location_id; off = today's flat
--                                   behavior (reversible downgrade)
--      location_injection_enabled  'true' — the known-locations <locations> block in both seams
--                                   (the 'location' marker-slot value and the {{known_locations}}
--                                   header-repair token)
--      location_injection_prompt   '' — the <locations> block template; empty = the built-in
--                                   default exported by util/renderLocationBlock.ts
--    The key list below is the *complete* current vocabulary (every key 0010–0082 added, from
--    0081's rebuild — 0082 added no keys), not just the diff — the CHECK constraint is rebuilt
--    wholesale, so a fresh volume must land on the same constraint the live DB has.
--
-- 4. Builtin-preset 'location' marker slot (location.md §5.4) — the marker is always available
--    (0042 seeded Standard with it enabled at position 5, and frontend api/markerLabels.ts already
--    registers it as 'Active Location'), but Minimal and any other builtin preset lack the slot.
--    Insert an enabled 'location' slot into builtin presets that don't have one, at the canonical
--    position (after the last of the core markers system/global_rules/description/personality/
--    scenario/persona), shifting later slots up. Guarded to is_builtin presets only — a
--    customized user preset is never mutated (the marker stays available there in the picker).
--
-- Hand-apply one-shot — the add column, constraint rebuild and inserts are not individually
-- idempotent (a re-run errors on the duplicate column / duplicate constraint), so apply once and
-- verify. The backfill DO block IS idempotent by construction.

alter table locations add column parent_location_id uuid references locations(location_id) on delete set null;
create index locations_by_parent on locations (parent_location_id);

do $$
declare
  r record;
  parent_id uuid;
  parent_name text;
  row_user_id uuid;
begin
  for r in
    select location_id, user_id, name, status, anchor_chat_id, anchor_swipe_id, environment
    from locations
    where parent_location_id is null
      and position(' - ' in name) > 1
    order by location_id
  loop
    row_user_id := r.user_id;
    parent_name := trim(split_part(r.name, ' - ', 1));
    if parent_name = '' or parent_name = r.name then
      continue;
    end if;
    -- Resolve-or-create the parent row (any status — the area may already exist standalone).
    select location_id into parent_id
    from locations
    where user_id = row_user_id and name = parent_name
    limit 1;
    if parent_id is null then
      insert into locations (user_id, name, visual_description, environment, status, anchor_chat_id, anchor_swipe_id)
      values (row_user_id, parent_name, parent_name, r.environment, r.status, r.anchor_chat_id, r.anchor_swipe_id)
      returning location_id into parent_id;
    end if;
    update locations set parent_location_id = parent_id, updated_at = now()
    where location_id = r.location_id;
  end loop;
end $$;

alter table orchestrator_settings drop constraint if exists orchestrator_settings_key_check;
alter table orchestrator_settings add constraint orchestrator_settings_key_check check (key in (
  'active_llm_profile',
  'active_llm_model',
  'household_timezone',
  'llm_vision_capable_profiles',
  'ntfy_server_url',
  'notifications_enabled',
  'agent_routines_enabled',
  'agent_routine_max_runs_per_day',
  'agent_routine_max_tokens_per_day',
  'agent_routines_disabled_reason',
  'chat_memory_profile',
  'chat_memory_live_window_pairs',
  'chat_memory_sync_every_pairs',
  'chat_memory_digest_horizon_pairs',
  'chat_memory_chunk_summary_prompt',
  'chat_memory_distill_prompt',
  'chat_memory_household_memory_prompt',
  'chat_memory_bridge_prompt',
  'chat_memory_lorebook_curator_prompt',
  'chat_memory_people_curator_prompt',
  'chat_memory_auto_recall_enabled',
  'chat_memory_auto_recall_pairs',
  'chat_memory_auto_recall_chunk_top_k',
  'chat_memory_inject_bridge_prompt',
  'chat_memory_inject_plot_prompt',
  'chat_memory_inject_auto_recall_prompt',
  'chat_memory_auto_recall_chunk_prompt',
  'chat_memory_inject_recent_history_prompt',
  'canon_recall_top_k',
  'canon_extraction_prompt',
  'screen_lock_password',
  'screen_lock_timeout_minutes',
  'pia_proxy_url',
  'persona_name',
  'persona_description',
  'llm_gate_max_concurrent',
  'llm_gate_max_concurrent_agent_routine',
  'llm_gate_max_concurrent_background',
  'llm_gate_max_retries',
  'llm_gate_retry_base_ms',
  'llm_gate_retry_max_ms',
  'image_prompt_template',
  'chat_background_parallax',
  'cleanup_header_regex',
  'cleanup_header_prompt',
  'cleanup_footer_regex',
  'cleanup_footer_prompt',
  'chat_background_overlay_opacity',
  'chat_background_overlay_shade',
  'chat_background_bubble_opacity',
  'chat_background_bubble_user_shade',
  'chat_background_bubble_assistant_shade',
  'chat_legibility_halo',
  'chat_legibility_outline',
  'chat_legibility_solid_code',
  'chat_legibility_weight',
  'chat_legibility_hover_focus',
  'chat_legibility_halo_strength',
  'location_describer_prompt',
  'location_describer_history_pairs',
  'location_split_enabled',
  'location_injection_enabled',
  'location_injection_prompt'
));

-- Ensure every builtin preset carries an enabled 'location' marker slot (location.md §5.4).
do $$
declare
  p record;
  slot_pos integer;
begin
  for p in select preset_id from context_stack_presets where is_builtin loop
    if not exists (select 1 from context_stack_slots where preset_id = p.preset_id and marker_key = 'location') then
      select coalesce(max(position), -1) + 1 into slot_pos
      from context_stack_slots
      where preset_id = p.preset_id
        and marker_key in ('system', 'global_rules', 'description', 'personality', 'scenario', 'persona');
      update context_stack_slots set position = position + 1
      where preset_id = p.preset_id and position >= slot_pos;
      insert into context_stack_slots (preset_id, position, slot_type, marker_key, enabled)
      values (p.preset_id, slot_pos, 'marker', 'location', true);
    end if;
  end loop;
end $$;
