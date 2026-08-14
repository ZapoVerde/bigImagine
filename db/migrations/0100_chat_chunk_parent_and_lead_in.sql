-- Adds the persisted parent edge for chat_chunks and the lead-in context settings
-- (docs/plans/chunk-lead-in-context-plan.md):
--
--   chat_chunks.parent_chunk_id  uuid, self-referencing — the chunk immediately before this one in
--                                the actual conversation, persisted rather than inferred from
--                                `ordinal` adjacency (which `count(*)`-based numbering and any
--                                future subset deletion make untrustworthy). Null = first chunk in
--                                its chat. Unique across non-null values (deferred): at most one
--                                child per parent, so the chain is a linear list per chat.
--                                `on delete set null` keeps a parent's removal from cascading
--                                silently into its children (deleteChatChunk relinks explicitly,
--                                before deleting — see the plan's Logic).
--
--   chat_memory_auto_recall_lead_in_chunks  integer-as-text (no stored default row) — how many
--                                           preceding chunks' existing summaries are prepended to
--                                           each retrieved chunk at auto-recall. 0 disables the
--                                           feature; unset/corrupt falls back to 2; clamped to
--                                           [0, 3] on read (recallForPrompt.ts).
--
--   chat_memory_auto_recall_lead_in_prompt  text — user-overridable template for a lead-in entry
--                                           (summary-only, lighter than the full chunk wrapper);
--                                           empty string means the built-in default
--                                           (DEFAULT_AUTO_RECALL_LEAD_IN_PROMPT, memoryInjection.ts).
--
-- Applied by hand against the dedicated BigImagine database, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0100_chat_chunk_parent_and_lead_in.sql
--
-- Both unique constraints this plan needs to move to commit-time are marked
-- `deferrable initially deferred`: deleteChatChunk's relink-then-renumber-then-delete sequence
-- transits states that would trip a per-row check mid-transaction (the classic "swap two unique
-- values in one statement" problem). Postgres has no `alter constraint` for unique constraints —
-- that form is foreign-key-only — so the ordinal uniqueness is dropped and re-added with the
-- deferrable property. The constraint name below was confirmed against the live DB (`\d
-- chat_chunks`) before writing this file.
alter table chat_chunks add column if not exists parent_chunk_id uuid references chat_chunks(chunk_id) on delete set null;

alter table chat_chunks drop constraint if exists chat_chunks_parent_unique;
alter table chat_chunks add constraint chat_chunks_parent_unique unique (parent_chunk_id) deferrable initially deferred;

alter table chat_chunks drop constraint if exists chat_chunks_chat_id_ordinal_key;
alter table chat_chunks add constraint chat_chunks_chat_id_ordinal_key unique (chat_id, ordinal) deferrable initially deferred;

-- One-shot backfill: today's ordinal adjacency is still trustworthy (nothing has ever deleted a
-- single chat_chunks row), so seed the chain once from it. After this, ordinal is never trusted
-- for adjacency again — every future INSERT sets parent_chunk_id explicitly.
update chat_chunks c
set parent_chunk_id = p.chunk_id
from chat_chunks p
where p.chat_id = c.chat_id and p.ordinal = c.ordinal - 1;

-- The key list below is the *complete* current vocabulary (every key 0010-0099 added), not just
-- the diff — the CHECK constraint is rebuilt wholesale, so a fresh volume must land on the same
-- constraint the live DB has (the 0092/0095/0097/0099 precedent). Live-DB state is the source of
-- truth; verified against pg_get_constraintdef before writing this file.
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
