-- Stage 4 of the CNZ retrieval port (docs/plans/rag-dynamic-cutoff-plan.md): the keyword/FTS
-- lane over chat_chunks.content. recallForPrompt.ts's chunk query scores each fetched row with
-- ts_rank(content_tsv, ...) and recallCutoff.ts's blendKeyword re-ranks the window by blended
-- distance before the pool is sliced and measured (Canonize's RAG_strategy_v4.md §3 Step 3,
-- chat channel only).
--
-- content_tsv is a STORED generated column: Postgres computes it on insert AND backfills it for
-- existing rows when the column is added, so there is no trigger and no backfill script — the
-- sync pass that writes chat_chunks keeps working unchanged.
--
-- The GIN index is added per the plan's own scope text ("tsvector column + GIN index on
-- chat_chunks.content"). The Stage-4 recall query itself never filters by @@ — the keyword lane
-- is additive-only (a row can only rank better via keyword, never be excluded), so the index
-- serves future keyword-filtered paths (the plan's "later canon_facts text" widening, the
-- recall tools' FTS). Chat lane only — canon_facts gets its own tsvector when that stage ships.
--
-- Idempotent (IF NOT EXISTS on both statements) — safe to re-run if a prior apply attempt is
-- unconfirmed. Applied by hand against the dedicated BigImagine database, same as every
-- post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0093_chat_chunks_keyword_lane.sql

alter table chat_chunks
  add column if not exists content_tsv tsvector generated always as (to_tsvector('english', content)) stored;

create index if not exists chat_chunks_content_tsv_gin on chat_chunks using gin (content_tsv);
