-- Encrypted, DB-backed home for the provider API keys that get rotated far more often than the
-- rest of bigBrain's config (deepseek/openrouter LLM keys, the Voyage embeddings key) — see
-- orchestrator/src/io/providerCredentials.ts for how it's read/written. Applied by
-- hand, same as 0003-0007, since docker-entrypoint-initdb.d only runs against an empty volume:
--   psql -U bigbrain_admin -d bigbrain -f /docker-entrypoint-initdb.d/0008_provider_credentials.sql

-- Household-wide system config, not per-user data — no user_id column, and deliberately NOT
-- added to 0002's user_scoped-RLS loop, exactly like `users` itself is exempt from it. No RLS is
-- enabled here: there is no bigBrain user this could sensibly be scoped to, and the only caller
-- of this table (the admin credentials route) already authenticates with a single household-wide
-- admin key, not a per-user one.
--
-- `name` is a small, fixed vocabulary the orchestrator's boot code already knows by name, not an
-- open key-value store meant to grow ad hoc — the CHECK constraint enforces that closed set at
-- the schema level, so a typo in the admin API fails loudly (constraint violation) instead of
-- silently creating a row nothing will ever read.
create table provider_credentials (
  name        text primary key check (name in (
                'deepseek_api_key',
                'openrouter_api_key',
                'voyage_api_key'
              )),
  ciphertext  text not null,
  updated_at  timestamptz not null default now()
);

-- Belt-and-braces explicit grant, same precedent as 0003's re-grant after adding columns — 0002's
-- `alter default privileges` should already cover a brand-new table, but this keeps the file
-- self-contained rather than relying on that holding.
grant select, insert, update, delete on provider_credentials to bigbrain_app;
