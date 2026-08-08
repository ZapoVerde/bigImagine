-- Async heuristic cleanup pass (plan v2, PAUSE 1-approved) — replaces the retired post-runTurn
-- cleanup LLM preset (migrations 0057/0066/0070/0071) with a background subloop that cleans a
-- reply AFTER it lands: heuristic regex triggers decide what needs doing, and only then fire a
-- small, user-defined repair prompt (header/footer) or a deterministic text-op (antislop).
-- The old cleanup_preset_id column is deliberately left in place, unread — migrations are
-- append-only; nothing new reads it (the inline pass that did is removed alongside this feature).
--
-- 1. chat_sessions.cleanup_enabled_at — per-chat cleanup switch. A timestamp, not a bool,
--    because it doubles as the retroactive-flood guard: the subloop only processes messages
--    created AFTER this stamp, so enabling cleanup never re-processes an old history. Null = off.
--    RP-only by loop policy (kind = 'rp' is checked in code); this column is the per-chat opt-in.
--
-- 2. cleanup_slop_rules — the antislop rule table ("data defined, multiple regex sets", plan v2
--    §3). Each row is one regex trigger + action: 'remove' (default; deterministic delete of the
--    match, optional replacement), 'replace-paragraph' (TRG-style: fire an LLM prompt per
--    paragraph containing the match, splice the result back), or 'llm' (whole-message prompt).
--    set_name groups rules into named, independently toggleable sets (e.g. 'ai-cliches',
--    'formatting'); position orders rules within a set. Household-wide setup config (the Cleanup
--    page's "setup" surface), not per-user data — same RLS-exempt, system-scoped shape as
--    orchestrator_settings (0010): no user_id, no RLS, admin-gated endpoints write it. Seeded
--    below with a small starter set of concrete literal-phrase regexes (the old 0066 prompt's
--    prose slop list is not mechanically convertible to regexes — these are a safe first cut the
--    user refines on the page).
--
-- 3. cleanup_jobs — per-message processing ledger for the subloop: one row per (message, swipe)
--    the loop has processed, so dedup is exact (a cleaned message is never re-processed; cycling
--    to an uncleaned alternate swipe legitimately creates a new job). status: 'done' (processed,
--    maybe changed), 'flagged' (repair prompt failed/empty and the problem was left in place),
--    'error' (unexpected failure). notes carries the fail-open reason / what changed. Same
--    user-scoped RLS shape as chat_message_swipes (0059): no user_id column, policy subqueries
--    chat_messages.user_id, cascade off chat_messages.
--
-- 4. Widens orchestrator_settings.key's CHECK constraint with the four cleanup config keys
--    (io/orchestratorSettings.ts SETTING_NAMES): the header trigger regex + repair prompt, and
--    the footer trigger regex + repair prompt. Same widen-both-sides shape as 0065/0068/0069.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0072_cleanup_heuristic_settings.sql

alter table chat_sessions
  add column cleanup_enabled_at timestamptz;

create table cleanup_slop_rules (
  rule_id     uuid primary key default gen_random_uuid(),
  set_name    text not null default 'custom',
  position    int  not null default 0,
  pattern     text not null,
  flags       text not null default '',
  action      text not null default 'remove'
              check (action in ('remove', 'replace-paragraph', 'llm')),
  replacement text,
  llm_prompt  text,
  enabled     boolean not null default true,
  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default clock_timestamp()
);

create index cleanup_slop_rules_by_set on cleanup_slop_rules (set_name, position);

grant select, insert, update, delete on cleanup_slop_rules to bigimagine_app;

-- Starter antislop sets — concrete literal-phrase regexes, case-insensitive via the flags column.
insert into cleanup_slop_rules (set_name, position, pattern, flags, action) values
  ('ai-cliches', 0, '\\b(?:as an AI|as a language model|as an AI language model)\\b', 'i', 'remove'),
  ('ai-cliches', 1, '\\b(?:I''m (?:here to help|happy to help)|let me know if (?:you need|there''s))\\b', 'i', 'remove'),
  ('ai-cliches', 2, '\\b(?:in conclusion|it''s important to note|let''s dive in)\\b', 'i', 'remove'),
  ('ai-cliches', 3, '\\bdelve(?:d|s|ing)?\\b', 'i', 'remove'),
  ('formatting', 0, '\\b(?:meanwhile|however),?\\b', 'i', 'remove'),
  ('formatting', 1, '\\s*[\\u2026]{2,}\\s*', '', 'remove');

create table cleanup_jobs (
  job_id      uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references chat_sessions(chat_id) on delete cascade,
  message_id  uuid not null references chat_messages(message_id) on delete cascade,
  swipe_id    uuid not null references chat_message_swipes(swipe_id) on delete cascade,
  status      text not null check (status in ('done', 'flagged', 'error')),
  changed     boolean not null default false,
  notes       text,
  created_at  timestamptz not null default clock_timestamp(),
  finished_at timestamptz
);

create unique index cleanup_jobs_msg_swipe on cleanup_jobs (message_id, swipe_id);

alter table cleanup_jobs enable row level security;
alter table cleanup_jobs force row level security;
create policy user_scoped on cleanup_jobs using (
  exists (select 1 from chat_messages m where m.message_id = cleanup_jobs.message_id and m.user_id = app_current_user_id())
) with check (
  exists (select 1 from chat_messages m where m.message_id = cleanup_jobs.message_id and m.user_id = app_current_user_id())
);

grant select, insert, update, delete on cleanup_jobs to bigimagine_app;

-- Widens orchestrator_settings.key's CHECK constraint with the four cleanup config keys.
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
  'chat_memory_lorebook_curator_prompt',
  'chat_memory_people_curator_prompt',
  'canon_recall_top_k',
  'canon_extraction_prompt',
  'screen_lock_password',
  'screen_lock_timeout_minutes',
  'pia_proxy_url',
  'persona_name',
  'persona_description',
  'llm_gate_max_concurrent',
  'llm_gate_max_concurrent_agent_routine',
  'llm_gate_max_retries',
  'llm_gate_retry_base_ms',
  'llm_gate_retry_max_ms',
  'image_prompt_template',
  'chat_background_parallax',
  'cleanup_header_regex',
  'cleanup_header_prompt',
  'cleanup_footer_regex',
  'cleanup_footer_prompt'
));
