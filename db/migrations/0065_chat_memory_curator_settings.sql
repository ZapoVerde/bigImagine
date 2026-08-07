-- Widens orchestrator_settings.key's CHECK constraint with chat_memory_lorebook_curator_prompt and
-- chat_memory_people_curator_prompt (io/orchestratorSettings.ts, io/chatMemory/curateLorebook.ts,
-- curatePeople.ts): the 'rp'-kind sync lane's two periodic curator prompts (place/thing/concept and
-- person respectively), same "default + bespoke" override shape as chat_memory_bridge_prompt but
-- separate keys since they're separate LLM calls with separate prompts. Applied by hand against the
-- dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0065_chat_memory_curator_settings.sql
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
  'llm_gate_retry_max_ms'
));
