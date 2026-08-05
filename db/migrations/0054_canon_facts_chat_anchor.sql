-- Point-in-time canon recall (docs/bb_principles.md's never-erase precedent, canonize-plan.md §3.2):
-- anchors each canon fact to the chat and message it was proposed at, so "what did the story know
-- as of message N" is a filtered read over the existing append-only table, never a mutation.
-- Applied by hand against the dedicated BigImagine database, same as 0053:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0054_canon_facts_chat_anchor.sql
--
-- `on delete set null`, not cascade, on both columns: truncating/editing a chat must never delete a
-- canon fact (bi_principles.md §15's "a proposal is reviewable, not erased" — the same invariant
-- that already keeps rejected rows around forever). If the anchor message is later deleted (an
-- edit/rollback truncating past it), the fact just loses its chat-scoping and falls back to global
-- visibility — the same "self-healing via FK, not app code" property chat_chunks/chat_memory_entries
-- already get from `on delete cascade` (0036_chat_sync_points.sql), just `set null` instead of
-- `cascade` since this table isn't allowed to lose rows.
--
-- No new ordinal column: `(created_at, message_id)` row-value comparison is already the codebase's
-- established "position in this chat" ordering (io/chatSessions.ts's truncateMessagesFrom/forkChat/
-- getChat all use it), so anchoring directly to a chat_messages row and reusing that same tuple
-- comparison for "as of" queries needs no backfill of a redundant position column.
--
-- scene_id (existing) and chat_id (new) are orthogonal scopes: scene_id is "who's in the room",
-- chat_id is "which conversation's timeline this fact belongs to" — a fact can have either, both,
-- or neither (a platform-global fact has no scene and no chat).

alter table canon_facts add column chat_id uuid references chat_sessions(chat_id) on delete set null;
alter table canon_facts add column anchor_message_id uuid references chat_messages(message_id) on delete set null;

create index canon_facts_chat_anchor_idx on canon_facts (chat_id, anchor_message_id);
