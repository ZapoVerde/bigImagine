-- docs/chat-memory.md: the cross-chat "worth keeping" memory — the one piece of derived state
-- from this feature that deliberately outlives its source chat. Populated by
-- classifyHouseholdMemory.ts's single end-of-chat judgment call, triggered by the explicit
-- archive_chat action (docs/bb_principles.md §3: an explicit "this chat is done" signal, not an
-- inferred idle-timeout) — see io/chatSessions.ts's archiveChat.
--
-- source_chat_id is `on delete set null`, not cascade — unlike chat_chunks/chat_memory_entries,
-- this table's rows are not reconstructible from their source chat once it's gone (there is no
-- resync that regenerates them), so deleting the source chat must never take these with it. source
-- defaults 'inferred' (docs/bb_principles.md §3: explicit user signal outranks inferred) so a
-- future editing surface can visually distinguish an LLM-proposed memory from one a household
-- member typed or edited directly; flipped to 'user' by update_household_memory whenever a human
-- edits an entry's content.
create table household_memory (
  memory_id      uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(user_id),
  source_chat_id uuid references chat_sessions(chat_id) on delete set null,
  content        text not null,
  source         text not null default 'inferred' check (source in ('inferred', 'user')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table household_memory enable row level security;
alter table household_memory force row level security;
create policy user_scoped on household_memory
  using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

create index household_memory_by_user on household_memory (user_id, updated_at desc);
