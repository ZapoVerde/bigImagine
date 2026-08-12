-- Widens orchestrator_settings.key's CHECK constraint with the canon_facts lane's Min floor for
-- the RAG dynamic cutoff (docs/plans/rag-dynamic-cutoff-plan.md, Stage 2 of the CNZ retrieval
-- port, applied on top of Stage 1's io/chatMemory/recallCutoff.ts):
--   canon_recall_min  integer-as-text (default '2') — the Min floor for the dynamic cutoff on
--                      the canon_facts lane of buildAutoRecallParts: how many approved facts are
--                      injected at minimum even when the pool distribution says nothing clears
--                      the threshold. The per-channel Max is the existing canon_recall_top_k
--                      (default '8'); the two shared knobs (chat_memory_auto_recall_pool_multiple,
--                      chat_memory_auto_recall_cutoff_mode, migration 0091) apply to the fact lane
--                      unchanged, exactly the per-channel Min/Max + shared Pool Multiple/Cutoff
--                      Mode split Stage 1's naming anticipated. Read live on every RP prompt
--                      assembly by recallForPrompt.ts; unset or corrupt values fall back to the
--                      DEFAULT_FACT_MIN constant (same fail-open shape as every other setting).
-- Applied by hand against the dedicated BigImagine database, same as every post-initdb
-- migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0092_canon_recall_min.sql
-- The key list below is the *complete* current vocabulary (every key 0010–0091 added), not just
-- the diff — the CHECK constraint is rebuilt wholesale, so a fresh volume must land on the same
-- constraint the live DB has. Live-DB state is the source of truth (confirmed via
-- pg_get_constraintdef after applying).
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
  'chat_memory_world_curator_prompt',
  'chat_memory_people_curator_prompt',
  'chat_memory_auto_recall_enabled',
  'chat_memory_auto_recall_pairs',
  'chat_memory_auto_recall_chunk_top_k',
  'chat_memory_auto_recall_chunk_min',
  'chat_memory_auto_recall_pool_multiple',
  'chat_memory_auto_recall_cutoff_mode',
  'chat_memory_inject_bridge_prompt',
  'chat_memory_inject_plot_prompt',
  'chat_memory_inject_auto_recall_prompt',
  'chat_memory_auto_recall_chunk_prompt',
  'chat_memory_inject_recent_history_prompt',
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
  'lorebook_recursion_enabled'
));
