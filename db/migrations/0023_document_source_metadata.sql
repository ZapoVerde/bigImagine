-- Structured source metadata for clipped documents (ingest_url), populated via
-- htmlToMarkdown.ts's extractMetadata (Schema.org JSON-LD / OpenGraph / meta[name=author],
-- falling back to Readability's own byline/siteName/publishedTime). save_document's manual path
-- leaves all four null. Display-only for now (DocumentsView), not filtered/searched on, so no
-- index.
alter table documents add column source_url text;
alter table documents add column site_name text;
alter table documents add column author text;
alter table documents add column published_at timestamptz;
