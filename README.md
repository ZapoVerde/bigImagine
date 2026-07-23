# bigBrain

Self-hosted, multi-user "Second Brain" platform — Postgres+pgvector canonical store, server-side
LLM reasoning/orchestration layer, replaceable interface layer, and a set of microservice plugins
(document ingestion, shopping analytics, communications, Notion sync, GitHub docs ingestion).

Read before touching code:
- `docs/bb_principles.md` — design intent, read first
- `docs/spec.md` — architecture spec (principles win where they disagree)
- `docs/conventions.md` — module preamble format and file-organization rules

## Layout

- `orchestrator/` — the reasoning/orchestration layer (tool manifest, LLM client, agentic loop)
- `plugins/*` — microservice plugins, one per domain, registered as orchestrator tools
- `db/migrations/` — Postgres+pgvector schema
- `docker-compose.yml` — the Dockge-managed stack definition
