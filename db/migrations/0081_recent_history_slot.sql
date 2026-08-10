-- 0081: recent_history becomes a LIVE marker — the active context (the last sent turn + the
-- live-window turns, the same window the messages array used to carry) rendered into the stack
-- where the preset ordered the slot, wrapped in the preset's own HTML tags (2026-08-10 user
-- direction: "I want it to work so that it gets wrapped in my html tags and so that I can manage
-- caching effectively"). When the slot renders, the caller no longer appends the window as
-- messages — the stack alone carries it, and the LLM adapters emit a single empty user turn to
-- keep the request shape valid.
--
-- Two parts:
--   1) new template key chat_memory_inject_recent_history_prompt joins the CHECK — same "default +
--      bespoke" override shape as every other inject_* template (bi_principles.md §18; unset or
--      empty value = the built-in default, a bare {{turns}}). Rendered by
--      buildNarratorStackItems (orchestrator/src/server/httpServer.ts) via
--      renderRecentHistory (orchestrator/src/io/chatMemory/memoryInjection.ts).
--   2) the builtin Standard/Minimal presets' recent_history marker is disabled so the default
--      experience is byte-for-byte unchanged (the live window keeps flowing as plain messages);
--      the slot only renders where a preset author explicitly enables and orders it — the user's
--      own Comfy 2 preset keeps it enabled inside <narrative_execution>.
--
-- Applied by hand against the dedicated BigImagine database (volume already exists), same as
-- every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0081_recent_history_slot.sql
-- The key list below is the *complete* current vocabulary (every key 0010–0080 added), not just
-- the diff — the CHECK constraint is rebuilt wholesale, so a fresh volume must land on the same
-- constraint the live DB has. Confirmed against the live DB via pg_get_constraintdef before
-- writing (0080's file list == live constraint, plus the one new key).
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
  'chat_memory_auto_recall_enabled',
  'chat_memory_auto_recall_pairs',
  'chat_memory_auto_recall_chunk_top_k',
  'chat_memory_inject_bridge_prompt',
  'chat_memory_inject_plot_prompt',
  'chat_memory_inject_auto_recall_prompt',
  'chat_memory_inject_recent_history_prompt',
  'chat_memory_auto_recall_chunk_prompt',
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
  'location_describer_history_pairs'
));

-- Disable recent_history in the builtin presets (Standard pos 9 / Minimal pos 3, seeded by 0042):
-- with the slot live-rendering the window, an enabled builtin slot would silently change every
-- default user's prompt shape the moment the code deploys. The user's own presets are untouched.
update context_stack_slots
set enabled = false
where marker_key = 'recent_history'
  and preset_id in (select preset_id from context_stack_presets where is_builtin);
