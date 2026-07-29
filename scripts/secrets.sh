#!/usr/bin/env bash
# bigBrain/scripts/secrets.sh — deploy or edit stacks/bigbrain/secrets.enc.env without ever
# writing the decrypted plaintext to disk. See docs/bootstrap.md's Secrets section.
#
# Requires `sops`/`age` on PATH and SOPS_AGE_KEY_FILE pointing at the age private key — this
# script doesn't know or care where that key actually lives (sandbox file today, Vaultwarden
# tomorrow), it just expects the standard sops env var to already be set.
#
# Usage:
#   scripts/secrets.sh deploy [docker compose args...]   # default: up -d --build
#   scripts/secrets.sh edit                              # sops's own edit mode: decrypts to a
#                                                         # secure temp file, opens $EDITOR,
#                                                         # re-encrypts and shreds on save.
set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACKS_BIGBRAIN="$WORKSPACE_ROOT/stacks/bigbrain"

cmd="${1:-}"
shift || true

case "$cmd" in
  deploy)
    cd "$STACKS_BIGBRAIN"
    # exec-env sets vars via exec's envp directly, not by re-parsing decrypted text through a
    # shell — `source <(sops ... --decrypt)` looked equivalent but silently corrupts any value
    # containing embedded double quotes (BIGBRAIN_LLM_PROFILES is JSON): bash's own quote-removal
    # strips the JSON's quotes during word-splitting, breaking it. Caught this in testing
    # (2026-07-28) before it became the documented workflow — do not revert to `source`.
    sops --input-type dotenv --output-type dotenv exec-env secrets.enc.env \
      "docker compose up -d --build $*"
    ;;
  edit)
    cd "$STACKS_BIGBRAIN"
    sops secrets.enc.env
    ;;
  *)
    echo "usage: $(basename "$0") deploy [docker compose args...] | edit" >&2
    exit 1
    ;;
esac
