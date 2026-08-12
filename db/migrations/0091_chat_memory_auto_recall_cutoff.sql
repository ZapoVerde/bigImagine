-- Widens orchestrator_settings.key's CHECK constraint with the RAG dynamic-cutoff's three knobs
-- (docs/plans/completed/rag-dynamic-cutoff-plan.md, Stage 1 of the CNZ retrieval port, shipped with
-- io/chatMemory/recallCutoff.ts):
--   chat_memory_auto_recall_chunk_min      integer-as-text (default '2') — the Min floor for the
--                                           dynamic chunk cutoff: how many archived full-turn
--                                           chunks are injected at minimum even when the pool
--                                           distribution says nothing clears the threshold
--                                           (Canonize's own ragChatMin default)
--   chat_memory_auto_recall_pool_multiple  float-as-text (default '2') — Pool Multiple P: the
--                                           candidate pool is P × Max (min 6), the pool the
--                                           cutoff measures before deciding how many of its
--                                           leading rows to keep (Canonize's ragPoolMultiple;
--                                           parsed as a float, not an integer — P is not
--                                           restricted to whole numbers either)
--   chat_memory_auto_recall_cutoff_mode    enum-as-text, one of 'mean' | 'mean+1sd' | 'mean+2sd'
--                                           (default 'mean') — how strict the threshold is, in
--                                           raw-distance space where lower is better: 'mean'
--                                           keeps everything closer than the pool's mean
--                                           distance; the two sd modes demand results stand
--                                           below mean − 1/2×σ (Canonize's ragCutoffMode)
-- The three keys are read live on every RP prompt assembly by recallForPrompt.ts alongside the
-- 0077-era keys; unset or corrupt values fall back to the constants in recallForPrompt.ts /
-- recallCutoff.ts (same fail-open shape as every other setting here). Like 0077's trio they
-- deliberately carry no chunk_/fact_ prefix on pool_multiple and cutoff_mode because Stage 2
-- reuses those two shared knobs unchanged for the canon_facts query, mirroring Canonize's own
-- settings shape (per-channel Min/Max, shared Pool Multiple/Cutoff Mode).
-- Applied by hand against the dedicated BigImagine database, same as every post-initdb
-- migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0091_chat_memory_auto_recall_cutoff.sql
-- The key list below is the *complete* current vocabulary (every key 0010–0090 added), not just
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
