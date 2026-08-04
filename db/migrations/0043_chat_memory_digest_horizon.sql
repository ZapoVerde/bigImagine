-- Adds the digest-horizon knob docs/chat-memory.md's Settings section was missing (the analogue
-- of SillyTavern-Canonize's "Summary horizon (pairs)" — how far back the AI looks when
-- regenerating its rolling summary, not just what's brand new since the last sync), and fixes a
-- real gap this migration also had to close: orchestrator_settings.key's CHECK constraint was
-- never widened for the six chat_memory_* keys 0036-0041 already read and wrote
-- (orchestrator/src/io/orchestratorSettings.ts's SETTING_NAMES, adminServer.ts's
-- getChatMemorySettings/setChatMemorySettings) — every Settings-tab save against any of them
-- would have failed a check-constraint violation at the DB layer, code and migration having
-- drifted apart across 0036-0041 without anyone hitting that path yet. Applied by hand, same as
-- 0030/0034/0035:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0043_chat_memory_digest_horizon.sql
--
-- chat_memory_digest_horizon_pairs: distillChatMemory (io/chatMemory/distillChatMemory.ts) used to
-- see only the chunk summaries newly produced by the current sync tick — real continuity, but no
-- way to revisit anything already committed to chat_chunks in an earlier tick. This widens that
-- input to the trailing N pairs' worth of chunk summaries (default 24 — three sync-every cycles
-- at this platform's own default of 8), so a genuinely cross-sync-boundary idea has more than one
-- chunk's worth of chance to register before it ages out of the raw window entirely. Unlike
-- Canonize's own bridge horizon (default 40 pairs, a full wholesale re-read every sync since its
-- bridge summary has no persistent entries of its own), this platform's key-ideas digest already
-- carries its own state forward as chat_memory_entries rows — the horizon here is a *revision
-- window* layered on top of that persistence, not the sole source of continuity, so it can start
-- smaller. docs/bi_principles.md §18: this is a prompt-adjacent *behavior* knob, not a prompt
-- itself, but it lives in the same "read live every tick, no restart" settings shape as the other
-- five chat_memory_* keys for the same reason — see docs/chat-memory.md.
alter table orchestrator_settings drop constraint orchestrator_settings_key_check;
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
  'chat_memory_household_memory_prompt'
));
