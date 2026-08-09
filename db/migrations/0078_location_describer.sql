-- The room-description pass (docs/vistalyze_integration/describer.md): a new background LLM
-- step between the post-turn scraper and the image-gen pass (endpoint.md §5) that turns a
-- freshly-minted location's name-seeded visual_description into a real room description —
-- BigImagine's analogue of SillyTavern-Vistalyze's Step 3 Describer (pipeline.js
-- handleUnknownLocation -> detectDescriber). Applied by hand against the dedicated BigImagine
-- database, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0078_location_describer.sql
--
-- 1. locations.definition — the describer's logical-definition output (the "Definition:" half of
--    VLZ's Name/Definition/Visuals markers; the "Visuals:" half lands in the existing
--    visual_description column). Nullable, no default: only the describer pass and
--    create_location's optional argument write it. Model-facing getters (get_locations,
--    create_location) surface it per segway.md §2.6; the image pipeline ignores it entirely
--    (synthesizeImagePrompt expands only visual_description + environment).
--
-- 2. Two new orchestrator_settings keys, same "empty override means built-in default" shape as
--    image_prompt_template (bi_principles.md §18):
--      location_describer_prompt          the describer LLM prompt template; empty = the built-in
--                                         default exported by describeLocation.ts
--      location_describer_history_pairs   integer-as-text (default '1') — how many trailing
--                                         turn-pairs the describer reads as narrative context,
--                                         the knob behind VLZ's describerHistory
--    The key list below is the *complete* current vocabulary (every key 0010–0077 added), not
--    just the diff — the CHECK constraint is rebuilt wholesale, so a fresh volume must land on
--    the same constraint the live DB has. Live-DB state is the source of truth (confirmed via
--    pg_get_constraintdef after applying). Hand-apply one-shot — the `add column` and the
--    constraint rebuild are not individually idempotent (a re-run errors on the duplicate
--    column / duplicate constraint), so apply once and verify.
alter table locations add column definition text;

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
