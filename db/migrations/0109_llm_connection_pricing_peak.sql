-- Peak-tier LLM pricing + last-sync stamp for llm_connections
-- (docs/plans/deepseek-pricing-sync.md). DeepSeek bills two rates per token type — off-peak
-- (base) and peak (hours 01:00-04:00 and 06:00-10:00 UTC) — so the single-tier 0089 columns are a
-- lossy view. The existing price_input/output/cache_hit_per_million columns stay the off-peak/base
-- tier exactly as-is (they already hold the manual off-peak entries and the page's OFF-PEAK
-- column); this migration adds the peak counterparts plus price_synced_at, the timestamp the
-- pricing sync stamps when it last wrote this row's rates.
--
-- Same nullable-numeric contract as 0089: NULL means "not configured", never zero — a connection
-- with a missing needed tier shows token counts only in the inspector, never a fabricated $0.00.
-- price_synced_at is NULL until the sync has ever written this row; it is written only by the sync
-- pass (orchestrator/src/io/deepseekPricingSync.ts), never by the admin editor.
--
-- Plain visible/editable runtime config per bi_principles.md §12-13 (DB-backed, Connections tab),
-- same treatment as the 0089 columns. Table-level grants already cover new columns, so no grant
-- change is needed.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0109_llm_connection_pricing_peak.sql

alter table llm_connections add column price_peak_input_per_million numeric;
alter table llm_connections add column price_peak_output_per_million numeric;
alter table llm_connections add column price_peak_cache_hit_per_million numeric;
alter table llm_connections add column price_synced_at timestamptz;