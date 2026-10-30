# pg-txmode

Safe PostgreSQL through transaction-pooling proxies (Cloudflare Hyperdrive first; PgBouncer in transaction mode and Supavisor are the same class). Read [`README.md`](README.md); [`STATE.md`](STATE.md) says which spec is active. This repository is **public**: no secret, no personal data, ever.

The lifecycle below is specified in [`docs/specs/0000-development-lifecycle.md`](docs/specs/0000-development-lifecycle.md). This file links facts that live in scripts or in the spec; it does not copy them. It was adapted from `reebeat/studio`'s `AGENTS.md` (see [`PROVENANCE.md`](PROVENANCE.md)).

## How a change travels

```text
spec → code → PR   (1:1)
```

- **One spec, one branch, one PR.** The spec is `docs/specs/NNNN-*.md`; the branch is `feat/NNNN-<slug>`. If a spec needs two PRs, it was two specs.
- **Plan and build are one step.** Write the plan (journey, constraints, falsifiers) first, then build without waiting for approval. Revise the plan as the build teaches: each change is a dated entry in the spec's Revisions section, never a silent edit. Stop only at an operator-owned fork (preference, authority, external effects), and report it.
- **The PR carries spec and code**, opens only when the whole journey is built and `bun run ready` passed on the head, and **freezes the spec**. Use skill `pr-create`; the PR body is the report.
- **Never block on a merge.** After opening a PR, start the next spec on a stacked branch (`gh pr create --base <the branch below>`).
- **Review judges three things**: the plan, the implementation, and their agreement. Use skill `review-pr`; `.agents/skills/review-pr/merge.sh` merges only a head with a passing recorded round, and `record-round.sh` refuses a pass that the PR's author recorded about its own head. Every number in a report has its script, its raw output and its command.
- **The verify skill stays true (maintenance rule).** A PR that changes what a reviewer runs or observes (the harness, the probes, the CLI) updates skill `verify-pg-txmode` in the same PR. A stale skill is a `maintenance` finding of medium severity.
- **One writer per working directory.** A second agent works in its own worktree under `.worktrees/` (`/run/current-system/sw/bin/git worktree add .worktrees/<name> -b <branch>`; it is git-ignored). Use that full path: the harness rewrites a bare `git worktree` into `omp worktree`, which once copied `.worktrees/` into itself (189 to 215 GB). Commit by pathspec on a shared tree. Before a heavy job (`ready`, the harness) check the operator's limits with `.agents/skills/verify-pg-txmode/scripts/headroom.sh`.
- `main` is protected: a pull request is required (administrators included), the status check `checks` must pass, no force push, no deletion.

## Gates

Every gate is a root script in `package.json`; `bun run ready` runs them in this order. CI (`.github/workflows/checks.yml`) runs each script as its own step. Run everything inside devenv: `devenv shell -- bun run ready` (the system Bun can hang on install). Set up once with `devenv shell -- bun install`, which also installs the git hooks (`prepare`).

| Gate | Command | Runs where | Catches | See it fail |
| --- | --- | --- | --- | --- |
| Commit message | commitlint (`.vite-hooks/commit-msg`) | every commit | a message that is not a Conventional Commit | `git commit -m "stuff"` |
| Secrets, staged | gitleaks on staged blobs (`.vite-hooks/pre-commit`) | every commit | a secret in a staged file | stage a file with a fake key in a well-known format |
| Format and lint, staged | `vp staged` (`vp check --fix`, `.vite-hooks/pre-commit`) | every commit | format drift, lint errors | stage a file with a `console.log` and an `any` parameter |
| Tests | `bun run test` (`.vite-hooks/pre-push`) | every push, `ready`, CI | a failing test: the catalogue, the mode, the constructs, the lint, the probe suite against PostgreSQL 18 and PgBouncer 1.25 (the harness starts both on free ports), the exception registry, the review record, the headroom gate, the Effect boundary | change a cell of `packages/core/src/catalogue.ts` from `leaks` to `works` |
| Format, lint, types | `bun run check` (`vp check`) | `ready`, CI | Oxfmt drift; Oxlint with Ultracite and its anti-slop rules, cognitive complexity above 15; type errors (type-aware via tsgolint) | a function with complexity 16 |
| Effect diagnostics | `bun run check:effect` (`effect-tsgo tsc -p packages/effect`: the Effect-patched compiler, run without patching `node_modules`) | `ready`, CI | an Effect language-service diagnostic in `packages/effect` (all are errors in its `tsconfig.json`: an async function, a global timer, a native array method, an unstable API outside `allowedUnstableApis`, a missing service) | add `export async function f() {}` to a file of `packages/effect/src` |
| Exception registry | `bun run check:exceptions` | `ready`, CI | a suppression directive without a registry entry; a registry entry without a live suppression | add `// oxlint-disable-next-line <rule>` with no entry |
| README table | `bun run check:docs` (`packages/core/scripts/readme.ts --check`, and `packages/core/test/readme.test.ts`) | `ready`, CI | the README catalogue table that differs from `packages/core/src/catalogue.ts` | edit one cell of the table by hand; `bun run docs:gen` writes it back |
| Effect boundary | `bun run test` (`tools/quality/test/effectBoundary.test.ts`) | `ready`, CI | a workspace package other than the Effect adapter that depends on `effect` or an `@effect/*` package (the root may list `@effect/tsgo`, the checker); a TypeScript file outside `packages/effect` that imports Effect; a suppression directive in `packages/effect`; a pooler name or setting read in `packages/effect/src` | add `"effect"` to `dependencies` of another package; add `import { Effect } from "effect"` to a file of `packages/core` |
| Review record | `bun run test` (`tools/quality/test/recordRound.test.ts`) | `ready`, CI | `record-round.sh` accepting a pass whose `Author` is among its `Reviewers`, or a body without `Author`, `Reviewers` or `Checked` | change a reviewer name in the test's body to the author's |
| Headroom gate | `bun run test` (`tools/quality/test/headroom.test.ts`) | `ready`, CI | `headroom.sh` passing a machine that is short on memory (MemAvailable after the demand under 20% of RAM), swap-in (1000 pages per second or more), memory PSI (`full` avg60 of 10% or more) or load (1-minute load at or above the CPU threads), or passing a gate whose sample it cannot read | make the gate's comparison in `headroom.sh` never fire; delete `/proc/pressure/memory` from the injected sample |
| Build | `bun run build` (`vp run -r build`) | `ready`, CI | a package that no longer builds | import a module that does not exist |
| Release stage | `bun run release:stage` (`tools/quality/stagePackages.ts`) | `ready`, CI | a published package that cannot ship: a `workspace:` or `catalog:` range left, a missing licence or description or public access, an export that is not a source file, a file in the tarball that is not built output (`npm pack --dry-run --json`), a built file that imports what the manifest does not ship (a development dependency, or types from a development-only `@types/*`) | add `"@probe/x": "workspace:^"` to `dependencies` of `packages/lint`; add a `src/x.ts` import of a development dependency to a published package |
| Release rules | `bun run test` (`tools/quality/test/release.test.ts`, `releaseWorkflow.test.ts`) | `ready`, CI | package manifest drift, stored workflow credentials, unsafe release modes, bypassed hold, missing npm checkout preparation, and non-E404 publish decisions | add `NODE_AUTH_TOKEN` to a workflow; put `npm publish ./x` in `check`; add `if: always()` to `Publish` |
| Dead code | `bun run knip` | `ready`, CI | unused files, exports and dependencies | export a symbol nothing imports |
| Duplication | `bun run cpd` | `ready`, CI | copy-paste (threshold 0) | paste a 40-token block twice |
| Secrets, history | `bun run secrets` | `ready`, CI | a secret anywhere in the git history | commit a fake key on a scratch branch |

## Exceptions

Fix the code, not the rule. When a suppression (`oxlint-disable`, `eslint-disable`, `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`) is genuinely needed, add an entry to [`tools/quality/exceptions.json`](tools/quality/exceptions.json) in the same change: `id` (`EX-NNNN`), `scope` (`files`, `directives`), `reason`, `nativeAlternativesExamined`, `owner`, `versions` (the versions examined) and `retirementTrigger`. `bun run check:exceptions` fails on a suppression without an entry and on an entry without a live suppression, so an entry retires with its suppression. A rule turned off in `vite.config.ts` is not a suppression directive: it carries its reason in a comment there and in the spec's Revisions.

## Stack

TypeScript 7 (the native compiler), Bun, Vite+ (`vp`: Oxlint, Oxfmt, Vitest, `vp pack`), devenv (Bun, Node 24, gitleaks, PostgreSQL 18, PgBouncer 1.25).

- **The core does not depend on Effect.** Effect v4.1 is used only by the Effect adapter package, `packages/effect` ([spec 0003](docs/specs/0003-effect-adapter.md)); the Effect boundary gate enforces it, in manifests and in imports. The Effect rules (`@effect/tsgo` diagnostics in `packages/effect/tsconfig.json`, the Oxlint Effect plugin in `vite.config.ts`) apply to that package only (the language-service diagnostics run in `bun run check:effect`, the plugin rules in `bun run check`), and admit no suppression directive: a directive of the Effect language service or plugin in `packages/effect` fails the boundary test.
- **Packages, tools, categories.** `packages/*` are libraries and adapters (published); `tools/*` are repository tooling and depend on no package. A library depends only on libraries; an adapter may depend on a library and on its driver.
- **Positive constructs over detection.** A property that can be made structural is structural (a typed connection mode with no session-only API) before it is linted or tested.
- **One source per fact.** The catalogue is one data file; the README table, lint messages and capability checks derive from it by generation or by a test that fails on drift.

## Conventions

- **Conventional Commits** (`feat(scope): …`, `fix: …`, `docs: …`, `chore: …`). Body lines at most 100 characters.
- **Never `--no-verify`.** A rejected commit can leave files staged: check `git status` after any hook failure.
- **Never set or change the git identity.**
- Python only for throwaway work; commit TypeScript. Edit files with the edit and write tools, never with a shell redirect into source.
- Copied code carries its provenance (source repository, commit, deviations) in a header or in [`PROVENANCE.md`](PROVENANCE.md); keep third-party licences in place.
- Tests prove a rule, not an implementation detail; a test fixture lives in a temporary directory the test creates, never outside the repository.
- **LICENSE is Apache-2.0, verbatim** (checked against <https://www.apache.org/licenses/LICENSE-2.0.txt>), with a `NOTICE` that reads `Copyright 2026 Philip Bjørknes Krogh`. Never edit either.
- Primary sources only in the catalogue: every claim has a URL or a local measurement (script, raw output and command).

## Emergency

Branch protection includes administrators. To remove it (operator only, an external effect):

```sh
gh api -X DELETE repos/phibkro/pg-txmode/branches/main/protection
```

Restore it afterwards as spec 0000 describes it.
