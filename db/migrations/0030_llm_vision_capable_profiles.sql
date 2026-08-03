-- Widens orchestrator_settings' closed key vocabulary for io/llm/profiles.ts's per-profile
-- vision-capability flag (LlmProfile.supportsVision) — which named connection profiles (of
-- BIGBRAIN_LLM_PROFILES) can accept image attachments. DB-backed and Settings-tab editable
-- rather than .env (bb_principles.md §13). Unlike every other setting here, the value is a small
-- JSON array of profile names rather than a bare scalar — justified the same way
-- BIGBRAIN_LLM_PROFILES itself already is (a structured blob in one string field), because a
-- single scalar can't express "vision-capable" per profile name, and a chat can pick any
-- configured profile, not just the household-wide active one (server/httpServer.ts's per-chat
-- profile override). Applied by hand, same as 0010:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0030_llm_vision_capable_profiles.sql

alter table orchestrator_settings drop constraint orchestrator_settings_key_check;
alter table orchestrator_settings add constraint orchestrator_settings_key_check check (key in (
  'active_llm_profile',
  'active_llm_model',
  'household_timezone',
  'llm_vision_capable_profiles'
));
