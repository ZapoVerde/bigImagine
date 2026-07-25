-- docs/spec.md §6.6 chunking: saveDocument.ts previously embedded a whole document as one
-- vector (risking Voyage's per-text token ceiling on long clipped articles, and diluting
-- retrieval precision across multi-section pages). This table holds the per-chunk decomposition
-- chunkDocument.ts produces, keyed to its parent document, with its own embedding so
-- search_documents can rank chunks instead of whole documents. Same RLS shape as every other
-- user-scoped table (0002_schema.sql); on delete cascade since a chunk has no lifecycle of its
-- own beyond its parent document's.
create table document_chunks (
  chunk_id     uuid primary key default gen_random_uuid(),
  doc_id       uuid not null references documents(doc_id) on delete cascade,
  user_id      uuid not null references users(user_id),
  ordinal      int not null,
  heading_path text,
  content      text not null,
  vector_embed vector(2048),
  created_at   timestamptz not null default now(),
  unique (doc_id, ordinal)
);

alter table document_chunks enable row level security;
alter table document_chunks force row level security;
create policy user_scoped on document_chunks
  using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

create index document_chunks_by_doc on document_chunks (doc_id, ordinal);
