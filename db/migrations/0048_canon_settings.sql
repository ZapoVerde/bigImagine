-- Widens orchestrator_settings.key's CHECK constraint for the two Canonize settings
-- (docs/canonize-plan.md §6): canon_recall_top_k and canon_extraction_prompt. Applied by hand:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0048_canon_settings.sql
--
-- IMPORTANT — this Postgres instance (bigbrain-postgres / db "bigbrain") is shared with the live
-- bigBrain household orchestrator, not a BigImagine-only database. orchestrator_settings still
-- holds bigBrain's original household keys (calendar_owner_user_id, mask_work_calendar,
-- notion_owner_user_id, notion_lists_data_source_id, google_calendar_*, default_recipe_servings)
-- as live rows the running household orchestrator reads/writes continuously. 0043's own CHECK
-- replacement list omits every one of those keys — applying 0043 verbatim against this database
-- would violate the CHECK against those existing rows (confirmed 2026-08-04: it errors, and if run
-- as separate DROP/ADD statements without a wrapping transaction, the DROP commits before the
-- failed ADD, leaving the column with no CHECK at all until fixed). This migration's list is
-- therefore a strict superset — every key 0043 and this migration need, plus every household key
-- still live — not a replacement. Do not narrow this list down to "just the BigImagine keys" while
-- bigBrain and BigImagine share this database; 0043 has the same latent gap and should get the
-- same superset treatment if it's ever (re)applied here.
alter table orchestrator_settings drop constraint if exists orchestrator_settings_key_check;
alter table orchestrator_settings add constraint orchestrator_settings_key_check check (key in (
  'active_llm_profile',
  'active_llm_model',
  'household_timezone',
  'calendar_owner_user_id',
  'mask_work_calendar',
  'notion_owner_user_id',
  'notion_lists_data_source_id',
  'google_calendar_client_id',
  'google_calendar_owner_user_id',
  'google_calendar_id',
  'google_calendar_sync_token',
  'default_recipe_servings',
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
  'canon_recall_top_k',
  'canon_extraction_prompt'
));
