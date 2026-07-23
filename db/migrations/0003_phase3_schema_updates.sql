-- Two changes needed before Document Ingestion (Phase 3) can run. Applied by hand, since
-- docker-entrypoint-initdb.d only runs against an empty volume and this one already has data:
--   psql -U bigbrain_admin -d bigbrain -f /docker-entrypoint-initdb.d/0003_phase3_schema_updates.sql
-- (bigbrain_admin, not bigbrain_app — ALTER TABLE needs owner/superuser privileges bigbrain_app
-- was deliberately never granted.)

-- 1. Resize the vector columns from 1536 to 2048. Voyage AI (the chosen embeddings provider,
--    voyage-4) does not support a 1536-dimensional output at all — verified against Voyage's
--    current docs, its output_dimension is one of {2048, 1024, 512, 256}. 1536 wasn't load-
--    bearing anywhere else in the schema, so the choice among the four is purely about
--    quality/cost/storage — at household-notes scale (thousands, not millions, of rows),
--    storage and query latency are irrelevant regardless of which one is picked, so 2048
--    (Voyage's highest-quality tier) was chosen over the usual web-scale default of 1024.
--    Safe to run: no ingestion has happened yet, so both columns are all-NULL.
alter table unstructured_notes alter column vector_embed type vector(2048);
alter table documents alter column vector_embed type vector(2048);

-- 2. unstructured_notes was missing columns for two of the three fields the ingestion pipeline
--    actually produces (docs/spec.md §6.1: {category, auto_tags, summary_short}) — auto_tags
--    already existed from the original migration, category and summary_short did not, even
--    though `documents` already carries summary_short. Adding them rather than silently
--    discarding what the LLM extracts.
alter table unstructured_notes add column category text;
alter table unstructured_notes add column summary_short text;

-- Re-asserting the existing grant is harmless and keeps this file self-contained; new columns
-- on an already-granted table don't strictly need it, but ALTER TABLE ... ADD COLUMN on a table
-- with FORCE ROW LEVEL SECURITY still respects the original grant, this is just belt-and-braces.
grant select, insert, update, delete on unstructured_notes, documents to bigbrain_app;
