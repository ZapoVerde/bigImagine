# Migrations

Mounted straight into the Postgres container as `/docker-entrypoint-initdb.d` (see
`docker-compose.yml`), so these run once, in filename order, only against a fresh volume:

- `0001_create_app_role.sh` — creates the non-superuser `bigbrain_app` role RLS actually applies to
- `0002_schema.sql` — `users`, `unstructured_notes`, `recipes_meals`, `shopping_logs`,
  `notion_sync_map`, `documents` (per `docs/spec.md` §3), RLS enabled+forced on every
  `user_id`-scoped table, grants to `bigbrain_app`

To change the schema after the volume already exists, add a new numbered file here (this
directory is not re-run against an existing volume) and apply it by hand, or wipe the volume in
dev. `../checks/verify_rls.sql` proves the RLS policies actually hold.

Already applied by hand, not run automatically (see the file for the exact command):
- `0003_phase3_schema_updates.sql` — resizes `vector_embed` from 1536 to 1024 dims (Voyage AI's
  models don't support 1536) and adds `unstructured_notes.category` /
  `unstructured_notes.summary_short`, which the original migration omitted despite the ingestion
  pipeline (`docs/spec.md` §6.1) producing both.
- `0008_provider_credentials.sql` — adds `provider_credentials`, the encrypted DB-backed home for
  the four provider API keys previously only in static env vars (`deepseek_api_key`,
  `openrouter_api_key`, `voyage_api_key`, `notion_token`). Household-wide system config, not
  per-user data — deliberately exempt from RLS the same way `users` is. Rotated via the admin-only
  `POST /v1/admin/credentials` route (`orchestrator/src/server/adminServer.ts`) instead of a code
  rebuild.
