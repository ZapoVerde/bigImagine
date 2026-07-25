-- docs/spec.md §6.6 tags: chunk-level, not document-level, since search_documents/list_documents
-- rank and filter at chunk granularity — a doc-level tag couldn't say which chunk of a
-- multi-topic document it applies to. Auto-assigned at save time (saveDocument.ts's tagChunks),
-- vocabulary-aware but not consolidated (tags are inexact by nature, same tolerance already
-- extended to unstructured_notes.auto_tags). GIN index for the array-overlap (&&) filter queries
-- list_documents/search_documents/list_document_tags use.
alter table document_chunks add column tags text[] not null default '{}';
create index document_chunks_tags_gin on document_chunks using gin (tags);
