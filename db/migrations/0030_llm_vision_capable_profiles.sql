-- Widens orchestrator_settings' closed key vocabulary for io/llm/profiles.ts's per-profile
-- vision-capability flag (LlmProfile.supportsVision) — which named connection profiles (of
-- BIGBRAIN_LLM_PROFILES) can accept image attachments. DB-backed and Settings-tab editable
-- rather than .env (bb_principles.md §13), same reasoning as 0027's default_recipe_servings.
-- Unlike every other setting here, the value is a small JSON array of profile names rather than
-- a bare scalar — justified the same way BIGBRAIN_LLM_PROFILES itself already is (a structured
-- blob in one string field), because a single scalar can't express "vision-capable" per profile
-- name, and a chat can pick any configured profile, not just the household-wide active one
-- (server/httpServer.ts's per-chat profile override). Applied by hand, same as 0010/0027:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0030_llm_vision_capable_profiles.sql

alter table orchestrator_settings drop constraint orchestrator_settings_key_check;
alter table orchestrator_settings add constraint orchestrator_settings_key_check check (key in (
  'active_llm_profile',
  'active_llm_model',
  'household_timezone',
  'calendar_owner_user_id',
  'mask_work_calendar',
  'notion_owner_user_id',
  'notion_lists_data_source_id',
  'google_calendar_client_id',
  'google_calendar_owner_user_id',
  'google_calendar_id',
  'google_calendar_sync_token',
  'default_recipe_servings',
  'llm_vision_capable_profiles'
));
