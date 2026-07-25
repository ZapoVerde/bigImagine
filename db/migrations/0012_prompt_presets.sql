-- Reusable named system-prompt snippets ("instruction sets") for the Chat tab's per-chat settings
-- pane — applied by hand, same as 0004/0009/0011:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0012_prompt_presets.sql
-- (bigbrain_admin, not bigbrain_app — CREATE TABLE needs owner/superuser privileges bigbrain_app
-- was deliberately never granted.)
--
-- Picking a preset only copies its content into a chat's own params.system text (chat_sessions,
-- 0009) — it is not a live reference. Editing or deleting a preset later never changes any chat
-- that already copied from it.

create table prompt_presets (
  preset_id  uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(user_id),
  name       text not null,
  content    text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index prompt_presets_by_user_updated on prompt_presets (user_id, updated_at desc);

alter table prompt_presets enable row level security;
alter table prompt_presets force row level security;
create policy user_scoped on prompt_presets using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on prompt_presets to bigbrain_app;
