#!/usr/bin/env bash
# Provenance: adapted from phibkro/vektorprogrammet-reimagined @ 1104c3019a76c619c4c8e9ee04c71ce191467ed4 (.agents/skills/review-pr/record-round.sh).
# Deviation (spec 0003): the body file must carry `Author:`, `Reviewers:` and `Checked:` lines, and a `pass` is refused when
# the author is among the reviewers: a review that the author records about its own PR is not independent. Names are
# self-declared, so this stops the honest mistake, not a forgery.
# record-round.sh <pr> <round> <pass|changes> <body-file>
# Posts one review round on the PR as a GitHub review (comment), headed by the marker that merge.sh requires.
# The head is read from GitHub, so a record always names the commit that was reviewed.
set -euo pipefail
[ $# -eq 4 ] || { echo "usage: record-round.sh <pr> <round> <pass|changes> <body-file>" >&2; exit 64; }
n=$1; round=$2; verdict=$3; body=$4
case "$verdict" in pass|changes) ;; *) echo "verdict must be pass or changes" >&2; exit 64 ;; esac
[[ "$round" =~ ^[1-9][0-9]*$ ]] || { echo "round must be a positive integer" >&2; exit 64; }
[ -s "$body" ] || { echo "body file is empty or missing: $body" >&2; exit 64; }
for key in Author Reviewers Checked; do
  grep -Eq "^$key: +[^ ]" "$body" || { echo "body file needs a line '$key: …' (who wrote the head, who reviewed, what was checked)" >&2; exit 65; }
done
trim() { local s=${1,,}; s=${s#"${s%%[![:space:]]*}"}; printf '%s' "${s%"${s##*[![:space:]]}"}"; }
author=$(grep -m1 '^Author: ' "$body"); author=$(trim "${author#Author: }")
reviewers=$(grep -m1 '^Reviewers: ' "$body")
IFS=',' read -ra names <<<"${reviewers#Reviewers: }"
if [ "$verdict" = pass ]; then
  for name in "${names[@]}"; do
    if [ "$(trim "$name")" = "$author" ]; then
      echo "the author ($author) is among the reviewers: a pass needs a reviewer who did not write the head" >&2; exit 65
    fi
  done
fi
head=$(gh pr view "$n" --json headRefOid --jq .headRefOid)
{
  echo "<!-- review-round n=$round head=$head verdict=$verdict -->"
  echo "## Review round $round on \`${head:0:7}\`: $verdict"
  echo
  cat "$body"
} | gh pr review "$n" --comment --body-file -
echo "#$n round $round recorded on ${head:0:8}: $verdict"
