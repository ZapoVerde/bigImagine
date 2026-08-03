-- Widens provider_credentials' closed name vocabulary to cover the Brave Search API key
-- (docs/bb_principles.md §12: an API key is a secret, same encrypted, write-only,
-- closed-vocabulary shape as the LLM keys, not a parallel mechanism). Applied by
-- hand, same as 0008:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0016_web_search_credentials.sql

alter table provider_credentials drop constraint provider_credentials_name_check;
alter table provider_credentials add constraint provider_credentials_name_check check (name in (
  'deepseek_api_key',
  'openrouter_api_key',
  'voyage_api_key',
  'brave_api_key'
));
