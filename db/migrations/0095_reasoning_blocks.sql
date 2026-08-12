-- Reasoning ("Thinking") blocks for RP chat (docs/plans/reasoning-blocks-plan.md) — the
-- `<think>...</think>`-wrapped span a model emits before its in-character reply, streamed live
-- into its own collapsible block above the reply, stored with the message, and never resent to
-- the model on later turns.
--
-- 1. chat_messages.reasoning — nullable text, one per assistant-message row. Holds the trimmed
--    inner text of the tagged reasoning span (tags themselves consumed at detection, never
--    stored). NULL when the turn produced no reasoning span. Deliberately a SEPARATE column
--    from content: nothing that builds recent_history or any other prompt-stack field reads it,
--    so exclusion from resent history is structural (the plan's "never resent" payoff) — the
--    prompt-stack assembler keeps assembling byte-identical prompts whether or not prior
--    messages carry reasoning.
--
-- 2. chat_message_swipes.reasoning — nullable text, the per-swipe counterpart of content's own
--    per-swipe independence: each swipe carries its own reasoning (or none), matching the
--    "cycling swipes shows that swipe's own reasoning" edge case. The active swipe's reasoning
--    is mirrored onto chat_messages.reasoning by recordSwipe/cycleSwipe, exactly the way
--    content is already mirrored onto chat_messages.content.
--
-- 3. Widens orchestrator_settings.key's CHECK constraint with the two tag-pair keys
--    (io/orchestratorSettings.ts SETTING_NAMES): reasoning_open_tag / reasoning_close_tag,
--    defaulting to '<think>' / '</think>'. Same widen-both-sides shape as 0072/0092 — the key
--    list below is the *complete* current vocabulary (every key 0010–0094 added), not just the
--    diff, because the CHECK constraint is rebuilt wholesale; a fresh volume must land on the
--    same constraint the live DB has.
--
-- No grants needed: chat_messages / chat_message_swipes / orchestrator_settings already grant
-- select/insert/update/delete to bigimagine_app, and adding a column doesn't change that.
-- RLS unaffected (chat_messages' user_scoped policy and chat_message_swipes' subquery policy
-- apply per-row, not per-column).
--
-- Applied by hand against the dedicated BigImagine database, same as every post-initdb
-- migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0095_reasoning_blocks.sql
-- Idempotent (IF NOT EXISTS) — safe to re-run if a prior apply attempt is unconfirmed.

alter table chat_messages
  add column if not exists reasoning text;

alter table chat_message_swipes
  add column if not exists reasoning text;

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
  'chat_memory_auto_recall_chunk_min',
  'chat_memory_auto_recall_pool_multiple',
  'chat_memory_auto_recall_cutoff_mode',
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
