-- Swipe capability on the last LLM response (docs/bi_principles.md §1: swipe history is real,
-- attributable relational state, not something the client fakes locally). chat_messages.content
-- stays the single source every existing reader already trusts (search ilike, chunking, canon
-- anchors, fork, chat-memory sync) — untouched by this migration. A swipe row is an *alternate*
-- variant of one assistant message; the currently active variant's text still lives on the
-- chat_messages row itself, mirrored into a swipe row once a message has been regenerated at least
-- once (io/chatSessions.ts's recordSwipe/cycleSwipe do the mirroring, not application code at the
-- call sites).
--
-- Scoped deliberately to whichever message is still the *last* assistant reply: that's the only
-- message swiping ever touches (server/httpServer.ts gates regeneration to it, same as the
-- pre-existing Rerun action), and it's always still inside the live window — chatMemorySync.ts's
-- chunking/canon-extraction pipeline never reaches back and touches an in-place content swap out
-- from under it.
--
-- No pruning when a chat moves on: a message's swipe rows are left alone once a newer turn is
-- appended after it, even though that message is no longer "last" and its swipe controls are no
-- longer shown. This is what makes "delete the last turn -> the previous turn's swipes reappear"
-- fall out for free — deleting the newer message just exposes this one as the new last assistant
-- reply again, and nothing ever touched its chat_message_swipes rows in the meantime. on delete
-- cascade off chat_messages, so deleting/truncating a message takes its own swipe history with it,
-- same shape as chat_sync_points -> chat_chunks in 0040's own design.
--
-- Fork intentionally does not carry swipe history into the branch (io/chatSessions.ts's forkChat)
-- — same accepted-imprecision trade docs/chat-memory.md already documents for chat_memory_entries;
-- only the active content comes along, not the alternates.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0059_chat_message_swipes.sql

create table chat_message_swipes (
  swipe_id   uuid primary key default gen_random_uuid(),
  message_id uuid not null references chat_messages(message_id) on delete cascade,
  content    text not null,
  created_at timestamptz not null default clock_timestamp()
);

create index chat_message_swipes_by_message on chat_message_swipes (message_id, created_at);

alter table chat_messages add column active_swipe_id uuid references chat_message_swipes(swipe_id) on delete set null;

alter table chat_message_swipes enable row level security;
alter table chat_message_swipes force row level security;
create policy user_scoped on chat_message_swipes using (
  exists (select 1 from chat_messages m where m.message_id = chat_message_swipes.message_id and m.user_id = app_current_user_id())
) with check (
  exists (select 1 from chat_messages m where m.message_id = chat_message_swipes.message_id and m.user_id = app_current_user_id())
);

grant select, insert, update, delete on chat_message_swipes to bigimagine_app;
