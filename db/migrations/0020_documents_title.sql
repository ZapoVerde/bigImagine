-- documents (0002/0003) was missing what the new save_document/list_documents/get_document tools
-- (docs/spec.md §6.6) actually need: a queryable title (so list_documents can show one without
-- re-fetching and parsing every file out of git on every call), and created_at/updated_at (so a
-- document list can be ordered the same way get_notes already orders notes). Mirrors notes'
-- own shape (0011_notes.sql) exactly, including the same (user_id, updated_at desc) browse index.
alter table documents add column title text;
alter table documents add column created_at timestamptz not null default now();
alter table documents add column updated_at timestamptz not null default now();
create index documents_by_user_updated on documents (user_id, updated_at desc);
