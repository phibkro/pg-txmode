<!-- Provenance: adapted from reebeat/studio @ d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8 (.agents/skills/review-pr/reviewers.md).
     Deviations: studio's Foldkit and browser checks are dropped; `verify-pg-txmode`; pg-txmode's repository rules. See PROVENANCE.md. -->

# Reviewer briefs

Read by each reviewer of a round (see `SKILL.md`). You report; you do not edit product code, push or comment on the PR. Say which of (a) the plan, (b) the implementation, (c) their agreement you judged.

**Every number in a report has its script, its raw output and its command.** A count, a size, a timing or a pass rate that you cannot trace to a command that you ran (or that the PR names), whose raw output is in a file or in the report, is a finding of medium or above, whoever wrote it. Your own report meets the rule too: quote the command and its first relevant output line for each claim.

## Verification reviewer

1. In your detached worktree run `devenv shell -- bun install --frozen-lockfile`, then `devenv shell -- bun run ready`. It must exit 0 on the head; record the head sha and the output summary. Run `.agents/skills/verify-pg-txmode/scripts/headroom.sh` first.
2. Check the PR body's falsifier table against the branch: for each falsifier, find the gate that holds it and its negative control, and re-run the control where it is cheap (a scratch change in the worktree, undone afterwards). A control that was not shown, or that does not fail as the table says, is a finding.
3. Read CI's result on the head (`gh pr checks <n>`): `checks` must be green.
4. **Run `verify-pg-txmode`** for the changed behaviour (its `SKILL.md` says what to run), in your own worktree, and keep the run directory. Docs-only and `.agents`-only changes drive nothing; say so.
5. **Keep the verify skill true.** If the diff changes what a reviewer runs or observes, check that `verify-pg-txmode/SKILL.md` still describes it. A gap is a finding (`maintenance`, medium); a skill that describes behaviour the code no longer has is a finding of the severity of the behaviour it hides.

## Conformance reviewer

1. **The plan** (a): the spec states the right problem; the journey can be experienced from the PR body; each falsifier has a gate and a control that can fail; Revisions explain each change made while building.
2. **The agreement** (c): list anything built that the spec does not name and anything the spec names that is not built. Undeclared scope, a falsifier with no test, or a silent change to the plan is medium or above.
3. **Repository rules** in `AGENTS.md`: one source per fact (a derived fact is generated, or a test fails on drift); every suppression has a registry entry with a retirement trigger; the core does not depend on Effect; tools depend on no package; the catalogue's claims each have a source URL or a local measurement, and `hyperdrive-probe` is claimed only with recorded evidence.
4. **Public repository**: no secret, personal data or private material in code, fixtures, logs or evidence paths; `LICENSE` is Apache-2.0 verbatim and `NOTICE` reads `Copyright 2026 Philip Bjørknes Krogh`; a file copied from reebeat carries its provenance and **`PROVENANCE.md` is accurate** (source commit, deviations; a copied file is byte for byte when it says so, checked with `git hash-object`).
5. **Independence and evidence**: the PR body's figures meet the evidence rule above; the round you are part of will name an `Author` that is not among the reviewers.

## Severity

| Severity | Meaning | Examples |
| --- | --- | --- |
| critical | data loss, a security hole, a leaked secret or personal data, or a broken `main` once merged | a key in a fixture; a gate that always passes |
| high | a spec falsifier is not met, or behaviour a user relies on is wrong | a control that does not fail; `ready` red on the head; a catalogue row that claims a probe that does not exist |
| medium | a rule of `AGENTS.md` broken, evidence that does not match the branch, a number without its script, raw output and command, any (c) finding, or a verify skill out of step (`maintenance`) | a suppression without an entry; undeclared scope; a Revisions entry missing |
| low | clarity or maintainability with no behavioural effect | a misleading name or comment |
| nit | taste | none |

Each finding: severity, `file:line` or run path, what is wrong in one sentence, and the evidence (command and output).
