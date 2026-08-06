-- Retry/queueing for the LLM gate (docs/llm-gate-plan.md, io/llm/llmGate.ts). base.complete() is
-- now retried internally on a retryable failure (io/llm/llmRetryClassify.ts) with bounded
-- exponential backoff (io/llm/llmBackoff.ts), admitted through a per-lane concurrency slot
-- (io/llm/llmQueue.ts) — invisible to every caller, which still just awaits one promise.
--
-- llm_calls widens with request_id (one per logical complete() call, shared across every attempt)
-- and attempt (0-indexed) so a call that needed 2 internal attempts to succeed shows up as two
-- rows sharing a request_id rather than losing the earlier failed attempt's latency/outcome, per
-- llm-gate-plan.md §4.3 — "every attempt is a call in the sense that matters." Backfilled with
-- gen_random_uuid()/0 for any pre-existing rows so the column can be not null from the start.
--
-- orchestrator_settings widens with the five llm_gate_* tuning keys (io/orchestratorSettings.ts):
-- two per-lane concurrency caps (interactive vs. agent_routine, kept separate so a background
-- sync/extraction burst can never delay a live turn — llm-gate-plan.md §6's resolved "concurrency
-- lanes" question), plus max_retries/retry_base_ms/retry_max_ms. Unset means "use llmGate.ts's
-- own conservative built-in default", same fallback shape every other tunable setting in this
-- table already uses.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0056_llm_gate_retry.sql

alter table llm_calls
  add column request_id uuid not null default gen_random_uuid(),
  add column attempt int not null default 0;

alter table llm_calls alter column request_id drop default;

create index llm_calls_request on llm_calls (request_id);

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
  'llm_gate_retry_max_ms'
));
