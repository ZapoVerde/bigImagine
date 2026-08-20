-- Persistent location + optional time-of-day background identities. Existing location image URLs
-- are preserved as base combinations; the legacy columns remain for a later cleanup migration.

create table location_image_combinations (
  combination_id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(location_id) on delete cascade,
  time_of_day_key text null,
  image_url text not null,
  image_generated_at timestamptz not null default now(),
  rendered_prompt text null,
  provider_kind text null,
  provider_model text null,
  seed bigint null,
  render_metadata jsonb null
);

create unique index location_image_combinations_base_uq
  on location_image_combinations (location_id) where time_of_day_key is null;
create unique index location_image_combinations_tod_uq
  on location_image_combinations (location_id, time_of_day_key) where time_of_day_key is not null;

alter table location_image_combinations enable row level security;
alter table location_image_combinations force row level security;
create policy user_scoped on location_image_combinations using (
  exists (select 1 from locations l
          where l.location_id = location_image_combinations.location_id
            and l.user_id = app_current_user_id())
) with check (
  exists (select 1 from locations l
          where l.location_id = location_image_combinations.location_id
            and l.user_id = app_current_user_id())
);
grant select, insert, update, delete on location_image_combinations to bigimagine_app;

insert into location_image_combinations (location_id, time_of_day_key, image_url, image_generated_at)
select location_id, null, image_url, coalesce(image_generated_at, now())
from locations
where image_url is not null
on conflict do nothing;

alter table location_swipe_images add column combination_id uuid
  references location_image_combinations(combination_id) on delete set null;

update location_swipe_images swi
set combination_id = c.combination_id
from location_image_combinations c
where c.location_id = swi.location_id
  and c.time_of_day_key is null
  and swi.combination_id is null
  and swi.image_url = c.image_url;

alter table orchestrator_settings drop constraint if exists orchestrator_settings_key_check;
alter table orchestrator_settings add constraint orchestrator_settings_key_check check (key in (
  'active_llm_profile', 'active_llm_model', 'household_timezone', 'llm_vision_capable_profiles',
  'ntfy_server_url', 'notifications_enabled', 'agent_routines_enabled',
  'agent_routine_max_runs_per_day', 'agent_routine_max_tokens_per_day', 'agent_routines_disabled_reason',
  'chat_memory_profile', 'chat_memory_live_window_pairs', 'chat_memory_sync_every_pairs',
  'chat_memory_digest_horizon_pairs', 'chat_memory_chunk_pairs', 'chat_memory_chunk_summary_prompt',
  'chat_memory_distill_prompt', 'chat_memory_household_memory_prompt', 'chat_memory_bridge_prompt',
  'chat_memory_world_curator_prompt', 'chat_memory_people_curator_prompt', 'chat_memory_auto_recall_enabled',
  'chat_memory_auto_recall_pairs', 'chat_memory_auto_recall_chunk_top_k', 'chat_memory_auto_recall_chunk_min',
  'chat_memory_auto_recall_pool_multiple', 'chat_memory_auto_recall_cutoff_mode', 'chat_memory_plot_recall_top_k',
  'chat_memory_plot_recall_min', 'chat_memory_plot_recall_floor_syncs', 'chat_memory_inject_bridge_prompt',
  'chat_memory_inject_plot_prompt', 'chat_memory_inject_auto_recall_prompt', 'chat_memory_auto_recall_chunk_prompt',
  'chat_memory_auto_recall_lead_in_chunks', 'chat_memory_auto_recall_lead_in_prompt',
  'chat_memory_inject_recent_history_prompt', 'chat_memory_inject_sync_summaries_prompt',
  'chat_memory_sync_summary_entry_prompt', 'canon_recall_top_k', 'canon_recall_min', 'canon_extraction_prompt',
  'screen_lock_password', 'screen_lock_timeout_minutes', 'pia_proxy_url', 'persona_name', 'persona_description',
  'llm_gate_max_concurrent', 'llm_gate_max_concurrent_agent_routine', 'llm_gate_max_concurrent_background',
  'llm_gate_max_retries', 'llm_gate_retry_base_ms', 'llm_gate_retry_max_ms', 'image_prompt_template',
  'chat_background_parallax', 'cleanup_header_regex', 'cleanup_header_prompt', 'cleanup_footer_regex',
  'cleanup_footer_prompt', 'chat_background_overlay_opacity', 'chat_background_overlay_shade',
  'chat_background_bubble_opacity', 'chat_background_bubble_user_shade', 'chat_background_bubble_assistant_shade',
  'chat_legibility_halo', 'chat_legibility_outline', 'chat_legibility_solid_code', 'chat_legibility_weight',
  'chat_legibility_hover_focus', 'chat_legibility_halo_strength', 'location_describer_prompt',
  'location_describer_history_pairs', 'character_describer_prompt', 'character_describer_history_pairs',
  'location_split_enabled', 'location_injection_enabled', 'location_injection_prompt', 'lorebook_mode',
  'lorebook_token_budget', 'lorebook_recall_top_k', 'lorebook_recursion_enabled', 'reasoning_open_tag',
  'reasoning_close_tag', 'visual_layer_stack', 'visual_mutation_candidate_count',
  'visual_mutation_system_prompt_override', 'visual_reflection_system_prompt_override', 'visual_portraits_enabled',
  'portrait_subject_describer_prompt', 'portrait_llm_connection', 'portrait_slot_bootstrap_prompt',
  'visual_wiki_context_budget', 'visual_wiki_investigation_max_turns', 'character_visual_state_enabled',
  'background_tod_variants_enabled'
));
