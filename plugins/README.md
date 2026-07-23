# Plugins

Each subdirectory here is one microservice plugin per `docs/spec.md` §6 — an IO Wrapper per
`docs/bb_principles.md` §8, registered with the orchestrator's tool manifest. Nothing lives here
yet; plugins land in build order (see the project plan): document ingestion, shopping analytics,
communications gateway, Notion sync gateway, GitHub ingestion gateway.

Each plugin package follows the same shape as `orchestrator/`: its own `package.json`,
`tsconfig.json` (extending `../../tsconfig.base.json`), and `src/` with module preambles per
`docs/conventions.md`.
