-- Stage 5 of the CNZ retrieval port (docs/plans/rag-dynamic-cutoff-plan.md): the header/second
-- vector lane over chat_chunks.summary. recallForPrompt.ts now queries both lanes (content
-- vector_embed and summary_vector_embed), merges them with best-of scoring (the closer of the
-- two decayed distances), and applies Canonize's 1.08× dual-confirmation bonus to chunks that
-- appear in BOTH lanes' windows (RAG_strategy_v4.md §3 Step 1: s_vec = best cosine across
-- content/header lanes, ×1.08 if both matched — ported to distance space by recallCutoff.ts's
-- dualBonus).
--
-- summary_vector_embed is NULL for rows that predate this migration: the summary gists are
-- stored, but nothing has embedded them until now. The header lane query skips NULLs
-- (`summary_vector_embed is not null`), so pre-existing chunks simply don't participate in the
-- header lane until they'd be re-written by a future sync pass — the content lane still covers
-- them. No SQL-side backfill is possible (embeddings come from the orchestrator's provider);
-- chatMemorySync.ts embeds summaries from the next sync pass onward.
--
-- No vector index, matching vector_embed's own no-index design (0047's comment: a vector(2048)
-- column is too wide to index usefully at household scale; recall queries seq-scan).
--
-- Applied by hand against the dedicated BigImagine database, same as every post-initdb
-- migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0094_chat_chunks_summary_lane.sql

alter table chat_chunks
  add column summary_vector_embed vector(2048);
