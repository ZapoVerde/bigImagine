-- Per-sync inspection for the RP chat sync-status panel: make each sync point answer "what did
-- this pass produce, and what did it send the model?" Two gaps in the current schema block that:
--
-- 1. bridge_prompt on chat_sync_points — the bridge prompt (bridgeChatMemory.ts) is rendered and
--    discarded inside the sync: the template (chat_memory_bridge_prompt), interpolated {{user}},
--    the raw transcript, the PREVIOUS OUTPUT block, and the running plot threads are handed to the
--    LLM and never kept. This column records the fully-rendered system+user message that pass
--    actually sent, so the panel can "play back" the prompt instead of reconstructing it (exact
--    reconstruction is impossible after the fact — previous output / running threads have since
--    moved on). Null for non-rp chats (no bridge) and for syncs predating this migration.
--
-- 2. canon_facts.sync_id — plot/lorebook/people proposals a pass writes carry chat_id but no
--    sync_id, so they can't be attributed to the sync that produced them (only guessed at by
--    proposed_at timing). `on delete set null`, not cascade — unlike chat_chunks/chat_memory_entries
--    (which are pure derived state, reconstructible from their source transcript, so 0036's
--    self-healing cascade is right for them), an approved canon fact is a durable record
--    (bi_principles.md §15: reviewable, not erased). Truncating a message away destroys the sync
--    point and its *reconstructible* state; the facts it proposed stay, just de-attributed —
--    exactly 0054's original `set null` reasoning for canon_facts.chat_id, and the same reason a
--    fork's copied facts (which keep the parent's sync_id) must not be cascade-deleted when the
--    parent's sync point later dies. Nullable — facts written outside the sync loop (tools,
--    future writers) stay unattributed, which is exactly the distinction the inspection view
--    wants to draw.
--
-- Applied by hand against the dedicated BigImagine database, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0079_sync_inspection.sql
alter table chat_sync_points add column bridge_prompt text;

alter table canon_facts add column sync_id uuid references chat_sync_points(sync_id) on delete set null;
create index canon_facts_sync_idx on canon_facts (sync_id);
