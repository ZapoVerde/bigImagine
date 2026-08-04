-- Per-turn performance visibility (docs/observability plan) — the BigImagine analog of
-- SillyTavern-Loggeryze's st_turn_perf.json, scoped to this loop's actual round/tool-call
-- structure rather than ST's fixed browser-side phases (everything here is already server-side,
-- so there's no separate browser round-trip to break out). Applied by hand, same as
-- 0031/0032/0035/etc:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0041_turn_metrics.sql
--
-- Standard user_scoped RLS, deliberately diverging from llm_calls' RLS exemption
-- (0035_agent_routine_dispatch.sql). llm_calls is exempt for one narrow, documented reason: the
-- household-wide agent_routine daily cap check must sum usage across every user, which a forced
-- per-user policy structurally can't do. Nothing here needs that — every row is per-turn data
-- written by a request that already has a trusted user_id in scope, same shape as
-- chat_sessions/notes. Copying llm_calls' exemption would turn a narrow, justified exception into
-- the default.
--
-- rounds (jsonb array) carries the per-round breakdown: [{ round, llm_duration_ms, prompt_tokens,
-- completion_tokens, total_tokens, tool_calls: [{ name, duration_ms, outcome }] }, ...]. Kept as
-- one jsonb column rather than a child table since it's write-once (inserted alongside the parent
-- row, never queried or updated independently) and only ever read back whole for one turn at a
-- time — a join would buy nothing a child table doesn't already cost in insert complexity.
--
-- outcome/error_reason mirrors llm_calls' own outcome/reason split: a failed turn still gets a
-- row, so the rounds it did complete and where it died stay visible instead of vanishing with the
-- exception.
--
-- Complementary, independent addition at the per-call level: llm_calls gains duration_ms so a
-- single call's latency is visible without waiting on the turn it belongs to.
create table turn_metrics (
  turn_metric_id    uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(user_id),
  task_id           text not null,
  kind              text not null check (kind in ('chat', 'agent_routine', 'system')),
  round_count       int not null,
  tool_call_count   int not null,
  total_duration_ms int not null,
  outcome           text not null check (outcome in ('ok', 'error')),
  error_reason      text,
  rounds            jsonb not null,
  created_at        timestamptz not null default now()
);

create index turn_metrics_recent on turn_metrics (created_at);
create index turn_metrics_task on turn_metrics (task_id);

alter table turn_metrics enable row level security;
alter table turn_metrics force row level security;
create policy user_scoped on turn_metrics using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on turn_metrics to bigbrain_app;

alter table llm_calls add column duration_ms int;
