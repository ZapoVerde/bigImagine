-- Canonical schema per docs/spec.md §3, with Correction 1 (auto_tags/pinned_tags split) and
-- Correction 2 (RLS on every user_id-scoped table) already applied.

create extension if not exists vector;
create extension if not exists pgcrypto;

create table users (
  user_id    uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

-- Every RLS policy below reads this. The orchestrator's Postgres IO wrapper sets it once per
-- request, inside the request's transaction, from trusted server-side context — never from
-- anything a message, note, or inbound webhook claims about itself (bb_principles.md §4).
create or replace function app_current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

create table unstructured_notes (
  note_id      uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(user_id),
  raw_text     text not null,
  vector_embed vector(1536),
  auto_tags    text[] not null default '{}',
  pinned_tags  text[] not null default '{}',
  created_at   timestamptz not null default now()
);

-- Not canonical for its own content (docs/spec.md §3) — the file at file_path, in git, is.
-- This row exists purely so the LLM can find/summarize it via chat.
create table documents (
  doc_id          uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(user_id),
  repo            text not null,
  file_path       text not null,
  last_synced_sha text,
  vector_embed    vector(1536),
  summary_short   text,
  status          text not null default 'fresh' check (status in ('fresh', 'stale')),
  unique (repo, file_path)
);

-- RLS: enabled + forced on every user_id-scoped table (users itself is the root and is exempt,
-- per spec §3 Correction 2). FORCE is required because bigbrain_app is not a superuser but
-- policies would otherwise still apply to it by default — FORCE additionally covers the case
-- where bigbrain_app is ever made the table owner.
do $$
declare
  t text;
begin
  foreach t in array array['unstructured_notes', 'documents']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy user_scoped on %I using (user_id = app_current_user_id()) with check (user_id = app_current_user_id())',
      t
    );
  end loop;
end $$;

grant usage on schema public to bigbrain_app;
grant select, insert, update, delete on all tables in schema public to bigbrain_app;
alter default privileges in schema public grant select, insert, update, delete on tables to bigbrain_app;
