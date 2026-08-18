-- Promotes provider identity from a base_url heuristic to a first-class `kind` on llm_connections,
-- and reconnects the provider-level API key so every connection of a provider shares it in the
-- background instead of each row owning (and manually re-pasting) its own key. See
-- docs/plans/shared-provider-api-keys-plan.md.
--
-- The two new kinds are 'deepseek' and 'openrouter'. Both still speak the OpenAI-compatible wire
-- shape and dispatch through the same adapter (io/llm/index.ts's createLlmProviderForProfile); the
-- kind only says *who* the provider is. A provider-kind row stores no per-row key
-- (api_key_ciphertext is NULL): io/llmConnections.ts resolves the shared key at call time from the
-- provider_credentials row of the same name (deepseek_api_key / openrouter_api_key, migration 0008) —
-- the key is rotated once, in Settings, for every connection of that kind.
--
-- Existing openai-compatible rows whose base_url host is api.deepseek.com / openrouter.ai are
-- converted in-place (step 2b), and their per-row ciphertext is hoisted verbatim into
-- provider_credentials (step 2): both columns are AES-256-GCM under the same
-- BIGBRAIN_FIELD_ENCRYPTION_KEY in the same fieldCipher format (io/fieldCipher.ts), so the ciphertext
-- copies across without a decrypt/re-encrypt, and no existing connection's key changes value. A
-- pre-existing provider_credentials row wins (on conflict do nothing): it is the newer, canonical
-- value (the legacy Settings surface already let it be rotated in place).
--
-- If more than one existing row matches the same provider host with a *different* key (not expected
-- today — confirmed no such rows exist at plan-time — but not schema-enforced either),
-- `order by name` makes "first" a deterministic, reproducible pick (alphabetically-first connection
-- name) instead of leaving it to unspecified SELECT row order; every matching row still converts to
-- the provider kind in step 2b regardless of which one won the insert.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0117_llm_connection_provider_kinds.sql
--
-- The whole migration runs as one transaction (begin/commit) rather than relying on psql's
-- per-statement autocommit: steps 2-3 mix DDL (constraint changes) with data backfill across two
-- tables, and a mid-script failure under autocommit would leave hoisted keys and converted rows
-- committed with no way to roll back by hand.

begin;

-- 1. widen kind
alter table llm_connections drop constraint if exists llm_connections_kind_check;
alter table llm_connections add constraint llm_connections_kind_check
  check (kind in ('anthropic', 'openai-compatible', 'deepseek', 'openrouter'));

-- 2. hoist existing DeepSeek/OpenRouter rows' keys into provider_credentials (verbatim ciphertext
--    copy, see header) and convert those rows to provider kinds, dropping their per-row key.
insert into provider_credentials (name, ciphertext, updated_at)
select 'deepseek_api_key', api_key_ciphertext, now()
from llm_connections
where kind = 'openai-compatible' and base_url is not null and base_url::text <> ''
  and lower(regexp_replace(regexp_replace(base_url, '^[a-z]+://', ''), '[:/].*$', '')) = 'api.deepseek.com'
order by name
on conflict (name) do nothing;

insert into provider_credentials (name, ciphertext, updated_at)
select 'openrouter_api_key', api_key_ciphertext, now()
from llm_connections
where kind = 'openai-compatible' and base_url is not null and base_url::text <> ''
  and lower(regexp_replace(regexp_replace(base_url, '^[a-z]+://', ''), '[:/].*$', '')) = 'openrouter.ai'
order by name
on conflict (name) do nothing;

-- 2b. every matching row converts, whether or not its own key was the one hoisted in 2 — that's the
--     point of "one shared key per provider" (see plan §Design Decisions). The column is still
--     NOT NULL at this point (dropped just below, in step 3) — so that drop has to run before this
--     UPDATE can null it out, not after.
alter table llm_connections alter column api_key_ciphertext drop not null;

update llm_connections set kind = 'deepseek',
  base_url = 'https://api.deepseek.com', api_key_ciphertext = null
where kind = 'openai-compatible' and base_url is not null and base_url::text <> ''
  and lower(regexp_replace(regexp_replace(base_url, '^[a-z]+://', ''), '[:/].*$', '')) = 'api.deepseek.com';

update llm_connections set kind = 'openrouter',
  base_url = 'https://openrouter.ai/api/v1', api_key_ciphertext = null
where kind = 'openai-compatible' and base_url is not null and base_url::text <> ''
  and lower(regexp_replace(regexp_replace(base_url, '^[a-z]+://', ''), '[:/].*$', '')) = 'openrouter.ai';

-- 3. the pairing rule: provider kinds draw the shared credential and carry no per-row key; every
--    other kind still requires one, exactly as before this migration.
alter table llm_connections add constraint llm_connections_key_source_check check (
  (kind in ('deepseek', 'openrouter') and api_key_ciphertext is null) or
  (kind not in ('deepseek', 'openrouter') and api_key_ciphertext is not null)
);

grant select, insert, update, delete on llm_connections to bigimagine_app; -- unchanged, restated

commit;
