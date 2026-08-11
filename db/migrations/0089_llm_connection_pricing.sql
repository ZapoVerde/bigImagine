-- Per-connection LLM pricing for the Prompt Inspector's usage receipt
-- (docs/plans/prompt-inspector-usage-cost.md). Three nullable numeric columns on
-- llm_connections: USD per 1M tokens for input, output, and cache-hit tokens.
--
-- NULL means "not configured", not zero — a connection with no price set shows token counts
-- only in the inspector, never a fabricated $0.00. The three tiers mirror the billing shape of
-- the in-scope provider (DeepSeek/OpenAI-compatible: input, output, cache-hit). There is
-- deliberately no cache-write tier: no in-scope vendor has a cache-creation concept, and the
-- Anthropic adapter that would need one is out of scope for this platform (see the plan).
--
-- Plain visible/editable runtime config per bi_principles.md §12 (configures behavior, not a
-- secret — none of api_key_ciphertext's write-only treatment) and §13 (lives in the DB,
-- editable from the Connections tab, never an env var). Same table as the key, deliberately
-- different treatment.
--
-- Table-level grants already cover new columns, so no grant change is needed.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0089_llm_connection_pricing.sql

alter table llm_connections add column price_input_per_million numeric;
alter table llm_connections add column price_output_per_million numeric;
alter table llm_connections add column price_cache_hit_per_million numeric;
