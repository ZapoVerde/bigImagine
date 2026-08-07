-- Vistalyze image generation subsystem (docs/vistalyze_integration/endpoint.md §2): the
-- admin-managed image-connection registry, the orchestrator settings key for the master image
-- prompt template, and the locations.image_path -> image_url rename that makes a location's
-- image column mean "a remote CDN URL", not a local file path.
-- Applied by hand against the dedicated BigImagine database, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0068_image_connections.sql
--
-- 1. image_connections mirrors llm_connections (db/migrations/0062_llm_connections.sql) exactly:
--    household-wide system config with no user_id column and no RLS (0062's own comment explains
--    why — there is no BigImagine user an admin-managed backend could sensibly be scoped to, and
--    the only readers are the admin routes and the generation pass, both household-wide).
--    api_key_ciphertext follows io/fieldCipher.ts (AES-256-GCM) and is nullable: only a local
--    ComfyUI endpoint legitimately has no key — every cloud provider (Runware, fal.ai,
--    Pollinations, OpenAI) requires one. Pollinations stopped being keyless in 2025; its token
--    is required and rides as the `token` URL param (io/imageGen/pollinations.ts), unlike llm_connections
--    where every connection needs a key. is_active is the single active-pointer — enforced by the
--    partial unique index, read live by io/imageConnections.ts's resolveActive() on every
--    generateLocationImage call (no boot-time singleton, no restart on switch, per bi_principles.md
--    §13). The spec's §2.2 "Active Image Connection Pointer" settings entry is deliberately NOT
--    added: it would duplicate this column as a second source of truth, and the llm_connections
--    precedent (§2.1's is_active + resolveActive) is the established shape.
--
-- 2. locations.image_path is renamed to image_url. 0045's own comment scoped image_path for a
--    local file path on the explicit assumption that "Vistalyze's image pipeline isn't built yet";
--    that pipeline is what this migration's sibling code implements, and the column now stores the
--    direct, remote HTTPS CDN link the provider returns (endpoint.md §2.3). Stateless media
--    philosophy (endpoint.md §1.1): no image file is ever stored locally, the DB holds only the
--    remote URL. Cache validation (endpoint.md §5.1) compares the location's current visual
--    description/environment/seed against the state recorded at Image Generated At — stored in
--    the new image_rendered_input snapshot column, NOT via updated_at (the post-cleanup scraper
--    bumps updated_at on every matched turn's environment merge/re-anchor even when nothing
--    visual changed, which would make updated_at-based validation always miss and defeat the
--    cache-first commitment). A row whose current inputs equal its snapshot is a cache hit; any
--    real scrape/update of those inputs diverges the snapshot and correctly invalidates.
--
-- 3. image_prompt_template widens orchestrator_settings.key's CHECK constraint (the widen-only
--    precedent every settings key follows, e.g. 0065): the master image prompt template
--    (endpoint.md §2.2) that synthesizeImagePrompt.ts expands against a location's
--    visual_description/environment, read live per generation with an empty value meaning "use the
--    built-in default" (bi_principles.md §18). There is no separate reset action — writing '' is
--    how Settings clears an override, same as every other prompt override key.

create table image_connections (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null unique,
  kind                        text not null check (kind in ('runware', 'fal-ai', 'pollinations', 'comfyui', 'openai-images')),
  model                       text not null,
  api_key_ciphertext          text,
  base_url                    text,
  -- Explicit output resolution in pixels, per connection — every adapter sends width/height
  -- (neither this subsystem nor the upstream VLZ stack ever sends an aspect-ratio string to a
  -- provider; VLZ's own background renders default to 16:9 landscape, and the pre-2026-08-13
  -- aspect_ratio string was just an indirection to these same pixels).
  width                       integer not null default 1344,
  height                      integer not null default 768,
  sampling_steps              integer not null default 30,
  cfg_scale                   numeric not null default 7.0,
  sampler_name                text,
  master_positive_style_prefix text,
  master_negative_prompt      text,
  workflow_parameters         jsonb,
  is_active                   boolean not null default false,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create unique index image_connections_one_active on image_connections (is_active) where is_active;

grant select, insert, update, delete on image_connections to bigimagine_app;

alter table locations rename column image_path to image_url;

-- The input snapshot (visual_description/environment/seed) recorded at the last successful
-- render — endpoint.md §5.1's cache validation compares the row's *current* inputs against this,
-- not against updated_at (the scraper bumps updated_at every matched turn even on a no-op merge,
-- which would otherwise make the cache always miss).
alter table locations add column image_rendered_input jsonb;

alter table orchestrator_settings drop constraint if exists orchestrator_settings_key_check;
alter table orchestrator_settings add constraint orchestrator_settings_key_check check (key in (
  'active_llm_profile',
  'active_llm_model',
  'household_timezone',
  'llm_vision_capable_profiles',
  'ntfy_server_url',
  'notifications_enabled',
  'agent_routines_enabled',
  'agent_routine_max_runs_per_day',
  'agent_routine_max_tokens_per_day',
  'agent_routines_disabled_reason',
  'chat_memory_profile',
  'chat_memory_live_window_pairs',
  'chat_memory_sync_every_pairs',
  'chat_memory_digest_horizon_pairs',
  'chat_memory_chunk_summary_prompt',
  'chat_memory_distill_prompt',
  'chat_memory_household_memory_prompt',
  'chat_memory_bridge_prompt',
  'chat_memory_lorebook_curator_prompt',
  'chat_memory_people_curator_prompt',
  'canon_recall_top_k',
  'canon_extraction_prompt',
  'screen_lock_password',
  'screen_lock_timeout_minutes',
  'pia_proxy_url',
  'persona_name',
  'persona_description',
  'llm_gate_max_concurrent',
  'llm_gate_max_concurrent_agent_routine',
  'llm_gate_max_retries',
  'llm_gate_retry_base_ms',
  'llm_gate_retry_max_ms',
  'image_prompt_template'
));
