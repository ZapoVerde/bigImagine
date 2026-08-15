-- Adds the sync_summaries prompt-stack component's two settings
-- (docs/plans/sync-summaries-plan.md Step 4):
--
--   chat_memory_inject_sync_summaries_prompt  text — the outer wrapper template for the
--                                             sync_summaries marker, mirroring
--                                             chat_memory_inject_auto_recall_prompt
--                                             ({{#if text}}...{{/if}}, empty collapses to
--                                             nothing). Empty string = the built-in default
--                                             (DEFAULT_INJECT_SYNC_SUMMARIES_PROMPT,
--                                             memoryInjection.ts).
--
--   chat_memory_sync_summary_entry_prompt     text — the per-entry template for a bare
--                                             sync-summary row (a chunk archived since the
--                                             last bridge tick that RAG did not also select);
--                                             {{text}} = the chunk's summary. Its own setting,
--                                             NOT a reuse of chat_memory_auto_recall_lead_in_
--                                             prompt (lead-ins stay reserved for auto_recall's
--                                             deep-archive picks). Empty string = the built-in
--                                             default (DEFAULT_SYNC_SUMMARY_ENTRY_PROMPT).
--
-- No schema change — chat_sync_points / chat_chunks already carry everything the lane reads.
--
-- Applied by hand against the dedicated BigImagine database, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0104_sync_summaries.sql
--
-- The key list below is the *complete* current vocabulary (every key 0010-0103 added), not just
-- the diff — the CHECK constraint is rebuilt wholesale, so a fresh volume must land on the same
-- constraint the live DB has (the 0092/0095/0097/0099/0100 precedent). Live-DB state is the source
-- of truth; verified against pg_get_constraintdef before writing this file.
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
  'chat_memory_chunk_pairs',
  'chat_memory_chunk_summary_prompt',
  'chat_memory_distill_prompt',
  'chat_memory_household_memory_prompt',
  'chat_memory_bridge_prompt',
  'chat_memory_world_curator_prompt',
  'chat_memory_people_curator_prompt',
  'chat_memory_auto_recall_enabled',
  'chat_memory_auto_recall_pairs',
  'chat_memory_auto_recall_chunk_top_k',
  'chat_memory_auto_recall_chunk_min',
  'chat_memory_auto_recall_pool_multiple',
  'chat_memory_auto_recall_cutoff_mode',
  'chat_memory_plot_recall_top_k',
  'chat_memory_plot_recall_min',
  'chat_memory_plot_recall_floor_syncs',
  'chat_memory_inject_bridge_prompt',
  'chat_memory_inject_plot_prompt',
  'chat_memory_inject_auto_recall_prompt',
  'chat_memory_auto_recall_chunk_prompt',
  'chat_memory_auto_recall_lead_in_chunks',
  'chat_memory_auto_recall_lead_in_prompt',
  'chat_memory_inject_recent_history_prompt',
  'chat_memory_inject_sync_summaries_prompt',
  'chat_memory_sync_summary_entry_prompt',
  'canon_recall_top_k',
  'canon_recall_min',
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
  'location_injection_prompt',
  'lorebook_mode',
  'lorebook_token_budget',
  'lorebook_recall_top_k',
  'lorebook_recursion_enabled',
  'reasoning_open_tag',
  'reasoning_close_tag'
));
