-- Scheduled alarms/routines (docs/spec.md's Landing Deck / temporal-primitives addition) —
-- applied by hand, same as 0004/0009/0011/0013/0025/0031/etc:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0032_scheduled_jobs.sql
--
-- classification distinguishes a human-facing alarm from an autonomous agent-facing routine that
-- would wake the LLM reasoning loop unattended. Both values are accepted here already, even
-- though only 'alarm' rows are dispatched for now (plugins/temporal's Stage 2 poll loop only
-- fires 'alarm' jobs) — 'agent_routine' needs a household-wide kill switch and a per-job daily
-- run cap before it's safe to dispatch at all, and those land in a later stage as application-layer
-- gates, not a schema change. Accepting the value now avoids a second migration just to widen this
-- CHECK later.
--
-- schedule_kind is 'once' (a single absolute next_run_at, no recurrence) or 'daily' (a wall-clock
-- time_of_day + timezone, recomputed forward after each fire — plugins/temporal/src/
-- nextOccurrence.ts). No 'weekly'/cron-expression support yet; the vocabulary stays closed to
-- what's implemented, same reasoning as active_timers.status omitting 'paused'
-- (0031_active_timers.sql).
--
-- next_run_at is always the single source of truth for "when does this fire next" — a 'once' job
-- never recomputes it (status flips to 'completed' after firing instead), a 'daily' job always
-- does. No separate run_at/schedule-description column: next_run_at already is that value.

create table scheduled_jobs (
  job_id          uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(user_id),
  title           text not null,
  classification  text not null default 'alarm' check (classification in ('alarm', 'agent_routine')),
  schedule_kind   text not null check (schedule_kind in ('once', 'daily')),
  time_of_day     text, -- 'HH:MM', required for schedule_kind = 'daily', null for 'once'
  timezone        text not null,
  status          text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  last_run_at     timestamptz,
  next_run_at     timestamptz not null,
  linked_chat_id  uuid references chat_sessions(chat_id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint scheduled_jobs_kind_fields check (
    (schedule_kind = 'daily' and time_of_day is not null) or
    (schedule_kind = 'once' and time_of_day is null)
  )
);

create index scheduled_jobs_due on scheduled_jobs (next_run_at) where status = 'active';

alter table scheduled_jobs enable row level security;
alter table scheduled_jobs force row level security;
create policy user_scoped on scheduled_jobs using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on scheduled_jobs to bigbrain_app;
