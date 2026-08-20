-- Permanent-failure classification for the rolling chat-memory sync loop's status row
-- (orchestrator/src/orchestrator/chatMemorySync.ts, bi_principles.md §11): a permanent failure —
-- 400/401/403/404, or a malformed/empty provider response — must not be retried on every 30s poll
-- tick forever (observed ×1500 in a row on a dead "No endpoints found for <model>" 404). The tick
-- suppresses the identical request while suppression is active, preserving last_step/last_error/
-- consecutive_errors/last_attempt_at, and retries only when something meaningful changed:
--
--   * last_error_kind      — 'permanent' | 'transient', the classification of the last recorded
--                            error (null before the first error, and on ok/skipped).
--   * failure_signature    — a fingerprint of the connection the permanent failure ran through
--                            (kind|model|baseUrl of the resolved chat_memory_profile / active
--                            connection). The tick recomputes the current fingerprint on every
--                            tick and retries the moment it differs (chat_memory_profile changed,
--                            a model/provider was edited) — plus a slow periodic retry so a
--                            recovered provider eventually gets another chance.
--
-- Applied by hand, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0127_chat_memory_sync_status_failure_class.sql

alter table chat_memory_sync_status add column last_error_kind text check (last_error_kind in ('permanent', 'transient'));
alter table chat_memory_sync_status add column failure_signature text;