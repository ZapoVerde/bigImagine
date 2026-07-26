-- Widens orchestrator_settings' closed key vocabulary for the household-wide default recipe
-- scale ("always show recipes scaled for 6") — same shape as household_timezone: not a secret
-- (docs/bb_principles.md §12, it's a number not a credential), DB-backed and Settings-tab
-- editable rather than .env (§13), read fresh on every scale_recipe call rather than cached at
-- boot so a change takes effect immediately, same as household_timezone. Applied by hand, same
-- as 0010/0015/0018:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0027_default_recipe_servings_setting.sql

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
  'default_recipe_servings'
));
