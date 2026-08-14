-- Client-reported end-to-end RP turn display timing (docs/plans/llm-stats-page-plan.md) — the
-- Timing section's source table. One row per RP turn, written by the frontend's turnTimeline.ts
-- recorder once the turn is final (success, abort, or error), fire-and-forget through
-- POST /v1/turn-display-metrics.
--
-- Every *_ms column is elapsed milliseconds since that turn's dispatch (dispatch_at), so the
-- rows are directly comparable across turns regardless of wall-clock. Columns stay null when the
-- event never happened for that turn — same "omit, don't fabricate a zero" convention cost_usd
-- uses on llm_calls (e.g. turn 1's pre-stream header repair is invisible to the client timeline,
-- and a no-completeStream connection never emits cleanup frames, so its six cleanup columns stay
-- null).
--
-- Standard user_scoped RLS (unlike llm_calls, which is RLS-exempt for the household-wide cap
-- check): this is per-user chat-experience data with no household-wide aggregate reading it, the
-- same shape as turn_metrics (0041). The admin stats endpoint reads across every user via
-- db.withSystemScope, same as handleLlmStatsGet.
--
-- The explicit bigimagine_app grants follow the new-table convention established by 0088 (new
-- tables get their own grant statement; column additions like 0101 need none since table-level
-- grants are column-agnostic).
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0102_turn_display_metrics.sql

create table turn_display_metrics (
  turn_display_metric_id  uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references users(user_id),
  chat_id                 uuid not null references chat_sessions(chat_id) on delete cascade,
  message_id              text not null,
  dispatch_at             timestamptz not null,
  first_token_ms          int,
  last_token_ms           int,
  display_land_ms         int,
  display_settle_ms       int,
  header_start_ms         int,
  header_stop_ms          int,
  body_start_ms           int,
  body_stop_ms            int,
  footer_start_ms         int,
  footer_stop_ms          int,
  outcome                 text not null check (outcome in ('ok', 'aborted', 'error')),
  terminated_at_ms        int,
  created_at              timestamptz not null default now()
);
create unique index turn_display_metrics_message on turn_display_metrics (message_id);
create index turn_display_metrics_recent on turn_display_metrics (created_at);
alter table turn_display_metrics enable row level security;
alter table turn_display_metrics force row level security;
create policy user_scoped on turn_display_metrics using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on turn_display_metrics to bigimagine_app;
