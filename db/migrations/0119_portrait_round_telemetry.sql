-- Portrait Studio round telemetry (docs/plans/portrait-studio-telemetry-plan.md) — one honest,
-- per-round account of every provider call involved in generating and evaluating a portrait:
-- mutation, optional Wiki pulls, image renders, Reflection, and Reflection retries. Applied by
-- hand against the dedicated BigImagine database, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0119_portrait_round_telemetry.sql
--
-- Two new tables (both following visual_*'s RLS shape: user_id references users, enable + force
-- row level security, a user_scoped policy, grants to bigimagine_app) and two column additions:
--
-- 1. visual_rounds — one row per generation round, created before the first mutation call.
--    status is the round's terminal outcome (running until dispatch finishes, then
--    succeeded / failed / partial — the same three-way outcome runPortraitGenerationRound's own
--    result already distinguishes); completed_at is set exactly once, when status goes terminal.
--    The row is never appended to or rewritten.
--
-- 2. visual_round_image_calls — one row per candidate image render. Image calls have no other
--    ledger (visual_candidates.render_metadata stores model/size/sampler settings but no
--    duration), so this is the plan's one place real call-recording code is added. candidate_id
--    is null at render time (no visual_candidates row exists yet) and backfilled once the
--    candidate row lands; a retry re-renders the same candidate as a NEW row under the same
--    round_id — history is never overwritten.
--
-- Column additions:
--   - visual_episodes.round_id — the generation round this episode evaluates. Nullable for
--     historical episodes created before this plan; every new generation/feedback path supplies it.
--   - llm_calls.round_id — the correlation column that keeps llm_calls the SOLE source of LLM
--     token/duration/error accounting. No token/duration/provider/model columns are added
--     anywhere else for LLM calls; this one nullable column rides the same ambient-context
--     mechanism call_label already uses (callContext.ts). llm_calls is RLS-exempt by design
--     (llmGate.ts's own documented household-wide-table exemption), so telemetry reads of it must
--     filter by user_id explicitly, never trust round_id alone.
--
-- Table-level grants already cover new columns on existing tables (column-agnostic — same note
-- as 0101/0103), so the llm_calls and visual_episodes additions need no grant change. The two
-- new tables grant to bigimagine_app like every visual_* table.

create table visual_rounds (
  round_id     uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(user_id),
  goal         text not null,
  started_at   timestamptz not null default now(),
  completed_at timestamptz null,
  status       text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'partial')),
  created_at   timestamptz not null default now()
);
create index visual_rounds_by_user on visual_rounds (user_id, created_at);
alter table visual_rounds enable row level security;
alter table visual_rounds force row level security;
create policy user_scoped on visual_rounds using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on visual_rounds to bigimagine_app;

create table visual_round_image_calls (
  call_id        uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(user_id),
  round_id       uuid not null references visual_rounds(round_id),
  candidate_id   uuid null references visual_candidates(candidate_id),
  status         text not null check (status in ('running', 'succeeded', 'failed')),
  provider_kind  text null,
  model          text null,
  duration_ms    integer null,
  error_code     text null,
  error_message  text null,
  started_at     timestamptz not null,
  completed_at   timestamptz null,
  created_at     timestamptz not null default now()
);
create index visual_round_image_calls_by_round on visual_round_image_calls (user_id, round_id, started_at);
create index visual_round_image_calls_by_candidate on visual_round_image_calls (candidate_id) where candidate_id is not null;
alter table visual_round_image_calls enable row level security;
alter table visual_round_image_calls force row level security;
create policy user_scoped on visual_round_image_calls using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on visual_round_image_calls to bigimagine_app;

-- The generation round an episode evaluates — nullable for pre-plan history.
alter table visual_episodes add column round_id uuid null references visual_rounds(round_id);
create index visual_episodes_by_round on visual_episodes (round_id) where round_id is not null;

-- The correlation column on the universal (RLS-exempt) LLM ledger. Nullable, no backfill —
-- pre-plan rows can't be reconstructed, and a null round_id isn't necessarily a pre-plan
-- artifact (any LLM call outside Portrait Studio). The partial index keeps the portrait
-- telemetry lookup (round_id + user_id) cheap without paying for index maintenance on the
-- million-row household-wide ledger's non-portrait rows.
alter table llm_calls add column round_id uuid null;
create index llm_calls_by_round on llm_calls (round_id) where round_id is not null;