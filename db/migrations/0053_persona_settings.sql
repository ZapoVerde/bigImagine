-- Widens orchestrator_settings.key's CHECK constraint for persona_name/persona_description
-- (io/orchestratorSettings.ts, plugins/context-stack-presets) — the household's own name and
-- self-description, the BigImagine analogue of SillyTavern's user persona ({{user}}/{{persona}}).
-- Same live-read, no-restart, read-back-in-full shape as household_timezone/screen_lock_password:
-- not a secret, just text an admin can set and see. Consumed by applyPromptStackToChatTool.ts to
-- populate the 'persona' prompt-stack marker slot (assemblePromptStack.ts) added alongside this
-- migration — see docs/prompt-macros.md's Stage 1.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0053_persona_settings.sql
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
  'canon_recall_top_k',
  'canon_extraction_prompt',
  'screen_lock_password',
  'screen_lock_timeout_minutes',
  'pia_proxy_url',
  'persona_name',
  'persona_description'
));
