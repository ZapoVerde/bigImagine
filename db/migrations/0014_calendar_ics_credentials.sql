-- Widens provider_credentials' closed name vocabulary to cover the two calendar ICS feed URLs
-- (docs/bb_principles.md §12: a capability URL is a secret exactly like an API key — same
-- encrypted, write-only, closed-vocabulary shape, not a parallel mechanism). Applied by hand,
-- same as 0008/0013:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0014_calendar_ics_credentials.sql
--
-- BIGBRAIN_CALENDAR_OWNER_USER_ID and BIGBRAIN_MASK_WORK_CALENDAR are deliberately NOT added here
-- — neither grants access on its own (a user_id is just a selector, the mask flag is just a
-- toggle), so both stay plain env, same as BIGBRAIN_NOTION_OWNER_USER_ID already does.

alter table provider_credentials drop constraint provider_credentials_name_check;
alter table provider_credentials add constraint provider_credentials_name_check check (name in (
  'deepseek_api_key',
  'openrouter_api_key',
  'voyage_api_key',
  'notion_token',
  'cozi_ics_url',
  'outlook_ics_url'
));
