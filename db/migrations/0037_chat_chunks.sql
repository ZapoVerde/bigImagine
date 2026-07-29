-- docs/chat-memory.md: the chat-lane RAG table — full-turn recall for archived conversation, same
-- shape as document_chunks (0021_document_chunks.sql) with chat_id/sync_id in place of doc_id.
-- content is the raw transcript slice (chunkChatTranscript.ts's turn-pair grouping); summary is a
-- one/two-sentence AI-generated gist of that slice (classifyChatChunk.ts), embedded and stored
-- alongside it so recall_chat_history can show a quick gist without re-fetching the full excerpt.
-- Only content is embedded, not summary — a second embedding lane (Canonize's "content + header"
-- two-lane retrieval) is a real refinement but not something to build speculatively; single-lane
-- content search already works for search_documents at the same household scale.
--
-- sync_id on delete cascade: a chunk has no lifecycle of its own beyond the sync that produced it
-- — if that sync point is invalidated (chat_sync_points' own doc), the chunk goes with it, and the
-- next sync pass regenerates it (correctly) from whatever raw messages survived.
create table chat_chunks (
  chunk_id     uuid primary key default gen_random_uuid(),
  chat_id      uuid not null references chat_sessions(chat_id) on delete cascade,
  sync_id      uuid not null references chat_sync_points(sync_id) on delete cascade,
  user_id      uuid not null references users(user_id),
  ordinal      int not null,
  content      text not null,
  summary      text not null,
  vector_embed vector(2048),
  created_at   timestamptz not null default now(),
  unique (chat_id, ordinal)
);

alter table chat_chunks enable row level security;
alter table chat_chunks force row level security;
create policy user_scoped on chat_chunks
  using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

create index chat_chunks_by_chat on chat_chunks (chat_id, ordinal);
