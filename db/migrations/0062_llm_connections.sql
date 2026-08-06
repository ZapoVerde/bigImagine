-- Promotes LLM "connections" from a fixed set defined once in the BIGBRAIN_LLM_PROFILES env var
-- (orchestrator/src/io/llm/profiles.ts) to real, admin-managed, named rows — created/renamed/
-- deleted from the frontend's new Connections tab, not just field-overridden onto an env-defined
-- profile the way the old Settings "Connection" fieldset worked. See orchestrator/src/io/
-- llmConnections.ts for how this is read/written.
--
-- Household-wide system config, not per-user data — no user_id column, no RLS, same shape as
-- orchestrator_settings/provider_credentials (0008's own comment explains why: there is no
-- bigimagine user this could sensibly be scoped to, and the only callers are the admin connections
-- route and boot-time resolution, both already household-wide).
--
-- api_key_ciphertext follows provider_credentials' own column naming (io/fieldCipher.ts,
-- AES-256-GCM) — never returned in plaintext once set; the admin route only ever reports whether a
-- connection has a key configured (io/llmConnections.ts's LlmConnectionRow), same "write-only
-- secret" shape as provider_credentials.
--
-- provider_order/quantizations are jsonb string arrays rather than a normalized child table: at
-- most a primary + one fallback provider tag, and an optional quantization filter list — both
-- OpenRouter's own request-level `provider` object fields (order, quantizations), read as a unit
-- and never queried into individually, so a normalized table would add join cost for no benefit.
--
-- is_active marks which single connection the boot-time singleton (index.ts) uses for turns with
-- no per-chat override — the partial unique index enforces "at most one" at the schema level
-- instead of relying on application code to keep it consistent. Switching it still requires an
-- orchestrator restart (same Switch-and-restart contract the old Settings fieldset had); there is
-- deliberately no on-delete cascade default for the active row — io/llmConnections.ts's remove()
-- rejects deleting whichever connection is currently active, so this constraint is never tested
-- against a delete in practice, but is kept regardless as the schema-level backstop.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0062_llm_connections.sql

create table llm_connections (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null unique,
  kind                 text not null check (kind in ('anthropic', 'openai-compatible')),
  model                text not null,
  api_key_ciphertext   text not null,
  base_url             text,
  supports_vision      boolean not null default false,
  provider_order       jsonb,
  allow_fallbacks      boolean not null default true,
  quantizations        jsonb,
  is_active            boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create unique index llm_connections_one_active on llm_connections (is_active) where is_active;

grant select, insert, update, delete on llm_connections to bigimagine_app;
