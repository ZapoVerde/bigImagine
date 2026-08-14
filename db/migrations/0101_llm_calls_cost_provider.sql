-- Widens llm_calls with the four fields the Stats page's Usage & Cost section reads
-- (docs/plans/llm-stats-page-plan.md):
--
--   provider_kind         text — the LlmProfile.kind ('anthropic' | 'openai-compatible') that
--                         actually served the call, closed over by the gate's fourth parameter
--                         (io/llm/llmGate.ts). Null = row written before this migration.
--   model                 text — the LlmProfile.model that served the call, same source. Null =
--                         row written before this migration.
--   cache_read_tokens     int — the usage.cacheReadTokens the adapter already relays (DeepSeek's
--                         prompt_cache_hit_tokens); undefined usage means null, never a guessed 0.
--   cost_usd              numeric — derived by io/llm/callCost.ts from the call's token counts and
--                         the resolved connection's price tiers; null when a needed tier is
--                         missing (omit, don't guess $0.00), or for pre-migration rows.
--
-- All four nullable, no backfill: pre-migration rows can't be reconstructed (no provider/model
-- was recorded, and cost needs both token counts and price tiers), and the admin endpoint
-- substitutes '(pre-tracking)' for the two attribution columns while leaving the numeric columns
-- null — excluded from sums/averages, not treated as zero.
--
-- Table-level grants already cover new columns (column-agnostic), so no grant change is needed —
-- same note as 0089.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0101_llm_calls_cost_provider.sql

alter table llm_calls
  add column provider_kind text,
  add column model text,
  add column cache_read_tokens int,
  add column cost_usd numeric;
