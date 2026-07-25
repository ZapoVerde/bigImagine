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
  (secrets, gitignored, never in `bigBrain/` — see **Secrets** below) and is where migrations get
  hand-applied.

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

**Secrets**: the canonical copy of every secret in `.env` is `stacks/bigbrain/secrets.enc.env` —
`sops`-encrypted with `age`, safe to read, back up, or even commit (it's ciphertext; individual
values are unreadable without the private key). `.env` itself is a disposable, regeneratable
artifact decrypted from it before each deploy, not the source of truth anymore:
```
sops --input-type dotenv --output-type dotenv --decrypt secrets.enc.env > .env
docker compose up -d --build orchestrator
```
The `age` private key that decrypts it is **not** on this host (deliberately — an encrypted file
next to its own key on the same disk protects against nothing). Whoever holds that key runs the
decrypt step; there's no way to redeploy without it. To change a secret: decrypt, edit `.env`,
re-encrypt with `sops --input-type dotenv --output-type dotenv --encrypt --age <public-key>
.env > secrets.enc.env`, then delete the plaintext `.env` if it shouldn't linger.

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
(`/v1/tools/openapi.json`), grocery-list section ordering, a native frontend (`frontend/`, spec.md
§5 Correction 7) with chat history/folders, freeform notes, prompt presets, and household-wide
orchestrator settings (active LLM profile/model, timezone) — see spec.md §3's `provider_credentials`
/ `folders`+`chat_sessions`+`chat_messages` / `orchestrator_settings` / `notes` / `prompt_presets`
additions. Most of this (frontend/, plugins/notes, plugins/prompt-presets, chat sessions, access
identity, date context, migrations 0009-0012) is deployed but **not yet committed** to this repo —
check `git status` before assuming the working tree matches HEAD. Parked: GitHub Ingestion Gateway,
the governance doc-sync (blocked on it), and Gmail parsing (spec.md §6.3). Drafted but not yet
actioned: Open WebUI suggested-prompts content, registering the OpenAPI tool server inside Open
WebUI's own admin panel (needs a human in the browser), and the household calendar (spec.md §6.7,
phase 1 not yet scaffolded).
