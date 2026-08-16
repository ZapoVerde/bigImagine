-- Portrait Studio (docs/plans/portrait-studio-plan.md) — the generative character-portrait
-- training system: layer/entity store, generation candidates, human-evaluation episodes, and the
-- tagged reflection wiki. Applied by hand against the dedicated BigImagine database, same as
-- every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0105_visual_studio.sql
--
-- Four new tables, all following characters' RLS shape (db/migrations/0044_characters.sql):
-- user_id references users, enable + force row level security, a user_scoped policy, grants to
-- bigimagine_app (the plan's original "bigbrain_app" was a 0044-era role name; every migration
-- since the bigBrain -> BigImagine re-point grants bigimagine_app).
--
-- 1. visual_entities — one generic row per layer entity (Subject/Outfit/Style/Expression and any
--    future layer the manifest adds), distinguished by layer_id, never one table per layer
--    (plan §Entities). character_id is set for character-scoped entities (Subject always, Outfit
--    when character-specific) and null for global ones (Style, Expression, shared Outfit).
--    slots is the entity's chromosome fragment: { [slotName]: value } per promptable layer.
--    template is only meaningful for style-layer entities — a per-entity override of the
--    manifest's composition template. current_best_candidate_id is a soft pointer (no FK) to the
--    winning candidate, mirroring last_image_url's own looseness.
--
-- 2. visual_candidates — one row per generated candidate per round. entity_ids is the round's
--    { [layerId]: entityId } map; chromosome is the reconciled candidate { slots: {...},
--    negative_prompt? }. rating/note are written by submitPortraitFeedback after the human picks
--    a winner. generation is the per-subject round counter the task-id `attempt` derives from.
--
-- 3. visual_episodes — one row per human evaluation: the round's goal, the picked winner, the
--    per-candidate ratings/rationale, and the full candidate list (so the round is reconstructible
--    after the fact). The Reflection Investigation's origin_episode_id hangs off wiki entries.
--
-- 4. visual_wiki_entries — the self-improving knowledge base: a standalone lesson (title/body,
--    open-vocabulary tags) with subscriptions naming which layer-type/entity it applies to
--    (plan §Reflection): [{ layerType: text, layerEntityId: uuid | null }]. A null
--    layerEntityId is the whole-layer-type subscription that reaches every sibling entity.
--
-- Also: image_connections gains purpose ('background' | 'portrait', default 'background'), and
-- the single-active-row partial unique index is rebuilt scoped to (purpose) so a background and
-- a portrait connection can be active simultaneously (plan §Image connection purpose split).
-- orchestrator_settings' key CHECK is rebuilt wholesale with the complete current vocabulary
-- (verified against pg_get_constraintdef on the live DB: 0100's list + the two 0104 keys) plus
-- the five visual_* keys — the same widen-only wholesale-rebuild pattern 0100/0104 used.

create table visual_entities (
  entity_id                 uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references users(user_id),
  layer_id                  text not null,          -- validated against the active manifest at write time, app-level
  character_id              uuid null references characters(character_id),
  name                      text not null,
  slots                     jsonb not null default '{}'::jsonb,
  standing_instructions     text not null default '',
  template                  text null,              -- only meaningful for style-layer entities
  last_image_url            text null,
  current_best_candidate_id uuid null,              -- soft pointer, no FK (mirrors last_image_url's looseness)
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index visual_entities_by_user_layer on visual_entities (user_id, layer_id);
create index visual_entities_by_character on visual_entities (character_id) where character_id is not null;
alter table visual_entities enable row level security;
alter table visual_entities force row level security;
create policy user_scoped on visual_entities using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on visual_entities to bigimagine_app;

create table visual_candidates (
  candidate_id  uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(user_id),
  entity_ids    jsonb not null,                     -- { [layerId]: entityId }
  generation    integer not null default 0,
  chromosome    jsonb not null,                     -- { slots: { [layerId]: { [slotName]: value } }, negative_prompt?: string }
  image_url     text null,
  rating        smallint null check (rating between 1 and 5),
  note          text null,
  created_at    timestamptz not null default now()
);
create index visual_candidates_by_user on visual_candidates (user_id, created_at);
alter table visual_candidates enable row level security;
alter table visual_candidates force row level security;
create policy user_scoped on visual_candidates using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on visual_candidates to bigimagine_app;

create table visual_episodes (
  episode_id           uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users(user_id),
  entity_ids           jsonb not null,
  goal                 text not null,
  rationale            text null,
  selected_candidate_id uuid null references visual_candidates(candidate_id),
  candidate_ids        uuid[] not null,
  created_at           timestamptz not null default now()
);
create index visual_episodes_by_user on visual_episodes (user_id, created_at);
alter table visual_episodes enable row level security;
alter table visual_episodes force row level security;
create policy user_scoped on visual_episodes using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on visual_episodes to bigimagine_app;

create table visual_wiki_entries (
  entry_id           uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(user_id),
  title              text not null,
  body               text not null,
  tags               text[] not null default '{}',
  subscriptions      jsonb not null,                -- [{ layerType: text, layerEntityId: uuid | null }]
  origin_episode_id  uuid null references visual_episodes(episode_id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index visual_wiki_entries_by_user on visual_wiki_entries (user_id, created_at);
-- GIN for the Path-1 subscription containment lookups (@> '[{"layerEntityId": ...}]' /
-- @> '[{"layerType": ...}]') — the reflection and injection reads scan by subscription shape.
create index visual_wiki_entries_subscriptions_gin on visual_wiki_entries using gin (subscriptions);
alter table visual_wiki_entries enable row level security;
alter table visual_wiki_entries force row level security;
create policy user_scoped on visual_wiki_entries using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on visual_wiki_entries to bigimagine_app;

-- The purpose split: every existing row lands on 'background', so generateLocationImage.ts's
-- unchanged resolveActive() continues to resolve exactly the row it resolves today (plan §Edge
-- Cases). The one-active constraint becomes per-purpose: a background connection and a portrait
-- connection can both be active at once.
alter table image_connections add column purpose text not null default 'background' check (purpose in ('background', 'portrait'));
drop index image_connections_one_active;
create unique index image_connections_one_active_per_purpose on image_connections (purpose) where is_active;

-- The key list below is the *complete* current vocabulary (every key 0010-0104 added), not just
-- the diff — the CHECK constraint is rebuilt wholesale, so a fresh volume must land on the same
-- constraint the live DB has (the 0100/0104 precedent). Live-DB state is the source of truth;
-- verified against pg_get_constraintdef before writing this file.
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
  'visual_reflection_system_prompt_override'
));
