-- Widens orchestrator_settings.key's CHECK constraint with the ranked plot-arc lane's three
-- knobs (docs/plans/plot-arc-recall-plan.md, shipped with io/chatMemory/recallPlotLane.ts):
--   chat_memory_plot_recall_top_k         integer-as-text (default '6') — the Max ceiling for
--                                           the silent plot recall: how many per-arc cards are
--                                           injected at most, fewer than the fact lane's 8
--                                           default since each result is a multi-entry card
--                                           (first entry + last three), not one line
--   chat_memory_plot_recall_min           integer-as-text (default '1') — the Min floor: how
--                                           many arcs are injected at minimum even when the pool
--                                           distribution says nothing clears the threshold
--   chat_memory_plot_recall_floor_syncs   integer-as-text (default '2') — the recency floor: an
--                                           arc touched in the chat's last N sync ticks
--                                           (chat_sync_points.ordinal recency) stays visible
--                                           regardless of score (Canonize's "supplemented by
--                                           recency-based filler")
-- The three keys are read live on every RP prompt assembly by recallForPrompt.ts alongside the
-- 0077/0091/0092 keys; unset or corrupt values fall back to the DEFAULT_PLOT_* constants in
-- recallForPrompt.ts (same fail-open shape as every other setting here). Like 0091's
-- pool_multiple/cutoff_mode they deliberately carry no plot_ prefix on the shared knobs — the
-- plot lane reuses chat_memory_auto_recall_pool_multiple / chat_memory_auto_recall_cutoff_mode
-- unchanged, mirroring Canonize's per-channel Min/Max + shared Pool Multiple/Cutoff Mode shape.
-- Applied by hand against the dedicated BigImagine database, same as every post-initdb
-- migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0097_plot_recall_bounds.sql
-- The key list below is the *complete* current vocabulary (every key 0010–0096 added), not just
-- the diff — the CHECK constraint is rebuilt wholesale, so a fresh volume must land on the same
-- constraint the live DB has. Live-DB state is the source of truth (confirmed via
-- pg_get_constraintdef after applying): 0092's list plus reasoning_open_tag/reasoning_close_tag
-- (0095), with the three new keys appended after chat_memory_auto_recall_cutoff_mode to sit with
-- the other auto-recall knobs.
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
  'chat_memory_plot_recall_top_k',
  'chat_memory_plot_recall_min',
  'chat_memory_plot_recall_floor_syncs',
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
  'lorebook_recursion_enabled',
  'reasoning_open_tag',
  'reasoning_close_tag'
));
