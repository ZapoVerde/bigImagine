-- docs/plans/eager-chunk-sync-plan.md: the "closed" marker on chat_sync_points. A sync point is
-- now created by one of two paths, distinguished by this column:
--   closed_at null  = OPEN — created eagerly by eagerChunkSync.ts right after a turn pair rolls
--                     off the live window (chunk-only: chat_chunks rows exist under it, but no
--                     digest/bridge/curator consolidation has run against it yet)
--   closed_at set   = CLOSED — the sync tick that eventually consolidated the block (digest/
--                     bridge/curators) has run; last_message_id carries the consolidation boundary
-- The eager path reuses the chat's open point until the tick closes it ("at most one open sync
-- point" is enforced by construction: only the eager path opens points, and only the tick closes
-- them, both under the same per-chat pg_advisory_xact_lock). The tick's and Review Panel's "last
-- sync point" reads narrow to closed points only (findDueChats / runOneChatSync's lastSynced /
-- chatSessions.ts's getChatMemorySyncStatus / recallPlotLane.ts's arc-recency floor), so an
-- eager-only point is never mistaken for a consolidation boundary.
--
-- The backfill is load-bearing, not cosmetic: every pre-existing row was created by the sync tick
-- inside the same transaction as its consolidation (chatMemorySync.ts's runOneChatSync), so all
-- historical points are semantically closed. Left null, the first deploy after this migration
-- would read every chat as never-synced — closed-only findDueChats/lastSynced lose all anchors
-- (full-history re-consolidation with duplicate canon-fact inserts), the Review Panel's syncs list
-- empties, and the "at most one open sync point" invariant is dead on arrival.
alter table chat_sync_points add column closed_at timestamptz;

update chat_sync_points set closed_at = created_at where closed_at is null;
