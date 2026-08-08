-- Widens orchestrator_settings.key's CHECK constraint with the five chat-background FX
-- settings (io/orchestratorSettings.ts, the ChatView location-background controls): the dimming
-- veil over the background image and the bubble fill opacity/shades. Companion to 0069's
-- chat_background_parallax — together they are the Settings tab's "Chat Background" fieldset,
-- read live by the frontend at chat load via GET /v1/chat-background-settings (same no-restart
-- shape as household_timezone — fetched fresh, never baked in at boot), written by the
-- admin-gated SettingsView fieldset.
--
-- The five keys:
--   chat_background_overlay_opacity  — the veil's strength, text '0'..'1', default 0.5 when
--                                      unset (the pre-0073 resting bg dimming, now a real layer)
--   chat_background_overlay_shade    — the veil's color, text hex '#rrggbb', default '#000000'
--   chat_background_bubble_opacity   — bubble background alpha, text '0'..'1', default 0.7 (the
--                                      old hardcoded rgba alpha)
--   chat_background_bubble_user_shade       — user bubble fill, text hex, default '#4f46e5'
--   chat_background_bubble_assistant_shade  — assistant bubble fill, text hex, default '#26272c'
-- (the last two default to the dark-theme bubble colors — this is a single-user build on the
-- dark theme; unset means "use the theme tokens", and the theme's own defaults stay the light-
-- theme values in tokens.css until the user first saves the fieldset.)
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0073_chat_background_fx_settings.sql
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
  'chat_background_bubble_assistant_shade'
));
