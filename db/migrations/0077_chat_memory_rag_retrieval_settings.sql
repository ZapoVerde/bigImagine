-- Widens orchestrator_settings.key's CHECK constraint with the RP read path's three retrieval
-- knobs (io/chatMemory/recallForPrompt.ts — the CNZ-style auto-recall shipped in f9b8dc6):
--   chat_memory_auto_recall_enabled      'true'/'false' (default 'true' — the silent per-turn
--                                         recall is on for 'rp' chats; 'false' turns it off
--                                         without disabling the recall tools themselves)
--   chat_memory_auto_recall_pairs        integer-as-text (default '3') — how many trailing
--                                         turn-pairs form the query, the knob behind the
--                                         AUTO_RECALL_PAIRS constant
--   chat_memory_auto_recall_chunk_top_k  integer-as-text (default '4') — how many archived
--                                         full-turn chunks are injected, the knob behind the
--                                         AUTO_RECALL_CHUNK_TOP_K constant
-- The read path was hardcoded constants (recallForPrompt.ts) because "a plain constant is a
-- sensible first cut"; this is the follow-up the code comment itself called for, keeping the
-- constants as the defaults. canon_recall_top_k (facts injected) already exists in the CHECK and
-- is read live — no new key needed for it. Applied by hand against the dedicated BigImagine
-- database, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0077_chat_memory_rag_retrieval_settings.sql
-- The key list below is the *complete* current vocabulary (every key 0010–0076 added), not just
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
  'chat_memory_lorebook_curator_prompt',
  'chat_memory_people_curator_prompt',
  'chat_memory_auto_recall_enabled',
  'chat_memory_auto_recall_pairs',
  'chat_memory_auto_recall_chunk_top_k',
  'canon_recall_top_k',
  'canon_extraction_prompt',
  'screen_lock_password',
  'screen_lock_timeout_minutes',
  'pia_proxy_url',
  'persona_name',
  'persona_description',
  'llm_gate_max_concurrent',
  'llm_gate_max_concurrent_agent_routine',
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
  'chat_legibility_halo_strength'
));
