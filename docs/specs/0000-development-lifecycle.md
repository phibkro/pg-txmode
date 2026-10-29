# 0000 Development lifecycle and scaffold

Status: **spec** (frozen when its PR opens). Date: 2026-10-29. Decided by: the operator's assignment of 2026-10-29 (build `phibkro/pg-txmode`, copy the development lifecycle from `reebeat/studio` `d4fd75e`, branch protection like reebeat's, first commit straight to `main`, PRs only afterwards).
Binding for: every later PR in this repository. Implemented by the PR that carries this file.
Mirrors: [reebeat/studio spec 0000](https://github.com/reebeat/studio/blob/d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8/docs/specs/0000-development-lifecycle.md) and [reebeat spec 0000](https://github.com/reebeat/reebeat/blob/f7c348877585f54b6bf00651608726dd7e5044d3/docs/specs/0000-development-lifecycle.md). Read them for the reasons; this file records what is the same, what differs and why.

## Goal

Every change to pg-txmode travels one road: **spec → code → PR**, strictly 1:1, and no change reaches `main` without passing the same gates locally, in CI and in a recorded review round. The road is the one reebeat built (Vite+, Oxlint, Oxfmt, Ultracite, gitleaks, commitlint, knip, jscpd, `gh`), copied with provenance, not rewritten. On that road stands the tooling workspace `tools/quality`, whose tests prove the road itself (the exception registry, the review record, the headroom gate, the Effect boundary). The product packages arrive with spec 0001.

## Journey

```text
contributor (human or agent)
  1. write or pick a spec        docs/specs/NNNN-*.md          the plan, its falsifiers, its dated Revisions
  2. branch                      feat/NNNN-<slug>              one spec, one branch, one PR (stacked on the spec below it)
  3. commit                      pre-commit: gitleaks on the staged blobs, then `vp staged` (format and lint --fix)
                                 commit-msg: commitlint (Conventional Commits)
  4. push                        pre-push: the test suite
  5. open the PR                 skill pr-create: the PR body is the report
  6. CI                          .github/workflows/checks.yml runs the same gates as `bun run ready`
  7. review round(s)             skill review-pr: independent reviewers, severity, recorded on the PR
  8. merge                       .agents/skills/review-pr/merge.sh: refuses without a passing record on the head
```

A reader who clones the repository, runs `devenv shell -- bun install` and then `devenv shell -- bun run ready`, sees every gate pass on a clean tree.

## Constraints and values

- Correctness by construction: a gate that can be made structural is structural. `main` cannot be pushed to, a PR cannot be merged without a passing recorded round on its head, a suppression cannot exist without a registry entry, a package other than the Effect adapter cannot depend on Effect.
- One source per fact. The gate list lives in `package.json` scripts (`ready`) and the table in `AGENTS.md` names each script; CI calls the same scripts and never repeats their commands.
- Reuse, do not hand-roll. Every copied file names its source (repository, commit, deviation) in a header or in `PROVENANCE.md`; a file that says "identical" is checked with `git hash-object`.
- **The core does not depend on Effect** (operator, 2026-10-29). reebeat's tooling is written in Effect; here the tooling is plain TypeScript too, so Effect enters the lockfile only with the Effect adapter package. This is the one structural deviation from the source lifecycle (Revisions 2026-10-29, deviation 1).
- Public repository, Apache-2.0: `LICENSE` is the verbatim text of <https://www.apache.org/licenses/LICENSE-2.0.txt>, `NOTICE` reads `Copyright 2026 Philip Bjørknes Krogh`. No secret, no personal data.
- Default stack as the operator's: TypeScript 7.0.2, Bun, Oxfmt, Oxlint, Vite+ 1.2.0, devenv. Alchemy is not used yet: there is nothing to deploy.

## What is built

| Part | Content | Reused from |
|---|---|---|
| Repository | `phibkro/pg-txmode`, public; first commit `8d3407c` (README, `LICENSE`, `NOTICE`, `.gitignore`) pushed to `main` because the repository was empty; every later change by PR | assignment |
| Toolchain | `package.json` (workspaces `packages/*`, `tools/*`; `catalog` pins), `tsconfig.json`, `devenv.nix` (Bun, Node 24, gitleaks, PostgreSQL 18, PgBouncer), `devenv.yaml`, `devenv.lock` | studio `d4fd75e`: `devenv.lock`, `devenv.yaml` unchanged; `package.json`, `tsconfig.json` and `devenv.nix` adapted |
| Lint and format | root `vite.config.ts`: Oxfmt (Ultracite), Oxlint with Ultracite `core` and `anti-slop`, cognitive complexity at most 15, type-aware | studio `vite.config.ts`, adapted (no Effect, Foldkit or vendored anti-slop Effect rules) |
| Hooks | `.vite-hooks/pre-commit`, `commit-msg`, `pre-push`; `commitlint.config.ts` | studio, byte for byte |
| Exceptions registry | `tools/quality/exceptions.json` (empty), `exceptions.ts`, `checkExceptions.ts` and their test | studio's, **ported to plain TypeScript** (zod instead of Effect Schema) |
| Effect boundary | `tools/quality/test/effectBoundary.test.ts` | new |
| Secrets, dead code, duplication | `.gitleaks.toml` (default rules), `knip.json`, `.jscpd.json` | studio, adapted (paths cut) |
| CI | `.github/workflows/checks.yml`: pull requests and push to `main`; pinned devenv; one step per gate; actions pinned by commit | studio, header only |
| Skills | `.agents/skills/review-pr/` (`SKILL.md`, `reviewers.md`, `record-round.sh`, `merge.sh`), `.agents/skills/pr-create/SKILL.md`, `.agents/skills/verify-pg-txmode/` (`SKILL.md`, `scripts/headroom.sh`, `scripts/lib.sh`) | studio; `record-round.sh` and `merge.sh` byte for byte; `headroom.sh` and `lib.sh` adapted; the three `SKILL.md` and `reviewers.md` adapted |
| Tests of the road | `tools/quality/test/recordRound.test.ts` (the Author/Reviewers/Checked rule), `headroom.test.ts` (each gate, with an injected sample) | studio's, **ported to plain Vitest**, same controls |
| Agent docs | `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md` only), `STATE.md`, `PROVENANCE.md`, `README.md` (roadmap) | studio's `AGENTS.md`, adapted |
| One command | `bun run ready` = `check`, `check:exceptions`, `test`, `build`, `knip`, `cpd`, `secrets` | studio |
| Branch protection | `main`: pull request required (administrators included, no approving reviews), required status check `checks`, no force push, no deletion | `gh api -X PUT repos/phibkro/pg-txmode/branches/main/protection`, the same body as studio's |

### Not copied from studio

`apps/editor`, the Foldkit plugin and its lint adapter, `@effect/tsgo` and the diagnostic rules, `tools/oxlint/anti-slop` (its rules are Effect rules; Ultracite's `anti-slop` preset already supplies the generic ones), `effectFamily` and its test (nothing to keep in step until the Effect adapter exists), `featureMap` (no UI), `verify-studio`'s launch, doctor and Chromium scripts (the harness will start its own servers).

## Falsifiers

Each falsifier has a negative control that is run and observed to fail, with the output recorded in the PR body. A control is a deliberate defect applied to a scratch copy or a throwaway branch and never committed to `main`.

| # | Falsifier (must hold) | Gate | Negative control (must fail) |
|---|---|---|---|
| F1 | `bun run ready` exits 0 on a clean tree of the PR head | `ready` | F2 to F5, F7, F10 each make `ready` or a hook exit non-zero where it is the gate |
| F2 | A commit message that is not a Conventional Commit is rejected | `commit-msg` | `git commit -m "stuff"` is refused with the commitlint reason; `git commit -m "chore: x"` is accepted |
| F3 | A lint error in a staged file blocks the commit | `pre-commit` (`vp staged`) | Stage a file with `console.log` and an `any` parameter; the commit is refused |
| F4 | A secret in a staged file blocks the commit | `pre-commit` (gitleaks) | Stage a file holding a synthetic key in a well-known format (written only to the scratch copy); the commit is refused |
| F5 | An `oxlint-disable` without a registry entry fails `check:exceptions` | `check:exceptions` | Add `// oxlint-disable-next-line <rule>` without an entry: exits non-zero and names the file and line; remove the directive again: exits 0 |
| F6 | CI runs the gates on every PR and fails when one fails | `checks.yml` | This PR shows a green `checks` run; a throwaway PR with a lint violation shows a red one (closed, not merged) |
| F7 | A package other than the Effect adapter cannot depend on Effect | effect boundary test | In a scratch copy, add `"effect"` to `packages/core/package.json`: the test fails and names the manifest |
| F8 | A PR cannot be merged without a passing recorded round on its current head | `merge.sh`, `record-round.sh` | On the PR: `merge.sh` before any record exits 4; `record-round.sh` refuses a pass whose Author is among the Reviewers (exit 65). The merge itself is not run: this assignment does not merge |
| F9 | `main` cannot be pushed to directly | branch protection | `git push origin HEAD:main` from a scratch clone is rejected by GitHub |
| F10 | Cognitive complexity above 15 fails `vp check` | Oxlint | A scratch function with complexity 16 fails |
| F11 | The headroom gate fails closed on each limit and on an unreadable sample | `headroom.test.ts` | Make a comparison in `headroom.sh` never fire: the test for that gate fails |
| F12 | `LICENSE` is the verbatim Apache-2.0 text | review check (`cmp`) | `cmp LICENSE <(curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt)` exits 0 on the head; a one-byte change makes it exit 1 |

## Constraints on the implementation

- Free on mechanism, specific on behaviour: the scripts may be arranged differently as long as `ready`, `check`, `check:exceptions`, `test`, `build`, `knip`, `cpd` and `secrets` exist and the journey above holds.
- No product code: the catalogue, the connection mode and the rest are spec 0001's.
- Tests use fixtures written to temporary directories; none reads a file outside the repository.

## Risks

| Risk | Mitigation |
|---|---|
| devenv in CI is slow (Nix install, cache misses) | Reuse studio's pinned devenv and the `devenv` Cachix cache; the first run's time is recorded in the PR |
| PostgreSQL 18 or PgBouncer 1.25 are missing from the pinned nixpkgs | `devenv shell -- pgbouncer --version` and `postgres --version` ran on the lock copied from studio: PgBouncer 1.25.2, PostgreSQL 18.6 (PR body) |
| The exception registry becomes a rubber stamp | Each entry needs a retirement trigger and the conformance reviewer checks new entries |
| Branch protection with administrators included blocks the operator in an emergency | The command that removes it is in `AGENTS.md` |
| A session cannot spawn reviewers | `review-pr` says what then happens: the author opens the PR and reports to the lead, who arranges independent reviewers; the author never records a pass |

## Open questions for the operator

1. A required human approval, signed commits, Renovate: deferred, as in studio.
2. The vendored anti-slop Effect rules and `@effect/tsgo` diagnostics return in the Effect adapter's spec; is a separate `effect-house` overlay wanted then?

## Revisions

Dated entries. A spec is revised only here; its text above is never edited silently after the PR opens. Before the PR opens, the plan may change freely as the build teaches; a change that alters the journey, scope or a falsifier gets an entry anyway.

- **2026-10-29, plan written** with the build: studio's lifecycle copied at `d4fd75e`, the Effect-based tooling ported to plain TypeScript, the docs adapted.
- **2026-10-29, build deviations (found while building; none changes the journey or a falsifier).**
  1. **Tooling without Effect.** studio's `effectExceptions.ts`, `recordRound.test.ts`, `headroom.test.ts` and `scriptHarness.ts` import Effect. The operator's rule is that Effect is used only in the Effect adapter package, so the four were ported to plain TypeScript and Vitest (node:fs, node:child_process, zod for the registry shape). Their controls and assertions are the same; `PROVENANCE.md` lists each.
  2. **No `build` target yet.** `bun run build` runs `vp run -r build`; no workspace has a `build` script until spec 0001, so the gate passes vacuously today. It is kept so the `ready` sequence is the one the later specs use.
  3. **`verify-pg-txmode` instead of `verify-studio`.** There is no UI to launch, so the skill runs the gates and, from spec 0001, the harness; its feature map is not copied.
- **2026-10-29, after the PR opened (found by running F6; no falsifier changes).**
  1. **F6's control is a knip violation, not a lint one.** A commit with a lint violation cannot be created without `--no-verify` (the pre-commit hook refuses it, which is F3), and the rules forbid `--no-verify`. The throwaway PR #2 instead added one unused file, `tools/quality/unusedExport.ts`, which passes every hook and fails only the `knip` gate in CI. It proves the same thing: CI fails when a gate fails.
  2. **Two CI step names.** studio's step names "Effect exception registry" and "...prepare editor/hooks" were copied unchanged and name things this repository does not have. They are now "Exception registry" and "...prepare hooks"; commands and pins are unchanged. The table row "CI ... studio, header only" above is therefore "studio, two step names and the header".
- **2026-10-29, after review round 1 (recorded on the PR with `Reviewers: Claude Code`).**
  1. **The `stack` process moved to spec 0001.** `devenv.nix` declared `processes.stack.exec = "bun run stack"` and cited `packages/harness/src/profile.ts`, neither of which exists in this spec; `devenv up` would fail. The process now arrives in spec 0001 with its script. `postgresql_18` and `pgbouncer` stay: they were run (`pgbouncer --version`, `postgres --version`) and the harness needs them.
  2. **`PROVENANCE.md` corrected.** `tools/quality/tsconfig.json` and `tools/quality/vite.config.ts` are byte-identical to studio's (blob hashes compared) and now sit in the identical set; the `headroom.sh` row names the one figure that changed (`DEMAND_MEM_MIB` 3584 to 3072; `DEMAND_DISK_MIB` unchanged).
