-- Lorebook runtime schema (docs/lorebook-plan.md §3b/§3c/§3d/§3e, build order step 1). Builds on
-- 0051's storage-only lorebooks/lorebook_entries (those two tables are not renamed or reshaped —
-- only extended); adds the scoping tables, the activation-mechanics columns, the activation log,
-- and the four lorebook_settings keys to orchestrator_settings. No prompt-stack wiring here —
-- that's steps 2-4 of the plan. Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0088_lorebook_runtime.sql
--
-- Scoping (§3b) reuses the canon_facts shape (chat_id/scene_id anchors, 0054) and the
-- scene_presence junction shape (0046): user_id is denormalized onto every row so RLS applies
-- directly, and the standard user_scoped policy + bigimagine_app grants follow. A book's scope is
-- global_scope (new column) plus its character links; per-chat on/off lives in the override
-- tables, which beat the book's default and mean "no row = use the default".
--
-- Gating columns (§3c) are additive on lorebook_entries with defaults that preserve today's
-- behavior until an author opts in (default-off posture, §2): use_probability=false means the
-- existing probability column is not consulted, group_weight=1 (uniform when a group competes),
-- sticky/cooldown/delay=0. selective_logic is deliberately NOT added — keyword-combination logic
-- exists only to serve keyword discovery, which this plan drops outright (§9); the already-present
-- selective column stays for import/export round-trip fidelity and is never read by the evaluator.
-- vector_embed is vector(2048) with no index, same as canon_facts/chat_chunks (0047's comment:
-- pgvector's hnsw/ivfflat cap out below 2048 dims, so this is a brute-force scan over the scoped
-- candidate set). Populated at create/import/update time by the step-2 IO wrapper, not here.
--
-- lorebook_activation_log (§3e) is the audit trail AND the timed-effect state (sticky/cooldown/
-- delay resolve from its rows, not a separate counter table — one source of truth for "was this
-- entry active as of message N"). Its FKs are `on delete cascade`, deliberately NOT 0054's
-- `on delete set null`: the log is per-chat/per-entry bookkeeping, allowed to disappear with the
-- chat/message/entry it describes, unlike canon_facts which must never be erased (§15).
--
-- Settings (§3d) follow the orchestrator_settings key/value + CHECK-list convention (0048/0043);
-- no default rows are inserted — absent keys resolve to the application-side defaults, same as
-- every other key in this store. The CHECK is re-listed with the full current key set (67 keys:
-- 0087's 63 + the four new ones), superset pattern per 0048's warning — never narrow this list.
-- Wrapped in one transaction for the DROP/ADD so a failure rolls back instead of leaving the
-- column unconstrained (0048's warning).
begin;

-- §3b scoping.

alter table lorebooks add column global_scope boolean not null default false;

create table lorebook_character_links (
  lorebook_id   uuid not null references lorebooks(lorebook_id) on delete cascade,
  character_id  uuid not null references characters(character_id) on delete cascade,
  user_id       uuid not null references users(user_id),  -- denormalized, RLS precedent (0046)
  joined_at     timestamptz not null default now(),
  primary key (lorebook_id, character_id)
);
create index lorebook_character_links_character_idx on lorebook_character_links (character_id);

create table lorebook_chat_overrides (
  chat_id       uuid not null references chat_sessions(chat_id) on delete cascade,
  lorebook_id   uuid not null references lorebooks(lorebook_id) on delete cascade,
  user_id       uuid not null references users(user_id),  -- denormalized, RLS precedent (0046)
  enabled       boolean not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (chat_id, lorebook_id)
);

create table lorebook_entry_overrides (
  chat_id       uuid not null references chat_sessions(chat_id) on delete cascade,
  entry_id      uuid not null references lorebook_entries(entry_id) on delete cascade,
  user_id       uuid not null references users(user_id),  -- denormalized, RLS precedent (0046)
  enabled       boolean not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (chat_id, entry_id)
);

alter table lorebook_character_links enable row level security;
alter table lorebook_character_links force row level security;
create policy user_scoped on lorebook_character_links using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

alter table lorebook_chat_overrides enable row level security;
alter table lorebook_chat_overrides force row level security;
create policy user_scoped on lorebook_chat_overrides using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

alter table lorebook_entry_overrides enable row level security;
alter table lorebook_entry_overrides force row level security;
create policy user_scoped on lorebook_entry_overrides using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on lorebook_character_links, lorebook_chat_overrides, lorebook_entry_overrides to bigimagine_app;

-- §3c gating + discovery columns on lorebook_entries.

alter table lorebook_entries add column use_probability boolean not null default false;
alter table lorebook_entries add column group_weight integer not null default 1;
alter table lorebook_entries add column group_override boolean not null default false;
alter table lorebook_entries add column sticky integer not null default 0;
alter table lorebook_entries add column cooldown integer not null default 0;
alter table lorebook_entries add column delay integer not null default 0;
alter table lorebook_entries add column vector_embed vector(2048);

-- §3e activation log.

create table lorebook_activation_log (
  activation_id uuid primary key default gen_random_uuid(),
  chat_id       uuid not null references chat_sessions(chat_id) on delete cascade,
  message_id    uuid not null references chat_messages(message_id) on delete cascade,
  entry_id      uuid not null references lorebook_entries(entry_id) on delete cascade,
  user_id       uuid not null references users(user_id),  -- denormalized, RLS precedent (0046)
  activated_at  timestamptz not null default now()
);
create index lorebook_activation_log_chat_idx on lorebook_activation_log (chat_id, message_id);
create index lorebook_activation_log_entry_idx on lorebook_activation_log (chat_id, entry_id, message_id);

alter table lorebook_activation_log enable row level security;
alter table lorebook_activation_log force row level security;
create policy user_scoped on lorebook_activation_log using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on lorebook_activation_log to bigimagine_app;

-- §3d settings keys: lorebook_mode ('off' default | 'on'), lorebook_token_budget,
-- lorebook_recall_top_k, lorebook_recursion_enabled (ships disabled — exists so recursion is a
-- config flip later, not a redeploy; §9).

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
  'chat_memory_chunk_summary_prompt',
  'chat_memory_distill_prompt',
  'chat_memory_household_memory_prompt',
  'chat_memory_bridge_prompt',
  'chat_memory_world_curator_prompt',
  'chat_memory_people_curator_prompt',
  'chat_memory_auto_recall_enabled',
  'chat_memory_auto_recall_pairs',
  'chat_memory_auto_recall_chunk_top_k',
  'chat_memory_inject_bridge_prompt',
  'chat_memory_inject_plot_prompt',
  'chat_memory_inject_auto_recall_prompt',
  'chat_memory_auto_recall_chunk_prompt',
  'chat_memory_inject_recent_history_prompt',
  'canon_recall_top_k',
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
  'lorebook_recursion_enabled'
));
commit;
