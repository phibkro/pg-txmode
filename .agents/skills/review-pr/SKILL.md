---
name: review-pr
description: "The automated pull-request loop for pg-txmode: independent reviewers judge the plan, the implementation and their agreement, run verify-pg-txmode for the changed behaviour and keep it true, a fixer addresses findings, each round is recorded on the PR, and a passing PR is merged. Use when a PR is ready for review, when asked to review or merge a PR, or when a review round finishes."
---

<!-- Provenance: adapted from reebeat/studio @ d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8 (.agents/skills/review-pr/SKILL.md),
     which adapted it from reebeat/reebeat @ f7c348877585f54b6bf00651608726dd7e5044d3 and phibkro/vektorprogrammet-reimagined
     @ 1104c3019a76c619c4c8e9ee04c71ce191467ed4. Deviations: studio's Foldkit checks and browser rule are dropped; the verify
     skill is `verify-pg-txmode`; the public-repository check names the Apache-2.0 LICENSE and NOTICE; the lead may not be able
     to spawn reviewers (see "Round without spawned reviewers"). See PROVENANCE.md. -->

# Review and merge a pull request

The lead (the session that owns merges) runs this loop. Reviewers and fixers are separate agents, so the one who judges a change never wrote it. The binding contract is `docs/specs/0000-development-lifecycle.md`.

```text
round 1..n:
  reviewers (independent, read-only on product code) → findings with severity
  pass?  → merge
  else   → fixer addresses every finding (incl. skill maintenance) → push → next round
stop:   after round 3, unless an open finding is critical or high (then keep going);
        a stop without a pass is reported to the operator, never merged
```

## 1. Prepare

- A PR carries its spec and its code together. The spec is frozen when the PR opens; later changes to it are dated entries in its Revisions section.
- Create a separate detached worktree per reviewer or fixer role with **`/run/current-system/sw/bin/git worktree add --detach .worktrees/pr-$N-<role> origin/<head branch>`** (no local branch). The harness rewrites a bare `git worktree` into `omp worktree`, which once copied `.worktrees/` into itself (189 to 215 GB). Remove each worktree when its role ends. The `verify-pg-txmode` run of a reviewer uses its own worktree: parallel reviewers never share one.
- Read the PR body, its spec in `docs/specs/` (falsifiers and Revisions), and `git diff --stat origin/<base>...HEAD`. A PR stacked on another PR's branch is reviewed at its head, against its base.
- Check the machine before a heavy job (`bun run ready`, the harness): `.agents/skills/verify-pg-txmode/scripts/headroom.sh` applies the operator's limits (`MemAvailable` after the job's demand at least 20% of RAM, swap-in under 1000 pages per second, memory PSI `full` avg60 under 10%, load average under the CPU threads). Wait while it says `SHORT`.

## 2. Review round: two independent reviewers, in parallel

Give each reviewer the PR number, the worktree, the spec, and [`reviewers.md`](reviewers.md) (their checks, the severity table). Reviewers do not edit product code and do not push or comment; they report. Every reviewer says which of three things it judged:

- **(a) The plan**: the spec states the right problem, journey and falsifiers.
- **(b) The implementation**: it is correct, the gates are green, every control was shown.
- **(c) Their agreement**: the code does what the spec with its Revisions says. Undeclared scope, a falsifier with no test, or a silent change to the plan (no dated Revisions entry) is a finding of medium or above.

**Verification reviewer** (mainly (b) and the evidence side of (c)): `bun run ready` on the head; the PR body's falsifier table against the branch; `verify-pg-txmode` for the changed behaviour; the maintenance rule.

**Conformance reviewer** (mainly (a) and (c)): the spec, the diff against it, the repository rules, public-repository hygiene.

Both read CI's result on the head (`gh pr checks <n>`): the `checks` job must be green.

### Round without spawned reviewers

A session that cannot spawn agents (the harness disables it) does not review its own work and does not record a pass. It opens the PR, runs `ready`, and reports to the lead: the PR URL, the head, the checks it ran, and the reviewer briefs to run. The lead arranges reviewers. A `changes` round the author records about its own head is allowed; a `pass` is not (see "Record").

## 3. Decide

**Pass** when all of these hold: no open finding of medium or above; CI green on the head; `bun run ready` exits 0 on the head; every falsifier has a shown control; the verification evidence exists for the changed behaviour, in a run directory the report names. Low and nit findings go into the merge comment, or are fixed if cheap.

**Merge a passing PR** with `.agents/skills/review-pr/merge.sh <n> "<type>: <summary>"` from the main checkout (squash, title `<type>: <summary> (#<n>)`). It refuses (exit 4) unless a round recorded by `record-round.sh` passed the PR's current head, waits for CI green on that head (exit 1 when not green), and merges only that head (`--match-head-commit`). If `main` moved since the head was reviewed, it computes the expected tree with `git merge-tree --write-tree origin/main <reviewed head>` and refuses on conflicts (exit 2) or on files that both changed (exit 3): then rebase, require CI green on the rebased head, and record a new round on it. After a rebase without overlap, `git rev-parse HEAD^{tree}` must equal the expected tree that `merge.sh` printed. A stacked PR merges after the PR below it; retarget it to `main` first.

**Otherwise**, start a fixer: a separate agent in the PR's worktree, with the findings verbatim. It fixes the code and, for `maintenance` findings, the verify skill; the spec only through a dated Revisions entry. It commits, pushes, and reports. Then the next round, with fresh reviewers.

## 4. Iteration limit

- Rounds 1 to 3: iterate until the PR passes.
- After round 3: continue only while an open finding is **critical or high**. If only medium or lower findings remain, stop: do not merge; report the PR, the open findings and the rounds to the operator.
- A finding that the same fix has failed twice is reported at once, whatever the round.

## 5. Record

Every round is recorded on the PR, so the review is visible where the change is (the repository is public) and outlives the agents' transcripts. The lead posts it with `.agents/skills/review-pr/record-round.sh <n> <round> <pass|changes> <body-file>`: a GitHub review (comment) headed by the marker `<!-- review-round n=<round> head=<sha> verdict=<pass|changes> -->`, with the head read from GitHub. `merge.sh` reads the marker, so a PR without a passing record on its head cannot be merged.

The body file starts with three lines, and `record-round.sh` refuses a body without them:

```text
Author: <the agent or person who wrote the head commits>
Reviewers: <comma-separated names of the agents who reviewed>
Checked: plan, implementation, agreement      (exactly the parts (a), (b), (c) that were judged)
```

**A review that the author records about its own PR is not independent.** `record-round.sh` refuses a `pass` whose `Author` is among the `Reviewers`; the author may record `changes`. The lead who wrote the head arranges a separate reviewer even for a docs change. The names are self-declared: the script stops the honest mistake, and the lead keeps the reviewers genuinely separate agents.

After the three lines: the findings with severity, what the fixer changed (commits), and the evidence (commands, output, run directories). The PR body lists the rounds (number, head, verdict) under `## Review rounds` once the PR passes.
