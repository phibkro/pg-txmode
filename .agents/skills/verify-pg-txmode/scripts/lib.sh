#!/usr/bin/env bash
# Shared by the other scripts here; source it, do not run it.
# Provenance: adapted from reebeat/studio @ d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8
# (.agents/skills/verify-studio/scripts/lib.sh), which adapted it from phibkro/vektorprogrammet-reimagined
# @ 1104c3019a76c619c4c8e9ee04c71ce191467ed4. Deviations: only the parts headroom.sh and the run recipe need (no server
# state, pointer or Chromium helpers: the harness starts and stops its own PostgreSQL and PgBouncer); pg-txmode's names.
#
# Where things are:
#   TREE           the worktree under verification: $VERIFY_TREE, else the git toplevel of the current directory.
#   EVIDENCE_ROOT  $VERIFY_EVIDENCE_ROOT, else ~/.local/state/pg-txmode-verify. Outside every worktree, so a
#                  worktree cleanup never removes evidence.

# shellcheck disable=SC2034 # used by the scripts that source this file
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_ROOT="${VERIFY_EVIDENCE_ROOT:-$HOME/.local/state/pg-txmode-verify}"

TREE="${VERIFY_TREE:-$(git rev-parse --show-toplevel)}"
TREE="$(cd "$TREE" && pwd)"

die() { echo "error: $*" >&2; exit 1; }

# Runs a command inside the tree's devenv shell (Bun, Node, PostgreSQL and PgBouncer come from there; the system Bun can
# hang on install). devenv's own "Running devenv:..." task lines are dropped from stderr; the command's output is untouched.
in_devenv() { (cd "$TREE" && devenv shell -- "$@") 2> >(grep --line-buffered -v -E '^[•✓✖] Running devenv:' >&2); }
