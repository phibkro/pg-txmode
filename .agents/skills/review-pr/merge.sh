#!/usr/bin/env bash
# Provenance: copied from phibkro/vektorprogrammet-reimagined @ 1104c3019a76c619c4c8e9ee04c71ce191467ed4 (.agents/skills/review-pr/merge.sh), unchanged (identical at 797e9e41).
# merge.sh <pr> "<squash subject>": refuse unless a review round recorded by record-round.sh passed the PR's
# current head; wait for CI green on that head; if main moved, require no overlapping files (merge-tree check);
# then squash-merge. Run from the main checkout.
# Exit codes: 1 CI not green, 2 conflicts with main, 3 files overlap with main (rebase, new round), 4 no passing record.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: merge.sh <pr> \"<squash subject>\"" >&2; exit 64; }
n=$1; subject=$2
reviewed=$(gh pr view "$n" --json headRefOid --jq .headRefOid)
marker="<!-- review-round n=[0-9]+ head=$reviewed verdict=pass -->"
records=$(gh pr view "$n" --json comments,reviews --jq '[.comments[].body, .reviews[].body] | .[]')
grep -Eq "$marker" <<<"$records" || {
  echo "#$n has no passing review round recorded on ${reviewed:0:8}: run record-round.sh first"; exit 4; }
echo "#$n waiting for CI on ${reviewed:0:8}"
gh pr checks "$n" --watch --interval 30 >/dev/null 2>&1 || true
bad=$(gh pr view "$n" --json statusCheckRollup --jq '[.statusCheckRollup[] | select(.conclusion != "SUCCESS" and .conclusion != "SKIPPED" and .conclusion != "NEUTRAL")] | length')
[ "$bad" = 0 ] || { echo "#$n CI not green"; gh pr checks "$n" | cat; exit 1; }
[ "$(gh pr view "$n" --json headRefOid --jq .headRefOid)" = "$reviewed" ] || {
  echo "#$n head moved during CI: record a round on the new head"; exit 4; }
git fetch -q origin
if ! git merge-base --is-ancestor origin/main "$reviewed"; then
  expected=$(git merge-tree --write-tree origin/main "$reviewed") || { echo "#$n conflicts with main: new round"; exit 2; }
  base=$(git merge-base origin/main "$reviewed")
  overlap=$(comm -12 <(git diff --name-only "$base" origin/main | sort) <(git diff --name-only "$base" "$reviewed" | sort))
  echo "#$n main moved; expected tree $expected; overlapping files: ${overlap:-none}"
  [ -z "$overlap" ] || { echo "#$n overlapping files with main: rebase, push, CI, new round, then merge"; exit 3; }
fi
gh pr merge "$n" --squash --match-head-commit "$reviewed" --subject "$subject (#$n)" | tail -1
git fetch -q origin; echo "#$n merged: $(git log --oneline -1 origin/main)"
