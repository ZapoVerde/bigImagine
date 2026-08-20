-- Malformed-output detail for the rolling chat-memory sync loop's status row
-- (orchestrator/src/orchestrator/chatMemorySync.ts, bi_principles.md §11): last_error alone names
-- what was wrong ("plot entry ... has no valid arc tag") but not what the model actually said, which
-- makes a parse failure undiagnosable from the review panel. When the failure is an
-- LlmOutputParseError (orchestrator/src/io/chatMemory/llmOutputParseError.ts — thrown by the
-- bridge/distill/curator/chunk-summary parsers), these two columns carry the Settings-tab prompt key
-- and the model's raw completion text, both surfaced to the review panel's error-detail modal.
-- null for every other failure kind (HTTP/transport errors have no "reply" to show).
--
-- Applied by hand, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0130_chat_memory_sync_status_error_detail.sql

alter table chat_memory_sync_status add column last_error_prompt_name text;
alter table chat_memory_sync_status add column last_error_llm_reply text;
