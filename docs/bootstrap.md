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

**GitHub**: this repo still points at `github.com/ZapoVerde/bigbrain` (the bigBrain remote it was
forked from) — not yet repointed at a BigImagine repo of its own. Don't assume a push here lands
anywhere BigImagine-specific until that's done.

---

## The workspace/stacks split (not written down anywhere else — read this carefully)

BigImagine is dev-only right now — there is no deployed BigImagine stack, and no
`stacks/bigimagine/` directory. What exists:

- **`/config/workspace/BigImagine/`** — this repo, source of truth for BigImagine. Edit and verify
  (`npm run verify`) here. Separate directory tree from bigBrain's own, **not symlinked** — it's a
  fork, not a shared checkout.
- **`/config/workspace/bigBrain/`** — the original bigBrain repo. Unrelated to BigImagine work;
  don't edit it expecting it to affect this project.
- **`/config/workspace/stacks/bigbrain/`** — bigBrain's real *deployed* stack (its own running
  containers, its own `.env`). BigImagine has no equivalent yet.

Per the project owner's call (2026-08-03): for now, BigImagine piggybacks on bigBrain's existing
secrets rather than standing up its own — see **Secrets** below. When BigImagine actually gets
deployed, this section needs a real update: either a new `stacks/bigimagine/` tree with its own
`.env`/`secrets.enc.env`, or a documented decision to keep sharing bigBrain's. Until then, treat
the sync workflow and hand-applied migrations bigBrain's own `docs/bootstrap.md` describes as
not-yet-applicable here — there's nothing deployed to sync to.

**Secrets**: BigImagine deliberately reuses bigBrain's — there's no separate BigImagine secrets
store yet, and `scripts/secrets.sh` in this repo is a straight copy of bigBrain's own, still
hardcoded to operate against `stacks/bigbrain/secrets.enc.env`. This is the literal mechanism
behind "piggyback on BB's secrets": running it from `BigImagine/` deploys/edits *bigBrain's*
running stack, not a BigImagine one, because that's the only stack that exists. That canonical
`secrets.enc.env` is `sops`-encrypted with `age`, safe to read, back up, or even commit (it's
ciphertext; individual values are unreadable without the private key). Nothing decrypts to a
plaintext file on disk — `sops exec-env` injects the decrypted values straight into the deploy
command's environment via `exec`, never through a shell that has to re-parse the text:
```
scripts/secrets.sh deploy [service name(s)...]   # runs: docker compose up -d --build <args>
scripts/secrets.sh edit                          # sops's own edit mode — decrypts to a
                                                  # secure temp file, opens $EDITOR,
                                                  # re-encrypts and shreds on save
```
The `up -d --build` is already baked into the script — pass just a service name (e.g.
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

**Live testing**: there's nothing to test live yet — BigImagine has no deployed stack of its own
(see the split above). Two general notes for whenever that changes: no `gh` CLI in this
environment, GitHub API calls go through a cached OAuth token in `~/.config/gh/hosts.yml` /
`~/.git-credentials` instead; and bigBrain's own deployed orchestrator has no published port,
reached only via `docker run --network traefik-net curlimages/curl ...` or from another container
already on that network — BigImagine's, once deployed, will likely follow the same pattern.

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

The actual narrative engine — `characters`/`scenes`/`canon_facts`/`locations`/`rules`/
`status_effects` tables, the Canonize/Vistalyze/Triggeryze plugins, the Director Pass, the
Character Roster, the Inspector Canvas — is fully **(designed)** in `spec.md` and has no code
behind it yet. There's no migration past `0040_chat_branching.sql` that touches any of it. This is
the actual next body of work, not a someday item.

The rest of bigBrain's old "Current state" detail (below this line, in bigBrain's own
`docs/bootstrap.md`) doesn't apply here — it describes household features this fork removed.
