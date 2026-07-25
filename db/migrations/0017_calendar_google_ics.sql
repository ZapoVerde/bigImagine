-- Widens calendar_events.source to add 'google' (docs/spec.md §6.7) — in support of the
-- OAuth-based bidirectional Google Calendar sync in 0018_google_calendar_oauth.sql, not a
-- read-only ICS feed. (An earlier read-only-ICS version of this migration also widened
-- provider_credentials for a google_ics_url secret — dropped before ever being deployed once the
-- OAuth approach was chosen instead, so provider_credentials only needs 0018's widen.) Applied by
-- hand, same as 0013/0014/0016:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0017_calendar_google_ics.sql

alter table calendar_events drop constraint calendar_events_source_check;
alter table calendar_events add constraint calendar_events_source_check check (source in ('cozi', 'outlook', 'google', 'native'));
