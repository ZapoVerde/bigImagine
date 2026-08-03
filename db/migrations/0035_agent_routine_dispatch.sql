-- Unblocks scheduled_jobs' 'agent_routine' classification (0032_scheduled_jobs.sql accepted the
-- value but nothing dispatched it) — the household kill switch and per-job daily run cap that
-- migration flagged as prerequisites, plus the new llm_calls audit table bb_principles.md §14's
-- gate (orchestrator/src/io/llm/llmGate.ts) reads and writes on every LLM call, agent_routine or
-- not. Applied by hand, same as 0008/0010/.../0034:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0035_agent_routine_dispatch.sql
--
-- scheduled_jobs additions:
--   instructions       — what the LLM should actually do when this routine wakes up unattended;
--                        title (existing) stays a human label, same "label vs. body" split
--                        notes.title/notes.content already has. Nullable at the column level
--                        (an 'alarm' job has no reasoning to do) but required for 'agent_routine'
--                        via the widened kind-fields CHECK below — a routine with nothing to
--                        reason about isn't a real routine, same "don't accept a value with
--                        nothing behind it" instinct as classification itself.
--   max_runs_per_day / max_tokens_per_day — per-job caps, NOT NULL with sane defaults (5 calls /
--                        50,000 tokens) rather than nullable-meaning-unlimited: an unattended
--                        job's blast radius should never be "however much it wants" by default.
--                        Overridable at creation via schedule_routine's own args.
--   capped_reason      — set alongside a status flip to 'capped' (llmGate.ts's reactToBreach), so
--                        Settings can show *why* a routine stopped rather than a bare status.
--   status             — widens to add 'capped': distinct from 'cancelled' so the Settings tab can
--                        tell "the bot turned this off because it hit its budget" apart from "a
--                        person turned this off", per docs/bb_principles.md §11.
--   scheduled_jobs_routine_fields — an 'agent_routine' job requires both instructions and
--                        linked_chat_id (mirrors scheduled_jobs_kind_fields' own shape): the
--                        dispatcher (orchestrator/src/orchestrator/agentRoutineDispatch.ts) runs
--                        every routine inside its linked chat so it inherits that chat's own
--                        tool allow-list and system prompt/sampling params, and so a household
--                        member can actually read the transcript of what an unattended run did —
--                        a routine with no chat to run in and nothing to say has nowhere to go.
--
-- llm_calls: the universal per-call usage log bb_principles.md §14 requires. Deliberately
-- RLS-exempt — same household-wide category as provider_credentials/orchestrator_settings, not
-- the usual user_scoped shape (bb_principles.md §4) — because the household-wide agent_routine
-- cap genuinely needs to sum usage across every user, which a forced user_scoped RLS policy
-- cannot do even from an unscoped system session (an unset app.current_user_id satisfies no
-- user_scoped policy, not "every one of them" — orchestrator/src/io/postgres.ts's own doc).
-- Nothing user-facing ever queries this table with caller-supplied filters; only llmGate.ts
-- reads/writes it, always with a userId/jobId it already trusts from server-side call context, so
-- RLS isn't defending anything here this file doesn't already defend itself. task_id is plain
-- text, not a uuid FK, since it means three different things depending on kind (a chat_id, a
-- scheduled_jobs.job_id, or a short caller-chosen label for a standalone system call like
-- "generateChatTitle") — job_id is the real, nullable FK used for the agent_routine-specific
-- tally queries.
--
-- orchestrator_settings widens with agent_routines_enabled (the household kill switch — the
-- literal same setting a Settings-tab "big red button" would flip, and the literal same setting
-- llmGate.ts's household-cap breach reaction flips automatically), the two household-wide caps
-- (defaults live in code — orchestrator/src/io/llm/llmGate.ts's DEFAULT_HOUSEHOLD_MAX_* — so an
-- unset row means "use the conservative built-in default", not "unlimited"), and
-- agent_routines_disabled_reason (set alongside the switch so Settings can show why it's off,
-- same "state plus reason" shape as scheduled_jobs.capped_reason above).

alter table scheduled_jobs
  add column instructions text,
  add column max_runs_per_day int not null default 5,
  add column max_tokens_per_day int not null default 50000,
  add column capped_reason text;

alter table scheduled_jobs drop constraint scheduled_jobs_status_check;
alter table scheduled_jobs add constraint scheduled_jobs_status_check check (status in ('active', 'completed', 'cancelled', 'capped'));

alter table scheduled_jobs add constraint scheduled_jobs_routine_fields check (
  classification <> 'agent_routine' or (instructions is not null and linked_chat_id is not null)
);

create table llm_calls (
  call_id             uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(user_id),
  kind                text not null check (kind in ('chat', 'agent_routine', 'system')),
  task_id             text not null,
  job_id              uuid references scheduled_jobs(job_id) on delete set null,
  outcome             text not null check (outcome in ('ok', 'refused', 'error')),
  prompt_tokens       int,
  completion_tokens   int,
  total_tokens        int,
  reason              text,
  created_at          timestamptz not null default now()
);

create index llm_calls_recent on llm_calls (created_at);
create index llm_calls_job on llm_calls (job_id) where job_id is not null;

grant select, insert, update, delete on llm_calls to bigbrain_app;

alter table orchestrator_settings drop constraint orchestrator_settings_key_check;
alter table orchestrator_settings add constraint orchestrator_settings_key_check check (key in (
  'active_llm_profile',
  'active_llm_model',
  'household_timezone',
  'llm_vision_capable_profiles',
  'ntfy_server_url',
  'notifications_enabled',
  'agent_routines_enabled',
  'agent_routine_max_runs_per_day',
  'agent_routine_max_tokens_per_day',
  'agent_routines_disabled_reason'
));
