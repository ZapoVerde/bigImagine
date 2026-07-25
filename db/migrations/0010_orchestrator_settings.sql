-- Small, DB-backed home for household-wide orchestrator settings that should be changeable from
-- the Settings tab without a rebuild — which named connection profile (see io/llm/profiles.ts's
-- BIGBRAIN_LLM_PROFILES) is active, which model within it, and the household's own IANA timezone
-- (used to tell the LLM what day/time it actually is — see util/dateContext.ts). Applied by hand,
-- same as 0008/0009:
--   psql -U bigbrain_admin -d bigbrain -f /docker-entrypoint-initdb.d/0010_orchestrator_settings.sql
--
-- Same shape and same rationale as 0008_provider_credentials.sql: household-wide system config,
-- not per-user data, so no user_id column and deliberately exempt from RLS. `key` is a small,
-- fixed vocabulary (CHECK constraint) rather than an open key-value store, so a typo fails loudly
-- instead of silently writing a row nothing will ever read. Unlike provider_credentials, values
-- here are never secret (a profile/model/timezone *name*, not an API key), so they're stored and
-- read back as plain text — the whole point is that Settings can display the current value.
create table orchestrator_settings (
  key        text primary key check (key in ('active_llm_profile', 'active_llm_model', 'household_timezone')),
  value      text not null,
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on orchestrator_settings to bigbrain_app;
