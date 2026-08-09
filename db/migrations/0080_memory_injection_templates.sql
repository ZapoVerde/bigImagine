-- Widens orchestrator_settings.key's CHECK constraint with the RP memory component-split
-- injection templates (io/chatMemory/memoryInjection.ts — the 2026-08-13 user direction: the
-- monolithic memory_recall block is replaced by three independently orderable prompt-stack
-- markers, bridge / plot_threads / auto_recall, each rendered from its own user-editable
-- template, CNZ-style {{var}}/{{#if}} interpolation):
--   chat_memory_inject_bridge_prompt      template for the `bridge` marker — {{scene}} and
--                                          {{events}} (the bridge's two chat_memory_entries rows,
--                                          combined as in SillyTavern-Canonize's summary prompt)
--   chat_memory_inject_plot_prompt        template for the `plot_threads` marker — {{plot}} (the
--                                          approved plot arcs, one "- #arc: summary — detail" each)
--   chat_memory_inject_auto_recall_prompt template for the `auto_recall` marker — {{text}} (chunk
--                                          blocks) + {{facts}} (fact bullets), CNZ's
--                                          DEFAULT_RAG_INJECTION_TEMPLATE shape
--   chat_memory_auto_recall_chunk_prompt  per-chunk template inside auto_recall — {{text}},
--                                          {{turn_range}}, {{header}}, {{char_name}}, CNZ's
--                                          DEFAULT_RAG_CHUNK_TEMPLATE shape
-- The templates are read live on every RP prompt assembly (buildNarratorStackItems), so a save
-- takes effect on the next turn with no restart. The deprecated `memory_recall` marker remains
-- as a fused alias of all three for presets that haven't migrated; `chat_memory_auto_recall_*`
-- knobs already exist in the CHECK. Applied by hand against the dedicated BigImagine database,
-- same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0080_memory_injection_templates.sql
-- The key list below is the *complete* current vocabulary (every key 0010–0079 added), not just
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
  'chat_memory_inject_bridge_prompt',
  'chat_memory_inject_plot_prompt',
  'chat_memory_inject_auto_recall_prompt',
  'chat_memory_auto_recall_chunk_prompt',
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
  'location_describer_history_pairs'
));
