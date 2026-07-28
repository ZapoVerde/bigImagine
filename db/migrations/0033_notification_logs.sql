-- Outbound notification gateway audit log (plugins/notifications, docs/spec.md addition) —
-- applied by hand, same as 0031/0032:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0033_notification_logs.sql
--
-- One row per send_push_notification tool call, success or failure — this is a delivery audit
-- trail (bb_principles.md §11: observable, not silent), not the conversational record of *why* the
-- LLM decided to send it; that reasoning still lives in the chat's own messages same as any other
-- tool call. RLS-scoped same shape as scheduled_jobs (0032): a notification is user data, provider
-- credentials/settings that configure *how* it's sent are not (those stay in provider_credentials/
-- orchestrator_settings, both RLS-exempt household config).
--
-- provider is a closed vocabulary of exactly one value today ('ntfy') — widened the same way
-- CREDENTIAL_NAMES/SETTING_NAMES are, when a Home Assistant/Telegram driver actually gets built,
-- not speculatively included now.

create table notification_logs (
  notification_id  uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(user_id),
  provider          text not null check (provider in ('ntfy')),
  target            text not null, -- the topic/channel this send targeted
  title             text not null,
  body              text not null,
  priority          text not null default 'default' check (priority in ('low', 'default', 'high', 'urgent')),
  status            text not null check (status in ('sent', 'failed', 'rate_limited', 'disabled')),
  error             text, -- provider error detail; null on a successful send
  created_at        timestamptz not null default now()
);

create index notification_logs_user_recent on notification_logs (user_id, created_at desc);

alter table notification_logs enable row level security;
alter table notification_logs force row level security;
create policy user_scoped on notification_logs using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on notification_logs to bigbrain_app;
