-- turn_metrics.cleanup_duration_ms — the live cleanup pass's end-of-stream repair duration,
-- appended to the turn's already-written turn_metrics row once the backgrounded handoff
-- (docs/plans/cleanup-pass-blocks-turn-slot-plan.md) completes. The base row is written the
-- instant the raw turn finishes (total_duration_ms covers the LLM turn only); the backgrounded
-- cleanup pass records how long it then spent running finishStream + finalizeCleanupResult, so
-- end-to-end turn cost = total_duration_ms + cleanup_duration_ms without delaying the row (and
-- without losing it if the background task dies). Null = this turn had no live cleanup handoff
-- (or it never finished), which is the plan's "a turn with no cleanup never touches this column".
--
-- Applied by hand against the dedicated BigImagine database, same as every post-0105 migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0115_turn_metrics_cleanup_duration.sql

alter table turn_metrics add column cleanup_duration_ms int;
