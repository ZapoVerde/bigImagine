-- Widens orchestrator_settings' closed key vocabulary to cover the non-secret runtime config that
-- was previously only in .env (docs/bb_principles.md §13: .env is for bootstrap-level values
-- only, everything else the orchestrator can already reach Postgres for belongs in the DB and the
-- Settings tab). Applied by hand, same as 0010/0014:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0015_settings_owner_ids.sql
--
-- Neither pair here is a secret (docs/bb_principles.md §12) — an owning user id is a selector, a
-- masking flag is a toggle, and both were already plain env before this, just not DB-backed or
-- UI-editable. calendar_owner_user_id/mask_work_calendar (plugins/calendar) and
-- notion_owner_user_id/notion_lists_data_source_id (io/notion.ts) all follow: values are read
-- fresh at boot with a BIGBRAIN_*-prefixed env var as a fallback (index.ts /
-- plugins/calendar/src/index.ts), same shape active_llm_profile already uses — not the seed-once-
-- and-persist shape provider_credentials.resolve() uses, since these were never secrets that
-- needed migrating out of plaintext env in the first place.

alter table orchestrator_settings drop constraint orchestrator_settings_key_check;
alter table orchestrator_settings add constraint orchestrator_settings_key_check check (key in (
  'active_llm_profile',
  'active_llm_model',
  'household_timezone',
  'calendar_owner_user_id',
  'mask_work_calendar',
  'notion_owner_user_id',
  'notion_lists_data_source_id'
));
