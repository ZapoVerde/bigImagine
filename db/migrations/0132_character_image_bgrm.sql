-- Character-image BGRM persistence (docs/plans/bgrm/3_IMPLEMENTATION_PLAN.md Task 2.1).
-- Both feature toggles are opt-in: an absent setting is interpreted as false by their callers.
-- Existing character visual combinations are raw assets, so the new state column defaults false.

alter table orchestrator_settings drop constraint if exists orchestrator_settings_key_check;
alter table orchestrator_settings add constraint orchestrator_settings_key_check check (key in (
  'active_llm_profile', 'active_llm_model', 'household_timezone', 'llm_vision_capable_profiles',
  'ntfy_server_url', 'notifications_enabled', 'agent_routines_enabled',
  'agent_routine_max_runs_per_day', 'agent_routine_max_tokens_per_day', 'agent_routines_disabled_reason',
  'chat_memory_profile', 'chat_memory_live_window_pairs', 'chat_memory_sync_every_pairs',
  'chat_memory_digest_horizon_pairs', 'chat_memory_chunk_pairs', 'chat_memory_chunk_summary_prompt',
  'chat_memory_distill_prompt', 'chat_memory_household_memory_prompt', 'chat_memory_bridge_prompt', 'chat_memory_world_curator_prompt',
  'chat_memory_people_curator_prompt', 'chat_memory_auto_recall_enabled', 'chat_memory_auto_recall_pairs',
  'chat_memory_auto_recall_chunk_top_k', 'chat_memory_auto_recall_chunk_min',
  'chat_memory_auto_recall_pool_multiple', 'chat_memory_auto_recall_cutoff_mode',
  'chat_memory_plot_recall_top_k', 'chat_memory_plot_recall_min', 'chat_memory_plot_recall_floor_syncs',
  'chat_memory_inject_bridge_prompt', 'chat_memory_inject_plot_prompt', 'chat_memory_inject_auto_recall_prompt',
  'chat_memory_auto_recall_chunk_prompt', 'chat_memory_auto_recall_lead_in_chunks',
  'chat_memory_auto_recall_lead_in_prompt', 'chat_memory_inject_recent_history_prompt',
  'chat_memory_inject_sync_summaries_prompt', 'chat_memory_sync_summary_entry_prompt',
  'canon_recall_top_k', 'canon_recall_min', 'canon_extraction_prompt', 'screen_lock_password',
  'screen_lock_timeout_minutes', 'pia_proxy_url', 'persona_name', 'persona_description',
  'llm_gate_max_concurrent', 'llm_gate_max_concurrent_agent_routine', 'llm_gate_max_concurrent_background',
  'llm_gate_max_retries', 'llm_gate_retry_base_ms', 'llm_gate_retry_max_ms', 'image_prompt_template',
  'chat_background_parallax', 'cleanup_header_regex', 'cleanup_header_prompt', 'cleanup_footer_regex',
  'cleanup_footer_prompt', 'chat_background_overlay_opacity', 'chat_background_overlay_shade',
  'chat_background_bubble_opacity', 'chat_background_bubble_user_shade', 'chat_background_bubble_assistant_shade',
  'chat_legibility_halo', 'chat_legibility_outline', 'chat_legibility_solid_code', 'chat_legibility_weight',
  'chat_legibility_hover_focus', 'chat_legibility_halo_strength', 'location_describer_prompt',
  'location_describer_history_pairs', 'character_describer_prompt', 'character_describer_history_pairs',
  'location_split_enabled', 'location_injection_enabled', 'location_injection_prompt',
  'background_tod_variants_enabled', 'lorebook_mode', 'lorebook_token_budget', 'lorebook_recall_top_k',
  'lorebook_recursion_enabled', 'reasoning_open_tag', 'reasoning_close_tag', 'visual_layer_stack',
  'visual_mutation_candidate_count', 'visual_mutation_system_prompt_override',
  'visual_reflection_system_prompt_override', 'visual_wiki_investigation_max_turns',
  'visual_wiki_context_budget', 'visual_portraits_enabled', 'portrait_subject_describer_prompt',
  'portrait_llm_connection', 'portrait_slot_bootstrap_prompt', 'character_visual_state_enabled',
  'portrait_bgrm_enabled', 'character_visual_bgrm_enabled'
));

alter table character_visual_combinations
  add column bgrm_applied boolean not null default false;

alter table character_visual_combinations
  drop constraint if exists character_visual_combinations_user_id_chat_id_character_id_outfit_key_expression_key_key;
alter table character_visual_combinations
  drop constraint if exists character_visual_combinations_user_id_chat_id_character_id_outf;
alter table character_visual_combinations
  drop constraint if exists character_visual_combinations_user_id_chat_id_character_id__key;

alter table character_visual_combinations
  add constraint character_visual_combinations_identity
  unique (user_id, chat_id, character_id, outfit_key, expression_key, bgrm_applied);
