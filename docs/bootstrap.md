# BigImagine — Bootstrap

*Orientation for a new session with no prior context. Points into the real docs rather than
re-deriving them — read those for actual detail, this is just the map.*

---

## What it is

A self-hosted, single-user interactive fiction and roleplay platform, forked from the bigBrain
core engine and re-pointed at narrative instead of household data. See the root `README.md` for
the full picture — it's explicit about what's actually running (bigBrain's inherited chat/notes/
documents/timers infrastructure) versus what's designed but not yet built (the narrative engine
itself: Canonize/Vistalyze/Triggeryze, the Director Pass, single-user conversion). Don't assume
`docs/spec.md` describes live behavior — its own header says it's a target, not a build log.

## Start here, in order

1. `bi_principles.md` — the foundational rules (e.g. §4 scene-not-content scoping, §8 the four
   kinds of code, §11 observable-not-silent failures, §15 canon requires approval). These override
   intuition.
2. `spec.md` — the target architecture for the narrative engine. Status-tagged throughout
   (**(built)**/**(designed)**/**(parked)**) — as of this writing almost everything in it is
   **(designed)**, not built. This is the plan, not the current state.
3. `conventions.md` and `verification.md` — code style and the verify-script testing philosophy
   (no unit-test framework; purpose-built `.mjs` scripts with fake pools/LLMs, chained via each
   package's `npm run verify`).

**GitHub**: this repo's `origin` is `github.com/ZapoVerde/bigImagine.git` — its own remote, not
bigBrain's fork-origin. A `git push` here lands on BigImagine's own history.

---

## The workspace/stacks split (not written down anywhere else — read this carefully)

BigImagine has its own dedicated stack as of 2026-08-04 (`docs/dedicated-infra-plan.md` has the
full design/build history — read that for *why*, this is just the current-state map). What exists:

- **`/config/workspace/BigImagine/`** — this repo, source of truth for BigImagine. Edit and verify
  (`npm run verify`) here. Separate directory tree from bigBrain's own, **not symlinked** — it's a
  fork, not a shared checkout.
- **`/config/workspace/bigBrain/`** — the original bigBrain repo. Unrelated to BigImagine work;
  don't edit it expecting it to affect this project.
- **`/config/workspace/stacks/bigbrain/`** — bigBrain's own deployed stack. No longer shares
  anything live with BigImagine (see below) — a BigImagine migration touching a table bigBrain also
  owns rows in used to be a real shared-fate risk (`docs/dedicated-infra-plan.md` §1.1 has the
  incident); that risk is closed now that the two run against separate Postgres instances.
- **`/config/workspace/stacks/bigimagine/`** — BigImagine's own deployed stack: `bigimagine-postgres`
  (db `bigimagine`, roles `bigimagine_admin`/`bigimagine_app` — not bigBrain's `bigbrain_admin`/
  `bigbrain_app` names) and `bigimagine-orchestrator`, both defined in this directory's own
  `docker-compose.yml` (not checked into either git repo — `stacks/` isn't version-controlled).
  Public route at `bigimagine.your-domain.example` (Cloudflare Access + Traefik, same shape as bigBrain's
  own route), loopback fallback via `ssh -L 8790:localhost:8790 <user>@<host>` then
  `http://localhost:8790/`. Named volumes: `bigimagine-pgdata`, `bigimagine-documents` (git-backed
  document store), `bigimagine-character-media` (character avatar PNGs, added 2026-08-05 alongside
  the Character Roster feature — without this volume, avatars would live in the container's
  writable layer and vanish on the next rebuild).

**Deploying**: this repo's own `scripts/secrets.sh` (a copy of bigBrain's, retargeted at
`stacks/bigimagine/secrets.enc.env` — BigImagine has its own encrypted secrets file now, it no
longer piggybacks on bigBrain's):
```
scripts/secrets.sh deploy [service name(s)...]   # runs: docker compose up -d --build <args>
scripts/secrets.sh edit                          # sops's own edit mode — decrypts to a
                                                  # secure temp file, opens $EDITOR,
                                                  # re-encrypts and shreds on save
```
e.g. `scripts/secrets.sh deploy orchestrator` to rebuild and restart just the orchestrator
container after a code change. That `secrets.enc.env` is `sops`-encrypted with `age`, safe to
read, back up, or even commit (it's ciphertext; individual values are unreadable without the
private key). Nothing decrypts to a plaintext file on disk — `sops exec-env` injects the decrypted
values straight into the deploy command's environment via `exec`, never through a shell that has
to re-parse the text. The `up -d --build` is already baked into the script — pass just a service name (e.g.
`scripts/secrets.sh deploy orchestrator`), not a full compose invocation.
`scripts/secrets.sh deploy up -d --build orchestrator` duplicates it into
`docker compose up -d --build up -d --build orchestrator`, which fails with a confusing
"no such service: up" rather than anything obviously about the args.

Do **not** use `sops --decrypt ... > .env` or `source <(sops ... --decrypt ...)` — the former
leaves real plaintext sitting on disk with cleanup dependent on someone remembering it, and the
latter *looks* equivalent to `exec-env` but isn't: bash's own quote-removal during `source`
silently strips the double quotes out of any JSON value (`BIGBRAIN_LLM_PROFILES` is JSON),
corrupting it — this crashed `bigbrain-orchestrator` in a real deploy on 2026-07-28 before the
script was fixed to use `exec-env` instead.

Both scripts require `sops`/`age` on `PATH` and `SOPS_AGE_KEY_FILE` pointing at the private key.
**Neither binary is preinstalled system-wide, and neither is on `PATH` by default in a fresh
shell** — check `/config/workspace/.tools/bin/` first (static `sops`/`age`/`age-keygen` binaries
already fetched there, no root needed) before assuming they need reinstalling:
```
export PATH=/config/workspace/.tools/bin:$PATH
sops --version && age --version   # confirms they're there and runnable
```
If that directory is ever actually empty (moved/rebuilt sandbox), apt only has `age` (Ubuntu's
universe repo) — `sops` isn't packaged for apt at all — so fetch official static releases instead,
into any directory already on `PATH`:
```
curl -sL -o <bindir>/sops "$(curl -s https://api.github.com/repos/getsops/sops/releases/latest \
  | grep -oE 'https://\S+linux\.amd64"' | tr -d '"')"
chmod +x <bindir>/sops

curl -sL "$(curl -s https://api.github.com/repos/FiloSottile/age/releases/latest \
  | grep -oE 'https://\S+linux-amd64\.tar\.gz"' | tr -d '"')" -o /tmp/age.tar.gz
tar xzf /tmp/age.tar.gz -C /tmp
cp /tmp/age/age /tmp/age/age-keygen <bindir>/ && chmod +x <bindir>/age*
```
Don't fetch a second copy into a different directory just because `which sops` came up empty in a
new shell — check `.tools/bin` before reaching for `curl`.

The active key lives at `/config/workspace/.secrets/bigbrain-age-key.txt` — sibling to `bigBrain/`
and `stacks/`, outside both, mode 0600, not in either git repo. This is a deliberate, *temporary*
convenience for low-friction dev in this sandbox (the user's call, made 2026-07-28), not a
permanent home — it may move to Vaultwarden or similar later, so check `.secrets/` still exists
before trusting this path. A retired key sits alongside it
(`bigbrain-age-key-RETIRED-2026-07-28.txt`), kept only for reference. Set
`SOPS_AGE_KEY_FILE=/config/workspace/.secrets/bigbrain-age-key.txt` before running either
`scripts/secrets.sh` command.

**Live testing**: `bigimagine-orchestrator` has no published port either (same as bigBrain's own),
so hit it from another container already on `traefik-net`:
```
docker run --rm --network traefik-net curlimages/curl -s http://bigimagine-orchestrator:8787/v1/... \
  -H "Authorization: Bearer <a BIGIMAGINE_API_KEYS value>"
```
or through the loopback fallback (`127.0.0.1:8790`, see the split above) via SSH port-forward. No
`gh` CLI in this environment — GitHub API calls go through a cached OAuth token in
`~/.config/gh/hosts.yml` / `~/.git-credentials` instead. `docker logs bigimagine-orchestrator` on
a fresh deploy should show every plugin loading with its tool count — a quick sanity check that a
`scripts/secrets.sh deploy` actually picked up the new code and didn't silently fail to boot.

---

## Current state

*Verify against the root `README.md` (which carries the same **(built)**/**(designed)** split as
`spec.md`) or git log before trusting this — it will go stale.*

This is a fork of bigBrain with the household-specific plugins removed (recipes, meal planning,
shopping lists/analytics, calendar, Notion sync, weather — all deleted, not coming back). What's
running is bigBrain's other infrastructure, inherited as-is: chat with folders/branching/Canvas/
prompt presets, chat memory (rolling summarization + RAG), notes, documents (git-backed clip/save
with semantic search), web search, timers/scheduled-job dispatch, push notifications, math/date
utilities, LLM-agnostic orchestration with DB-backed runtime settings. The database schema is still
bigBrain's original multi-user/RLS design — single-user conversion (`spec.md` §3) hasn't happened.

The narrative engine has started landing, in slices — check `spec.md`'s own **(built)**/
**(designed)** tags before trusting this paragraph, it will go stale fastest of anything here.
`characters`/`scenes`/`canon_facts`/`locations` tables and their plugins exist (migrations
`0044`–`0048`), including the Character Roster (create/edit/delete/import/export a full V2/V3 PNG
card, apply a card to a chat's system prompt + opening greeting) and Canonize's extraction/recall
tools. Still **(designed)**, not built: `rules`/`status_effects` tables, Vistalyze, Triggeryze, the
Director Pass, and wiring a character into a scene's actual turn loop (`apply_character_to_chat`
only touches a chat's system prompt today, deliberately not `scenes`/`scene_presence` — that needs
the Director Pass to exist first). The Inspector Canvas is unbuilt.

The rest of bigBrain's old "Current state" detail (below this line, in bigBrain's own
`docs/bootstrap.md`) doesn't apply here — it describes household features this fork removed.
