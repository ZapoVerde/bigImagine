-- Widens orchestrator_settings.key's CHECK constraint for the screen-lock feature (docs/
-- bi_principles.md §12, §13, mirroring SillyTavern-Playground's driver/ui/lockScreen.js): an
-- idle-timeout overlay that re-prompts for a password while the tab stays open, layered on top of
-- the real household-key/Access auth in App.tsx rather than replacing it. screen_lock_password
-- is fetched and compared client-side in plaintext by design — like playground's, this is a
-- privacy shield for an unattended screen, not a second access-control boundary (the API itself
-- stays reachable regardless of lock state, same as every other request already gated by
-- authenticate()/isAdminAuthorized). It fails §12's "grants access on its own" secrecy test the
-- same way ntfy_server_url/household_timezone do: without the device itself (already past the
-- real auth gate), the password unlocks nothing. Unset (empty string, the default) disables the
-- feature entirely. screen_lock_timeout_minutes is the idle window in minutes before it re-locks.
--
-- Applied by hand against the dedicated BigImagine database (BigImagine is on its own
-- bigimagine-postgres container/bigimagine DB as of the 2026-08-04 dedicated-infra deploy, not the
-- old shared bigbrain-postgres 0048 had to work around):
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0050_screen_lock_settings.sql
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
  'screen_lock_timeout_minutes'
));
