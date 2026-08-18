-- Portrait Studio reflection learning ledger (docs/plans/portrait-studio-vision-review-harness-plan.md)
-- — makes reflection reliable: every episode produces an auditable, actionable lesson, or is
-- explicitly marked incomplete/failed. Applied by hand against the dedicated BigImagine database,
-- same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0118_portrait_reflection_learning.sql
--
-- Five new tables (all following visual_*'s RLS shape: user_id references users, enable + force
-- row level security, a user_scoped policy, grants to bigimagine_app):
--
-- 1. visual_episode_learning — one immutable row per reflection attempt. input_snapshot is the
--    compact episode record (goal, parent chromosome, server-computed per-candidate diffs, human
--    ratings/notes/rationale/layer assessments, prior lesson ids, bounded wiki context +
--    revision ids). output_snapshot is the validated response or the provider/validation error.
--    status is the truthful outcome; a row is never mutated or deleted.
--
-- 2. visual_lessons — only a validated conclusion creates a lesson: statement, evidence, the one
--    actionable next_change { layer, instruction }, the preserve list, confidence, and the
--    maturity state (provisional until repeated supporting episodes or explicit operator approval
--    promote it — the wiki is a separate, operator-approved projection).
--
-- 3. visual_lesson_uses — records that a mutation round consumed a lesson: lesson_id, the episode
--    that later evaluated it (null until feedback lands), the mutation call's context, the applied
--    change, and the resulting candidate ids. A round without a lesson is explicitly exploratory.
--
-- 4. visual_episode_events — the append-only event log: winner_applied /
--    reflection_started / reflection_failed / lesson_created / insufficient_evidence, with payload
--    snapshots. Winner slot promotion is recorded here as its own event: changing slots is not
--    evidence that learning occurred.
--
-- 5. visual_wiki_revisions — immutable history per wiki entry (created|amended|retired), carrying
--    the supporting lesson ids / episode ids and the source (reflection | operator |
--    legacy_backfill). Existing entries receive a baseline revision with source=legacy_backfill and
--    no invented lesson provenance; existing episodes are labeled historical via the migration
--    below's reflection_status default and are never falsely marked supported.
--
-- Column additions:
--   - visual_episodes.reflection_status — the episode's truthful reflection state machine
--     (awaiting_feedback -> reflecting -> concluded | insufficient_evidence | failed).
--   - visual_candidates.parent_chromosome / composed_prompt / render_metadata /
--     wiki_revision_ids / lesson_id — the missing immutable provenance that lets a recorded
--     episode be replayed from its snapshot and lets a lesson be traced to the rounds that used it.
--
-- orchestrator_settings.key's CHECK is rebuilt wholesale (the 0091/0092/0095/0105/0108/0111/0112/
-- 0113 precedent) — the list below is the *complete* current vocabulary, adding visual_wiki_context_budget
-- and keeping every existing key (including the retired visual_wiki_investigation_max_turns — the
-- codebase only ever widens the CHECK, never narrows; the retired key stays readable but is no
-- longer executed).

create table visual_episode_learning (
  learning_id     uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(user_id),
  episode_id      uuid not null references visual_episodes(episode_id),
  attempt         integer not null default 1,
  status          text not null check (status in ('concluded', 'insufficient_evidence', 'failed')),
  input_snapshot  jsonb not null,
  output_snapshot jsonb not null,
  connection      text null,
  created_at      timestamptz not null default now()
);
create index visual_episode_learning_by_episode on visual_episode_learning (user_id, episode_id, attempt);
alter table visual_episode_learning enable row level security;
alter table visual_episode_learning force row level security;
create policy user_scoped on visual_episode_learning using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on visual_episode_learning to bigimagine_app;

create table visual_lessons (
  lesson_id          uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(user_id),
  source_episode_id  uuid null references visual_episodes(episode_id),
  source_learning_id uuid null references visual_episode_learning(learning_id),
  statement          text not null,
  evidence           text not null,
  next_change        jsonb not null,                -- { layer: text, instruction: text }
  preserve           text[] not null default '{}',  -- layers the next mutation must keep unchanged
  confidence         text not null check (confidence in ('low', 'medium', 'high')),
  state              text not null default 'provisional' check (state in ('provisional', 'supported', 'rejected', 'superseded')),
  created_at         timestamptz not null default now()
);
create index visual_lessons_by_user on visual_lessons (user_id, created_at);
alter table visual_lessons enable row level security;
alter table visual_lessons force row level security;
create policy user_scoped on visual_lessons using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on visual_lessons to bigimagine_app;

create table visual_lesson_uses (
  use_id            uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(user_id),
  lesson_id         uuid not null references visual_lessons(lesson_id),
  episode_id        uuid null references visual_episodes(episode_id),
  mutation_call     jsonb not null,                 -- { goal, attempt, parent, wikiRevisionIds }
  applied_change    jsonb null,                     -- the lesson's next_change/preserve as applied
  result_candidates jsonb null,                     -- { candidateIds: uuid[] }
  created_at        timestamptz not null default now()
);
create index visual_lesson_uses_by_lesson on visual_lesson_uses (user_id, lesson_id, created_at);
create index visual_lesson_uses_by_episode on visual_lesson_uses (user_id, episode_id);
alter table visual_lesson_uses enable row level security;
alter table visual_lesson_uses force row level security;
create policy user_scoped on visual_lesson_uses using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on visual_lesson_uses to bigimagine_app;

create table visual_episode_events (
  event_id   uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(user_id),
  episode_id uuid null references visual_episodes(episode_id),
  event_type text not null check (event_type in ('winner_applied', 'reflection_started', 'reflection_failed', 'lesson_created', 'insufficient_evidence')),
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index visual_episode_events_by_episode on visual_episode_events (user_id, episode_id, created_at);
alter table visual_episode_events enable row level security;
alter table visual_episode_events force row level security;
create policy user_scoped on visual_episode_events using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on visual_episode_events to bigimagine_app;

create table visual_wiki_revisions (
  revision_id     uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(user_id),
  entry_id        uuid not null references visual_wiki_entries(entry_id),
  revision_number integer not null,
  content         jsonb not null,                   -- { title, body, tags, subscriptions }
  kind            text not null check (kind in ('created', 'amended', 'retired')),
  lesson_ids      uuid[] not null default '{}',
  episode_ids     uuid[] not null default '{}',
  source          text not null default 'reflection' check (source in ('reflection', 'operator', 'legacy_backfill')),
  created_at      timestamptz not null default now(),
  unique (user_id, entry_id, revision_number)
);
create index visual_wiki_revisions_by_entry on visual_wiki_revisions (user_id, entry_id, revision_number);
alter table visual_wiki_revisions enable row level security;
alter table visual_wiki_revisions force row level security;
create policy user_scoped on visual_wiki_revisions using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on visual_wiki_revisions to bigimagine_app;

-- visual_episodes: the truthful reflection state (the old schema had no status at all — a round
-- could fail reflection and still look successful).
alter table visual_episodes add column reflection_status text not null default 'awaiting_feedback'
  check (reflection_status in ('awaiting_feedback', 'reflecting', 'concluded', 'insufficient_evidence', 'failed'));

-- visual_candidates: immutable provenance for replay + lesson linkage.
alter table visual_candidates add column parent_chromosome jsonb null;
alter table visual_candidates add column composed_prompt text null;
alter table visual_candidates add column render_metadata jsonb null;
alter table visual_candidates add column wiki_revision_ids uuid[] null;
alter table visual_candidates add column lesson_id uuid null references visual_lessons(lesson_id);

-- Backfill: every existing wiki entry gets a baseline revision (kind=created, source=legacy_backfill),
-- with its origin episode recorded as supporting provenance and NO invented lesson linkage.
insert into visual_wiki_revisions (user_id, entry_id, revision_number, content, kind, source, episode_ids)
select
  user_id,
  entry_id,
  1,
  jsonb_build_object('title', title, 'body', body, 'tags', tags, 'subscriptions', subscriptions),
  'created',
  'legacy_backfill',
  case when origin_episode_id is not null then array[origin_episode_id] else '{}'::uuid[] end
from visual_wiki_entries;

-- orchestrator_settings CHECK rebuild — the complete current vocabulary (widen-only precedent,
-- see 0111/0112/0113 headers).
alter table orchestrator_settings drop constraint if exists orchestrator_settings_key_check;
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
  'agent_routines_disabled_reason',
  'chat_memory_profile',
  'chat_memory_live_window_pairs',
  'chat_memory_sync_every_pairs',
  'chat_memory_digest_horizon_pairs',
  'chat_memory_chunk_pairs',
  'chat_memory_chunk_summary_prompt',
  'chat_memory_distill_prompt',
  'chat_memory_household_memory_prompt',
  'chat_memory_bridge_prompt',
  'chat_memory_world_curator_prompt',
  'chat_memory_people_curator_prompt',
  'chat_memory_auto_recall_enabled',
  'chat_memory_auto_recall_pairs',
  'chat_memory_auto_recall_chunk_top_k',
  'chat_memory_auto_recall_chunk_min',
  'chat_memory_auto_recall_pool_multiple',
  'chat_memory_auto_recall_cutoff_mode',
  'chat_memory_plot_recall_top_k',
  'chat_memory_plot_recall_min',
  'chat_memory_plot_recall_floor_syncs',
  'chat_memory_inject_bridge_prompt',
  'chat_memory_inject_plot_prompt',
  'chat_memory_inject_auto_recall_prompt',
  'chat_memory_auto_recall_chunk_prompt',
  'chat_memory_auto_recall_lead_in_chunks',
  'chat_memory_auto_recall_lead_in_prompt',
  'chat_memory_inject_recent_history_prompt',
  'chat_memory_inject_sync_summaries_prompt',
  'chat_memory_sync_summary_entry_prompt',
  'canon_recall_top_k',
  'canon_recall_min',
  'canon_extraction_prompt',
  'screen_lock_password',
  'screen_lock_timeout_minutes',
  'pia_proxy_url',
  'persona_name',
  'persona_description',
  'llm_gate_max_concurrent',
  'llm_gate_max_concurrent_agent_routine',
  'llm_gate_max_concurrent_background',
  'llm_gate_max_retries',
  'llm_gate_retry_base_ms',
  'llm_gate_retry_max_ms',
  'image_prompt_template',
  'chat_background_parallax',
  'cleanup_header_regex',
  'cleanup_header_prompt',
  'cleanup_footer_regex',
  'cleanup_footer_prompt',
  'chat_background_overlay_opacity',
  'chat_background_overlay_shade',
  'chat_background_bubble_opacity',
  'chat_background_bubble_user_shade',
  'chat_background_bubble_assistant_shade',
  'chat_legibility_halo',
  'chat_legibility_outline',
  'chat_legibility_solid_code',
  'chat_legibility_weight',
  'chat_legibility_hover_focus',
  'chat_legibility_halo_strength',
  'location_describer_prompt',
  'location_describer_history_pairs',
  'character_describer_prompt',
  'character_describer_history_pairs',
  'location_split_enabled',
  'location_injection_enabled',
  'location_injection_prompt',
  'lorebook_mode',
  'lorebook_token_budget',
  'lorebook_recall_top_k',
  'lorebook_recursion_enabled',
  'reasoning_open_tag',
  'reasoning_close_tag',
  'visual_layer_stack',
  'visual_mutation_candidate_count',
  'visual_wiki_investigation_max_turns',
  'visual_mutation_system_prompt_override',
  'visual_reflection_system_prompt_override',
  'visual_portraits_enabled',
  'portrait_subject_describer_prompt',
  'portrait_llm_connection',
  'portrait_slot_bootstrap_prompt',
  'visual_wiki_context_budget'
));