-- Adds the configurable chat-memory chunk size (docs/plans/chunk-size-resize-plan.md):
--
--   chat_memory_chunk_pairs  integer-as-text (no stored default row) — how many turn-pairs form
--                            one archived chat_chunks row. Previously the hardcoded
--                            MESSAGES_PER_CHUNK constant (4 messages = 2 pairs) in
--                            chunkChatTranscript.ts; now a live, DB-backed setting read on every
--                            sync/eager/recall pass with unset or corrupt values falling back to
--                            2 (today's behavior — shipping this alone is a no-op until the user
--                            saves a different value). Read live by chatMemorySync.ts,
--                            eagerChunkSync.ts, and recallForPrompt.ts.
--
-- Also creates the singleton resize-job status table, chat_chunk_resize_status — household-wide
-- like orchestrator_settings itself (no user_id, exempt from RLS, same rationale 0010 gives for
-- orchestrator_settings): the read/write surface for the admin-triggered backfill that re-chunks
-- every chat's archived history at the new size (orchestrator/src/orchestrator/chatChunkResize.ts).
-- A singleton rather than a per-job table: only one resize pass may run at a time (the trigger
-- returns 409 while status = 'running'), so `id` is fixed at a single row via check (id = 1).
--
-- Applied by hand against the dedicated BigImagine database, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0099_chat_memory_chunk_pairs.sql
--
-- The key list below is the *complete* current vocabulary (every key 0010-0097 added), not just
-- the diff — the CHECK constraint is rebuilt wholesale, so a fresh volume must land on the same
-- constraint the live DB has (the 0092/0095/0097 precedent). Live-DB state is the source of truth.
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
  'chat_memory_inject_recent_history_prompt',
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
  'reasoning_close_tag'
));

create table chat_chunk_resize_status (
  id          integer primary key check (id = 1),
  status      text not null default 'idle' check (status in ('idle', 'running', 'done', 'error')),
  chats_total integer not null default 0,
  chats_done  integer not null default 0,
  started_at  timestamptz,
  finished_at timestamptz,
  error       text
);

-- New tables in this repo grant explicitly (0068's `grant select, insert, update, delete on
-- image_connections to bigimagine_app;` is the precedent): the app user reads/writes this row
-- on every trigger/status read, so it needs the same grant or every admin endpoint that touches
-- it fails with a permissions error.
grant select, insert, update, delete on chat_chunk_resize_status to bigimagine_app;

-- Seed the singleton row so status reads never hit a missing row (the app treats a missing row
-- as idle, but an explicit row keeps the "one row, no user_id" shape self-evident).
insert into chat_chunk_resize_status (id, status) values (1, 'idle');
