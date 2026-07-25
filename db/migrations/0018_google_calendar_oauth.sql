-- Bidirectional Google Calendar sync (docs/spec.md §6.7 Addition, supersedes the deferred-OAuth
-- framing) — widens provider_credentials/orchestrator_settings for the OAuth client secret and
-- refresh token, and adds calendar_google_sync_map, the join table between calendar_events and
-- Google's own event ids. Applied by hand, same as 0008/0010/0014/0015/0016:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0018_google_calendar_oauth.sql
--
-- google_calendar_client_secret/google_calendar_refresh_token are secrets (docs/bb_principles.md
-- §12: the refresh token alone grants ongoing read/write access to the household's calendar, same
-- as an API key) — provider_credentials, encrypted, write-only. google_calendar_client_id/
-- google_calendar_owner_user_id/google_calendar_id/google_calendar_sync_token are not secrets
-- (an id is a selector, a sync token is a bookmark, not a capability) — orchestrator_settings,
-- plaintext, same shape as notion_owner_user_id/notion_lists_data_source_id.

alter table provider_credentials drop constraint provider_credentials_name_check;
alter table provider_credentials add constraint provider_credentials_name_check check (name in (
  'deepseek_api_key',
  'openrouter_api_key',
  'voyage_api_key',
  'notion_token',
  'cozi_ics_url',
  'outlook_ics_url',
  'brave_api_key',
  'google_calendar_client_secret',
  'google_calendar_refresh_token'
));

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
  'google_calendar_sync_token'
));

-- Shaped like notion_sync_map (db/migrations/0002_schema.sql), but a strict 1:1 keyed off
-- calendar_events.event_id rather than a (source_table, source_row_id) pair, since this join
-- table only ever backs one table. unique(google_event_id) is applied from day one, not added
-- after a live race is caught — spec.md §6.4 Correction 5 hit exactly this shape of bug for
-- Notion (outbound insert creates the remote object, *then* the mapping row — an inbound poll
-- landing in that window sees an "unmapped" remote object and adopts it a second time) and the
-- fix there (0005_notion_sync_map_page_unique.sql) came only after it was caught live. This
-- migration applies that lesson pre-emptively instead of waiting to rediscover it.
create table calendar_google_sync_map (
  sync_id           uuid primary key default gen_random_uuid(),
  event_id          uuid not null references calendar_events(event_id) on delete cascade,
  google_event_id   text not null,
  google_updated_at timestamptz,
  last_synced_at    timestamptz not null default now(),
  unique (event_id),
  unique (google_event_id)
);

-- No RLS: this table is never queried independent of a join to calendar_events, which is already
-- RLS-scoped (db/migrations/0013_calendar.sql) — same reasoning notion_sync_map's own RLS policy
-- documents for why it still needs user_id despite this (notion_sync_map spans multiple source
-- tables so it can't rely on a single FK's RLS; this table can, since it only ever joins one).
grant select, insert, update, delete on calendar_google_sync_map to bigbrain_app;
