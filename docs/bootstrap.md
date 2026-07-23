# bigBrain — Bootstrap

*Orientation for a new session with no prior context. Points into the real docs rather than
re-deriving them — read those for actual detail, this is just the map.*

---

## What it is

A self-hosted, multi-user "Second Brain" — Postgres+pgvector canonical store, an LLM-agnostic
orchestrator that owns all reasoning/tool-calling, and plugin microservices (notes, shopping
analytics, generic lists w/ Notion sync, recipes & meal planning).

## Start here, in order

1. `bb_principles.md` — the foundational rules (e.g. §4 user-scoping, §8 the four kinds of code,
   §11 observable-not-silent failures). These override intuition.
2. `spec.md` — the living architecture spec. Structured as original design + inline
   "Correction"/"Addition" entries documenting every real deviation from it (e.g. the
   field-encryption scope, the Notion `ownerUserId` cross-account bug and fix, the OpenAPI tool
   server, grocery section-ordering). This is the actual source of truth for current state, not
   this file.
3. `conventions.md` and `verification.md` — code style and the verify-script testing philosophy
   (no unit-test framework; purpose-built `.mjs` scripts with fake pools/LLMs, chained via each
   package's `npm run verify`).

**GitHub**: private repo at `github.com/ZapoVerde/bigbrain`, main branch, clean history.

---

## The workspace/stacks split (not written down anywhere else — read this carefully)

Two separate directory trees, **not symlinked**:

- **`/config/workspace/bigBrain/`** — the git repo, source of truth, what gets pushed to GitHub.
  Edit and verify (`npm run verify`) here.
- **`/config/workspace/stacks/bigbrain/`** — the *deployed* copy. Not a git repo. This is what
  Dockge/`docker compose` actually builds the running containers from. Holds the real `.env`
  (secrets, gitignored, never in `bigBrain/`) and is where migrations get hand-applied.

**Nothing syncs automatically.** The workflow after any change in `bigBrain/`:
```
cp -r bigBrain/<changed dirs> stacks/bigbrain/<same paths>
cd stacks/bigbrain && docker compose up -d --build orchestrator
```
Migrations don't auto-run either (`docker-entrypoint-initdb.d` only fires against an empty volume,
and this one has data) — apply by hand:
```
docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/000N_whatever.sql
```
If you edit only `stacks/bigbrain/` directly, that change is invisible to git and will be silently
lost/overwritten by the next sync from `bigBrain/`. Always edit `bigBrain/`, verify, then sync.

**Live testing**: two real API keys exist — `jeremy` (real account) and `bb-test` (dedicated test
account). Use `bb-test` for anything experimental; only `jeremy`'s writes reach the real Notion
workspace (`notion.ownerUserId` gate). No `gh` CLI in this environment — GitHub API calls go
through a cached OAuth token in `~/.config/gh/hosts.yml` / `~/.git-credentials` instead. The
orchestrator has no published port; reach it via
`docker run --network traefik-net curlimages/curl ...` or from another container already on that
network.

---

## Current state

*Verify against `spec.md`/git log before trusting this — it will go stale.*

Live and deployed: data layer, orchestrator, document ingestion, shopping analytics, generic lists
+ Notion sync, recipes & meal planning, an OpenAPI tool-server surface
(`/v1/tools/openapi.json`), grocery-list section ordering. Parked: GitHub Ingestion Gateway and
the governance doc-sync (blocked on it). Drafted but not yet actioned: Open WebUI suggested-prompts
content, and registering the OpenAPI tool server inside Open WebUI's own admin panel (needs a
human in the browser).
