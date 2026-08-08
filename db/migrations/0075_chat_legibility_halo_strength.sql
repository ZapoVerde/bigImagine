-- Widens orchestrator_settings.key's CHECK constraint with chat_legibility_halo_strength
-- (io/orchestratorSettings.ts, the ChatView "Text legibility" menu's halo strength slider): the
-- intensity of the letter-halo ring, as text '0'..'1', default 0.6 when unset. The halo toggle
-- (0074) is a boolean on/off; this is the dial under it — the ring color's alpha, applied in
-- ChatView.css as `color-mix(in srgb, var(--color-bubble-*-halo) var(--halo-strength, 60%),
-- transparent)` so the per-theme halo colors keep their own alpha and the strength multiplies on
-- top. 0 = the ring is fully transparent (halo effectively off), 1 = the ring at full force (the
-- pre-0075 look, which read as too strong). Read live by the frontend at chat load via the same
-- GET /v1/chat-legibility-settings (no-restart shape), written by the admin-gated menu's slider
-- — household-wide, one value applies to all chats.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0075_chat_legibility_halo_strength.sql
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
