-- Outbound notification gateway config (plugins/notifications) — widens provider_credentials/
-- orchestrator_settings for the Ntfy driver, same combined-migration shape as 0018's Google
-- Calendar OAuth addition. Applied by hand, same as 0008/0010/0014/0015/0016/0018:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0034_notifications_credentials_settings.sql
--
-- ntfy_topic is a secret (docs/bb_principles.md §12): the ntfy server sits on a public hostname
-- with no Cloudflare Access gate (unlike bigbrain/webui/vault) and anonymous read-write auth, so
-- the topic name is the only thing standing between "your phone" and "anyone's phone" — exactly
-- the "possessing it grants access on its own" test §12 asks. provider_credentials, encrypted,
-- write-only, same shape as brave_api_key.
--
-- ntfy_server_url is not a secret — it's the URL the orchestrator itself posts to, a selector
-- rather than a capability, same reasoning as google_calendar_id. Deliberately the internal
-- container address (http://ntfy:80 over traefik-net), not the public nfty.your-domain.example hostname —
-- the orchestrator and ntfy sit on the same Docker network, so there's no reason to round-trip
-- through the tunnel for its own sends; the public hostname exists only for the phone app to
-- subscribe from outside the LAN. orchestrator_settings, plaintext, Settings-tab editable.
--
-- notifications_enabled is the household kill switch: a fast, reversible way to silence the
-- send_push_notification tool without touching/rotating ntfy_topic — checked live on every call
-- (sendPushNotificationTool.ts), same live-read-no-restart shape as household_timezone. Defaults
-- unset (falsy) so the tool stays off until an operator explicitly turns it on from the Settings
-- tab, same "no key/flag configured means don't offer a tool that would just fail or misfire"
-- caution as web_search's brave_api_key gate.

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
  'google_calendar_refresh_token',
  'ntfy_topic'
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
  'google_calendar_sync_token',
  'default_recipe_servings',
  'llm_vision_capable_profiles',
  'ntfy_server_url',
  'notifications_enabled'
));
