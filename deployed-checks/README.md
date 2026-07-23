# Deployed-tier checks

Scripts here need the real running stack — a live Postgres, a live LLM/embeddings API key, or
both — unlike everything under `orchestrator/scripts/` and `plugins/*/scripts/`, which run
locally with fakes at the I/O boundary (see `docs/verification.md`). Nothing here runs as part of
`npm run verify`; each script is run deliberately, by hand, from wherever it can actually reach
what it's checking (a `docker exec` shell, or a machine with network access to the deployed
stack).

Every script's own header comment states exactly how to run it and against what — mirroring
`db/checks/verify_rls.sql`'s convention, which stays in `db/checks/` since it's mounted straight
into the Postgres container and is really a database-specific check, not a general one.

## What lives here (as of Phase 4)

Nothing yet — the orchestrator isn't deployed as a running service. The first candidate is a
live-model check: hit the real `/v1/chat/completions` endpoint with a message that should trigger
`ingest_note`, and confirm a real row lands in `unstructured_notes` with a real Voyage embedding —
proving what no local script can: that the active `BIGBRAIN_LLM_PROFILES` model actually honors
`forceTool` and produces a usable classification. Add it here once there's a deployed orchestrator
and a real API key to run it against.
