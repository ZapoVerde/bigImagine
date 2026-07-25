-- Persisted chat sessions (history, folders, per-chat params & tools) — applied by hand, same as
-- 0003/0004:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0009_chat_sessions.sql
-- (bigbrain_admin, not bigbrain_app — CREATE TABLE needs owner privileges bigbrain_app was
-- deliberately never granted.)
--
-- Design deliberately skips Open WebUI's one-JSON-blob-per-chat storage (which that project is
-- itself mid-migration away from, dual-writing into a normalized message table) and goes straight
-- to normalized rows. Also deliberately lean vs. that reference: no pinned/archived/tags/share
-- columns — household scale doesn't need them, and delete is a real delete.
--
-- chat_sessions.params holds defined keys only (system, temperature, top_p, max_tokens, model),
-- merged over provider defaults at request time by httpServer.ts's chat_id handling.
-- chat_sessions.tool_names: null = all registered tools (the pre-existing behavior), '{}' = none,
-- otherwise an allow-list of tool names filtered via toolRegistry.ts's filterToolRegistry.
-- chat_messages.user_id is denormalized so RLS applies directly, no join needed (0004 precedent).

create table folders (
  folder_id  uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(user_id),
  name       text not null,
  parent_id  uuid references folders(folder_id) on delete cascade,
  created_at timestamptz not null default now()
);

create table chat_sessions (
  chat_id    uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(user_id),
  title      text not null default 'New chat',
  folder_id  uuid references folders(folder_id) on delete set null,
  params     jsonb not null default '{}',
  tool_names text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table chat_messages (
  message_id uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references chat_sessions(chat_id) on delete cascade,
  user_id    uuid not null references users(user_id), -- denormalized so RLS applies directly, no join needed
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  created_at timestamptz not null default now()
);

create index chat_messages_by_chat on chat_messages (chat_id, created_at);
create index chat_sessions_by_user_updated on chat_sessions (user_id, updated_at desc);

do $$
declare
  t text;
begin
  foreach t in array array['folders', 'chat_sessions', 'chat_messages']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy user_scoped on %I using (user_id = app_current_user_id()) with check (user_id = app_current_user_id())',
      t
    );
  end loop;
end $$;

grant select, insert, update, delete on folders, chat_sessions, chat_messages to bigbrain_app;
